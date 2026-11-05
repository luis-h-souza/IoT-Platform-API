import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, test } from 'node:test';
import { CommandStatus } from '../../src/generated/prisma/enums.ts';
import { createDeviceCommandService } from '../../src/modules/commands/command.service.js';
import { createDeviceEventService } from '../../src/modules/events/event.service.js';
import { createDeviceService } from '../../src/modules/devices/device.service.js';
import { createSectorService } from '../../src/modules/sectors/sector.service.js';
import { createStoreService } from '../../src/modules/stores/store.service.js';
import {
  createIntegrationContext,
  disconnectIntegrationDatabase,
  prisma,
  uniqueValue
} from './support.js';

const context = createIntegrationContext();
const storeService = createStoreService(prisma);
const sectorService = createSectorService(prisma);
const deviceService = createDeviceService(prisma);
const commandService = createDeviceCommandService(prisma);
const eventService = createDeviceEventService(prisma);

async function createDevice() {
  const store = await storeService.create({
    name: 'Loja de eventos',
    externalId: uniqueValue('event-store', randomUUID())
  });
  context.track(context.ids.storeIds, store.id);
  const sector = await sectorService.create({ storeId: store.id, name: 'Iluminação' });
  context.track(context.ids.sectorIds, sector.id);
  const device = await deviceService.create({
    deviceUid: uniqueValue('event-esp32', randomUUID()),
    name: 'Controlador de eventos',
    function: 'LIGHTING',
    sectorId: sector.id
  });
  context.track(context.ids.deviceIds, device.id);
  return deviceService.update(device.id, { status: 'ACTIVE' });
}

function stateEvent(eventId, state, occurredAt = new Date().toISOString()) {
  return {
    eventId,
    eventType: 'STATE_REPORTED',
    occurredAt,
    payload: { state }
  };
}

async function createAndDeliverCommand(deviceId, overrides = {}) {
  const command = await commandService.create({
    deviceId,
    commandType: 'LIGHTING_SET',
    payload: { state: 'ON' },
    idempotencyKey: uniqueValue('event-command', randomUUID()),
    expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
    ...overrides
  });
  context.track(context.ids.commandIds, command.id);
  await commandService.claimForPolling(deviceId);
  return command;
}

after(async () => {
  try {
    await context.cleanup();
  } finally {
    await disconnectIntegrationDatabase();
  }
});

test('DeviceEvent PostgreSQL: deduplica ingestão concorrente pelo eventId', async () => {
  const device = await createDevice();
  const input = stateEvent(uniqueValue('state-event', context.runId), 'ON');

  const [left, right] = await Promise.all([
    eventService.ingest(device.id, input),
    eventService.ingest(device.id, input)
  ]);
  context.track(context.ids.eventIds, left.event.id);

  assert.equal(left.event.id, right.event.id);
  assert.equal([left, right].filter(({ duplicate }) => !duplicate).length, 1);
  const rows = await prisma.deviceEvent.findMany({
    where: { deviceId: device.id, eventId: input.eventId }
  });
  assert.equal(rows.length, 1);
});

test('DeviceEvent PostgreSQL: reutilizar eventId com conteúdo diferente gera conflito', async () => {
  const device = await createDevice();
  const eventId = uniqueValue('conflicting-event', context.runId);
  const original = await eventService.ingest(device.id, stateEvent(eventId, 'ON'));
  context.track(context.ids.eventIds, original.event.id);

  await assert.rejects(eventService.ingest(device.id, stateEvent(eventId, 'OFF')), {
    code: 'DEVICE_EVENT_ID_CONFLICT',
    statusCode: 409
  });
});

test('DeviceEvent PostgreSQL: ordena STATE_REPORTED pelo recebimento, não pelo relógio do ESP32', async () => {
  const device = await createDevice();
  const olderObservation = await eventService.ingest(
    device.id,
    stateEvent(uniqueValue('state-old', context.runId), 'ON', '2026-11-05T10:00:00.000Z')
  );
  context.track(context.ids.eventIds, olderObservation.event.id);
  const laterReceived = await eventService.ingest(
    device.id,
    stateEvent(uniqueValue('state-new', context.runId), 'OFF', '2026-11-05T09:00:00.000Z')
  );
  context.track(context.ids.eventIds, laterReceived.event.id);

  const receivedEvents = await eventService.listByDevice(device.id);
  assert.equal(receivedEvents[0].id, laterReceived.event.id);
  assert.equal(receivedEvents[0].payload.state, 'OFF');
  assert.ok(laterReceived.event.receivedAt > olderObservation.event.receivedAt);
});

test('DeviceEvent PostgreSQL: confirmação e resultado atualizam comando em conjunto com o evento', async () => {
  const device = await createDevice();
  const command = await createAndDeliverCommand(device.id);
  const acknowledged = await eventService.ingest(device.id, {
    eventId: uniqueValue('ack', context.runId),
    eventType: 'COMMAND_ACKNOWLEDGED',
    occurredAt: new Date().toISOString(),
    payload: { commandId: command.id }
  });
  context.track(context.ids.eventIds, acknowledged.event.id);
  assert.equal(acknowledged.command.status, CommandStatus.ACKNOWLEDGED);

  const result = await eventService.ingest(device.id, {
    eventId: uniqueValue('result', context.runId),
    eventType: 'COMMAND_RESULT',
    occurredAt: new Date().toISOString(),
    payload: {
      commandId: command.id,
      status: 'SUCCEEDED',
      actualState: 'ON'
    }
  });
  context.track(context.ids.eventIds, result.event.id);
  assert.equal(result.command.status, CommandStatus.SUCCEEDED);
  assert.deepEqual(result.command.result, { actualState: 'ON' });

  const storedCommand = await prisma.deviceCommand.findUnique({ where: { id: command.id } });
  assert.equal(storedCommand.status, CommandStatus.SUCCEEDED);
});

test('DeviceEvent PostgreSQL: resultado fora de ordem não persiste sem confirmação', async () => {
  const device = await createDevice();
  const command = await createAndDeliverCommand(device.id);
  const eventId = uniqueValue('early-result', context.runId);

  await assert.rejects(
    eventService.ingest(device.id, {
      eventId,
      eventType: 'COMMAND_RESULT',
      occurredAt: new Date().toISOString(),
      payload: {
        commandId: command.id,
        status: 'SUCCEEDED',
        actualState: 'ON'
      }
    }),
    { code: 'DEVICE_COMMAND_INVALID_TRANSITION', statusCode: 409 }
  );

  const storedCommand = await prisma.deviceCommand.findUnique({ where: { id: command.id } });
  assert.equal(storedCommand.status, CommandStatus.DELIVERED);
  const storedEvent = await prisma.deviceEvent.findUnique({
    where: { deviceId_eventId: { deviceId: device.id, eventId } }
  });
  assert.equal(storedEvent, null);
});

test('DeviceEvent PostgreSQL: mensagem atrasada fica registrada sem regredir comando terminal', async () => {
  const device = await createDevice();
  const command = await createAndDeliverCommand(device.id);
  await commandService.expireDue(device.id);
  await prisma.deviceCommand.update({
    where: { id: command.id },
    data: { expiresAt: new Date(Date.now() - 1) }
  });
  await commandService.expireDue(device.id);

  const lateResult = await eventService.ingest(device.id, {
    eventId: uniqueValue('late-result', context.runId),
    eventType: 'COMMAND_RESULT',
    occurredAt: new Date().toISOString(),
    payload: {
      commandId: command.id,
      status: 'SUCCEEDED',
      actualState: 'ON'
    }
  });
  context.track(context.ids.eventIds, lateResult.event.id);

  assert.equal(lateResult.command.status, CommandStatus.EXPIRED);
  const storedCommand = await prisma.deviceCommand.findUnique({ where: { id: command.id } });
  assert.equal(storedCommand.status, CommandStatus.EXPIRED);
  assert.equal(storedCommand.result, null);
});

test('DeviceEvent PostgreSQL: rejeita vínculo de comando pertencente a outro dispositivo', async () => {
  const device = await createDevice();
  const otherDevice = await createDevice();
  const command = await createAndDeliverCommand(otherDevice.id);

  await assert.rejects(
    eventService.ingest(device.id, {
      eventId: uniqueValue('cross-device-ack', context.runId),
      eventType: 'COMMAND_ACKNOWLEDGED',
      occurredAt: new Date().toISOString(),
      payload: { commandId: command.id }
    }),
    { code: 'DEVICE_COMMAND_NOT_FOUND', statusCode: 404 }
  );

  const rows = await prisma.deviceEvent.findMany({ where: { deviceId: device.id } });
  assert.equal(rows.some(({ eventId }) => eventId.startsWith('cross-device-ack-')), false);
});

test('DeviceEvent PostgreSQL: rejects event timestamps beyond allowed clock skew', async () => {
  const device = await createDevice();
  const occurredAt = new Date(Date.now() + 6 * 60_000).toISOString();

  await assert.rejects(
    eventService.ingest(device.id, stateEvent(uniqueValue('future-state', context.runId), 'ON', occurredAt)),
    { code: 'DEVICE_EVENT_TIMESTAMP_IN_FUTURE', statusCode: 422 }
  );
});
