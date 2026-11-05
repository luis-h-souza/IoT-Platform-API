import assert from 'node:assert/strict';
import test from 'node:test';
import { createDeviceService } from '../../src/modules/devices/device.service.js';

const deviceId = '11111111-1111-4111-8111-111111111111';
const sectorId = '22222222-2222-4222-8222-222222222222';

function makeDevicePrisma({ sectors = [sectorId], devices = [] } = {}) {
  const sectorRows = new Map(sectors.map((id) => [id, { id }]));
  const deviceRows = new Map(devices.map((device) => [device.id, { ...device }]));
  const calls = { operations: [] };
  const record = (model, method, args) => calls.operations.push({ model, method, args });

  return {
    calls,
    sector: {
      async findUnique(args) {
        record('sector', 'findUnique', args);
        const { where } = args;
        return sectorRows.get(where.id) ?? null;
      }
    },
    device: {
      async create(args) {
        record('device', 'create', args);
        const { data } = args;
        const device = { id: deviceId, status: 'PROVISIONING', ...data };
        deviceRows.set(device.id, device);
        return device;
      },
      async findMany(args) {
        record('device', 'findMany', args);
        const { where } = args;
        return [...deviceRows.values()].filter((device) => device.sectorId === where.sectorId);
      },
      async findUnique(args) {
        record('device', 'findUnique', args);
        const { where } = args;
        return deviceRows.get(where.id) ?? null;
      },
      async update(args) {
        record('device', 'update', args);
        const { where, data } = args;
        const device = deviceRows.get(where.id);
        if (!device) {
          throw Object.assign(new Error('Record not found'), { code: 'P2025' });
        }
        Object.assign(device, data);
        return device;
      }
    }
  };
}

test('creates, lists, reads, and updates a LIGHTING device', async () => {
  const service = createDeviceService(makeDevicePrisma());
  const created = await service.create({ deviceUid: '  esp32-001 ', name: '  Relé 1 ', function: 'LIGHTING', sectorId });

  assert.equal(created.deviceUid, 'esp32-001');
  assert.equal(created.name, 'Relé 1');
  assert.equal(created.status, 'PROVISIONING');
  assert.deepEqual(await service.listBySector(sectorId), [created]);
  assert.equal((await service.findById(deviceId)).id, deviceId);
  assert.equal((await service.update(deviceId, { status: 'ACTIVE' })).status, 'ACTIVE');
});

test('rejects a device associated with a sector that does not exist', async () => {
  const service = createDeviceService(makeDevicePrisma({ sectors: [] }));

  await assert.rejects(
    service.create({ deviceUid: 'esp32-001', name: 'Relé', function: 'LIGHTING', sectorId }),
    { name: 'ServiceError', code: 'SECTOR_NOT_FOUND', statusCode: 404 }
  );
});

test('rejects updating a device to a sector that does not exist', async () => {
  const prisma = makeDevicePrisma();
  const service = createDeviceService(prisma);
  const missingSectorId = '33333333-3333-4333-8333-333333333333';

  await assert.rejects(service.update(deviceId, { sectorId: missingSectorId }), {
    name: 'ServiceError',
    code: 'SECTOR_NOT_FOUND',
    statusCode: 404
  });
  assert.deepEqual(prisma.calls.operations, [
    {
      model: 'sector',
      method: 'findUnique',
      args: { where: { id: missingSectorId }, select: { id: true } }
    }
  ]);
});

test('reports a missing device during update', async () => {
  const prisma = makeDevicePrisma();

  await assert.rejects(createDeviceService(prisma).update(deviceId, { status: 'ACTIVE' }), {
    name: 'ServiceError',
    code: 'DEVICE_NOT_FOUND',
    statusCode: 404
  });
  assert.deepEqual(prisma.calls.operations, [
    { model: 'device', method: 'update', args: { where: { id: deviceId }, data: { status: 'ACTIVE' } } }
  ]);
});

test('rejects invalid device IDs before querying Prisma', async () => {
  const prisma = makeDevicePrisma();

  await assert.rejects(createDeviceService(prisma).findById('not-a-uuid'), { name: 'ZodError' });
  assert.deepEqual(prisma.calls.operations, []);
});

test('reports a missing sector when listing its devices', async () => {
  const prisma = makeDevicePrisma({ sectors: [] });

  await assert.rejects(createDeviceService(prisma).listBySector(sectorId), {
    name: 'ServiceError',
    code: 'SECTOR_NOT_FOUND',
    statusCode: 404
  });
  assert.deepEqual(prisma.calls.operations, [
    { model: 'sector', method: 'findUnique', args: { where: { id: sectorId }, select: { id: true } } }
  ]);
});

test('validates sector IDs before querying', async () => {
  const prisma = makeDevicePrisma();
  let sectorLookups = 0;
  const findUnique = prisma.sector.findUnique;
  prisma.sector.findUnique = async (args) => {
    sectorLookups += 1;
    return findUnique(args);
  };
  const service = createDeviceService(prisma);

  await assert.rejects(service.listBySector('not-a-uuid'), { name: 'ZodError' });
  assert.equal(sectorLookups, 0);
});

test('maps a duplicate device UID to a conflict', async () => {
  const prisma = makeDevicePrisma();
  prisma.device.create = async () => {
    throw Object.assign(new Error('unique violation'), { code: 'P2002' });
  };

  await assert.rejects(
    createDeviceService(prisma).create({ deviceUid: 'esp32-001', name: 'Relé', function: 'LIGHTING', sectorId }),
    { name: 'ServiceError', code: 'DEVICE_UID_CONFLICT', statusCode: 409 }
  );
});

test('maps Prisma P2003 from device update to a missing-sector error', async () => {
  const prisma = makeDevicePrisma({ devices: [{ id: deviceId, sectorId, status: 'PROVISIONING' }] });
  prisma.device.update = async (args) => {
    prisma.calls.operations.push({ model: 'device', method: 'update', args });
    throw Object.assign(new Error('foreign key violation'), { code: 'P2003' });
  };
  const service = createDeviceService(prisma);

  await assert.rejects(service.update(deviceId, { sectorId }), {
    name: 'ServiceError',
    code: 'SECTOR_NOT_FOUND',
    statusCode: 404
  });
  assert.deepEqual(prisma.calls.operations.map(({ model, method }) => `${model}.${method}`), [
    'sector.findUnique',
    'device.update'
  ]);
});

test('rejects invalid data and status values', async () => {
  const service = createDeviceService(makeDevicePrisma());

  await assert.rejects(
    service.create({ deviceUid: 'esp32-001', name: 'Relé', function: 'THERMOSTAT', sectorId }),
    { name: 'ZodError' }
  );
  await assert.rejects(service.update(deviceId, { status: 'UNKNOWN' }), { name: 'ZodError' });
  await assert.rejects(service.update(deviceId, {}), { name: 'ZodError' });
  await assert.rejects(service.update(deviceId, { deviceUid: 'replacement-uid' }), { name: 'ZodError' });
});

test('allows a nullable firmware version patch', async () => {
  const service = createDeviceService(makeDevicePrisma());
  const created = await service.create({
    deviceUid: 'esp32-001',
    name: 'Relé',
    function: 'LIGHTING',
    firmwareVersion: '1.0.0',
    sectorId
  });

  assert.equal((await service.update(created.id, { firmwareVersion: null })).firmwareVersion, null);
});
