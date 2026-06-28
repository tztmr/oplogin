const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const { createAdminTestContext } = require('./helpers/create-admin-test-context');
const {
  extractInitialOpValueFromLocation,
  GAME_OPTIONS,
} = require('../lib/public-op-page');

async function login(agent, identifier, password) {
  return agent.post('/api/admin/auth/login').send({ identifier, password });
}

test('extractInitialOpValueFromLocation ignores bare /oplogin and keeps token routes', () => {
  assert.equal(
    extractInitialOpValueFromLocation({
      pathname: '/oplogin',
      search: '',
      hash: '',
    }),
    '',
  );

  assert.equal(
    extractInitialOpValueFromLocation({
      pathname: '/oplogin/AAA%7CBBB%7CCCC',
      search: '',
      hash: '',
    }),
    'AAA|BBB|CCC',
  );

  assert.equal(
    extractInitialOpValueFromLocation({
      pathname: '/',
      search: '?DDD%7CEEE',
      hash: '',
    }),
    'DDD|EEE',
  );
});

test('reserved /oplogin route is not hijacked by a user named oplogin', async () => {
  const { agent, config, app } = await createAdminTestContext();

  await login(agent, config.initialSuperAdminLogin, config.initialSuperAdminPassword);
  await agent.post('/api/admin/users').send({
    login: 'oplogin',
    email: 'oplogin@example.com',
    password: 'operator-pass',
    role: 'operator',
  });

  const response = await request(app).get('/oplogin');

  assert.equal(response.status, 200);
  assert.match(response.text, /OP极速登录器/);
  assert.doesNotMatch(response.text, /专属数据中心/);
});

test('user public page uses the same game options as the main oplogin page', async () => {
  const { agent, config, app } = await createAdminTestContext();

  await login(agent, config.initialSuperAdminLogin, config.initialSuperAdminPassword);
  await agent.post('/api/admin/users').send({
    login: 'lz',
    email: 'lz@example.com',
    password: 'operator-pass',
    role: 'operator',
  });

  const response = await request(app).get('/lz');

  assert.equal(response.status, 200);
  assert.match(response.text, /专属数据中心/);

  for (const option of GAME_OPTIONS) {
    assert.match(
      response.text,
      new RegExp(`<option value="${option.value}"`),
    );
  }
});
