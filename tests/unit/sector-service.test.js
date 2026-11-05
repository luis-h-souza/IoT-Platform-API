import assert from 'node:assert/strict';
import test from 'node:test';
import { createSectorService } from '../../src/modules/sectors/sector.service.js';

const storeId = '11111111-1111-4111-8111-111111111111';
const otherStoreId = '22222222-2222-4222-8222-222222222222';
const sectorId = '33333333-3333-4333-8333-333333333333';
const childSectorId = '44444444-4444-4444-8444-444444444444';

function makeSectorPrisma({ stores = [storeId], sectors = [] } = {}) {
  const storeRows = new Map(stores.map((id) => [id, { id }]));
  const sectorRows = new Map(sectors.map((sector) => [sector.id, { ...sector }]));
  const calls = { operations: [], transactions: [] };
  let activeTransaction;
  const record = (model, method, args) => {
    const operation = { model, method, args };
    calls.operations.push(operation);
    activeTransaction?.operations.push(operation);
  };
  const prisma = {
    calls,
    store: {
      async findUnique(args) {
        record('store', 'findUnique', args);
        const { where } = args;
        return storeRows.get(where.id) ?? null;
      }
    },
    sector: {
      async create(args) {
        record('sector', 'create', args);
        const { data } = args;
        const sector = { id: childSectorId, ...data };
        sectorRows.set(sector.id, sector);
        return sector;
      },
      async findMany(args) {
        record('sector', 'findMany', args);
        const { where } = args;
        return [...sectorRows.values()].filter((sector) => sector.storeId === where.storeId);
      },
      async findUnique(args) {
        record('sector', 'findUnique', args);
        const { where } = args;
        return sectorRows.get(where.id) ?? null;
      },
      async update(args) {
        record('sector', 'update', args);
        const { where, data } = args;
        const sector = sectorRows.get(where.id);
        if (!sector) {
          throw Object.assign(new Error('Record not found'), { code: 'P2025' });
        }
        Object.assign(sector, data);
        return sector;
      }
    },
    async $transaction(callback, options) {
      const transactionCall = { options, operations: [] };
      calls.transactions.push(transactionCall);

      if (prisma.transactionError) {
        const error = prisma.transactionError;
        prisma.transactionError = undefined;
        throw error;
      }

      activeTransaction = transactionCall;
      try {
        return await callback(prisma);
      } finally {
        activeTransaction = undefined;
      }
    }
  };

  return prisma;
}

test('creates, lists, reads, and updates sectors within a store', async () => {
  const prisma = makeSectorPrisma();
  const service = createSectorService(prisma);
  const created = await service.create({ storeId, name: '  Salão  ', description: 'Área principal' });

  assert.equal(created.name, 'Salão');
  assert.equal(created.storeId, storeId);
  assert.equal(prisma.calls.transactions[0].options.isolationLevel, 'Serializable');
  assert.deepEqual(prisma.calls.transactions[0].operations, [
    {
      model: 'store',
      method: 'findUnique',
      args: { where: { id: storeId }, select: { id: true } }
    },
    { model: 'sector', method: 'create', args: { data: { storeId, name: 'Salão', description: 'Área principal' } } }
  ]);
  assert.deepEqual(await service.listByStore(storeId), [created]);
  assert.equal((await service.findById(childSectorId)).id, childSectorId);
  assert.equal((await service.update(childSectorId, { name: 'Salão principal' })).name, 'Salão principal');
});

test('creates a sector with a valid parent inside a serializable transaction', async () => {
  const parent = { id: sectorId, storeId, parentId: null };
  const prisma = makeSectorPrisma({ sectors: [parent] });
  const created = await createSectorService(prisma).create({ storeId, name: 'Filho', parentId: sectorId });

  assert.equal(created.parentId, sectorId);
  assert.deepEqual(prisma.calls.transactions[0].options, { isolationLevel: 'Serializable' });
  assert.deepEqual(prisma.calls.transactions[0].operations, [
    {
      model: 'store',
      method: 'findUnique',
      args: { where: { id: storeId }, select: { id: true } }
    },
    {
      model: 'sector',
      method: 'findUnique',
      args: { where: { id: sectorId }, select: { id: true, storeId: true, parentId: true } }
    },
    {
      model: 'sector',
      method: 'create',
      args: { data: { storeId, name: 'Filho', parentId: sectorId } }
    }
  ]);
});

test('allows nullable fields in a sector patch and detaching its parent', async () => {
  const parent = { id: sectorId, storeId, parentId: null };
  const child = { id: childSectorId, storeId, parentId: sectorId, description: 'Área', externalId: 'sector-01' };
  const prisma = makeSectorPrisma({ sectors: [parent, child] });
  const service = createSectorService(prisma);
  const updated = await service.update(childSectorId, { parentId: null, description: null, externalId: null });

  assert.equal(updated.parentId, null);
  assert.equal(updated.description, null);
  assert.equal(updated.externalId, null);
  assert.deepEqual(prisma.calls.transactions[0], {
    options: { isolationLevel: 'Serializable' },
    operations: [
      {
        model: 'sector',
        method: 'findUnique',
        args: { where: { id: childSectorId }, select: { id: true, storeId: true } }
      },
      {
        model: 'sector',
        method: 'update',
        args: {
          where: { id: childSectorId },
          data: { parentId: null, description: null, externalId: null }
        }
      }
    ]
  });
});

test('rejects a sector whose store does not exist', async () => {
  const service = createSectorService(makeSectorPrisma({ stores: [] }));

  await assert.rejects(service.create({ storeId, name: 'Salão' }), {
    name: 'ServiceError',
    code: 'STORE_NOT_FOUND',
    statusCode: 404
  });
});

test('rejects a nonexistent parent reference without creating the sector', async () => {
  const prisma = makeSectorPrisma();
  const service = createSectorService(prisma);

  await assert.rejects(service.create({ storeId, name: 'Filho', parentId: sectorId }), {
    name: 'ServiceError',
    code: 'PARENT_SECTOR_NOT_FOUND',
    statusCode: 404
  });
  assert.equal(prisma.calls.transactions[0].options.isolationLevel, 'Serializable');
  assert.equal(prisma.calls.transactions[0].operations.some(({ method }) => method === 'create'), false);
});

test('rejects a parent sector from a different store', async () => {
  const parent = { id: sectorId, storeId: otherStoreId, parentId: null };
  const prisma = makeSectorPrisma({ stores: [storeId, otherStoreId], sectors: [parent] });
  const service = createSectorService(prisma);

  await assert.rejects(service.create({ storeId, name: 'Filho', parentId: sectorId }), {
    name: 'ServiceError',
    code: 'PARENT_SECTOR_STORE_MISMATCH',
    statusCode: 409
  });
  assert.equal(prisma.calls.transactions[0].options.isolationLevel, 'Serializable');
  assert.equal(prisma.calls.transactions[0].operations.some(({ method }) => method === 'create'), false);
});

test('rejects updating a sector with a missing parent', async () => {
  const current = { id: childSectorId, storeId, parentId: null };
  const prisma = makeSectorPrisma({ sectors: [current] });

  await assert.rejects(createSectorService(prisma).update(childSectorId, { parentId: sectorId }), {
    name: 'ServiceError',
    code: 'PARENT_SECTOR_NOT_FOUND',
    statusCode: 404
  });
  assert.equal(prisma.calls.transactions[0].operations.some(({ method }) => method === 'update'), false);
});

test('rejects updating a sector to a parent in another store', async () => {
  const current = { id: childSectorId, storeId, parentId: null };
  const parent = { id: sectorId, storeId: otherStoreId, parentId: null };
  const prisma = makeSectorPrisma({ stores: [storeId, otherStoreId], sectors: [current, parent] });

  await assert.rejects(createSectorService(prisma).update(childSectorId, { parentId: sectorId }), {
    name: 'ServiceError',
    code: 'PARENT_SECTOR_STORE_MISMATCH',
    statusCode: 409
  });
  assert.equal(prisma.calls.transactions[0].operations.some(({ method }) => method === 'update'), false);
});

test('prevents a cycle when reparenting and checks the hierarchy transactionally', async () => {
  const root = { id: sectorId, storeId, parentId: null };
  const child = { id: childSectorId, storeId, parentId: sectorId };
  const prisma = makeSectorPrisma({ sectors: [root, child] });
  const service = createSectorService(prisma);

  await assert.rejects(service.update(sectorId, { parentId: childSectorId }), {
    name: 'ServiceError',
    code: 'SECTOR_HIERARCHY_CYCLE',
    statusCode: 409
  });
  assert.equal(prisma.calls.transactions[0].options.isolationLevel, 'Serializable');
  assert.equal(prisma.calls.transactions[0].operations.some(({ method }) => method === 'update'), false);
});

test('maps Prisma P2034 from create and update to a hierarchy conflict', async () => {
  const prisma = makeSectorPrisma();
  prisma.transactionError = Object.assign(new Error('serialization conflict'), { code: 'P2034' });
  const service = createSectorService(prisma);

  const expectedConflict = {
    name: 'ServiceError',
    code: 'SECTOR_HIERARCHY_CONFLICT',
    statusCode: 409
  };

  await assert.rejects(service.create({ storeId, name: 'Salão' }), expectedConflict);
  prisma.transactionError = Object.assign(new Error('serialization conflict'), { code: 'P2034' });
  await assert.rejects(service.update(sectorId, { parentId: null }), expectedConflict);
  assert.equal(prisma.calls.transactions[0].options.isolationLevel, 'Serializable');
  assert.equal(prisma.calls.transactions[1].options.isolationLevel, 'Serializable');
});

test('does not open a transaction when a sector patch leaves parentId unchanged', async () => {
  const current = { id: sectorId, storeId, parentId: null, name: 'Salão' };
  const prisma = makeSectorPrisma({ sectors: [current] });

  await createSectorService(prisma).update(sectorId, { name: 'Salão atualizado' });

  assert.deepEqual(prisma.calls.transactions, []);
  assert.deepEqual(prisma.calls.operations, [
    {
      model: 'sector',
      method: 'update',
      args: { where: { id: sectorId }, data: { name: 'Salão atualizado' } }
    }
  ]);
});

test('rejects invalid sector data', async () => {
  const service = createSectorService(makeSectorPrisma());

  await assert.rejects(service.create({ storeId, name: '   ' }), { name: 'ZodError' });
  await assert.rejects(service.update(sectorId, {}), { name: 'ZodError' });
  await assert.rejects(service.update(sectorId, { storeId }), { name: 'ZodError' });
});
