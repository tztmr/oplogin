const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const session = require('express-session');

const { createApp } = require('../app');
const { loadConfig, DEFAULT_ACCESS_PASSWORD } = require('../lib/config');
const { createSessionMiddleware } = require('../lib/session');
const { createAdminUser } = require('../lib/admin-users');
const { createAdminTestContext } = require('./helpers/create-admin-test-context');

test('configuration defaults the shared password and permits an explicit override', () => {
  const env = {
    DATABASE_URL: 'postgres://user:pass@localhost:5432/access_test',
    SESSION_SECRET: 's'.repeat(32),
    GOOGLE_PASSWORD_ENCRYPTION_KEY: '0123456789abcdef'.repeat(4),
    INITIAL_SUPER_ADMIN_LOGIN: 'root',
    INITIAL_SUPER_ADMIN_EMAIL: 'root@example.com',
    INITIAL_SUPER_ADMIN_PASSWORD: 'change-me-now',
  };

  assert.equal(loadConfig(env).accessPassword, DEFAULT_ACCESS_PASSWORD);
  assert.equal(DEFAULT_ACCESS_PASSWORD, 'qq123456');
  assert.equal(
    loadConfig({ ...env, ACCESS_PASSWORD: 'changed-access-password' }).accessPassword,
    'changed-access-password',
  );
});

test('opening admin and user center does not require entering the shared password', async () => {
  const { agent, pool } = await createAdminTestContext();
  await createAdminUser(pool, {
    login: 'lz',
    email: 'lz@example.com',
    password: 'change-me-now',
    role: 'operator',
  });

  const adminPage = await agent.get('/admin');
  const userPage = await agent.get('/lz');
  const me = await agent.get('/api/admin/auth/me');
  const batch = await agent.get('/api/public/user/lz/batch');

  assert.equal(adminPage.status, 200);
  assert.doesNotMatch(adminPage.headers.location || '', /\/access/);
  assert.match(adminPage.text, /id="recordsAccessPasswordForm"/);
  assert.match(adminPage.text, /id="recordsAccessPassword"/);
  assert.match(adminPage.text, /<label for="recordsAccessPassword">密码<\/label>/);
  assert.equal(userPage.status, 200);
  assert.doesNotMatch(userPage.headers.location || '', /\/access/);
  assert.match(userPage.text, /id="accessPasswordText"/);
  assert.match(userPage.text, /copyText\('accessPasswordText'\)/);
  assert.ok(
    userPage.text.indexOf('id="bindPhoneNumberButton"')
      < userPage.text.indexOf('id="accessPasswordText"'),
  );
  assert.equal(me.status, 401);
  assert.notEqual(me.body.code, 'ACCESS_PASSWORD_REQUIRED');
  assert.equal(batch.status, 200);
  assert.equal(batch.body.accessPassword, DEFAULT_ACCESS_PASSWORD);
});

test('admin session exposes the shared password for the records page', async () => {
  const { agent, config } = await createAdminTestContext({
    ACCESS_PASSWORD: 'shown-on-records',
  });

  await agent.post('/api/admin/auth/login').send({
    identifier: config.initialSuperAdminLogin,
    password: config.initialSuperAdminPassword,
  });
  const me = await agent.get('/api/admin/auth/me');

  assert.equal(me.status, 200);
  assert.equal(me.body.accessPassword, 'shown-on-records');
  assert.equal(me.body.user.login, config.initialSuperAdminLogin);
});

test('user center APIs return the copyable shared password', async () => {
  const { agent, pool } = await createAdminTestContext({
    ACCESS_PASSWORD: 'copy-from-user-center',
  });
  await createAdminUser(pool, {
    login: 'mxw',
    email: 'mxw@example.com',
    password: 'change-me-now',
    role: 'operator',
  });

  const response = await agent.get('/api/public/user/mxw/batch');

  assert.equal(response.status, 200);
  assert.equal(response.body.accessPassword, 'copy-from-user-center');
});

test('data management form can save a new shared password', async () => {
  const { agent, app, pool, config } = await createAdminTestContext({
    ACCESS_PASSWORD: 'qq123456',
  });
  await createAdminUser(pool, {
    login: 'lz',
    email: 'lz@example.com',
    password: 'change-me-now',
    role: 'operator',
  });

  const unauthorized = await request(app)
    .put('/api/admin/auth/access-password')
    .send({ accessPassword: 'should-fail' });
  assert.equal(unauthorized.status, 401);

  await agent.post('/api/admin/auth/login').send({
    identifier: config.initialSuperAdminLogin,
    password: config.initialSuperAdminPassword,
  });

  const empty = await agent.put('/api/admin/auth/access-password').send({ accessPassword: '   ' });
  assert.equal(empty.status, 400);
  assert.equal(empty.body.error, '密码不能为空');

  const saved = await agent.put('/api/admin/auth/access-password').send({
    accessPassword: '  new-shared-pass  ',
  });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.accessPassword, 'new-shared-pass');

  const me = await agent.get('/api/admin/auth/me');
  const batch = await agent.get('/api/public/user/lz/batch');
  assert.equal(me.status, 200);
  assert.equal(me.body.accessPassword, 'new-shared-pass');
  assert.equal(batch.status, 200);
  assert.equal(batch.body.accessPassword, 'new-shared-pass');
});

test('health checks and OP pages remain public', async () => {
  const config = {
    accessPassword: 'unused-on-public-pages',
    sessionSecret: 's'.repeat(32),
    sessionCookieSecure: false,
  };
  const app = createApp({
    config,
    sessionMiddleware: createSessionMiddleware({ config, store: new session.MemoryStore() }),
    buildWakeUrlImpl: () => 'tencent1105602870://qzapp/mqzone/0?pasteboard=access-test',
  });

  const health = await request(app).get('/health');
  const opPage = await request(app).get('/oplogin');

  assert.equal(health.status, 200);
  assert.equal(health.body.status, 'ok');
  assert.equal(opPage.status, 200);
});
