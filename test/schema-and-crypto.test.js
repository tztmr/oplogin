const test = require('node:test');
const assert = require('node:assert/strict');
const { newDb } = require('pg-mem');

const {
  encryptGooglePassword,
  decryptGooglePassword,
  buildGooglePasswordSearchHash,
} = require('../lib/google-password-crypto');
const {
  ensureDatabaseSchema,
  ensureManagedRecordUidUniqueness,
} = require('../lib/schema');

const encryptionKey =
  '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

async function createLegacyPhoneSchema(pool) {
  await pool.query(`
    create table admin_users (
      id uuid primary key,
      login text not null unique,
      email text not null unique,
      password_hash text not null,
      role text not null check (role in ('super_admin', 'operator')),
      status text not null check (status in ('active', 'disabled')),
      wifi_type text not null default 'WPA',
      wifi_ssid text not null default '',
      wifi_password text not null default '',
      wifi_hidden boolean not null default false,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      last_login_at timestamptz null
    );

    create table managed_records (
      id uuid primary key,
      owner_id uuid references admin_users(id) on delete set null,
      google_account text not null,
      google_password_encrypted text not null,
      google_password_search_hash text not null,
      google_assist text not null,
      google_expire_at timestamptz null,
      uid_value text not null,
      uid_created_at timestamptz null,
      phone_number text not null default '',
      phone_sms_url text not null default '',
      phone_expire_at timestamptz null,
      phone_connected text not null default '未连接',
      phone_status text not null default '未绑定',
      phone_model text not null default '12mini',
      op_value text not null,
      op_nickname text not null default '',
      op_link text not null,
      op_expire_at timestamptz null,
      remark text null,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );
  `);
}

test(
  'Google password encryption round-trips and search hashes are deterministic',
  () => {
    const encrypted = encryptGooglePassword('secret-pass', encryptionKey);
    const decrypted = decryptGooglePassword(encrypted, encryptionKey);
    const hashA = buildGooglePasswordSearchHash('secret-pass', encryptionKey);
    const hashB = buildGooglePasswordSearchHash('secret-pass', encryptionKey);

    assert.equal(decrypted, 'secret-pass');
    assert.equal(hashA, hashB);
    assert.notEqual(encrypted, 'secret-pass');
  },
);

test('ensureDatabaseSchema creates the admin and record tables', async () => {
  const db = newDb();
  const { Pool } = db.adapters.createPg();
  const pool = new Pool();

  await ensureDatabaseSchema(pool);

  const adminColumns = await pool.query(`
    select column_name
    from information_schema.columns
    where table_name = 'admin_users'
    order by column_name
  `);
  const recordColumns = await pool.query(`
    select column_name
    from information_schema.columns
    where table_name = 'managed_records'
    order by column_name
  `);

  assert.ok(adminColumns.rows.some((row) => row.column_name === 'password_hash'));
  assert.ok(
    recordColumns.rows.some(
      (row) => row.column_name === 'google_password_encrypted',
    ),
  );
  assert.ok(
    recordColumns.rows.some((row) => row.column_name === 'google_assist'),
  );
  assert.ok(recordColumns.rows.some((row) => row.column_name === 'op_nickname'));
  assert.ok(recordColumns.rows.some((row) => row.column_name === 'op_link'));
  assert.ok(recordColumns.rows.some((row) => row.column_name === 'phone_number'));
  assert.ok(recordColumns.rows.some((row) => row.column_name === 'phone_sms_url'));
  assert.ok(recordColumns.rows.some((row) => row.column_name === 'phone_expire_at'));
  assert.ok(
    recordColumns.rows.some((row) => row.column_name === 'phone_connected'),
  );
  assert.ok(
    recordColumns.rows.some((row) => row.column_name === 'phone_status'),
  );
  assert.ok(recordColumns.rows.some((row) => row.column_name === 'phone_model'));
});

test('ensureDatabaseSchema creates short OP tables and seeds default Douyin app', async () => {
  const db = newDb();
  const { Pool } = db.adapters.createPg();
  const pool = new Pool();

  await ensureDatabaseSchema(pool);

  const applications = await pool.query(
    `select name, app_id, is_default, status from op_applications`,
  );
  const shortOpColumns = await pool.query(`
    select column_name from information_schema.columns
    where table_name = 'short_op_records'
  `);

  assert.deepEqual(applications.rows, [{
    name: '抖音', app_id: '1105602870', is_default: true, status: 'active',
  }]);
  assert.ok(shortOpColumns.rows.some((row) => row.column_name === 'code'));
  assert.ok(
    shortOpColumns.rows.some((row) => row.column_name === 'application_id'),
  );
  assert.ok(
    shortOpColumns.rows.some((row) => row.column_name === 'deleted_at'),
  );
});

test('ensureDatabaseSchema enforces short OP application and record constraints', async () => {
  const db = newDb();
  const { Pool } = db.adapters.createPg();
  const pool = new Pool();

  await ensureDatabaseSchema(pool);
  await pool.query(`
    insert into admin_users (id, login, email, password_hash, role, status)
    values (
      '00000000-0000-0000-0000-000000000101',
      'short-op-owner',
      'short-op-owner@example.com',
      'hash',
      'operator',
      'active'
    )
  `);

  await assert.rejects(
    pool.query(`
      insert into op_applications (id, name, app_id, is_default, status)
      values (
        '00000000-0000-0000-0000-000000000102',
        '重复抖音',
        '1105602870',
        false,
        'active'
      )
    `),
    /duplicate|unique/i,
  );

  const application = await pool.query(
    `select id from op_applications where app_id = '1105602870'`,
  );
  const applicationId = application.rows[0].id;
  const recordValues = (id, code, opValue) => `(
    '${id}',
    '00000000-0000-0000-0000-000000000101',
    '${code}',
    '${opValue}',
    '${applicationId}',
    now(),
    'active'
  )`;

  await assert.rejects(
    pool.query(`
      insert into short_op_records (
        id, owner_id, code, op_value, application_id, op_expire_at, status
      ) values ${recordValues(
        '00000000-0000-0000-0000-000000000103',
        'invalid',
        'op-invalid',
      )}
    `),
  );

  await pool.query(`
    insert into short_op_records (
      id, owner_id, code, op_value, application_id, op_expire_at, status
    ) values ${recordValues(
      '00000000-0000-0000-0000-000000000104',
      '12345678',
      'op-duplicate',
    )}
  `);

  await assert.rejects(
    pool.query(`
      insert into short_op_records (
        id, owner_id, code, op_value, application_id, op_expire_at, status
      ) values ${recordValues(
        '00000000-0000-0000-0000-000000000105',
        '87654321',
        'op-duplicate',
      )}
    `),
    /duplicate|unique/i,
  );

  await assert.rejects(
    pool.query(`
      insert into short_op_records (
        id, owner_id, code, op_value, application_id, op_expire_at, status
      ) values ${recordValues(
        '00000000-0000-0000-0000-000000000106',
        '12345678',
        'op-other',
      )}
    `),
    /duplicate|unique/i,
  );

  await pool.query(`
    update short_op_records
    set status = 'deleted', deleted_at = now()
    where id = '00000000-0000-0000-0000-000000000104'
  `);
  await assert.rejects(
    pool.query(`
      insert into short_op_records (
        id, owner_id, code, op_value, application_id, op_expire_at, status
      ) values ${recordValues(
        '00000000-0000-0000-0000-000000000107',
        '12345678',
        'op-after-delete',
      )}
    `),
    /duplicate|unique/i,
  );
  await pool.query(`
    insert into short_op_records (
      id, owner_id, code, op_value, application_id, op_expire_at, status
    ) values ${recordValues(
      '00000000-0000-0000-0000-000000000108',
      '87654321',
      'op-duplicate',
    )}
  `);
});

test('ensureDatabaseSchema keeps empty UID reusable but rejects duplicate non-empty UID', async () => {
  const db = newDb();
  const { Pool } = db.adapters.createPg();
  const pool = new Pool();

  await ensureDatabaseSchema(pool);

  await pool.query(
    `
      insert into managed_records (
        id,
        google_account,
        google_password_encrypted,
        google_password_search_hash,
        google_assist,
        uid_value,
        op_value,
        op_link
      )
      values
        ('00000000-0000-0000-0000-000000000001', 'empty-1@gmail.com', 'enc', 'hash', '', '', 'op-1', '/oplogin/op-1'),
        ('00000000-0000-0000-0000-000000000002', 'empty-2@gmail.com', 'enc', 'hash', '', '', 'op-2', '/oplogin/op-2')
    `,
  );

  await pool.query(
    `
      insert into managed_records (
        id,
        google_account,
        google_password_encrypted,
        google_password_search_hash,
        google_assist,
        uid_value,
        op_value,
        op_link
      )
      values (
        '00000000-0000-0000-0000-000000000003',
        'unique-1@gmail.com',
        'enc',
        'hash',
        '',
        'uid-001',
        'op-3',
        '/oplogin/op-3'
      )
    `,
  );

  await assert.rejects(
    pool.query(
      `
        insert into managed_records (
          id,
          google_account,
          google_password_encrypted,
          google_password_search_hash,
          google_assist,
          uid_value,
          op_value,
          op_link
        )
        values (
          '00000000-0000-0000-0000-000000000004',
          'unique-2@gmail.com',
          'enc',
          'hash',
          '',
          'uid-001',
          'op-4',
          '/oplogin/op-4'
        )
      `,
    ),
    /idx_records_uid_value_unique_non_empty|duplicate/i,
  );
});

test('ensureManagedRecordUidUniqueness detects legacy duplicate UID data', async () => {
  const db = newDb();
  const { Pool } = db.adapters.createPg();
  const pool = new Pool();

  await ensureDatabaseSchema(pool);
  await pool.query('drop index if exists idx_records_uid_value_unique_non_empty');

  await pool.query(
    `
      insert into managed_records (
        id,
        google_account,
        google_password_encrypted,
        google_password_search_hash,
        google_assist,
        uid_value,
        op_value,
        op_link
      )
      values
        ('00000000-0000-0000-0000-000000000011', 'legacy-1@gmail.com', 'enc', 'hash', '', 'legacy-uid', 'op-11', '/oplogin/op-11'),
        ('00000000-0000-0000-0000-000000000012', 'legacy-2@gmail.com', 'enc', 'hash', '', 'legacy-uid', 'op-12', '/oplogin/op-12')
    `,
  );

  await assert.rejects(
    ensureManagedRecordUidUniqueness(pool),
    /managed_records 存在重复 UID.*legacy-uid/,
  );
});

test('phone inventory schema enforces owner isolation, valid states, and one active reservation per record', async () => {
  const db = newDb();
  const { Pool } = db.adapters.createPg();
  const pool = new Pool();
  await ensureDatabaseSchema(pool);

  await pool.query(`
    insert into admin_users (id, login, email, password_hash, role, status)
    values
      ('00000000-0000-0000-0000-000000000201', 'owner-a', 'a@example.com', 'hash', 'operator', 'active'),
      ('00000000-0000-0000-0000-000000000202', 'owner-b', 'b@example.com', 'hash', 'operator', 'active')
  `);
  await pool.query(`
    insert into managed_records (
      id, owner_id, google_account, google_password_encrypted,
      google_password_search_hash, google_assist, uid_value, op_value, op_link
    ) values (
      '00000000-0000-0000-0000-000000000203',
      '00000000-0000-0000-0000-000000000201',
      'record@example.com', 'enc', 'hash', '', '', 'op', '/oplogin/op'
    )
  `);

  const inventoryValues = (id, ownerId, status = 'available') => `(
    '${id}', '${ownerId}', '13000000001', 'https://sms.example/1',
    '12mini', '${status}',
    ${status === 'reserved' ? "'00000000-0000-0000-0000-000000000203'" : 'null'}
  )`;
  await pool.query(`
    insert into phone_inventory (
      id, owner_id, phone_number, phone_sms_url, phone_model, status,
      reserved_record_id
    ) values ${inventoryValues(
      '00000000-0000-0000-0000-000000000204',
      '00000000-0000-0000-0000-000000000201',
      'reserved',
    )}
  `);
  await pool.query(`
    insert into phone_inventory (
      id, owner_id, phone_number, phone_sms_url, phone_model, status,
      reserved_record_id
    ) values ${inventoryValues(
      '00000000-0000-0000-0000-000000000205',
      '00000000-0000-0000-0000-000000000202',
    )}
  `);

  await assert.rejects(
    pool.query(`
      insert into phone_inventory (
        id, owner_id, phone_number, phone_model, status, reserved_record_id
      ) values (
        '00000000-0000-0000-0000-000000000206',
        '00000000-0000-0000-0000-000000000201',
        '13000000002', '12mini', 'reserved',
        '00000000-0000-0000-0000-000000000203'
      )
    `),
    /duplicate|unique/i,
  );
  await assert.rejects(
    pool.query(`
      insert into phone_inventory (id, owner_id, phone_number, phone_model, status)
      values (
        '00000000-0000-0000-0000-000000000207',
        '00000000-0000-0000-0000-000000000201',
        '13000000003', '13', 'available'
      )
    `),
    /check|constraint/i,
  );

  await pool.query(`
    update phone_inventory
    set status = 'bound'
    where id = '00000000-0000-0000-0000-000000000204'
  `);
  await pool.query(`
    insert into public_user_batches (id, owner_id, status)
    values (
      '00000000-0000-0000-0000-000000000208',
      '00000000-0000-0000-0000-000000000201',
      'open'
    );
    insert into public_user_batch_slots (
      id, batch_id, slot_number, record_id, status
    ) values (
      '00000000-0000-0000-0000-000000000209',
      '00000000-0000-0000-0000-000000000208',
      1,
      '00000000-0000-0000-0000-000000000203',
      'available'
    );
    update phone_inventory
    set reserved_batch_slot_id = '00000000-0000-0000-0000-000000000209'
    where id = '00000000-0000-0000-0000-000000000204';
  `);
  await pool.query(`
    delete from managed_records
    where id = '00000000-0000-0000-0000-000000000203'
  `);
  await pool.query(`
    delete from public_user_batches
    where id = '00000000-0000-0000-0000-000000000208'
  `);
  const retainedHistory = await pool.query(`
    select status, reserved_batch_slot_id
    from phone_inventory
    where id = '00000000-0000-0000-0000-000000000204'
  `);
  assert.deepEqual(retainedHistory.rows, [{
    status: 'bound',
    reserved_batch_slot_id: null,
  }]);
});

test('schema migrates pre-marker legacy phones atomically once and preserves duplicate history', async () => {
  // pg-mem otherwise rejects CREATE TABLE IF NOT EXISTS when the legacy table
  // predates the multi-statement schema batch, even though PostgreSQL accepts it.
  const db = newDb({ noAstCoverageCheck: true });
  const { Pool } = db.adapters.createPg();
  const pool = new Pool();
  await createLegacyPhoneSchema(pool);

  const ownerId = '00000000-0000-0000-0000-000000000211';
  const unboundId = '00000000-0000-0000-0000-000000000212';
  const duplicateUnboundId = '00000000-0000-0000-0000-000000000213';
  const boundId = '00000000-0000-0000-0000-000000000214';
  const duplicateBoundId = '00000000-0000-0000-0000-000000000215';
  const ownerlessId = '00000000-0000-0000-0000-000000000216';
  await pool.query(
    `insert into admin_users (id, login, email, password_hash, role, status)
     values ($1, 'legacy-phone', 'legacy-phone@example.com', 'hash', 'operator', 'active')`,
    [ownerId],
  );
  await pool.query(
    `insert into managed_records (
       id, owner_id, google_account, google_password_encrypted,
       google_password_search_hash, google_assist, uid_value,
       phone_number, phone_sms_url, phone_status, phone_model, op_value, op_link,
       created_at
     ) values
       ($1, $6, 'unbound@example.com', 'enc', 'hash-1', '', '',
        '13000000001', 'https://sms.example/unbound', '未绑定', '11', 'op-1', '/oplogin/op-1', '2026-01-01T00:00:00Z'),
       ($2, $6, 'duplicate-unbound@example.com', 'enc', 'hash-2', '', '',
        '13000000002', 'https://sms.example/unbound-duplicate', '未绑定', '14', 'op-2', '/oplogin/op-2', '2026-01-01T00:00:00Z'),
       ($3, $6, 'bound@example.com', 'enc', 'hash-3', '', '',
        '13000000002', 'https://sms.example/bound', '已绑定', 'x', 'op-3', '/oplogin/op-3', '2026-01-02T00:00:00Z'),
       ($4, $6, 'duplicate-bound@example.com', 'enc', 'hash-4', '', '',
        '13000000002', 'https://sms.example/bound-2', '已绑定', '12mini', 'op-4', '/oplogin/op-4', '2026-01-03T00:00:00Z'),
       ($5, null, 'ownerless@example.com', 'enc', 'hash-5', '', '',
        '13000000003', 'https://sms.example/ownerless', '未绑定', '12mini', 'op-5', '/oplogin/op-5', '2026-01-01T00:00:00Z')`,
    [
      unboundId,
      duplicateUnboundId,
      boundId,
      duplicateBoundId,
      ownerlessId,
      ownerId,
    ],
  );

  await ensureDatabaseSchema(pool);
  const firstInventory = await pool.query(`
    select id, phone_number, phone_sms_url, phone_model, status, reserved_record_id
    from phone_inventory
    order by phone_number
  `);
  assert.deepEqual(firstInventory.rows, [
    {
      id: firstInventory.rows[0].id,
      phone_number: '13000000001',
      phone_sms_url: 'https://sms.example/unbound',
      phone_model: '11',
      status: 'available',
      reserved_record_id: null,
    },
    {
      id: firstInventory.rows[1].id,
      phone_number: '13000000002',
      phone_sms_url: 'https://sms.example/bound',
      phone_model: 'x',
      status: 'bound',
      reserved_record_id: boundId,
    },
  ]);
  assert.notEqual(firstInventory.rows[0].id, unboundId);
  assert.notEqual(firstInventory.rows[1].id, boundId);

  const records = await pool.query(`
    select id, phone_number, phone_sms_url, phone_expire_at, phone_status
    from managed_records
    order by id
  `);
  assert.deepEqual(
    records.rows.filter((row) => [unboundId, duplicateUnboundId].includes(row.id)),
    [
      { id: unboundId, phone_number: '', phone_sms_url: '', phone_expire_at: null, phone_status: '未绑定' },
      { id: duplicateUnboundId, phone_number: '', phone_sms_url: '', phone_expire_at: null, phone_status: '未绑定' },
    ],
  );
  assert.equal(records.rows.find((row) => row.id === boundId).phone_number, '13000000002');
  assert.equal(records.rows.find((row) => row.id === duplicateBoundId).phone_number, '13000000002');
  assert.equal(records.rows.find((row) => row.id === ownerlessId).phone_number, '13000000003');

  const archive = await pool.query(`
    select source_record_id, phone_number, phone_sms_url, phone_status
    from phone_inventory_legacy_archive
    order by source_record_id
  `);
  assert.equal(archive.rowCount, 4);
  assert.deepEqual(
    archive.rows.find((row) => row.source_record_id === duplicateUnboundId),
    {
      source_record_id: duplicateUnboundId,
      phone_number: '13000000002',
      phone_sms_url: 'https://sms.example/unbound-duplicate',
      phone_status: '未绑定',
    },
  );

  await ensureDatabaseSchema(pool);
  assert.equal((await pool.query('select * from phone_inventory')).rowCount, 2);
  assert.equal((await pool.query('select * from phone_inventory_legacy_archive')).rowCount, 4);
  assert.equal(
    (await pool.query("select * from schema_migrations where name = 'phone_inventory_v1'"))
      .rowCount,
    1,
  );
});
