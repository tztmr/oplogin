const test = require('node:test');
const assert = require('node:assert/strict');

const { createAdminTestContext } = require('./helpers/create-admin-test-context');

async function login(agent, identifier, password) {
  return agent.post('/api/admin/auth/login').send({ identifier, password });
}

async function loginAsRoot(agent, config) {
  return login(agent, config.initialSuperAdminLogin, config.initialSuperAdminPassword);
}

async function createOperator(agent, loginName) {
  return agent.post('/api/admin/users').send({
    login: loginName,
    email: `${loginName}@example.com`,
    password: 'operator-pass',
    role: 'operator',
  });
}

async function createApplication(agent, payload) {
  const response = await agent.post('/api/admin/op-applications').send(payload);
  assert.equal(response.status, 201);
  return response.body.item;
}

test('authenticated operators can list active applications but cannot create them', async () => {
  const { agent, config } = await createAdminTestContext();
  await loginAsRoot(agent, config);
  await createOperator(agent, 'operator-apps');
  await agent.post('/api/admin/auth/logout');
  await login(agent, 'operator-apps', 'operator-pass');

  const listResponse = await agent.get('/api/admin/op-applications?page=1&pageSize=20');
  const createResponse = await agent.post('/api/admin/op-applications').send({
    name: '拼多多', appId: '1104790111',
  });

  assert.equal(listResponse.status, 200);
  assert.equal(listResponse.body.items[0].appId, '1105602870');
  assert.equal(createResponse.status, 403);
});

test('super admin can create applications and search all statuses with pagination', async () => {
  const { agent, config } = await createAdminTestContext();
  await loginAsRoot(agent, config);
  const active = await createApplication(agent, { name: '拼多多', appId: '1104790111' });
  const disabled = await createApplication(agent, { name: '快手', appId: '1104790112' });
  const disableResponse = await agent.post(`/api/admin/op-applications/${disabled.id}/disable`);
  const listResponse = await agent
    .get('/api/admin/op-applications?search=拼&page=1&pageSize=1');

  assert.equal(active.status, 'active');
  assert.equal(disableResponse.status, 200);
  assert.equal(listResponse.status, 200);
  assert.equal(listResponse.body.total, 1);
  assert.equal(listResponse.body.page, 1);
  assert.equal(listResponse.body.pageSize, 1);
  assert.deepEqual(listResponse.body.items.map((item) => item.appId), ['1104790111']);

  const disabledResponse = await agent
    .get('/api/admin/op-applications?status=disabled&page=1&pageSize=20');
  assert.equal(disabledResponse.status, 200);
  assert.deepEqual(disabledResponse.body.items.map((item) => item.appId), ['1104790112']);
});

test('super admin pageSize all returns every active application beyond the normal limit', async () => {
  const { agent, config } = await createAdminTestContext();
  await loginAsRoot(agent, config);
  for (let index = 0; index < 25; index += 1) {
    await createApplication(agent, {
      name: `应用 ${String(index).padStart(2, '0')}`,
      appId: `all-app-${String(index).padStart(2, '0')}`,
    });
  }

  const response = await agent.get(
    '/api/admin/op-applications?status=active&pageSize=all',
  );

  assert.equal(response.status, 200);
  assert.equal(response.body.total, 26);
  assert.equal(response.body.page, 1);
  assert.equal(response.body.pageSize, 'all');
  assert.equal(response.body.items.length, 26);
  assert.equal(response.body.items[0].isDefault, true);
});

test('super admin cannot create duplicate AppIDs', async () => {
  const { agent, config } = await createAdminTestContext();
  await loginAsRoot(agent, config);
  await createApplication(agent, { name: '拼多多', appId: '1104790111' });

  const response = await agent.post('/api/admin/op-applications').send({
    name: '重复应用',
    appId: '1104790111',
  });

  assert.equal(response.status, 409);
  assert.equal(response.body.error, 'AppID 已存在');
});

test('super admin can set a new default application but cannot disable it', async () => {
  const { agent, config } = await createAdminTestContext();
  await loginAsRoot(agent, config);
  const application = await createApplication(agent, { name: '拼多多', appId: '1104790111' });

  const defaultResponse = await agent.post(
    `/api/admin/op-applications/${application.id}/default`,
  );
  const disableResponse = await agent.post(
    `/api/admin/op-applications/${application.id}/disable`,
  );

  assert.equal(defaultResponse.status, 200);
  assert.equal(defaultResponse.body.item.isDefault, true);
  assert.equal(disableResponse.status, 400);
  assert.equal(disableResponse.body.error, '当前默认应用不能停用，请先设置其他默认应用');
});

test('super admin cannot change an AppID already referenced by a short OP record', async () => {
  const { agent, config, pool } = await createAdminTestContext();
  await loginAsRoot(agent, config);
  const application = await createApplication(agent, { name: '拼多多', appId: '1104790111' });
  const ownerResult = await pool.query(`select id from admin_users where login = $1`, ['root']);
  await pool.query(
    `
      insert into short_op_records (
        id, owner_id, code, op_value, application_id, op_expire_at, status
      )
      values ($1, $2, $3, $4, $5, $6, 'active')
    `,
    [
      '00000000-0000-0000-0000-000000000201',
      ownerResult.rows[0].id,
      '12345678',
      'op-value',
      application.id,
      '2030-01-01T00:00:00.000Z',
    ],
  );

  const response = await agent.put(`/api/admin/op-applications/${application.id}`).send({
    name: '拼多多新版',
    appId: '1104790999',
  });

  assert.equal(response.status, 409);
  assert.equal(response.body.error, '已使用的 AppID 不能修改');
});
