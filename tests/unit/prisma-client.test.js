import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const testOnlyDatabaseUrl =
  'postgresql://test:test@ep-test-pooler.us-east-2.aws.neon.tech/neondb';

test('imports the generated TypeScript client and initializes one Prisma Client instance', () => {
  const script = `
    import assert from 'node:assert/strict';
    import { PrismaClient } from './src/generated/prisma/client.ts';
    import { prisma } from './src/db/prisma.js';

    assert.equal(typeof PrismaClient, 'function');
    assert.equal(typeof prisma, 'object');
    assert.equal(typeof prisma.$connect, 'function');
    assert.equal(typeof prisma.$disconnect, 'function');
    await prisma.$disconnect();
    console.log('Prisma Client initialized');
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: {
      ...process.env,
      DATABASE_URL: testOnlyDatabaseUrl
    }
  });

  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /Prisma Client initialized/);
  const childOutput = `${result.stdout}${result.stderr}`;
  assert.equal(childOutput.includes(testOnlyDatabaseUrl), false);
  assert.equal(childOutput.includes('test:test'), false);
});

test('requires DATABASE_URL before initializing Prisma Client', () => {
  const script = `
    try {
      await import('./src/db/prisma.js');
      process.exitCode = 1;
    } catch (error) {
      console.log(error.message);
    }
  `;
  const childEnv = { ...process.env };
  delete childEnv.DATABASE_URL;

  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: childEnv
  });

  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /DATABASE_URL/);

  const childOutput = `${result.stdout}${result.stderr}`;
  assert.doesNotMatch(childOutput, /postgres(?:ql)?:\/\//i);
  assert.equal(childOutput.includes('test:test'), false);
});
