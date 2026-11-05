import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, test } from 'node:test';
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

async function createStore(name) {
  const store = await storeService.create({
    name,
    externalId: uniqueValue(name, context.runId)
  });
  context.track(context.ids.storeIds, store.id);
  return store;
}

async function createSector(input) {
  const sector = await sectorService.create(input);
  context.track(context.ids.sectorIds, sector.id);
  return sector;
}

after(async () => {
  try {
    await context.cleanup();
  } finally {
    await disconnectIntegrationDatabase();
  }
});

test('Sector real: cria setor e subsetor, lista e atualiza', async () => {
  const store = await createStore('Loja setores');
  const root = await createSector({ storeId: store.id, name: 'Térreo' });
  const child = await createSector({
    storeId: store.id,
    name: 'Iluminação',
    parentId: root.id
  });

  assert.equal(child.parentId, root.id);
  assert.equal((await sectorService.findById(child.id)).id, child.id);
  assert.ok((await sectorService.listByStore(store.id)).some(({ id }) => id === child.id));
  const updated = await sectorService.update(child.id, {
    description: 'Circuito principal'
  });
  assert.equal(updated.description, 'Circuito principal');
});

test('Sector real: rejeita loja ausente e pai de outra loja', async () => {
  const store = await createStore('Loja filha');
  const otherStore = await createStore('Loja do pai');
  const parent = await createSector({ storeId: otherStore.id, name: 'Pai externo' });

  await assert.rejects(
    sectorService.create({ storeId: randomUUID(), name: 'Sem loja' }),
    { code: 'STORE_NOT_FOUND', statusCode: 404 }
  );
  await assert.rejects(
    sectorService.create({
      storeId: store.id,
      name: 'Filho inválido',
      parentId: parent.id
    }),
    { code: 'PARENT_SECTOR_STORE_MISMATCH', statusCode: 409 }
  );
});

test('Sector real: impede ciclos na hierarquia', async () => {
  const store = await createStore('Loja ciclo');
  const parent = await createSector({ storeId: store.id, name: 'Raiz' });
  const child = await createSector({ storeId: store.id, name: 'Filho', parentId: parent.id });

  await assert.rejects(sectorService.update(parent.id, { parentId: child.id }), {
    code: 'SECTOR_HIERARCHY_CYCLE',
    statusCode: 409
  });
});

test('PostgreSQL: impõe FKs e unicidade composta de setor', async () => {
  const store = await createStore('Loja constraints');
  const externalId = uniqueValue('sector', context.runId);
  const sector = await createSector({ storeId: store.id, name: 'Setor único', externalId });

  await assert.rejects(
    prisma.sector.create({ data: { storeId: randomUUID(), name: 'FK store' } }),
    (error) => assertPrismaCode(error, 'P2003')
  );
  await assert.rejects(
    prisma.sector.create({
      data: { storeId: store.id, name: 'FK parent', parentId: randomUUID() }
    }),
    (error) => assertPrismaCode(error, 'P2003')
  );
  await assert.rejects(
    prisma.sector.create({ data: { storeId: store.id, name: 'Setor duplicado', externalId } }),
    (error) => assertPrismaCode(error, 'P2002')
  );

  assert.equal((await sectorService.findById(sector.id)).id, sector.id);
});

test('PostgreSQL: ON DELETE RESTRICT impede remover loja com setores e pai com filhos', async () => {
  const store = await createStore('Loja restrita');
  const parent = await createSector({ storeId: store.id, name: 'Pai restrito' });
  await createSector({ storeId: store.id, name: 'Filho restrito', parentId: parent.id });

  await assert.rejects(
    prisma.sector.delete({ where: { id: parent.id } }),
    (error) => assertPrismaCode(error, 'P2003')
  );
  await assert.rejects(
    prisma.store.delete({ where: { id: store.id } }),
    (error) => assertPrismaCode(error, 'P2003')
  );
});
