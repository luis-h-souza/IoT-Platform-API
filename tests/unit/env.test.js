import assert from 'node:assert/strict';
import test from 'node:test';
import { parseEnv } from '../../src/config/env.js';

test('uses defaults when environment variables are not provided', () => {
  assert.deepEqual(parseEnv({}), {
    NODE_ENV: 'development',
    PORT: 3000,
    LOG_LEVEL: 'info'
  });
});

test('accepts valid settings and converts a string PORT to a number', () => {
  assert.deepEqual(
    parseEnv({
      NODE_ENV: 'test',
      PORT: '3000',
      LOG_LEVEL: 'debug'
    }),
    {
      NODE_ENV: 'test',
      PORT: 3000,
      LOG_LEVEL: 'debug'
    }
  );
});

test('accepts PORT when it is already a number', () => {
  assert.equal(parseEnv({ PORT: 3000 }).PORT, 3000);
});

test('accepts pooled and direct Neon PostgreSQL URLs in their respective variables', () => {
  const pooledUrl = 'postgresql://test:test@ep-test-pooler.us-east-2.aws.neon.tech/neondb';
  const directUrl = 'postgresql://test:test@ep-test.us-east-2.aws.neon.tech/neondb';

  assert.deepEqual(parseEnv({ DATABASE_URL: pooledUrl, DIRECT_URL: directUrl }), {
    NODE_ENV: 'development',
    PORT: 3000,
    LOG_LEVEL: 'info',
    DATABASE_URL: pooledUrl,
    DIRECT_URL: directUrl
  });
});

test('rejects invalid database URLs without echoing their contents', () => {
  const invalidUrl = 'not-a-url-containing-a-secret';

  assert.throws(() => parseEnv({ DATABASE_URL: invalidUrl }), (error) => {
    assert.match(error.message, /DATABASE_URL/);
    assert.equal(error.message.includes(invalidUrl), false);
    return true;
  });
});

test('rejects a direct URL that uses the Neon pooler hostname', () => {
  const pooledUrl = 'postgresql://test:test@ep-test-pooler.us-east-2.aws.neon.tech/neondb';

  assert.throws(() => parseEnv({ DIRECT_URL: pooledUrl }), /DIRECT_URL/);
});

test('rejects an empty PORT without silently applying the default', () => {
  assert.throws(() => parseEnv({ PORT: '' }), (error) => {
    assert.match(error.message, /PORT/);
    assert.match(error.message, /não pode estar vazio/);
    return true;
  });
});

test('rejects invalid PORT values without including them in the error', () => {
  for (const value of ['abc-secret-value', '0', '65536', '3000.5']) {
    assert.throws(() => parseEnv({ PORT: value }), (error) => {
      assert.match(error.message, /PORT/);
      assert.equal(error.message.includes(value), false);
      return true;
    });
  }
});

test('rejects an invalid NODE_ENV without including its value in the error', () => {
  const invalidValue = 'private-node-env-value';

  assert.throws(() => parseEnv({ NODE_ENV: invalidValue }), (error) => {
    assert.match(error.message, /NODE_ENV/);
    assert.equal(error.message.includes(invalidValue), false);
    return true;
  });
});

test('rejects an invalid LOG_LEVEL without including its value in the error', () => {
  const invalidValue = 'private-log-level-value';

  assert.throws(() => parseEnv({ LOG_LEVEL: invalidValue }), (error) => {
    assert.match(error.message, /LOG_LEVEL/);
    assert.equal(error.message.includes(invalidValue), false);
    return true;
  });
});

test('rejects non-decimal PORT representations', () => {
  for (const value of ['3e3', '0xBB8', '+3000', '30 00']) {
    assert.throws(() => parseEnv({ PORT: value }));
  }
});
