const test = require('node:test');
const assert = require('node:assert/strict');
const { newDb } = require('pg-mem');

const {
  encryptGooglePassword,
  decryptGooglePassword,
  buildGooglePasswordSearchHash,
} = require('../lib/google-password-crypto');
const { ensureDatabaseSchema } = require('../lib/schema');

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
