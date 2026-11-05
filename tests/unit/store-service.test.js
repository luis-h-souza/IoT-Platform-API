import assert from 'node:assert/strict';
import test from 'node:test';
import { ServiceError } from '../../src/shared/errors/service-error.js';
import { createStoreService } from '../../src/modules/stores/store.service.js';

const storeId = '11111111-1111-4111-8111-111111111111';

function makeStorePrisma() {
  const rows = new Map();
  const calls = { operations: [] };
  const record = (method, args) => calls.operations.push({ method, args });

  const prisma = {
    calls,
    store: {
      async create(args) {
        record('create', args);
        const { data } = args;
        const store = { id: storeId, ...data };
        rows.set(storeId, store);
        return store;
      },
      async findMany(args) {
        record('findMany', args);
        return [...rows.values()];
      },
      async findUnique(args) {
        record('findUnique', args);
        const { where } = args;
        return rows.get(where.id) ?? null;
      },
      async update(args) {
        record('update', args);
        const { where, data } = args;
        const store = rows.get(where.id);
        if (!store) {
          throw Object.assign(new Error('Record not found'), { code: 'P2025' });
        }
        Object.assign(store, data);
        return store;
      }
    }
  };

  return prisma;
}

test('creates, lists, reads, and updates a store', async () => {
  const prisma = makeStorePrisma();
  const service = createStoreService(prisma);

  const created = await service.create({ name: '  Loja Central  ', externalId: 'store-01' });
  assert.equal(created.name, 'Loja Central');
  assert.equal(created.externalId, 'store-01');
  assert.deepEqual(await service.list(), [created]);
  assert.deepEqual(
    prisma.calls.operations.find(({ method }) => method === 'findMany').args,
    { orderBy: [{ name: 'asc' }, { id: 'asc' }] }
  );
  assert.equal((await service.findById(storeId)).id, storeId);
  assert.equal((await service.update(storeId, { name: '  Matriz  ' })).name, 'Matriz');
});

test('rejects invalid store data', async () => {
  const service = createStoreService(makeStorePrisma());

  await assert.rejects(service.create({ name: '   ' }), { name: 'ZodError' });
  await assert.rejects(service.update(storeId, {}), { name: 'ZodError' });
  await assert.rejects(service.update(storeId, { id: storeId }), { name: 'ZodError' });
});

test('allows explicitly nullable external IDs', async () => {
  const service = createStoreService(makeStorePrisma());

  assert.equal((await service.create({ name: 'Loja', externalId: null })).externalId, null);
  assert.equal((await service.update(storeId, { externalId: null })).externalId, null);
});

test('reports a duplicate external store identifier as a conflict', async () => {
  const prisma = makeStorePrisma();
  prisma.store.create = async () => {
    throw Object.assign(new Error('unique violation'), { code: 'P2002' });
  };

  await assert.rejects(createStoreService(prisma).create({ name: 'Loja', externalId: 'store-01' }), {
    name: 'ServiceError',
    code: 'STORE_EXTERNAL_ID_CONFLICT',
    statusCode: 409
  });
});

test('reports a missing store during update', async () => {
  const prisma = makeStorePrisma();

  await assert.rejects(createStoreService(prisma).update(storeId, { name: 'Matriz' }), {
    name: 'ServiceError',
    code: 'STORE_NOT_FOUND',
    statusCode: 404
  });
  assert.deepEqual(prisma.calls.operations, [
    { method: 'update', args: { where: { id: storeId }, data: { name: 'Matriz' } } }
  ]);
});

test('rejects an invalid store ID before querying Prisma', async () => {
  const prisma = makeStorePrisma();

  await assert.rejects(createStoreService(prisma).update('not-a-uuid', { name: 'Matriz' }), {
    name: 'ZodError'
  });
  assert.deepEqual(prisma.calls.operations, []);
});

test('maps Prisma P2002 during store update to an external ID conflict', async () => {
  const prisma = makeStorePrisma();
  prisma.store.update = async (args) => {
    prisma.calls.operations.push({ method: 'update', args });
    throw Object.assign(new Error('unique violation'), { code: 'P2002' });
  };

  await assert.rejects(createStoreService(prisma).update(storeId, { externalId: 'store-01' }), {
    name: 'ServiceError',
    code: 'STORE_EXTERNAL_ID_CONFLICT',
    statusCode: 409
  });
  assert.deepEqual(prisma.calls.operations, [
    { method: 'update', args: { where: { id: storeId }, data: { externalId: 'store-01' } } }
  ]);
});

test('reports an unknown store', async () => {
  await assert.rejects(
    createStoreService(makeStorePrisma()).findById('22222222-2222-4222-8222-222222222222'),
    (error) => {
      assert.ok(error instanceof ServiceError);
      assert.equal(error.code, 'STORE_NOT_FOUND');
      assert.equal(error.statusCode, 404);
      return true;
    }
  );
});
