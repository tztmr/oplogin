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
  assert.ok(recordColumns.rows.some((row) => row.column_name === 'op_link'));
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
    /check|constraint/i,
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
  await pool.query(`
    insert into short_op_records (
      id, owner_id, code, op_value, application_id, op_expire_at, status
    ) values ${recordValues(
      '00000000-0000-0000-0000-000000000107',
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
