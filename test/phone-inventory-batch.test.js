const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createAdminTestContext } = require('./helpers/create-admin-test-context');
const { hashAdminPassword } = require('../lib/admin-password');
const { createManagedRecord } = require('../lib/managed-records');

const endpoint = '/api/admin/records/phone-inventory';

async function login(agent, config) {
  await agent.post('/api/admin/auth/login').send({
    identifier: config.initialSuperAdminLogin, password: config.initialSuperAdminPassword,
  });
}

async function importPhones(agent, numbers) {
  const imported = await agent.post(`${endpoint}/import-text`).send({
    rowsText: numbers.map((number, index) => `${number}----https://example.test/${index}`).join('\n'),
  });
  assert.equal(imported.status, 201);
  return imported.body.items;
}

test('phone inventory batch delete removes owned numbers and unbinds projected records', async () => {
  const { agent, pool, config } = await createAdminTestContext();
  await login(agent, config);
  const [keep, remove] = await importPhones(agent, ['13000000001', '13000000002']);
  const record = await createManagedRecord(pool, config, {
    googleAccount: 'bound-phone@example.test',
    googlePassword: 'test-password',
    googleAssist: 'test-assist',
    opValue: 'test-op-bound',
  }, { id: keep.ownerId, role: 'super_admin' });
  await pool.query(
    `update phone_inventory
     set status = 'bound', reserved_record_id = $2, bound_at = now()
     where id = $1`,
    [remove.id, record.id],
  );
  await pool.query(
    `update managed_records
     set phone_number = $2, phone_status = '已绑定', phone_sms_url = $3
     where id = $1`,
    [record.id, remove.phoneNumber, remove.phoneSmsUrl],
  );

  assert.equal((await agent.post(`${endpoint}/batch-delete`).send({ ids: [] })).status, 400);
  assert.equal((await agent.post(`${endpoint}/batch-delete`).send({ ids: ['not-a-uuid'] })).status, 400);

  const deleted = await agent.post(`${endpoint}/batch-delete`).send({
    ids: [remove.id, remove.id, crypto.randomUUID()],
  });
  assert.equal(deleted.status, 200);
  assert.equal(deleted.body.deletedCount, 1);
  const remaining = await agent.get(endpoint);
  assert.deepEqual(remaining.body.items.map((item) => item.phoneNumber), ['13000000001']);
  const unbound = await pool.query('select phone_number, phone_status from managed_records where id = $1', [record.id]);
  assert.equal(unbound.rows[0].phone_number, '');
  assert.equal(unbound.rows[0].phone_status, '未绑定');
});

test('phone inventory batch delete and status never accept another owner including super admins', async () => {
  const { agent, pool, config } = await createAdminTestContext();
  await login(agent, config);
  const [adminPhone] = await importPhones(agent, ['14000000001']);
  const otherId = crypto.randomUUID();
  await pool.query(
    `insert into admin_users (id, login, email, password_hash, role, status)
     values ($1, 'batch-owner', 'batch-owner@example.test', $2, 'operator', 'active')`,
    [otherId, await hashAdminPassword('operator-pass')],
  );
  await agent.post('/api/admin/auth/login').send({ identifier: 'batch-owner', password: 'operator-pass' });
  const [operatorPhone] = await importPhones(agent, ['14000000002']);
  const deleted = await agent.post(`${endpoint}/batch-delete`).send({ ids: [adminPhone.id, operatorPhone.id] });
  assert.equal(deleted.body.deletedCount, 1);
  await login(agent, config);
  const listed = await agent.get(endpoint);
  assert.deepEqual(listed.body.items.map((item) => item.phoneNumber), ['14000000001']);
  const status = await agent.post(`${endpoint}/batch-status`).send({
    ids: [operatorPhone.id],
    status: 'after_sale',
  });
  assert.equal(status.body.updatedCount, 0);
  assert.equal(
    (await pool.query('select status from phone_inventory where id = $1', [operatorPhone.id])).rows.length,
    0,
  );
});

test('phone inventory batch status updates inventory and projects or releases reservations', async () => {
  const { agent, pool, config } = await createAdminTestContext();
  await login(agent, config);
  const items = await importPhones(agent, ['15000000001', '15000000002', '15000000003', '15000000004']);
  const record = await createManagedRecord(pool, config, {
    googleAccount: 'status-phone@example.test',
    googlePassword: 'test-password',
    googleAssist: 'test-assist',
    opValue: 'test-op-status',
  }, { id: items[0].ownerId, role: 'super_admin' });
  await pool.query(
    `update phone_inventory
     set status = 'reserved', reserved_record_id = $2, reserved_at = now()
     where id = $1`,
    [items[0].id, record.id],
  );
  await pool.query(
    `update phone_inventory
     set status = 'bound', reserved_record_id = $2, bound_at = now()
     where id = $1`,
    [items[1].id, record.id],
  );
  await pool.query(
    `update managed_records
     set phone_number = $2, phone_status = '已绑定'
     where id = $1`,
    [record.id, items[1].phoneNumber],
  );

  assert.equal((await agent.post(`${endpoint}/batch-status`).send({
    ids: [items[2].id],
    status: 'unknown',
  })).status, 400);

  const bound = await agent.post(`${endpoint}/batch-status`).send({
    ids: [items[0].id],
    status: 'bound',
  });
  assert.equal(bound.status, 200);
  assert.equal(bound.body.updatedCount, 1);
  assert.equal(
    (await pool.query('select phone_number, phone_status from managed_records where id = $1', [record.id])).rows[0].phone_number,
    items[1].phoneNumber,
  );

  const released = await agent.post(`${endpoint}/batch-status`).send({
    ids: [items[1].id],
    status: 'unbound',
  });
  assert.equal(released.body.updatedCount, 1);
  const releasedPhone = await pool.query(
    'select status, reserved_record_id, bound_at from phone_inventory where id = $1',
    [items[1].id],
  );
  assert.equal(releasedPhone.rows[0].status, 'available');
  assert.equal(releasedPhone.rows[0].reserved_record_id, null);
  const cleared = await pool.query('select phone_number, phone_status from managed_records where id = $1', [record.id]);
  assert.equal(cleared.rows[0].phone_number, '');
  assert.equal(cleared.rows[0].phone_status, '未绑定');

  const afterSale = await agent.post(`${endpoint}/batch-status`).send({
    ids: [items[2].id, items[3].id],
    status: 'after_sale',
  });
  assert.equal(afterSale.body.updatedCount, 2);
  const listed = await agent.get(endpoint).query({ status: 'after_sale', pageSize: 50 });
  assert.equal(listed.body.total, 2);
});

test('phone inventory batch endpoints require authentication', async () => {
  const { agent } = await createAdminTestContext();
  assert.equal((await agent.post(`${endpoint}/batch-delete`).send({ ids: [crypto.randomUUID()] })).status, 401);
  assert.equal((await agent.post(`${endpoint}/batch-status`).send({
    ids: [crypto.randomUUID()],
    status: 'unbound',
  })).status, 401);
});
