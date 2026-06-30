const test = require('node:test');
const assert = require('node:assert/strict');

const { createAdminTestContext } = require('./helpers/create-admin-test-context');

async function login(agent, identifier, password) {
  return agent.post('/api/admin/auth/login').send({ identifier, password });
}

test('super admin can create and update an operator account', async () => {
  const { agent, config } = await createAdminTestContext();
  await login(agent, config.initialSuperAdminLogin, config.initialSuperAdminPassword);

  const createResponse = await agent.post('/api/admin/users').send({
    login: 'operator01',
    email: 'operator01@example.com',
    password: 'operator-pass',
    role: 'operator',
  });

  const createdUser = createResponse.body.user;
  const updateResponse = await agent.put(`/api/admin/users/${createdUser.id}`).send({
    login: 'operator01',
    email: 'operator01@example.com',
    role: 'operator',
    status: 'disabled',
  });
  const resetResponse = await agent.put(`/api/admin/users/${createdUser.id}/password`).send({
    password: 'operator-pass-2',
  });
  await agent.post('/api/admin/auth/logout');
  const reloginResponse = await login(agent, 'operator01', 'operator-pass-2');

  assert.equal(createResponse.status, 201);
  assert.equal(createdUser.role, 'operator');
  assert.equal(updateResponse.body.user.status, 'disabled');
  assert.equal(resetResponse.status, 204);
  assert.equal(reloginResponse.status, 401);
});

test('operator cannot access super-admin-only user routes', async () => {
  const { agent, config } = await createAdminTestContext();

  await login(agent, config.initialSuperAdminLogin, config.initialSuperAdminPassword);
  await agent.post('/api/admin/users').send({
    login: 'operator02',
    email: 'operator02@example.com',
    password: 'operator-pass',
    role: 'operator',
  });
  await agent.post('/api/admin/auth/logout');
  await login(agent, 'operator02', 'operator-pass');

  const response = await agent.get('/api/admin/users');

  assert.equal(response.status, 403);
});

test('super admin can reset an active operator password and the new password works', async () => {
  const { agent, config } = await createAdminTestContext();
  await login(agent, config.initialSuperAdminLogin, config.initialSuperAdminPassword);

  const createResponse = await agent.post('/api/admin/users').send({
    login: 'operator03',
    email: 'operator03@example.com',
    password: 'old-password',
    role: 'operator',
  });

  const targetUserId = createResponse.body.user.id;
  const resetResponse = await agent.put(`/api/admin/users/${targetUserId}/password`).send({
    password: 'new-password',
  });

  await agent.post('/api/admin/auth/logout');
  const reloginResponse = await login(agent, 'operator03', 'new-password');

  assert.equal(resetResponse.status, 204);
  assert.equal(reloginResponse.status, 200);
});

test('super admin can save wifi qr config for an operator', async () => {
  const { agent, config } = await createAdminTestContext();
  await login(agent, config.initialSuperAdminLogin, config.initialSuperAdminPassword);

  const createResponse = await agent.post('/api/admin/users').send({
    login: 'operator04',
    email: 'operator04@example.com',
    password: 'operator-pass',
    role: 'operator',
  });

  const targetUserId = createResponse.body.user.id;
  const updateResponse = await agent.put(`/api/admin/users/${targetUserId}/qrcode-config`).send({
    wifiType: 'WPA',
    wifiSsid: '888800000',
    wifiPassword: 'qq123456',
    wifiHidden: false,
  });
  const listResponse = await agent.get('/api/admin/users');

  assert.equal(updateResponse.status, 200);
  assert.deepEqual(updateResponse.body.user.wifiQrConfig, {
    type: 'WPA',
    ssid: '888800000',
    password: 'qq123456',
    hidden: false,
  });
  assert.deepEqual(
    listResponse.body.users.find((item) => item.id === targetUserId).wifiQrConfig,
    {
      type: 'WPA',
      ssid: '888800000',
      password: 'qq123456',
      hidden: false,
    },
  );
});
