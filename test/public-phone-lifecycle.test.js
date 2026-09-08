const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const request = require('supertest');
const { createAdminTestContext } = require('./helpers/create-admin-test-context');
const { createAdminUser } = require('../lib/admin-users');
const { encryptGooglePassword, buildGooglePasswordSearchHash } = require('../lib/google-password-crypto');

async function fixture() {
  const context = await createAdminTestContext();
  // pg-mem incorrectly uses this partial index for unrestricted history reads,
  // hiding bound/after_sale rows. PostgreSQL integration tests retain the index
  // and verify its uniqueness/concurrency guarantees against the real planner.
  await context.pool.query('drop index idx_phone_inventory_active_record');
  const user = await createAdminUser(context.pool, { login: 'phones', email: 'phones@example.com', password: 'change-me-now', role: 'operator' });
  const recordId = crypto.randomUUID();
  await context.pool.query(`insert into managed_records (id, owner_id, google_account, google_password_encrypted, google_password_search_hash, google_assist, uid_value, phone_number, op_value, op_link, remark) values ($1,$2,$3,$4,$5,'','','','op','','')`, [recordId, user.id, 'phone@gmail.com', encryptGooglePassword('secret', context.config.googlePasswordEncryptionKey), buildGooglePasswordSearchHash('secret', context.config.googlePasswordEncryptionKey)]);
  const response = await request(context.app).get('/api/public/user/phones/batch');
  assert.equal(response.status, 200);
  return { ...context, user, recordId, batch: response.body.batch, identity: { batchId: response.body.batch.id, recordId } };
}

async function phone(f, overrides = {}) {
  const row = { id: crypto.randomUUID(), ownerId: f.user.id, number: crypto.randomUUID(), createdAt: '2024-01-01T00:00:00Z', expireAt: '2099-01-01T00:00:00Z', ...overrides };
  await f.pool.query(`insert into phone_inventory (id,owner_id,phone_number,phone_sms_url,phone_expire_at,phone_model,status,created_at) values ($1,$2,$3,'https://sms.example/read',$4,'12mini','available',$5)`, [row.id,row.ownerId,row.number,row.expireAt,row.createdAt]);
  return row;
}
const command = (f, action, body, slot = '1') => request(f.app).post(`/api/public/user/phones/batch/slots/${slot}/phone/${action}`).send(body);

test('phone lifecycle exposes unnumbered slots and blocks both prebind UID routes', async () => {
  const f = await fixture();
  assert.equal(f.batch.slots[0].record.id, f.recordId);
  assert.equal(f.batch.slots[0].record.phoneStatus, '');
  for (const path of ['batch/slots/1/uid', `record/${f.recordId}/uid`]) {
    const response = await request(f.app).post(`/api/public/user/phones/${path}`).send({ uid: '123', ...f.identity });
    assert.equal(response.status, 400);
    assert.match(response.body.error, /绑定/);
  }
});

test('phone lifecycle reserves FIFO, retains reservation across advance, permanently rejects stale after-sale commands and binds atomically', async () => {
  const f = await fixture();
  const first = await phone(f);
  const second = await phone(f, { createdAt: '2024-01-02T00:00:00Z' });
  let response = await command(f, 'extract', f.identity);
  assert.equal(response.status, 200);
  assert.equal(response.body.batch.slots[0].record.phoneInventoryId, first.id);
  assert.equal(response.body.batch.slots[0].record.phoneStatus, '未绑定');
  assert.equal((await f.pool.query('select phone_number from managed_records where id=$1', [f.recordId])).rows[0].phone_number, '');
  response = await command(f, 'extract', f.identity);
  assert.equal(response.body.batch.slots[0].record.phoneInventoryId, first.id);
  response = await request(f.app).post('/api/public/user/phones/batch/advance').send({});
  assert.equal(response.status, 200);
  assert.equal(response.body.batch.slots[0].record.phoneInventoryId, first.id);
  assert.equal((await command(f, 'extract', f.identity)).status, 409);
  f.identity.batchId = response.body.batch.id;
  const firstIdentity = { ...f.identity, phoneInventoryId: first.id };
  response = await command(f, 'status', { ...firstIdentity, phoneStatus: '老号售后' });
  assert.equal(response.status, 200);
  assert.equal(response.body.batch.slots[0].record.phoneNumber, '');
  assert.equal(response.body.batch.slots[0].record.lastPhoneAttempt.phoneInventoryId, first.id);
  const afterSale = (await f.pool.query('select status,after_sale_at,reserved_record_id from phone_inventory where id=$1', [first.id])).rows[0];
  assert.equal(afterSale.status, 'after_sale');
  assert.equal(afterSale.reserved_record_id, f.recordId);
  assert.ok(afterSale.after_sale_at);
  response = await command(f, 'extract', f.identity);
  assert.equal(response.body.batch.slots[0].record.phoneInventoryId, second.id);
  assert.equal((await command(f, 'status', { ...firstIdentity, phoneStatus: '已绑定' })).status, 409);
  assert.equal((await request(f.app).put('/api/public/user/phones/batch/slots/1/phone-model').send({ ...firstIdentity, phoneModel: '14' })).status, 409);
  const secondIdentity = { ...f.identity, phoneInventoryId: second.id };
  response = await request(f.app).put('/api/public/user/phones/batch/slots/1/phone-model').send({ ...secondIdentity, phoneModel: '14' });
  assert.equal(response.status, 200);
  assert.equal((await f.pool.query('select phone_model from managed_records where id=$1', [f.recordId])).rows[0].phone_model, '12mini');
  response = await command(f, 'status', { ...secondIdentity, phoneStatus: '已绑定' });
  assert.equal(response.status, 200);
  assert.equal(response.body.batch.slots[0].status, 'available');
  const bound = (await f.pool.query('select phone_number,phone_model,phone_status,phone_sms_url,phone_expire_at from managed_records where id=$1', [f.recordId])).rows[0];
  assert.equal(bound.phone_number, second.number);
  assert.equal(bound.phone_model, '14');
  assert.equal(bound.phone_status, '已绑定');
  assert.equal(bound.phone_sms_url, 'https://sms.example/read');
  assert.equal(new Date(bound.phone_expire_at).getUTCFullYear(), 2099);
  assert.equal((await command(f, 'extract', f.identity)).status, 409);
  assert.equal((await command(f, 'status', { ...secondIdentity, phoneStatus: '老号售后' })).status, 409);
  assert.equal((await request(f.app).put('/api/public/user/phones/batch/slots/1/phone-model').send({ ...secondIdentity, phoneModel: '11' })).status, 409);
  assert.equal((await command(f, 'bind', { ...secondIdentity, phoneStatus: '未绑定' })).status, 400);
  response = await request(f.app).post('/api/public/user/phones/batch/slots/1/uid').send({ ...f.identity, uid: '12345', remark: 'finished' });
  assert.equal(response.status, 200);
  assert.equal(response.body.batch.slots[0].status, 'done');
});

test('phone lifecycle validates command identities, whole slot values, inventory isolation and exhaustion', async () => {
  const f = await fixture();
  const other = await createAdminUser(f.pool, { login: 'other', email: 'other@example.com', password: 'change-me-now', role: 'operator' });
  await phone(f, { ownerId: other.id });
  await phone(f, { expireAt: '2000-01-01T00:00:00Z' });
  assert.equal((await command(f, 'extract', {})).status, 400);
  assert.equal((await command(f, 'extract', { ...f.identity, recordId: crypto.randomUUID() })).status, 409);
  for (const slot of ['1x', '1.0', '01', '7', '-1']) assert.equal((await command(f, 'extract', f.identity, slot)).status, 400);
  let response = await command(f, 'extract', f.identity);
  assert.equal(response.status, 400);
  assert.match(response.body.error, /库存不足/);
  const row = await phone(f);
  response = await command(f, 'extract', f.identity);
  assert.equal(response.body.batch.slots[0].record.phoneInventoryId, row.id);
  assert.equal((await command(f, 'status', { ...f.identity, phoneStatus: '已绑定' })).status, 400);
  assert.equal((await command(f, 'status', { ...f.identity, phoneInventoryId: row.id, phoneStatus: 'available' })).status, 400);
});

test('phone lifecycle retains bound lock after administrator clears final projection and allows bound legacy UID submit', async () => {
  const f = await fixture();
  const row = await phone(f);
  await command(f, 'extract', f.identity);
  const bound = await command(f, 'status', { ...f.identity, phoneInventoryId: row.id, phoneStatus: '已绑定' });
  assert.equal(bound.status, 200);
  const history = (await f.pool.query('select * from phone_inventory where id=$1', [row.id])).rows[0];
  assert.equal(history.status, 'bound');
  assert.equal(history.reserved_record_id, f.recordId);
  const associated = (await f.pool.query('select * from phone_inventory where owner_id=$1 and reserved_record_id=$2 order by created_at desc,id desc', [f.user.id, f.recordId])).rows;
  assert.equal(associated.length, 1);
  await f.pool.query(`update managed_records set phone_number='',phone_status='未绑定' where id=$1`, [f.recordId]);
  const clearedView = (await request(f.app).get('/api/public/user/phones/batch')).body.batch.slots[0].record;
  assert.equal(clearedView.phoneNumber, '');
  assert.equal(clearedView.phoneStatus, '');
  assert.equal(clearedView.phoneBindingLocked, true);
  const locked = await command(f, 'extract', f.identity);
  assert.equal(locked.status, 409, JSON.stringify(locked.body));
  assert.equal((await command(f, 'status', { ...f.identity, phoneInventoryId: row.id, phoneStatus: '老号售后' })).status, 409);
  let response = await request(f.app).post(`/api/public/user/phones/record/${f.recordId}/uid`).send({ uid: 'cleared' });
  assert.equal(response.status, 400);
  await f.pool.query(`update managed_records set phone_number=$2,phone_status='已绑定' where id=$1`, [f.recordId,row.number]);
  response = await request(f.app).post(`/api/public/user/phones/record/${f.recordId}/uid`).send({ uid: 'legacy-bound' });
  assert.equal(response.status, 200);
  assert.equal((await request(f.app).get('/api/public/user/phones/batch')).body.batch.slots[0].status, 'done');
});

test('phone lifecycle honors migrated duplicate bound archive after final projection is cleared', async () => {
  const f = await fixture();
  await f.pool.query(`insert into phone_inventory_legacy_archive
    (id,migration_name,source_record_id,owner_id,phone_number,phone_model,phone_connected,phone_status,source_created_at,source_updated_at,archive_reason)
    values ($1,'test-migration',$2,$3,'legacy-bound','12mini','未连接','已绑定',now(),now(),'duplicate')`, [crypto.randomUUID(),f.recordId,f.user.id]);
  await phone(f);
  const response = await command(f, 'extract', f.identity);
  assert.equal(response.status, 409);
  const batch = (await request(f.app).get('/api/public/user/phones/batch')).body.batch;
  assert.equal(batch.slots[0].record.phoneBindingLocked, true);
  assert.equal(batch.slots[0].record.phoneNumber, '');
});

test('phone lifecycle breaks FIFO timestamp ties by ID and rejects moved-owner records', async () => {
  const f = await fixture();
  await phone(f, { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' });
  const first = await phone(f, { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' });
  const response = await command(f, 'extract', f.identity);
  assert.equal(response.body.batch.slots[0].record.phoneInventoryId, first.id);
  const other = await createAdminUser(f.pool, { login: 'new-owner', email: 'new-owner@example.com', password: 'change-me-now', role: 'operator' });
  await f.pool.query('update managed_records set owner_id=$2 where id=$1', [f.recordId,other.id]);
  assert.equal((await command(f, 'status', { ...f.identity, phoneInventoryId: first.id, phoneStatus: '已绑定' })).status, 403);
  const view = await request(f.app).get('/api/public/user/phones/batch');
  assert.equal(view.body.batch.slots[0].record, null);
});
