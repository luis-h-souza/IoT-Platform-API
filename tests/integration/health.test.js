import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import app from '../../src/app.js';

test('GET /health returns the service health payload', async () => {
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');

  try {
    const { port } = server.address();
    const response = await fetch(`http://127.0.0.1:${port}/health`);
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.status, 'ok');
    assert.equal(body.service, 'iot-platform-api');

    assert.equal(typeof body.timestamp, 'string');
    assert.ok(Number.isFinite(Date.parse(body.timestamp)));
    assert.equal(new Date(body.timestamp).toISOString(), body.timestamp);

    assert.equal(typeof body.uptime, 'number');
    assert.ok(Number.isFinite(body.uptime));
    assert.ok(body.uptime >= 0);
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
});
