import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, test } from 'node:test';
import { createDeviceService } from '../../src/modules/devices/device.service.js';
import { createSectorService } from '../../src/modules/sectors/sector.service.js';
import { createStoreService } from '../../src/modules/stores/store.service.js';
import {
  assertPrismaCode,
  createIntegrationContext,
  disconnectIntegrationDatabase,
  prisma,
  uniqueValue
} from './support.js';

const context = createIntegrationContext();
const storeService = createStoreService(prisma);
const sectorService = createSectorService(prisma);
const deviceService = createDeviceService(prisma);

async function createStore() {
  const store = await storeService.create({
    name: 'Loja devices',
    externalId: uniqueValue('device-store', randomUUID())
  });
  context.track(context.ids.storeIds, store.id);
  return store;
}

async function createSector(storeId, name) {
  const sector = await sectorService.create({ storeId, name });
  context.track(context.ids.sectorIds, sector.id);
  return sector;
}

async function createDevice(input) {
  const device = await deviceService.create(input);
  context.track(context.ids.deviceIds, device.id);
  return device;
}

after(async () => {
  try {
    await context.cleanup();
  } finally {
    await disconnectIntegrationDatabase();
  }
});

test('Device real: cria, consulta, lista por setor, atualiza e muda de setor', async () => {
  const store = await createStore();
  const firstSector = await createSector(store.id, 'Setor inicial');
  const secondSector = await createSector(store.id, 'Setor destino');
  const device = await createDevice({
    deviceUid: uniqueValue('esp32', context.runId),
    name: 'Relé de integração',
    function: 'LIGHTING',
    sectorId: firstSector.id
  });

  assert.equal(device.status, 'PROVISIONING');
  assert.equal((await deviceService.findById(device.id)).id, device.id);
  assert.ok((await deviceService.listBySector(firstSector.id)).some(({ id }) => id === device.id));

  const updated = await deviceService.update(device.id, {
    name: 'Relé atualizado',
    status: 'ACTIVE',
    sectorId: secondSector.id
  });
  assert.equal(updated.name, 'Relé atualizado');
  assert.equal(updated.status, 'ACTIVE');
  assert.equal(updated.sectorId, secondSector.id);
  assert.ok((await deviceService.listBySector(secondSector.id)).some(({ id }) => id === device.id));
});

test('Device real: rejeita setor inexistente e UID duplicado', async () => {
  const store = await createStore();
  const sector = await createSector(store.id, 'Setor duplicidade');
  const deviceUid = uniqueValue('esp32-duplicate', context.runId);
  const device = await createDevice({
    deviceUid,
    name: 'Único',
    function: 'LIGHTING',
    sectorId: sector.id
  });

  await assert.rejects(
    deviceService.create({
      deviceUid: uniqueValue('esp32-missing-sector', context.runId),
      name: 'Inválido',
      function: 'LIGHTING',
      sectorId: randomUUID()
    }),
    { code: 'SECTOR_NOT_FOUND', statusCode: 404 }
  );
  await assert.rejects(
    deviceService.create({ deviceUid, name: 'Duplicado', function: 'LIGHTING', sectorId: sector.id }),
    { code: 'DEVICE_UID_CONFLICT', statusCode: 409 }
  );
  assert.equal((await deviceService.findById(device.id)).deviceUid, deviceUid);
});

test('PostgreSQL: impõe FK e unicidade de deviceUid', async () => {
  const deviceUid = uniqueValue('esp32-constraint', context.runId);
  const store = await createStore();
  const sector = await createSector(store.id, 'Setor constraints');
  const device = await createDevice({
    deviceUid,
    name: 'Único',
    function: 'LIGHTING',
    sectorId: sector.id
  });

  await assert.rejects(
    prisma.device.create({
      data: {
        deviceUid: uniqueValue('esp32-invalid-sector', context.runId),
        name: 'FK',
        function: 'LIGHTING',
        sectorId: randomUUID()
      }
    }),
    (error) => assertPrismaCode(error, 'P2003')
  );
  await assert.rejects(
    prisma.device.create({
      data: {
        deviceUid,
        name: 'UID duplicado',
        function: 'LIGHTING',
        sectorId: sector.id
      }
    }),
    (error) => assertPrismaCode(error, 'P2002')
  );

  assert.equal((await deviceService.findById(device.id)).id, device.id);
});

test('PostgreSQL: impõe FKs e unicidade dos históricos por dispositivo', async () => {
  const invalidDeviceId = randomUUID();
  const occurredAt = new Date();

  await assert.rejects(
    prisma.deviceEvent.create({
      data: {
        deviceId: invalidDeviceId,
        eventId: uniqueValue('event', context.runId),
        eventType: 'HEARTBEAT',
        occurredAt
      }
    }),
    (error) => assertPrismaCode(error, 'P2003')
  );
  await assert.rejects(
    prisma.deviceCommand.create({
      data: {
        deviceId: invalidDeviceId,
        commandType: 'LIGHTING_SET',
        payload: { state: 'ON' },
        expiresAt: new Date(Date.now() + 60_000)
      }
    }),
    (error) => assertPrismaCode(error, 'P2003')
  );

  const store = await createStore();
  const sector = await createSector(store.id, 'Setor histórico');
  const device = await createDevice({
    deviceUid: uniqueValue('esp32-history', context.runId),
    name: 'Histórico',
    function: 'LIGHTING',
    sectorId: sector.id
  });
  const eventId = uniqueValue('event', context.runId);
  const event = await prisma.deviceEvent.create({
    data: {
      deviceId: device.id,
      eventId,
      eventType: 'HEARTBEAT',
      occurredAt
    }
  });
  context.track(context.ids.eventIds, event.id);
  await assert.rejects(
    prisma.deviceEvent.create({
      data: {
        deviceId: device.id,
        eventId,
        eventType: 'HEARTBEAT',
        occurredAt
      }
    }),
    (error) => assertPrismaCode(error, 'P2002')
  );

  const idempotencyKey = uniqueValue('command', context.runId);
  const commandData = {
    deviceId: device.id,
    commandType: 'LIGHTING_SET',
    payload: { state: 'ON' },
    idempotencyKey,
    expiresAt: new Date(Date.now() + 60_000)
  };
  const command = await prisma.deviceCommand.create({ data: commandData });
  context.track(context.ids.commandIds, command.id);
  await assert.rejects(
    prisma.deviceCommand.create({ data: commandData }),
    (error) => assertPrismaCode(error, 'P2002')
  );
});

test('PostgreSQL: ON DELETE RESTRICT protege setor e dispositivo com histórico', async () => {
  const store = await createStore();
  const sector = await createSector(store.id, 'Setor restrito');
  const device = await createDevice({
    deviceUid: uniqueValue('esp32-restrict', context.runId),
    name: 'Relé restrito',
    function: 'LIGHTING',
    sectorId: sector.id
  });
  const event = await prisma.deviceEvent.create({
    data: {
      deviceId: device.id,
      eventId: uniqueValue('restrict-event', context.runId),
      eventType: 'HEARTBEAT',
      occurredAt: new Date()
    }
  });
  context.track(context.ids.eventIds, event.id);
  const command = await prisma.deviceCommand.create({
    data: {
      deviceId: device.id,
      commandType: 'LIGHTING_SET',
      payload: { state: 'OFF' },
      expiresAt: new Date(Date.now() + 60_000)
    }
  });
  context.track(context.ids.commandIds, command.id);

  await assert.rejects(
    prisma.sector.delete({ where: { id: sector.id } }),
    (error) => assertPrismaCode(error, 'P2003')
  );
  await assert.rejects(
    prisma.device.delete({ where: { id: device.id } }),
    (error) => assertPrismaCode(error, 'P2003')
  );
});
