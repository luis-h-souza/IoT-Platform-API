import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { CommandStatus } from '../../src/generated/prisma/enums.ts';
import { createDeviceEventService } from '../../src/modules/events/event.service.js';

const deviceId = '11111111-1111-4111-8111-111111111111';
const otherDeviceId = '22222222-2222-4222-8222-222222222222';
const commandId = '33333333-3333-4333-8333-333333333333';
const fixedNow = new Date('2026-11-05T12:00:00.000Z');

function makeEventPrisma({ commands = [] } = {}) {
  const devices = new Map([
    [deviceId, { id: deviceId, lastSeenAt: null }],
    [otherDeviceId, { id: otherDeviceId, lastSeenAt: null }]
  ]);
  const events = new Map();
  const commandRows = new Map(commands.map((command) => [command.id, { ...command }]));
  let receiptTick = 0;

  const deviceEvent = {
    async findUnique({ where }) {
      const key = where.deviceId_eventId;
      return events.get(`${key.deviceId}:${key.eventId}`) ?? null;
    },
    async create({ data }) {
      const key = `${data.deviceId}:${data.eventId}`;
      if (events.has(key)) {
        throw Object.assign(new Error('unique constraint'), { code: 'P2002' });
      }
      const event = {
        id: randomUUID(),
        receivedAt: new Date(fixedNow.getTime() + receiptTick++),
        ...data
      };
      events.set(key, event);
      return event;
    },
    async findMany({ where, orderBy, take }) {
      assert.equal(orderBy[0].receivedAt, 'desc');
      return [...events.values()]
        .filter((event) => event.deviceId === where.deviceId)
        .sort((left, right) => right.receivedAt - left.receivedAt || right.id.localeCompare(left.id))
        .slice(0, take);
    }
  };

  const device = {
    async findUnique({ where }) {
      return devices.get(where.id) ?? null;
    },
    async updateMany({ where, data }) {
      const current = devices.get(where.id);
      if (
        current &&
        (current.lastSeenAt === null || current.lastSeenAt < data.lastSeenAt)
      ) {
        current.lastSeenAt = data.lastSeenAt;
        return { count: 1 };
      }
      return { count: 0 };
    }
  };

  const deviceCommand = {
    async findUnique({ where }) {
      return commandRows.get(where.id) ?? null;
    }
  };

  const transaction = {
    device,
    deviceEvent,
    deviceCommand,
    async $executeRaw() {
      return 0;
    },
    async $queryRaw(strings, ...values) {
      const sql = strings.join('?');
      const command = commandRows.get(commandId);
      if (sql.includes("'ACKNOWLEDGED'::\"CommandStatus\"")) {
        if (command?.status !== CommandStatus.DELIVERED) return [];
        command.status = CommandStatus.ACKNOWLEDGED;
        command.acknowledgedAt = fixedNow;
        return [{ id: command.id }];
      }

      if (command?.status !== CommandStatus.ACKNOWLEDGED) return [];
      command.status = values.find((value) => ['SUCCEEDED', 'FAILED'].includes(value));
      command.completedAt = fixedNow;
      return [{ id: command.id }];
    }
  };

  const prisma = {
    device,
    deviceEvent,
    deviceCommand,
    events,
    devices,
    commandRows,
    async $transaction(callback) {
      return callback(transaction);
    }
  };

  return prisma;
}

function stateEvent(eventId, state, occurredAt = fixedNow.toISOString()) {
  return {
    eventId,
    eventType: 'STATE_REPORTED',
    occurredAt,
    payload: { state }
  };
}

test('DeviceEvent schema validates event types and state payloads', async () => {
  const service = createDeviceEventService(makeEventPrisma(), { now: () => fixedNow });

  await assert.rejects(
    service.ingest(deviceId, stateEvent('state-1', 'TOGGLE')),
    { name: 'ZodError' }
  );
  await assert.rejects(
    service.ingest(deviceId, {
      eventId: 'result-1',
      eventType: 'COMMAND_RESULT',
      occurredAt: fixedNow.toISOString(),
      payload: { commandId, status: 'FAILED' }
    }),
    { name: 'ZodError' }
  );
});

test('rejects device timestamps more than five minutes in the future', async () => {
  const prisma = makeEventPrisma();
  const service = createDeviceEventService(prisma, { now: () => fixedNow });
  const tooFarAhead = new Date(fixedNow.getTime() + 5 * 60_000 + 1).toISOString();

  await assert.rejects(service.ingest(deviceId, stateEvent('future-1', 'ON', tooFarAhead)), {
    name: 'ServiceError',
    code: 'DEVICE_EVENT_TIMESTAMP_IN_FUTURE',
    statusCode: 422
  });
  assert.equal(prisma.events.size, 0);
});

test('ingests events once, updates lastSeenAt, and returns an identical retry as a duplicate', async () => {
  const prisma = makeEventPrisma();
  const service = createDeviceEventService(prisma, { now: () => fixedNow });
  const input = stateEvent('state-duplicate', 'ON');

  const first = await service.ingest(deviceId, input);
  const retry = await service.ingest(deviceId, input);

  assert.equal(first.duplicate, false);
  assert.equal(retry.duplicate, true);
  assert.equal(retry.event.id, first.event.id);
  assert.equal(prisma.events.size, 1);
  assert.equal(prisma.devices.get(deviceId).lastSeenAt, first.event.receivedAt);
});

test('conflicts if an event ID is reused with different content', async () => {
  const service = createDeviceEventService(makeEventPrisma(), { now: () => fixedNow });

  await service.ingest(deviceId, stateEvent('state-conflict', 'ON'));
  await assert.rejects(service.ingest(deviceId, stateEvent('state-conflict', 'OFF')), {
    name: 'ServiceError',
    code: 'DEVICE_EVENT_ID_CONFLICT',
    statusCode: 409
  });
});

test('lists reports by API receipt time and does not infer state from occurredAt', async () => {
  const service = createDeviceEventService(makeEventPrisma(), { now: () => fixedNow });

  await service.ingest(deviceId, stateEvent('old-observation', 'ON', '2026-11-05T11:00:00.000Z'));
  await service.ingest(deviceId, stateEvent('newly-received', 'OFF', '2026-11-05T10:00:00.000Z'));

  const events = await service.listByDevice(deviceId);
  assert.equal(events[0].eventId, 'newly-received');
  assert.equal(events[0].payload.state, 'OFF');
});

test('acknowledgement events transition only commands belonging to the device', async () => {
  const command = {
    id: commandId,
    deviceId,
    status: CommandStatus.DELIVERED,
    expiresAt: new Date(fixedNow.getTime() + 60_000)
  };
  const prisma = makeEventPrisma({ commands: [command] });
  const service = createDeviceEventService(prisma, { now: () => fixedNow });

  const acknowledged = await service.ingest(deviceId, {
    eventId: 'ack-1',
    eventType: 'COMMAND_ACKNOWLEDGED',
    occurredAt: fixedNow.toISOString(),
    payload: { commandId }
  });
  assert.equal(acknowledged.command.status, CommandStatus.ACKNOWLEDGED);

  await assert.rejects(
    service.ingest(otherDeviceId, {
      eventId: 'ack-cross-device',
      eventType: 'COMMAND_ACKNOWLEDGED',
      occurredAt: fixedNow.toISOString(),
      payload: { commandId }
    }),
    { name: 'ServiceError', code: 'DEVICE_COMMAND_NOT_FOUND', statusCode: 404 }
  );
});

test('late result events are recorded without replacing a terminal command state', async () => {
  const command = {
    id: commandId,
    deviceId,
    status: CommandStatus.EXPIRED,
    expiresAt: new Date(fixedNow.getTime() - 1),
    result: null,
    errorCode: null
  };
  const prisma = makeEventPrisma({ commands: [command] });
  const service = createDeviceEventService(prisma, { now: () => fixedNow });

  const ingested = await service.ingest(deviceId, {
    eventId: 'late-result',
    eventType: 'COMMAND_RESULT',
    occurredAt: fixedNow.toISOString(),
    payload: { commandId, status: 'SUCCEEDED', actualState: 'ON' }
  });

  assert.equal(ingested.duplicate, false);
  assert.equal(ingested.command.status, CommandStatus.EXPIRED);
  assert.equal(prisma.commandRows.get(commandId).status, CommandStatus.EXPIRED);
});
