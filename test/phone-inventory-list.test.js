const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createAdminTestContext } = require('./helpers/create-admin-test-context');
const { hashAdminPassword } = require('../lib/admin-password');

const endpoint = '/api/admin/records/phone-inventory';
async function login(agent, config) {
  await agent.post('/api/admin/auth/login').send({
    identifier: config.initialSuperAdminLogin, password: config.initialSuperAdminPassword,
  });
}

test('phone inventory list displays imported numbers with pagination and status filters without managed records', async () => {
  const { agent, pool, config } = await createAdminTestContext();
  await login(agent, config);
  const imported = await agent.post(`${endpoint}/import-text`).send({
    rowsText: Array.from({ length: 23 }, (_, i) => `13000000${String(i).padStart(3, '0')}----https://example.test/${i}`).join('\n'),
  });
  assert.equal(imported.status, 201);
  for (const [i, status] of ['reserved', 'after_sale', 'bound'].entries()) {
    await pool.query('update phone_inventory set status = $1 where id = $2', [status, imported.body.items[i].id]);
  }
  const first = await agent.get(endpoint);
  assert.equal(first.status, 200);
  assert.equal(first.body.total, 23);
  assert.equal(first.body.items.length, 20);
  assert.equal(first.body.page, 1);
  const second = await agent.get(endpoint).query({ page: 2 });
  assert.equal(second.body.items.length, 3);
  assert.equal(new Set([...first.body.items, ...second.body.items].map((item) => item.id)).size, 23);
  const unbound = await agent.get(endpoint).query({ status: 'unbound', pageSize: 50 });
  assert.equal(unbound.body.total, 21);
  assert.ok(unbound.body.items.every((item) => ['available', 'reserved'].includes(item.status)));
  for (const status of ['after_sale', 'bound']) {
    const filtered = await agent.get(endpoint).query({ status });
    assert.equal(filtered.body.total, 1);
    assert.equal(filtered.body.items[0].status, status);
    assert.ok(filtered.body.items[0].phoneSmsUrl.startsWith('https://example.test/'));
    assert.equal(filtered.body.items[0].phoneModel, '12mini');
    assert.ok(filtered.body.items[0].phoneExpireAt);
  }
  const searched = await agent.get(endpoint).query({ search: '13000000022' });
  assert.equal(searched.body.total, 1);
  assert.equal(searched.body.items[0].phoneNumber, '13000000022');
  assert.equal((await agent.get('/api/admin/records')).body.total, 0);
});

test('phone inventory list requires authentication and never accepts another owner including for super admins', async () => {
  const { agent, pool, config } = await createAdminTestContext();
  assert.equal((await agent.get(endpoint)).status, 401);
  await login(agent, config);
  const imported = await agent.post(`${endpoint}/import-text`).send({ rowsText: '10001----https://example.test/admin' });
  const adminId = imported.body.items[0].ownerId;
  const otherId = crypto.randomUUID();
  await pool.query(`insert into admin_users (id, login, email, password_hash, role, status)
    values ($1, 'list-owner', 'list-owner@example.test', $2, 'operator', 'active')`,
  [otherId, await hashAdminPassword('operator-pass')]);
  await agent.post('/api/admin/auth/login').send({ identifier: 'list-owner', password: 'operator-pass' });
  assert.equal((await agent.get(endpoint).query({ ownerId: adminId })).body.total, 0);
  await agent.post(`${endpoint}/import-text`).send({ rowsText: '10002----https://example.test/operator' });
  assert.deepEqual((await agent.get(endpoint).query({ ownerId: adminId })).body.items.map((row) => row.phoneNumber), ['10002']);
  await login(agent, config);
  assert.deepEqual((await agent.get(endpoint).query({ ownerId: otherId })).body.items.map((row) => row.phoneNumber), ['10001']);
});

test('phone inventory list rejects invalid pagination and filters and returns an empty list honestly', async () => {
  const { agent, config } = await createAdminTestContext();
  await login(agent, config);
  const empty = await agent.get(endpoint);
  assert.equal(empty.status, 200);
  assert.deepEqual(empty.body.items, []);
  assert.equal(empty.body.total, 0);
  for (const query of [{ page: 'NaN' }, { page: 0 }, { page: '1.5' }, { pageSize: 0 }, { pageSize: 1000 }, { status: 'unknown' }]) {
    assert.equal((await agent.get(endpoint).query(query)).status, 400);
  }
});
