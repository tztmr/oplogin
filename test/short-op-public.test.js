const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const { createApp } = require('../app');
const { createAdminTestContext } = require('./helpers/create-admin-test-context');
const { extractShortCode, isValidShortCode } = require('../public/op');

const futureTimestamp = 2_000_000_000;
const op = (label, timestamp = futureTimestamp) =>
  `openid-${label}|access-${label}|pay-${label}|unused|${timestamp}`;

async function loginAsRoot(agent, config) {
  const response = await agent.post('/api/admin/auth/login').send({
    identifier: config.initialSuperAdminLogin,
    password: config.initialSuperAdminPassword,
  });
  assert.equal(response.status, 200);
}

async function defaultApplication(agent) {
  const response = await agent.get('/api/admin/op-applications?page=1&pageSize=20');
  assert.equal(response.status, 200);
  return response.body.items.find((item) => item.appId === '1105602870');
}

async function createApplication(agent, name, appId) {
  const response = await agent.post('/api/admin/op-applications').send({ name, appId });
  assert.equal(response.status, 201, response.text);
  return response.body.item;
}

async function createShortOp(agent, opValue, applicationId) {
  const response = await agent.post('/api/admin/short-ops').send({
    opValue,
    applicationId,
  });
  assert.equal(response.status, 201, response.text);
  return response.body.item;
}

test('POST /api/op/submit resolves the bound app without exposing OP plaintext', async () => {
  const { agent, config, pool } = await createAdminTestContext();
  await loginAsRoot(agent, config);
  const application = await defaultApplication(agent);
  const openid = 'openid-public-success';
  const opValue = `${openid}|access-success|pay-success|unused|${futureTimestamp}`;
  const item = await createShortOp(agent, opValue, application.id);
  const app = createApp({
    pool,
    buildWakeUrlImpl(value, appId) {
      assert.equal(value, opValue);
      assert.equal(appId, '1105602870');
      return 'tencent1105602870://qzapp/mqzone/0?pasteboard=encoded';
    },
  });

  const response = await request(app).post('/api/op/submit').send({ code: item.code });

  assert.equal(response.status, 200);
  assert.equal(response.body.appName, '抖音');
  assert.match(response.body.url, /^tencent1105602870:\/\//);
  assert.equal('opValue' in response.body, false);
  assert.doesNotMatch(JSON.stringify(response.body), new RegExp(openid));
});

test('POST /api/op/submit rejects malformed short codes', async () => {
  const { pool } = await createAdminTestContext();
  const app = createApp({ pool });

  for (const code of ['', '1234567', '123456789', 'abcd1234']) {
    const response = await request(app).post('/api/op/submit').send({ code });
    assert.equal(response.status, 400);
    assert.deepEqual(response.body, { error: '请输入正确的 8 位短码' });
  }
});

test('inactive, deleted, expired, missing, and app-disabled codes share one public error', async () => {
  const { agent, config, pool } = await createAdminTestContext();
  await loginAsRoot(agent, config);
  const application = await defaultApplication(agent);
  const disabled = await createShortOp(agent, op('disabled'), application.id);
  const deleted = await createShortOp(agent, op('deleted'), application.id);
  const expired = await createShortOp(agent, op('expired', 1_600_000_000), application.id);
  const inactiveApplication = await createApplication(agent, '停用应用', '1104790999');
  const appDisabled = await createShortOp(agent, op('app-disabled'), inactiveApplication.id);
  await agent.post(`/api/admin/short-ops/${disabled.id}/disable`);
  await agent.delete(`/api/admin/short-ops/${deleted.id}`);
  await agent.post(`/api/admin/op-applications/${inactiveApplication.id}/disable`);
  const app = createApp({ pool });
  const publicAgent = request.agent(app);
  const expected = { error: '短 OP 无效或已过期' };

  for (const code of [
    '99999999',
    disabled.code,
    deleted.code,
    expired.code,
    appDisabled.code,
  ]) {
    const response = await publicAgent.post('/api/op/submit').send({ code });
    assert.equal(response.status, 404, code);
    assert.deepEqual(response.body, expected, code);
  }
});

test('OP parsing failures use the uniform public error and never log OP plaintext', async () => {
  const { agent, config, pool } = await createAdminTestContext();
  await loginAsRoot(agent, config);
  const application = await defaultApplication(agent);
  const opValue = op('parse-secret');
  const item = await createShortOp(agent, opValue, application.id);
  const logCalls = [];
  const originalConsoleError = console.error;
  console.error = (...args) => logCalls.push(args);

  try {
    const app = createApp({
      pool,
      buildWakeUrlImpl() {
        throw new Error('parse failed');
      },
    });
    const response = await request(app).post('/api/op/submit').send({ code: item.code });

    assert.equal(response.status, 404);
    assert.deepEqual(response.body, { error: '短 OP 无效或已过期' });
  } finally {
    console.error = originalConsoleError;
  }

  const logged = JSON.stringify(logCalls);
  assert.match(logged, new RegExp(item.code));
  assert.match(logged, new RegExp(item.id));
  assert.doesNotMatch(logged, /openid-parse-secret|access-parse-secret|pay-parse-secret/);
  assert.doesNotMatch(logged, new RegExp(opValue.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('the public submit endpoint applies the injected rate limiter', async () => {
  const { pool } = await createAdminTestContext();
  let calls = 0;
  const app = createApp({
    pool,
    rateLimitMiddleware(req, res) {
      calls += 1;
      return res.status(429).json({ error: '请求过于频繁，请稍后重试' });
    },
  });

  const response = await request(app).post('/api/op/submit').send({ code: '12345678' });

  assert.equal(calls, 1);
  assert.equal(response.status, 429);
  assert.deepEqual(response.body, { error: '请求过于频繁，请稍后重试' });
});

test('GET /op pages work without DB or session while POST is not mounted', async () => {
  const app = createApp();

  const bare = await request(app).get('/op');
  const withCode = await request(app).get('/op/12345678');
  const submit = await request(app).post('/api/op/submit').send({ code: '12345678' });

  assert.equal(bare.status, 200);
  assert.equal(withCode.status, 200);
  assert.match(bare.text, /8 位短码/);
  assert.match(withCode.text, /8 位短码/);
  assert.doesNotMatch(bare.text, /应用选择|OP 全参|openid\|access_token/);
  assert.equal(submit.status, 404);
});

test('an employee named op cannot hijack the public page and /oplogin still works', async () => {
  const { agent, app, config } = await createAdminTestContext();
  await loginAsRoot(agent, config);
  const created = await agent.post('/api/admin/users').send({
    login: 'op',
    email: 'op@example.com',
    password: 'operator-pass',
    role: 'operator',
  });
  assert.equal(created.status, 201, created.text);

  const opPage = await request(app).get('/op');
  const legacyPage = await request(app).get('/oplogin');

  assert.equal(opPage.status, 200);
  assert.match(opPage.text, /8 位短码/);
  assert.doesNotMatch(opPage.text, /专属数据中心/);
  assert.equal(legacyPage.status, 200);
  assert.match(legacyPage.text, /OP极速登录器/);
});

test('public page helpers extract and validate only eight-digit path codes', () => {
  assert.equal(extractShortCode({ pathname: '/op/12345678' }), '12345678');
  assert.equal(extractShortCode({ pathname: '/op' }), '');
  assert.equal(extractShortCode({ pathname: '/op/1234abcd' }), '');
  assert.equal(extractShortCode({ pathname: '/other/12345678' }), '');
  assert.equal(isValidShortCode('12345678'), true);
  assert.equal(isValidShortCode('1234567'), false);
  assert.equal(isValidShortCode('1234abcd'), false);
});
