const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const request = require('supertest');

const { createAdminTestContext } = require('./helpers/create-admin-test-context');
const { createAdminUser } = require('../lib/admin-users');
const {
  encryptGooglePassword,
  buildGooglePasswordSearchHash,
} = require('../lib/google-password-crypto');

async function insertManagedRecord(pool, config, ownerId, overrides = {}) {
  const googlePassword = overrides.googlePassword || 'secret-pass';
  const encryptedPassword = encryptGooglePassword(
    googlePassword,
    config.googlePasswordEncryptionKey,
  );
  const passwordHash = buildGooglePasswordSearchHash(
    googlePassword,
    config.googlePasswordEncryptionKey,
  );

  const payload = {
    id: crypto.randomUUID(),
    ownerId,
    googleAccount: overrides.googleAccount || `${crypto.randomUUID()}@gmail.com`,
    googleAssist: overrides.googleAssist || 'assist@example.com',
    uidValue: overrides.uidValue || '',
    opValue: overrides.opValue || '',
    opLink: overrides.opLink || '',
    remark: overrides.remark || '',
  };

  await pool.query(
    `
      insert into managed_records (
        id,
        owner_id,
        google_account,
        google_password_encrypted,
        google_password_search_hash,
        google_assist,
        uid_value,
        op_value,
        op_link,
        remark
      )
      values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
    `,
    [
      payload.id,
      payload.ownerId,
      payload.googleAccount,
      encryptedPassword,
      passwordHash,
      payload.googleAssist,
      payload.uidValue,
      payload.opValue,
      payload.opLink,
      payload.remark,
    ],
  );

  return payload;
}

test('public user record API supports previous and next available records', async () => {
  const { app, pool, config } = await createAdminTestContext();
  const operator = await createAdminUser(pool, {
    login: 'lz',
    email: 'lz@example.com',
    password: 'change-me-now',
    role: 'operator',
  });

  const first = await insertManagedRecord(pool, config, operator.id, {
    googleAccount: 'first@gmail.com',
    opValue: 'op-first',
  });
  const second = await insertManagedRecord(pool, config, operator.id, {
    googleAccount: 'second@gmail.com',
    opValue: 'op-second',
  });
  const third = await insertManagedRecord(pool, config, operator.id, {
    googleAccount: 'third@gmail.com',
    opValue: 'op-third',
  });

  const firstResponse = await request(app).get('/api/public/user/lz/record');
  const nextResponse = await request(app)
    .get('/api/public/user/lz/record')
    .query({ currentRecordId: first.id, direction: 'next' });
  const previousResponse = await request(app)
    .get('/api/public/user/lz/record')
    .query({ currentRecordId: second.id, direction: 'prev' });
  const lastResponse = await request(app)
    .get('/api/public/user/lz/record')
    .query({ currentRecordId: second.id, direction: 'next' });

  assert.equal(firstResponse.status, 200);
  assert.equal(firstResponse.body.record.googleAccount, 'first@gmail.com');
  assert.equal(firstResponse.body.record.hasPrevious, false);
  assert.equal(firstResponse.body.record.hasNext, true);

  assert.equal(nextResponse.status, 200);
  assert.equal(nextResponse.body.record.id, second.id);
  assert.equal(nextResponse.body.record.googleAccount, 'second@gmail.com');
  assert.equal(nextResponse.body.record.hasPrevious, true);
  assert.equal(nextResponse.body.record.hasNext, true);

  assert.equal(previousResponse.status, 200);
  assert.equal(previousResponse.body.record.id, first.id);
  assert.equal(previousResponse.body.record.hasPrevious, false);
  assert.equal(previousResponse.body.record.hasNext, true);

  assert.equal(lastResponse.status, 200);
  assert.equal(lastResponse.body.record.id, third.id);
  assert.equal(lastResponse.body.record.hasPrevious, true);
  assert.equal(lastResponse.body.record.hasNext, false);
});

test('public user page renders previous and next account buttons', async () => {
  const { app, pool } = await createAdminTestContext();
  await createAdminUser(pool, {
    login: 'lz',
    email: 'lz@example.com',
    password: 'change-me-now',
    role: 'operator',
  });

  const response = await request(app).get('/lz');

  assert.equal(response.status, 200);
  assert.match(response.text, /id="previousRecordBtn"/);
  assert.match(response.text, /上一个账号/);
  assert.match(response.text, /id="nextRecordBtn"/);
  assert.match(response.text, /下一个账号/);
  assert.match(response.text, /let canGoPrevious = false;/);
  assert.match(response.text, /let canGoNext = false;/);
  assert.match(response.text, /showToast\('当前已经是第一条账号'/);
  assert.match(response.text, /showToast\('当前已经是最后一条账号'/);
});

test('public user record API supports submitting uid and remark', async () => {
  const { app, pool, config } = await createAdminTestContext();
  const operator = await createAdminUser(pool, {
    login: 'lz',
    email: 'lz@example.com',
    password: 'change-me-now',
    role: 'operator',
  });

  const record = await insertManagedRecord(pool, config, operator.id, {
    googleAccount: 'submit@gmail.com',
    opValue: 'op-submit',
  });

  const submitResponse = await request(app)
    .post(`/api/public/user/lz/record/${record.id}/uid`)
    .send({ uid: 'user-uid-123', remark: 'test remark' });

  assert.equal(submitResponse.status, 200);
  assert.equal(submitResponse.body.status, 'success');

  const updatedResult = await pool.query('select uid_value, remark from managed_records where id = $1', [record.id]);
  assert.equal(updatedResult.rows[0].uid_value, 'user-uid-123');
  assert.equal(updatedResult.rows[0].remark, 'test remark');
});
