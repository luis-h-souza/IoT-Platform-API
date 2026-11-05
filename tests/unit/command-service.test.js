import assert from 'node:assert/strict';
import test from 'node:test';
import { CommandStatus, DeviceStatus } from '../../src/generated/prisma/enums.ts';
import { createDeviceCommandService } from '../../src/modules/commands/command.service.js';

const deviceId = '11111111-1111-4111-8111-111111111111';
const commandId = '22222222-2222-4222-8222-222222222222';
const fixedNow = new Date('2026-11-05T12:00:00.000Z');
const expiresAt = new Date(fixedNow.getTime() + 60_000);

function makeCommandPrisma({ commands = [] } = {}) {
  const devices = new Map([[deviceId, { id: deviceId, status: DeviceStatus.ACTIVE }]]);
  const commandRows = new Map(commands.map((command) => [command.id, { ...command }]));
  const calls = { queries: [], creates: 0, transactions: 0 };

  const deviceCommand = {
    async findUnique({ where }) {
      if (where.deviceId_idempotencyKey) {
        return [...commandRows.values()].find(
          (command) =>
            command.deviceId === where.deviceId_idempotencyKey.deviceId &&
            command.idempotencyKey === where.deviceId_idempotencyKey.idempotencyKey
        ) ?? null;
      }

      return commandRows.get(where.id) ?? null;
    },
    async create({ data }) {
      calls.creates += 1;
      if ([...commandRows.values()].some(
        (command) => command.deviceId === data.deviceId && command.idempotencyKey === data.idempotencyKey
      )) {
        throw Object.assign(new Error('unique constraint'), { code: 'P2002' });
      }

      const command = {
        id: commandId,
        status: CommandStatus.QUEUED,
        attempts: 0,
        deliveredAt: null,
        acknowledgedAt: null,
        completedAt: null,
        result: null,
        errorCode: null,
        createdAt: fixedNow,
        ...data
      };
      commandRows.set(command.id, command);
      return command;
    },
    async findMany({ where }) {
      return [...commandRows.values()]
        .filter((command) => where.id.in.includes(command.id))
        .sort((left, right) => left.createdAt - right.createdAt);
    }
  };

  const transaction = {
    deviceCommand,
    device: {
      async findUnique({ where }) {
        return devices.get(where.id) ?? null;
      }
    },
    async $executeRaw(strings, ...values) {
      calls.queries.push({ sql: strings.join('?'), values, method: 'execute' });
      return 0;
    },
    async $queryRaw(strings, ...values) {
      const sql = strings.join('?');
      calls.queries.push({ sql, values, method: 'query' });

      if (sql.includes('WITH candidates AS')) {
        const command = [...commandRows.values()].find(
          (row) => row.deviceId === deviceId && row.status === CommandStatus.QUEUED
        );
        if (!command) return [];
        command.status = CommandStatus.DELIVERED;
        command.attempts += 1;
        command.deliveredAt = fixedNow;
        return [{ id: command.id }];
      }

      const command = commandRows.get(commandId);
      if (sql.includes("'ACKNOWLEDGED'::\"CommandStatus\"")) {
        if (command?.status !== CommandStatus.DELIVERED) return [];
        command.status = CommandStatus.ACKNOWLEDGED;
        command.acknowledgedAt = fixedNow;
        return [{ id: command.id }];
      }

      if (command?.status !== CommandStatus.ACKNOWLEDGED) return [];
      command.status = values.find((value) => ['SUCCEEDED', 'FAILED'].includes(value));
      command.result = JSON.parse(values.find((value) => typeof value === 'string' && value.startsWith('{')) ?? 'null');
      command.errorCode = values.find((value) => value === 'DEVICE_ERROR') ?? null;
      command.completedAt = fixedNow;
      return [{ id: command.id }];
    }
  };

  const prisma = {
    calls,
    device: transaction.device,
    deviceCommand,
    async $transaction(callback) {
      calls.transactions += 1;
      return callback(transaction);
    }
  };

  return { prisma, commandRows, calls };
}

function commandInput(overrides = {}) {
  return {
    deviceId,
    commandType: 'LIGHTING_SET',
    payload: { state: 'ON' },
    idempotencyKey: 'request-001',
    expiresAt: expiresAt.toISOString(),
    ...overrides
  };
}

test('DeviceCommand schema requires an idempotency key and an absolute lighting state', async () => {
  const { prisma } = makeCommandPrisma();
  const service = createDeviceCommandService(prisma, { now: () => fixedNow });

  await assert.rejects(service.create(commandInput({ idempotencyKey: '' })), { name: 'ZodError' });
  await assert.rejects(service.create(commandInput({ payload: { action: 'TOGGLE' } })), {
    name: 'ZodError'
  });
  await assert.rejects(service.create(commandInput({ expiresAt: 'not-a-date' })), {
    name: 'ZodError'
  });
});

test('creates an idempotent command and returns the existing command for the same intent', async () => {
  const { prisma, calls } = makeCommandPrisma();
  const service = createDeviceCommandService(prisma, { now: () => fixedNow });

  const first = await service.create(commandInput());
  const retry = await service.create(commandInput());

  assert.equal(retry.id, first.id);
  assert.equal(calls.creates, 1);
});

test('conflicts when an idempotency key is reused for a different intent', async () => {
  const { prisma } = makeCommandPrisma();
  const service = createDeviceCommandService(prisma, { now: () => fixedNow });

  await service.create(commandInput());
  await assert.rejects(service.create(commandInput({ payload: { state: 'OFF' } })), {
    name: 'ServiceError',
    code: 'DEVICE_COMMAND_IDEMPOTENCY_CONFLICT',
    statusCode: 409
  });
});

test('includes expiresAt in the idempotent intent comparison', async () => {
  const { prisma } = makeCommandPrisma();
  const service = createDeviceCommandService(prisma, { now: () => fixedNow });

  await service.create(commandInput());
  await assert.rejects(
    service.create(commandInput({ expiresAt: new Date(expiresAt.getTime() + 1_000).toISOString() })),
    { code: 'DEVICE_COMMAND_IDEMPOTENCY_CONFLICT', statusCode: 409 }
  );
});

test('rejects command expiration that is not in the future', async () => {
  const { prisma, calls } = makeCommandPrisma();
  const service = createDeviceCommandService(prisma, { now: () => fixedNow });

  await assert.rejects(
    service.create(commandInput({ expiresAt: fixedNow.toISOString() })),
    { name: 'ServiceError', code: 'DEVICE_COMMAND_EXPIRATION_INVALID', statusCode: 422 }
  );
  assert.equal(calls.creates, 0);
});

test('uses a transactional SKIP LOCKED claim that increments attempts atomically', async () => {
  const initialCommand = {
    id: commandId,
    deviceId,
    commandType: 'LIGHTING_SET',
    payload: { state: 'ON' },
    idempotencyKey: 'claim-001',
    expiresAt,
    status: CommandStatus.QUEUED,
    attempts: 0,
    deliveredAt: null,
    createdAt: fixedNow
  };
  const { prisma, calls } = makeCommandPrisma({ commands: [initialCommand] });
  const service = createDeviceCommandService(prisma);

  const [claimed] = await service.claimForPolling(deviceId);
  const claimSql = calls.queries.find(({ sql }) => sql.includes('WITH candidates AS')).sql;

  assert.equal(claimed.status, CommandStatus.DELIVERED);
  assert.equal(claimed.attempts, 1);
  assert.equal(claimed.deliveredAt, fixedNow);
  assert.match(claimSql, /FOR UPDATE OF command SKIP LOCKED/);
  assert.match(claimSql, /"attempts" = command\."attempts" \+ 1/);
  assert.equal(calls.transactions, 1);
});

test('requires delivery before acknowledgement and does not regress a terminal command', async () => {
  const queued = {
    id: commandId,
    deviceId,
    status: CommandStatus.QUEUED,
    expiresAt
  };
  const { prisma, commandRows, calls } = makeCommandPrisma({ commands: [queued] });
  const service = createDeviceCommandService(prisma);

  await assert.rejects(service.acknowledge({ commandId, deviceId }), {
    name: 'ServiceError',
    code: 'DEVICE_COMMAND_INVALID_TRANSITION'
  });
  assert.equal(calls.queries.some(({ sql }) => sql.includes("SET \"status\" = 'ACKNOWLEDGED'")), false);

  commandRows.get(commandId).status = CommandStatus.SUCCEEDED;
  const unchanged = await service.acknowledge({ commandId, deviceId });
  assert.equal(unchanged.status, CommandStatus.SUCCEEDED);
});
