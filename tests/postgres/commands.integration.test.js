import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, test } from 'node:test';
import { CommandStatus } from '../../src/generated/prisma/enums.ts';
import { createDeviceCommandService } from '../../src/modules/commands/command.service.js';
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

async function createDevice({ active = true } = {}) {
  const store = await storeService.create({
    name: 'Loja de comandos',
    externalId: uniqueValue('command-store', randomUUID())
  });
  context.track(context.ids.storeIds, store.id);

  const sector = await sectorService.create({ storeId: store.id, name: 'Iluminação' });
  context.track(context.ids.sectorIds, sector.id);

  const device = await deviceService.create({
    deviceUid: uniqueValue('command-esp32', randomUUID()),
    name: 'Controlador de iluminação',
    function: 'LIGHTING',
    sectorId: sector.id
  });
  context.track(context.ids.deviceIds, device.id);

  if (active) {
    return deviceService.update(device.id, { status: 'ACTIVE' });
  }

  return device;
}

async function createCommand(deviceId, overrides = {}) {
  const command = await commandService.create({
    deviceId,
    commandType: 'LIGHTING_SET',
    payload: { state: 'ON' },
    idempotencyKey: uniqueValue('command-key', randomUUID()),
    expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
    ...overrides
  });
  context.track(context.ids.commandIds, command.id);
  return command;
}

after(async () => {
  try {
    await context.cleanup();
  } finally {
    await disconnectIntegrationDatabase();
  }
});

test('DeviceCommand PostgreSQL: idempotência concorrente retorna um único comando', async () => {
  const device = await createDevice();
  const input = {
    deviceId: device.id,
    commandType: 'LIGHTING_SET',
    payload: { state: 'ON' },
    idempotencyKey: uniqueValue('concurrent-key', context.runId),
    expiresAt: new Date(Date.now() + 10 * 60_000).toISOString()
  };

  const [left, right] = await Promise.all([
    commandService.create(input),
    commandService.create(input)
  ]);
  context.track(context.ids.commandIds, left.id);

  assert.equal(left.id, right.id);
  const rows = await prisma.deviceCommand.findMany({
    where: { deviceId: device.id, idempotencyKey: input.idempotencyKey }
  });
  assert.equal(rows.length, 1);

  await assert.rejects(
    commandService.create({ ...input, payload: { state: 'OFF' } }),
    { code: 'DEVICE_COMMAND_IDEMPOTENCY_CONFLICT', statusCode: 409 }
  );
});

test('DeviceCommand PostgreSQL: polls concorrentes não reivindicam o mesmo comando', async () => {
  const device = await createDevice();
  const command = await createCommand(device.id);

  const [firstPoll, secondPoll] = await Promise.all([
    commandService.claimForPolling(device.id),
    commandService.claimForPolling(device.id)
  ]);
  const claimed = [...firstPoll, ...secondPoll];

  assert.equal(claimed.filter(({ id }) => id === command.id).length, 1);
  assert.equal(claimed.length, 1);

  const delivered = await prisma.deviceCommand.findUnique({ where: { id: command.id } });
  assert.equal(delivered.status, CommandStatus.DELIVERED);
  assert.equal(delivered.attempts, 1);
  assert.ok(delivered.deliveredAt instanceof Date);
  assert.deepEqual(await commandService.claimForPolling(device.id), []);
});

test('DeviceCommand PostgreSQL: reentrega após 30 segundos incrementa attempts e move deliveredAt', async () => {
  const device = await createDevice();
  const command = await createCommand(device.id);
  const [firstDelivery] = await commandService.claimForPolling(device.id);
  const staleDeliveryAt = new Date(Date.now() - 31_000);

  await prisma.deviceCommand.update({
    where: { id: command.id },
    data: { deliveredAt: staleDeliveryAt }
  });

  const [redelivery] = await commandService.claimForPolling(device.id);
  assert.equal(redelivery.id, command.id);
  assert.equal(redelivery.attempts, firstDelivery.attempts + 1);
  assert.ok(redelivery.deliveredAt > staleDeliveryAt);
});

test('DeviceCommand PostgreSQL: reconhece o ciclo de vida e preserva estados terminais', async () => {
  const device = await createDevice();
  const command = await createCommand(device.id);
  await commandService.claimForPolling(device.id);

  const acknowledged = await commandService.acknowledge({
    commandId: command.id,
    deviceId: device.id
  });
  assert.equal(acknowledged.status, CommandStatus.ACKNOWLEDGED);
  assert.ok(acknowledged.acknowledgedAt instanceof Date);
  assert.deepEqual(await commandService.claimForPolling(device.id), []);

  const result = { actualState: 'ON' };
  const completeInput = {
    commandId: command.id,
    deviceId: device.id,
    status: CommandStatus.SUCCEEDED,
    result
  };
  const [succeeded, concurrentRetry] = await Promise.all([
    commandService.complete(completeInput),
    commandService.complete(completeInput)
  ]);
  assert.equal(succeeded.status, CommandStatus.SUCCEEDED);
  assert.equal(concurrentRetry.status, CommandStatus.SUCCEEDED);
  assert.ok(succeeded.completedAt instanceof Date);
  assert.deepEqual(succeeded.result, result);

  const retry = await commandService.complete({
    commandId: command.id,
    deviceId: device.id,
    status: CommandStatus.SUCCEEDED,
    result
  });
  assert.equal(retry.status, CommandStatus.SUCCEEDED);

  await assert.rejects(
    commandService.complete({
      commandId: command.id,
      deviceId: device.id,
      status: CommandStatus.FAILED,
      errorCode: 'ACTUATOR_ERROR'
    }),
    { code: 'DEVICE_COMMAND_TERMINAL', statusCode: 409 }
  );
});

test('DeviceCommand PostgreSQL: registra falha como estado terminal', async () => {
  const device = await createDevice();
  const command = await createCommand(device.id, { payload: { state: 'OFF' } });
  await commandService.claimForPolling(device.id);
  await commandService.acknowledge({ commandId: command.id, deviceId: device.id });

  const failed = await commandService.complete({
    commandId: command.id,
    deviceId: device.id,
    status: CommandStatus.FAILED,
    errorCode: 'ACTUATOR_ERROR'
  });

  assert.equal(failed.status, CommandStatus.FAILED);
  assert.equal(failed.errorCode, 'ACTUATOR_ERROR');
  assert.ok(failed.completedAt instanceof Date);
});

test('DeviceCommand PostgreSQL: expira sob demanda e não entrega comando vencido', async () => {
  const device = await createDevice();
  const command = await createCommand(device.id);
  await prisma.deviceCommand.update({
    where: { id: command.id },
    data: { expiresAt: new Date(Date.now() - 1) }
  });

  assert.deepEqual(await commandService.claimForPolling(device.id), []);
  const expired = await prisma.deviceCommand.findUnique({ where: { id: command.id } });
  assert.equal(expired.status, CommandStatus.EXPIRED);
  assert.ok(expired.completedAt instanceof Date);
});

test('DeviceCommand PostgreSQL: polling não entrega comandos a dispositivo ainda não ativo', async () => {
  const device = await createDevice({ active: false });
  await createCommand(device.id);

  assert.deepEqual(await commandService.claimForPolling(device.id), []);
});
