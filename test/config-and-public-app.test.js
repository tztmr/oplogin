const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const { loadConfig } = require('../lib/config');
const { createApp } = require('../app');

const minimalEnv = {
  DATABASE_URL: 'postgres://user:pass@localhost:5432/op_proxy',
  SESSION_SECRET: 's'.repeat(32),
  GOOGLE_PASSWORD_ENCRYPTION_KEY:
    '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
  INITIAL_SUPER_ADMIN_LOGIN: 'root',
  INITIAL_SUPER_ADMIN_EMAIL: 'root@example.com',
  INITIAL_SUPER_ADMIN_PASSWORD: 'change-me-now',
};

test('loadConfig reads required env values and keeps the default port', () => {
  const config = loadConfig(minimalEnv);

  assert.equal(config.port, 4399);
  assert.equal(config.databaseUrl, minimalEnv.DATABASE_URL);
  assert.equal(config.initialSuperAdminLogin, 'root');
  assert.equal(config.sessionCookieSecure, false);
});

test('createApp redirects the root path to /admin', async () => {
  const app = createApp({
    buildWakeUrlImpl: () => 'tencent1105602870://qzapp/mqzone/0?pasteboard=test',
  });

  const response = await request(app).get('/');

  assert.equal(response.status, 302);
  assert.equal(response.headers.location, '/admin');
});

test('createApp serves the public OP homepage from /oplogin', async () => {
  const app = createApp({
    buildWakeUrlImpl: () => 'tencent1105602870://qzapp/mqzone/0?pasteboard=test',
  });

  const response = await request(app).get('/oplogin');

  assert.equal(response.status, 200);
  assert.match(response.text, /OP极速登录器/);
});

test('createApp keeps the submit API validation behavior', async () => {
  const app = createApp({
    buildWakeUrlImpl: () => 'tencent1105602870://qzapp/mqzone/0?pasteboard=test',
  });

  const response = await request(app).post('/api/submit').send({});

  assert.equal(response.status, 400);
  assert.match(response.body.error, /Missing required parameters/);
});

test('createApp exposes a lightweight health endpoint', async () => {
  const app = createApp({
    buildWakeUrlImpl: () => 'tencent1105602870://qzapp/mqzone/0?pasteboard=test',
  });

  const response = await request(app).get('/health');

  assert.equal(response.status, 200);
  assert.deepEqual(response.body, { status: 'ok' });
});
