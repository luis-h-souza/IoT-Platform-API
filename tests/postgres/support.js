import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

if (process.env.NODE_ENV !== 'test') {
  throw new Error('Os testes PostgreSQL exigem NODE_ENV=test.');
}

const { env } = await import('../../src/config/env.js');
const testDatabaseUrl = new URL(env.TEST_DATABASE_URL);
const validTestTarget =
  ['localhost', '127.0.0.1'].includes(testDatabaseUrl.hostname) &&
  testDatabaseUrl.port === '54329' &&
  testDatabaseUrl.pathname === '/iot_platform_test' &&
  testDatabaseUrl.searchParams.get('schema') === 'public';

if (!validTestTarget) {
  throw new Error(
    'TEST_DATABASE_URL deve apontar para localhost:54329/iot_platform_test?schema=public.'
  );
}

// Prisma Client só é importado depois da validação do ambiente e do destino.
const { prisma } = await import('../../src/db/prisma.js');

export { prisma };

export function createIntegrationContext() {
  const storeIds = [];
  const sectorIds = [];
  const deviceIds = [];
  const eventIds = [];
  const commandIds = [];

  return {
    runId: randomUUID(),
    ids: { storeIds, sectorIds, deviceIds, eventIds, commandIds },
    track(collection, id) {
      collection.push(id);
      return id;
    },
    async cleanup() {
      const failures = [];
      const cleanupSteps = [
        () => prisma.deviceEvent.deleteMany({ where: { id: { in: eventIds } } }),
        () => prisma.deviceCommand.deleteMany({ where: { id: { in: commandIds } } }),
        () => prisma.device.deleteMany({ where: { id: { in: deviceIds } } }),
        ...[...sectorIds].reverse().map((id) => () =>
          prisma.sector.deleteMany({ where: { id } })
        ),
        () => prisma.store.deleteMany({ where: { id: { in: storeIds } } })
      ];

      for (const cleanupStep of cleanupSteps) {
        try {
          await cleanupStep();
        } catch (error) {
          failures.push(error);
        }
      }

      if (failures.length > 0) {
        throw new AggregateError(failures, 'Falha ao limpar fixtures PostgreSQL.');
      }
    }
  };
}

export async function disconnectIntegrationDatabase() {
  await prisma.$disconnect();
}

export function assertPrismaCode(error, code) {
  assert.equal(error?.code, code);
  return true;
}

export function uniqueValue(prefix, runId) {
  return `${prefix}-${runId}`;
}
