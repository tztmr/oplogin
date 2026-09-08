const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { Pool } = require('pg');
const { ensureDatabaseSchema } = require('../lib/schema');
const { createAdminUser } = require('../lib/admin-users');
const { createManagedRecord } = require('../lib/managed-records');
const { importPhoneInventoryText } = require('../lib/phone-inventory');
const {
  getCurrentBatch, extractBatchSlotPhone, setBatchSlotPhoneStatus, submitBatchSlotUid,
} = require('../lib/public-user-batches');

// Uses a dedicated temporary schema on the explicitly supplied test server.
// pg-mem cannot exercise row locks, transaction rollback or its partial-index planner.
const connectionString = process.env.PHONE_TEST_DATABASE_URL;

async function fixture(t) {
  const admin = new Pool({ connectionString });
  const schema = `phone_test_${crypto.randomUUID().replaceAll('-', '')}`;
  await admin.query(`create schema "${schema}"`);
  const pool = new Pool({ connectionString, options: `-c search_path=${schema}`, max: 12 });
  t.after(async () => {
    await pool.end();
    await admin.query(`drop schema "${schema}" cascade`);
    await admin.end();
  });
  await ensureDatabaseSchema(pool);
  const config = { googlePasswordEncryptionKey: '0123456789abcdef'.repeat(4) };
  const user = await createAdminUser(pool, {
    login: 'pg-phones', email: 'pg-phones@example.test', password: 'test-password', role: 'operator',
  });
  for (let i = 0; i < 3; i++) {
    await createManagedRecord(pool, config, {
      googleAccount: `slot-${i}@example.test`, googlePassword: 'test-password',
      googleAssist: 'test-assist', opValue: `test-op-${i}`,
    }, user);
  }
  const batch = await getCurrentBatch(pool, config, user);
  const identity = (slot) => ({ batchId: batch.id, recordId: batch.slots[slot - 1].record.id });
  return { pool, config, user, batch, identity };
}

test('PostgreSQL: concurrent imports and extraction keep inventory and reservations unique', { skip: !connectionString }, async (t) => {
  const f = await fixture(t);
  const imports = await Promise.all(Array.from({ length: 4 }, () => importPhoneInventoryText(
    f.pool, '13000000001----https://example.test/1\n13000000002----https://example.test/2', f.user,
  )));
  assert.equal(imports.reduce((sum, result) => sum + result.importedCount, 0), 2);
  const batches = await Promise.all(Array.from({ length: 5 }, () => getCurrentBatch(f.pool, f.config, f.user)));
  assert.equal(new Set(batches.map((batch) => batch.id)).size, 1);
  const extracted = await Promise.all([1, 2].map((slot) => extractBatchSlotPhone(
    f.pool, f.config, f.user, slot, f.identity(slot),
  )));
  const phoneIds = extracted.map((batch, index) => batch.slots[index].record.phoneInventoryId);
  assert.equal(new Set(phoneIds).size, 2);
  const repeated = await Promise.all(Array.from({ length: 5 }, () => extractBatchSlotPhone(
    f.pool, f.config, f.user, 1, f.identity(1),
  )));
  assert.ok(repeated.every((batch) => batch.slots[0].record.phoneInventoryId === phoneIds[0]));
  const stored = await f.pool.query('select status,reserved_record_id from phone_inventory');
  assert.equal(stored.rowCount, 2);
  assert.ok(stored.rows.every((phone) => phone.status === 'reserved'));
  const managed = await f.pool.query("select id from managed_records where phone_number <> ''");
  assert.equal(managed.rowCount, 0);
  await assert.rejects(f.pool.query(
    `insert into phone_inventory (id,owner_id,phone_number,status,reserved_record_id)
     values ($1,$2,'13000000003','reserved',$3)`,
    [crypto.randomUUID(), f.user.id, f.identity(1).recordId],
  ), { code: '23505' });
});

test('PostgreSQL: binding rollback preserves reservation and terminal races have only one winner', { skip: !connectionString }, async (t) => {
  const f = await fixture(t);
  await importPhoneInventoryText(f.pool, '13000000001----https://example.test/1\n13000000002----https://example.test/2', f.user);
  const batch = await extractBatchSlotPhone(f.pool, f.config, f.user, 1, f.identity(1));
  const phoneInventoryId = batch.slots[0].record.phoneInventoryId;
  const payload = { ...f.identity(1), phoneInventoryId };
  await f.pool.query(`
    create function reject_test_binding() returns trigger language plpgsql as $$
    begin
      if NEW.phone_status = '已绑定' then raise exception 'test binding rollback'; end if;
      return NEW;
    end $$;
    create trigger reject_test_binding before update on managed_records
      for each row execute function reject_test_binding();
  `);
  await assert.rejects(setBatchSlotPhoneStatus(f.pool, f.config, f.user, 1, '已绑定', payload), /test binding rollback/);
  assert.equal((await f.pool.query('select status from phone_inventory where id=$1', [phoneInventoryId])).rows[0].status, 'reserved');
  assert.equal((await f.pool.query('select phone_number from managed_records where id=$1', [payload.recordId])).rows[0].phone_number, '');
  await f.pool.query('drop trigger reject_test_binding on managed_records');
  const results = await Promise.allSettled(['已绑定', '老号售后'].map((status) => setBatchSlotPhoneStatus(
    f.pool, f.config, f.user, 1, status, payload,
  )));
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(results.find((result) => result.status === 'rejected').reason.statusCode, 409);
  const phone = (await f.pool.query('select status from phone_inventory where id=$1', [phoneInventoryId])).rows[0];
  let boundPayload = payload;
  if (phone.status === 'after_sale') {
    const next = await extractBatchSlotPhone(f.pool, f.config, f.user, 1, f.identity(1));
    boundPayload = { ...f.identity(1), phoneInventoryId: next.slots[0].record.phoneInventoryId };
    assert.notEqual(boundPayload.phoneInventoryId, phoneInventoryId);
    await assert.rejects(setBatchSlotPhoneStatus(f.pool, f.config, f.user, 1, '已绑定', payload), { statusCode: 409 });
    await setBatchSlotPhoneStatus(f.pool, f.config, f.user, 1, '已绑定', boundPayload);
  }
  await assert.rejects(extractBatchSlotPhone(f.pool, f.config, f.user, 1, f.identity(1)), { statusCode: 409 });
  const saved = await submitBatchSlotUid(f.pool, f.config, f.user, 1, { ...f.identity(1), uid: 'real-pg-uid' });
  assert.equal(saved.slots[0].status, 'done');
  assert.equal(saved.slots[0].record.phoneStatus, '已绑定');
});
