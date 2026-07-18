const test = require('node:test');
const assert = require('node:assert/strict');

const { createAdminTestContext } = require('./helpers/create-admin-test-context');
const {
  createShortOpRecord,
  generateShortOpCode,
  resolveActiveShortOpByCode,
} = require('../lib/short-op-records');

const timestamp = 1_900_000_000;
const op = (label, timestampValue = timestamp) =>
  `openid-${label}|access-${label}|pay-${label}|unused|${timestampValue}`;

async function login(agent, identifier, password) {
  return agent.post('/api/admin/auth/login').send({ identifier, password });
}

async function loginAsRoot(agent, config) {
  return login(agent, config.initialSuperAdminLogin, config.initialSuperAdminPassword);
}

async function createOperator(agent, loginName) {
  const response = await agent.post('/api/admin/users').send({
    login: loginName,
    email: `${loginName}@example.com`,
    password: 'operator-pass',
    role: 'operator',
  });
  assert.equal(response.status, 201);
  return response.body.user;
}

async function createApplication(agent, name, appId) {
  const response = await agent.post('/api/admin/op-applications').send({ name, appId });
  assert.equal(response.status, 201);
  return response.body.item;
}

async function defaultApplication(agent) {
  const response = await agent.get('/api/admin/op-applications?page=1&pageSize=20');
  assert.equal(response.status, 200);
  return response.body.items.find((item) => item.appId === '1105602870');
}

async function createShortOp(agent, payload) {
  const response = await agent.post('/api/admin/short-ops').send(payload);
  assert.equal(response.status, 201, response.text);
  return response.body.item;
}

test('short-code generation is fixed-width and creation retries code collisions', async () => {
  assert.equal(generateShortOpCode(() => 7), '00000007');

  const application = {
    id: '00000000-0000-0000-0000-000000000110',
    name: '抖音',
    app_id: '1105602870',
    status: 'active',
  };
  const adminUser = {
    id: '00000000-0000-0000-0000-000000000001',
    login: 'root',
    email: 'root@example.com',
    role: 'super_admin',
  };
  const generated = [7, 8];
  const insertedCodes = [];
  let released = false;
  const client = {
    async query(sql, values = []) {
      const normalized = sql.replace(/\s+/g, ' ').trim();
      if (/^(begin|commit)$/i.test(normalized)) return { rows: [] };
      if (/from op_applications.*for key share/i.test(normalized)) {
        assert.deepEqual(values, [application.id]);
        return { rows: [application] };
      }
      if (/insert into short_op_records/i.test(normalized)) {
        insertedCodes.push(values[2]);
        if (insertedCodes.length === 1) return { rows: [] };
        return {
          rows: [{
            id: values[0], owner_id: values[1], code: values[2], op_value: values[3],
            application_id: values[4], op_expire_at: values[5], status: 'active',
            remark: values[6], created_at: new Date(), updated_at: new Date(),
          }],
        };
      }
      assert.fail(`unexpected query: ${normalized}`);
    },
    release() {
      released = true;
    },
  };
  const pool = {
    async connect() {
      return client;
    },
  };

  const item = await createShortOpRecord(pool, {
    opValue: op('collision'),
    applicationId: application.id,
  }, adminUser, {
    randomIntImpl: () => generated.shift(),
  });

  assert.deepEqual(insertedCodes, ['00000007', '00000008']);
  assert.equal(item.code, '00000008');
  assert.equal(released, true);
});

test('creating a short OP generates an eight-digit code and binds the app', async () => {
  const { agent, config } = await createAdminTestContext();
  await loginAsRoot(agent, config);
  const application = await defaultApplication(agent);
  const opValue = op('create');

  const response = await agent.post('/api/admin/short-ops').send({
    opValue,
    applicationId: application.id,
    remark: 'first short op',
  });

  assert.equal(response.status, 201);
  assert.match(response.body.item.code, /^\d{8}$/);
  assert.equal(response.body.item.appId, '1105602870');
  assert.equal(response.body.item.shortLink, `/op/${response.body.item.code}`);
  assert.equal(response.body.item.opValue, opValue);
});

test('list masks OP values while authorized detail returns the full value', async () => {
  const { agent, config } = await createAdminTestContext();
  await loginAsRoot(agent, config);
  const application = await defaultApplication(agent);
  const opValue = op('mask');
  const created = await createShortOp(agent, { opValue, applicationId: application.id });

  const listResponse = await agent.get('/api/admin/short-ops?page=1&pageSize=20');
  const detailResponse = await agent.get(`/api/admin/short-ops/${created.id}`);

  assert.equal(listResponse.status, 200);
  assert.equal(Object.hasOwn(listResponse.body.items[0], 'opValue'), false);
  assert.notEqual(listResponse.body.items[0].maskedOpValue, opValue);
  assert.match(listResponse.body.items[0].maskedOpValue, /\*/);
  assert.equal(detailResponse.status, 200);
  assert.equal(detailResponse.body.item.opValue, opValue);
});

test('duplicate OP and application conflicts but the same OP can bind another app', async () => {
  const { agent, config } = await createAdminTestContext();
  await loginAsRoot(agent, config);
  const defaultApp = await defaultApplication(agent);
  const otherApp = await createApplication(agent, '拼多多', '1104790111');
  const opValue = op('duplicate');
  await createShortOp(agent, { opValue, applicationId: defaultApp.id });

  const duplicateResponse = await agent.post('/api/admin/short-ops').send({
    opValue,
    applicationId: defaultApp.id,
  });
  const otherAppResponse = await agent.post('/api/admin/short-ops').send({
    opValue,
    applicationId: otherApp.id,
  });

  assert.equal(duplicateResponse.status, 409);
  assert.equal(duplicateResponse.body.error, '该 OP 与应用已存在');
  assert.equal(otherAppResponse.status, 201);
  assert.equal(otherAppResponse.body.item.appId, '1104790111');
});

test('creation rejects malformed OPs, invalid timestamps, and inactive applications', async () => {
  const { agent, config } = await createAdminTestContext();
  await loginAsRoot(agent, config);
  const application = await createApplication(agent, '快手', '1104790112');
  await agent.post(`/api/admin/op-applications/${application.id}/disable`);

  const malformed = await agent.post('/api/admin/short-ops').send({
    opValue: 'only-one-part', applicationId: application.id,
  });
  const badTimestamp = await agent.post('/api/admin/short-ops').send({
    opValue: op('bad-time', 'not-a-number'), applicationId: application.id,
  });
  const inactive = await agent.post('/api/admin/short-ops').send({
    opValue: op('inactive'), applicationId: application.id,
  });

  assert.equal(malformed.status, 400);
  assert.match(malformed.body.error, /格式不正确/);
  assert.equal(badTimestamp.status, 400);
  assert.match(badTimestamp.body.error, /时间戳格式不正确/);
  assert.equal(inactive.status, 400);
  assert.equal(inactive.body.error, '所选应用不存在或已停用');
});

test('operators only access their records while super admins access every record', async () => {
  const { agent: rootAgent, app, config } = await createAdminTestContext();
  await loginAsRoot(rootAgent, config);
  const application = await defaultApplication(rootAgent);
  await createOperator(rootAgent, 'operator-a');
  await createOperator(rootAgent, 'operator-b');
  await rootAgent.post('/api/admin/auth/logout');
  await login(rootAgent, 'operator-a', 'operator-pass');
  const operatorARecord = await createShortOp(rootAgent, {
    opValue: op('owner-a'), applicationId: application.id,
  });
  await rootAgent.post('/api/admin/auth/logout');
  await login(rootAgent, 'operator-b', 'operator-pass');
  const operatorBRecord = await createShortOp(rootAgent, {
    opValue: op('owner-b'), applicationId: application.id,
  });

  const operatorBList = await rootAgent.get('/api/admin/short-ops?page=1&pageSize=20');
  const forbiddenDetail = await rootAgent.get(`/api/admin/short-ops/${operatorARecord.id}`);
  const forbiddenUpdate = await rootAgent
    .put(`/api/admin/short-ops/${operatorARecord.id}`)
    .send({ remark: 'stolen' });
  const forbiddenDelete = await rootAgent.delete(`/api/admin/short-ops/${operatorARecord.id}`);

  assert.deepEqual(operatorBList.body.items.map((item) => item.id), [operatorBRecord.id]);
  assert.equal(forbiddenDetail.status, 404);
  assert.equal(forbiddenUpdate.status, 404);
  assert.equal(forbiddenDelete.status, 404);

  const superAgent = require('supertest').agent(app);
  await loginAsRoot(superAgent, config);
  const superList = await superAgent.get('/api/admin/short-ops?page=1&pageSize=20');
  assert.deepEqual(
    new Set(superList.body.items.map((item) => item.id)),
    new Set([operatorARecord.id, operatorBRecord.id]),
  );
});

test('editing preserves the code and status changes and deletion are soft', async () => {
  const { agent, config, pool } = await createAdminTestContext();
  await loginAsRoot(agent, config);
  const application = await defaultApplication(agent);
  const created = await createShortOp(agent, {
    opValue: op('lifecycle'), applicationId: application.id, remark: 'before',
  });

  const updateResponse = await agent.put(`/api/admin/short-ops/${created.id}`).send({
    remark: 'after',
  });
  const disableResponse = await agent.post(`/api/admin/short-ops/${created.id}/disable`);
  const enableResponse = await agent.post(`/api/admin/short-ops/${created.id}/enable`);
  const deleteResponse = await agent.delete(`/api/admin/short-ops/${created.id}`);
  const databaseRow = await pool.query(
    `select status, deleted_at from short_op_records where id = $1`, [created.id],
  );

  assert.equal(updateResponse.status, 200);
  assert.equal(updateResponse.body.item.code, created.code);
  assert.equal(updateResponse.body.item.remark, 'after');
  assert.equal(disableResponse.body.item.status, 'disabled');
  assert.equal(enableResponse.body.item.status, 'active');
  assert.equal(deleteResponse.status, 200);
  assert.equal(deleteResponse.body.item.status, 'deleted');
  assert.ok(databaseRow.rows[0].deleted_at);
});

test('public resolution only returns active, unexpired short OP records', async () => {
  const { agent, config, pool } = await createAdminTestContext();
  await loginAsRoot(agent, config);
  const application = await defaultApplication(agent);
  const created = await createShortOp(agent, {
    opValue: op('resolve'), applicationId: application.id,
  });

  const resolved = await resolveActiveShortOpByCode(pool, created.code);
  assert.equal(resolved.opValue, op('resolve'));
  assert.equal(resolved.appId, '1105602870');

  await agent.post(`/api/admin/short-ops/${created.id}/disable`);
  assert.equal(await resolveActiveShortOpByCode(pool, created.code), null);
});

test('list supports filtering and 20/50/100/all page sizes', async () => {
  const { agent, config } = await createAdminTestContext();
  await loginAsRoot(agent, config);
  const application = await defaultApplication(agent);
  const first = await createShortOp(agent, {
    opValue: op('filter-a'), applicationId: application.id, remark: 'needle',
  });
  const second = await createShortOp(agent, {
    opValue: op('filter-b'), applicationId: application.id, remark: 'other',
  });
  await agent.post(`/api/admin/short-ops/${second.id}/disable`);

  const filtered = await agent.get(
    `/api/admin/short-ops?search=needle&status=active&applicationId=${application.id}`,
  );
  assert.deepEqual(filtered.body.items.map((item) => item.id), [first.id]);

  for (const pageSize of ['20', '50', '100', 'all']) {
    const response = await agent.get(`/api/admin/short-ops?page=1&pageSize=${pageSize}`);
    assert.equal(response.status, 200);
    assert.equal(response.body.page, 1);
    assert.equal(response.body.pageSize, pageSize === 'all' ? 'all' : Number(pageSize));
    assert.equal(response.body.total, 2);
  }
});

test('text import counts successes, batch duplicates, database duplicates, and row errors', async () => {
  const { agent, config } = await createAdminTestContext();
  await loginAsRoot(agent, config);
  const defaultApp = await defaultApplication(agent);
  const otherApp = await createApplication(agent, '拼多多', '1104790111');
  const opA = op('import-a');
  const opB = op('import-b');
  const existingOp = op('import-existing');
  await createShortOp(agent, { opValue: existingOp, applicationId: defaultApp.id });

  const response = await agent.post('/api/admin/short-ops/import-text').send({
    rowsText: [
      opA,
      `${opB}----${otherApp.appId}`,
      opA,
      existingOp,
      'invalid-row',
    ].join('\n'),
  });

  assert.equal(response.status, 200);
  assert.deepEqual(Object.keys(response.body).sort(), [
    'duplicateCount', 'errors', 'failedCount', 'importedCount', 'items',
  ]);
  assert.equal(response.body.importedCount, 2);
  assert.equal(response.body.duplicateCount, 2);
  assert.equal(response.body.failedCount, 1);
  assert.deepEqual(new Set(response.body.items.map((item) => item.appId)), new Set([
    '1105602870', '1104790111',
  ]));
  assert.deepEqual(response.body.errors.map((error) => error.lineNumber), [5]);
});

test('all short OP routes require admin authentication', async () => {
  const { agent } = await createAdminTestContext();
  const responses = await Promise.all([
    agent.get('/api/admin/short-ops'),
    agent.post('/api/admin/short-ops').send({}),
    agent.post('/api/admin/short-ops/import-text').send({ rowsText: '' }),
  ]);
  assert.deepEqual(responses.map((response) => response.status), [401, 401, 401]);
});
