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
