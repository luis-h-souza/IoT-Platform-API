import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, test } from 'node:test';
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

after(async () => {
  try {
    await context.cleanup();
  } finally {
    await disconnectIntegrationDatabase();
  }
});

test('Store real: cria, busca, lista e atualiza lojas', async () => {
  const store = await storeService.create({
    name: 'Loja de integração',
    externalId: uniqueValue('store', context.runId)
  });
  context.track(context.ids.storeIds, store.id);

  assert.equal((await storeService.findById(store.id)).id, store.id);
  assert.ok((await storeService.list()).some(({ id }) => id === store.id));

  const updated = await storeService.update(store.id, { name: 'Loja atualizada' });
  assert.equal(updated.name, 'Loja atualizada');
});

test('Store real: rejeita identificadores inexistentes', async () => {
  const missingId = randomUUID();

  await assert.rejects(storeService.findById(missingId), {
    code: 'STORE_NOT_FOUND',
    statusCode: 404
  });
  await assert.rejects(storeService.update(missingId, { name: 'Não existe' }), {
    code: 'STORE_NOT_FOUND',
    statusCode: 404
  });
});

test('PostgreSQL: impõe unicidade de Store.externalId', async () => {
  const externalId = uniqueValue('unique-store', context.runId);
  const store = await storeService.create({ name: 'Loja única', externalId });
  context.track(context.ids.storeIds, store.id);

  await assert.rejects(
    prisma.store.create({ data: { name: 'Loja duplicada', externalId } }),
    (error) => assertPrismaCode(error, 'P2002')
  );
});
