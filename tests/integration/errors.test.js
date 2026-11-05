import assert from 'node:assert/strict';
import { once } from 'node:events';
import express from 'express';
import test from 'node:test';
import app from '../../src/app.js';
import { errorHandler } from '../../src/middlewares/error-handler.js';

async function withServer(testApp, run) {
  const server = testApp.listen(0, '127.0.0.1');
  await once(server, 'listening');

  try {
    const { port } = server.address();
    await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

test('returns a standard 404 response for an unknown route', async () => {
  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/route-that-does-not-exist`);
    const body = await response.json();

    assert.equal(response.status, 404);
    assert.deepEqual(body, {
      error: {
        code: 'NOT_FOUND',
        message: 'Rota não encontrada'
      }
    });
  });
});

test('returns 400 for malformed JSON', async () => {
  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/health`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"status":'
    });
    const body = await response.json();

    assert.equal(response.status, 400);
    assert.deepEqual(body, {
      error: {
        code: 'INVALID_JSON',
        message: 'JSON malformado'
      }
    });
  });
});

test('returns a generic 500 response without exposing unexpected error details', async () => {
  const isolatedApp = express();
  isolatedApp.get('/trigger-error', () => {
    throw new Error('internal secret detail');
  });
  isolatedApp.use(errorHandler);

  await withServer(isolatedApp, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/trigger-error`);
    const body = await response.json();

    assert.equal(response.status, 500);
    assert.deepEqual(body, {
      error: {
        code: 'INTERNAL_SERVER_ERROR',
        message: 'Erro interno do servidor'
      }
    });
    assert.equal(JSON.stringify(body).includes('internal secret detail'), false);
    assert.equal(JSON.stringify(body).includes('stack'), false);
  });
});
