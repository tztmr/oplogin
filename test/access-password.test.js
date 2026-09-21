const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const session = require('express-session');
const request = require('supertest');

const { createApp } = require('../app');
const { loadConfig } = require('../lib/config');
const { createSessionMiddleware } = require('../lib/session');
const { createAdminTestContext } = require('./helpers/create-admin-test-context');

const DEFAULT_PASSWORD = 'qq123456';

function createAccessContext({ password = DEFAULT_PASSWORD, store = new session.MemoryStore(), pool } = {}) {
  const config = {
    accessPassword: password,
    sessionSecret: 'access-test-session-secret-with-at-least-32-characters',
    sessionCookieSecure: false,
  };
  const sessionMiddleware = createSessionMiddleware({ config, store });
  const app = createApp({
    config,
    pool,
    sessionMiddleware,
    buildWakeUrlImpl: () => 'tencent1105602870://qzapp/mqzone/0?pasteboard=access-test',
  });
  return { app, agent: request.agent(app), store };
}

function sessionCookie(response) {
  const cookie = (response.headers['set-cookie'] || [])
    .find((value) => value.startsWith('op_admin_session='));
  assert.ok(cookie, 'successful access login should issue a session cookie');
  return cookie.split(';')[0];
}

async function requestRawPath(app, pathname) {
  // URL-aware clients normalize encoded dot segments before sending the request.
  const server = http.createServer(app);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  try {
    return await new Promise((resolve, reject) => {
      http.get({ host: '127.0.0.1', port: server.address().port, path: pathname }, (response) => {
        let text = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => { text += chunk; });
        response.on('error', reject);
        response.on('end', () => {
          resolve({ status: response.statusCode, headers: response.headers, text, body: JSON.parse(text) });
        });
      }).on('error', reject);
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function assertAccessRedirect(response, expectedNext) {
  assert.equal(response.status, 302, expectedNext);
  const location = new URL(response.headers.location, 'http://localhost');
  assert.equal(location.pathname, '/access');
  if (expectedNext) assert.equal(location.searchParams.get('next'), expectedNext);
  assert.match(response.headers['cache-control'] || '', /no-store/);
}

function assertAccessRequired(response) {
  assert.equal(response.status, 401);
  assert.equal(response.body.code, 'ACCESS_PASSWORD_REQUIRED');
  assert.match(response.body.error, /[\u4e00-\u9fff]/);
  assert.doesNotMatch(response.text, /qq123456/);
  assert.match(response.headers['cache-control'] || '', /no-store/);
}

test('configuration defaults the access password and permits an explicit override', () => {
  const env = {
    DATABASE_URL: 'postgres://user:pass@localhost:5432/access_test',
    SESSION_SECRET: 's'.repeat(32),
    GOOGLE_PASSWORD_ENCRYPTION_KEY: '0123456789abcdef'.repeat(4),
    INITIAL_SUPER_ADMIN_LOGIN: 'root',
    INITIAL_SUPER_ADMIN_EMAIL: 'root@example.test',
    INITIAL_SUPER_ADMIN_PASSWORD: 'test-admin-password',
  };
  assert.equal(loadConfig(env).accessPassword, DEFAULT_PASSWORD);
  assert.equal(loadConfig({ ...env, ACCESS_PASSWORD: 'changed-access-password' }).accessPassword, 'changed-access-password');
});

test('access form is public and does not expose the configured password', async () => {
  const { app } = createAccessContext();
  const response = await request(app).get('/access?next=%2Fadmin');
  assert.equal(response.status, 200);
  assert.match(response.text, /type=["']password["']/);
  assert.match(response.text, /<form\b/);
  assert.doesNotMatch(response.text, /qq123456/);
  assert.match(response.headers['cache-control'] || '', /no-store/);
});

test('admin pages and direct or encoded protected HTML require the access password', async () => {
  const { app } = createAccessContext();
  for (const path of [
    '/admin',
    '/admin/login',
    '/admin/users',
    '/admin/index.html',
    '/admin/login.html',
    '/admin/users.html',
    '/%61dmin/index.html',
    '/ADMIN',
    '/user-page.html',
    '/user%2dpage.html',
  ]) {
    assertAccessRedirect(await request(app).get(path), path);
  }
});

test('protected APIs reject direct reads and writes including case-insensitive routes', async () => {
  const { app } = createAccessContext();
  for (const path of [
    '/api/admin/auth/me',
    '/api/admin/records',
    '/api/admin/records/export.csv',
    '/api/public/user/root/batch',
    '/api/public/user/root/record',
    '/API/public/user/root/batch',
  ]) {
    assertAccessRequired(await request(app).get(path));
  }
  for (const path of [
    '/api/admin/auth/login',
    '/api/admin/records/import-text',
    '/api/public/user/root/batch/advance',
    '/api/public/user/root/batch/slots/1/uid',
    '/api/public/user/root/batch/slots/1/phone/extract',
  ]) {
    assertAccessRequired(await request(app).post(path).send({}));
  }
});

test('invalid access passwords are rejected without creating a usable session', async () => {
  const { agent } = createAccessContext();
  for (const payload of [{}, { password: null }, { password: 123456 }, { password: ['qq123456'] }]) {
    const response = await agent.post('/api/access/login').send(payload);
    assert.equal(response.status, 400);
    assert.doesNotMatch(response.text, /qq123456/);
  }
  const wrong = await agent.post('/api/access/login').send({ password: 'wrong-password' });
  assert.equal(wrong.status, 401);
  assert.doesNotMatch(wrong.text, /qq123456/);
  assertAccessRedirect(await agent.get('/admin'), '/admin');
});

test('encoded dot segments cannot remove the access guard from user API paths', async () => {
  const { app } = createAccessContext({ pool: { query: async () => ({ rows: [] }) } });
  for (const path of ['/api/public/user/%2e%2e/batch', '/api/public/user/%2e%2e/record']) {
    assertAccessRequired(await requestRawPath(app, path));
  }
});

test('successful access login retains a local destination and enables both protected HTML entries', async () => {
  const { agent } = createAccessContext();
  const response = await agent.post('/api/access/login').send({
    password: DEFAULT_PASSWORD,
    next: '/root?tab=batch',
  });
  assert.equal(response.status, 200);
  assert.equal(response.body.next, '/root?tab=batch');
  const cookie = response.headers['set-cookie'].join(';');
  assert.match(cookie, /HttpOnly/i);
  assert.match(cookie, /SameSite=Lax/i);
  assert.doesNotMatch(cookie, /qq123456/);
  for (const path of ['/admin', '/admin/index.html', '/user-page.html']) {
    const page = await agent.get(path);
    assert.equal(page.status, 200, path);
    assert.match(page.headers['cache-control'] || '', /no-store/);
  }
});

test('access login cannot redirect to an external origin', async () => {
  const { agent } = createAccessContext();
  for (const next of [
    'https://example.test/collect',
    '//example.test/collect',
    '/\\example.test/collect',
    'javascript:alert(1)',
    '/foo/..//example.test/collect',
    '/%2e%2e//example.test/collect',
  ]) {
    const response = await agent.post('/api/access/login').send({ password: DEFAULT_PASSWORD, next });
    assert.equal(response.status, 200);
    assert.equal(response.body.next, '/admin', next);
  }
});

test('access login regenerates sessions and invalidates the previous session cookie', async () => {
  const { app, agent } = createAccessContext();
  const first = await agent.post('/api/access/login').send({ password: DEFAULT_PASSWORD });
  assert.equal(first.status, 200);
  const firstCookie = sessionCookie(first);
  const second = await agent.post('/api/access/login').send({ password: DEFAULT_PASSWORD });
  assert.equal(second.status, 200);
  assert.notEqual(sessionCookie(second), firstCookie);
  assertAccessRedirect(await request(app).get('/admin').set('Cookie', firstCookie), '/admin');
  assert.equal((await agent.get('/admin')).status, 200);
});

test('a password configuration change invalidates existing access sessions', async () => {
  const firstContext = createAccessContext();
  const login = await firstContext.agent.post('/api/access/login').send({ password: DEFAULT_PASSWORD });
  assert.equal(login.status, 200);
  const cookie = sessionCookie(login);
  const secondContext = createAccessContext({ password: 'new-access-password', store: firstContext.store });
  assertAccessRedirect(await request(secondContext.app).get('/admin').set('Cookie', cookie), '/admin');
  assert.equal((await secondContext.agent.post('/api/access/login').send({ password: DEFAULT_PASSWORD })).status, 401);
  assert.equal((await secondContext.agent.post('/api/access/login').send({ password: 'new-access-password' })).status, 200);
  assert.equal((await secondContext.agent.get('/admin')).status, 200);
});

test('access login limits one IP after ten attempts without blocking another IP', async () => {
  const { app } = createAccessContext();
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const response = await request(app).post('/api/access/login')
      .set('X-Forwarded-For', '203.0.113.61')
      .send({ password: 'wrong-password' });
    assert.equal(response.status, 401, `attempt ${attempt + 1}`);
  }
  const blocked = await request(app).post('/api/access/login')
    .set('X-Forwarded-For', '203.0.113.61')
    .send({ password: DEFAULT_PASSWORD });
  assert.equal(blocked.status, 429);
  const otherIp = await request(app).post('/api/access/login')
    .set('X-Forwarded-For', '203.0.113.62')
    .send({ password: DEFAULT_PASSWORD });
  assert.equal(otherIp.status, 200);
});

test('health checks, OP pages and OP submission remain public', async () => {
  const { app } = createAccessContext({ pool: { query: async () => ({ rows: [] }) } });
  const health = await request(app).get('/health');
  assert.equal(health.status, 200);
  assert.deepEqual(health.body, { status: 'ok' });
  for (const path of ['/op', '/op/12345678', '/oplogin', '/oplogin/example', '/op.js', '/op-input.js', '/op-wake-url-cache.js']) {
    assert.equal((await request(app).get(path)).status, 200, path);
  }
  const submit = await request(app).post('/api/submit').send({ url: 'test-op', game: '1105602870' });
  assert.equal(submit.status, 200);
  assert.equal(submit.body.status, 'success');
  const invalidShortCode = await request(app).post('/api/op/submit').send({ code: 'bad-code' });
  assert.equal(invalidShortCode.status, 400);
  assert.match(invalidShortCode.body.error, /8 位/);
});

test('active user center paths require access authorization including existing subpaths', async () => {
  const { app } = await createAdminTestContext();
  for (const path of ['/root', '/root/subpath']) {
    assertAccessRedirect(await request(app).get(path), path);
  }
  const agent = request.agent(app);
  assert.equal((await agent.post('/api/access/login').send({ password: DEFAULT_PASSWORD })).status, 200);
  for (const path of ['/root', '/root/subpath']) {
    const page = await agent.get(path);
    assert.equal(page.status, 200, path);
    assert.match(page.text, /<title>用户专属数据中心<\/title>/);
  }
  assert.equal((await agent.get('/api/public/user/root/batch')).status, 200);
});

test('access authorization preserves admin account login and logout clears both authorizations', async () => {
  const { app, config } = await createAdminTestContext();
  const agent = request.agent(app);
  const accessLogin = await agent.post('/api/access/login').send({ password: DEFAULT_PASSWORD });
  assert.equal(accessLogin.status, 200);
  const withoutAdmin = await agent.get('/api/admin/auth/me');
  assert.equal(withoutAdmin.status, 401);
  assert.notEqual(withoutAdmin.body.code, 'ACCESS_PASSWORD_REQUIRED');
  assert.equal((await agent.get('/api/admin/records')).status, 401);
  const adminLogin = await agent.post('/api/admin/auth/login').send({
    identifier: config.initialSuperAdminLogin,
    password: config.initialSuperAdminPassword,
  });
  assert.equal(adminLogin.status, 200);
  assert.equal((await agent.get('/api/admin/auth/me')).status, 200);
  assert.equal((await agent.post('/api/access/logout')).status, 204);
  assertAccessRequired(await agent.get('/api/admin/auth/me'));
  assertAccessRequired(await agent.get('/api/public/user/root/batch'));
  assertAccessRedirect(await agent.get('/admin'), '/admin');
  assert.equal((await agent.post('/api/access/login').send({ password: DEFAULT_PASSWORD })).status, 200);
  const afterNewAccessLogin = await agent.get('/api/admin/auth/me');
  assert.equal(afterNewAccessLogin.status, 401);
  assert.notEqual(afterNewAccessLogin.body.code, 'ACCESS_PASSWORD_REQUIRED');
});
