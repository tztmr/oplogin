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

let managedRecordInsertOffset = 0;

async function insertManagedRecord(pool, config, ownerId, overrides = {}) {
  const googlePassword = Object.prototype.hasOwnProperty.call(overrides, 'googlePassword')
    ? overrides.googlePassword
    : 'secret-pass';
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
    googleAccount: Object.prototype.hasOwnProperty.call(overrides, 'googleAccount')
      ? overrides.googleAccount
      : `${crypto.randomUUID()}@gmail.com`,
    googleAssist: Object.prototype.hasOwnProperty.call(overrides, 'googleAssist')
      ? overrides.googleAssist
      : 'assist@example.com',
    uidValue: Object.prototype.hasOwnProperty.call(overrides, 'uidValue')
      ? overrides.uidValue
      : '',
    phoneNumber: Object.prototype.hasOwnProperty.call(overrides, 'phoneNumber')
      ? overrides.phoneNumber
      : `138${String(managedRecordInsertOffset + 1).padStart(8, '0')}`,
    phoneSmsUrl: Object.prototype.hasOwnProperty.call(overrides, 'phoneSmsUrl')
      ? overrides.phoneSmsUrl
      : '',
    phoneExpireAt: Object.prototype.hasOwnProperty.call(overrides, 'phoneExpireAt')
      ? overrides.phoneExpireAt
      : null,
    phoneStatus: Object.prototype.hasOwnProperty.call(overrides, 'phoneStatus')
      ? overrides.phoneStatus
      : '未绑定',
    phoneModel: Object.prototype.hasOwnProperty.call(overrides, 'phoneModel')
      ? overrides.phoneModel
      : '12mini',
    opValue: Object.prototype.hasOwnProperty.call(overrides, 'opValue')
      ? overrides.opValue
      : '',
    opLink: Object.prototype.hasOwnProperty.call(overrides, 'opLink')
      ? overrides.opLink
      : '',
    remark: Object.prototype.hasOwnProperty.call(overrides, 'remark')
      ? overrides.remark
      : '',
    createdAt:
      overrides.createdAt ||
      new Date(Date.UTC(2024, 0, 1, 0, 0, 0, managedRecordInsertOffset += 1)).toISOString(),
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
        phone_number,
        phone_sms_url,
        phone_expire_at,
        phone_status,
        phone_model,
        op_value,
        op_link,
        remark,
        created_at,
        updated_at
      )
      values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
    `,
    [
      payload.id,
      payload.ownerId,
      payload.googleAccount,
      encryptedPassword,
      passwordHash,
      payload.googleAssist,
      payload.uidValue,
      payload.phoneNumber,
      payload.phoneSmsUrl,
      payload.phoneExpireAt,
      payload.phoneStatus,
      payload.phoneModel,
      payload.opValue,
      payload.opLink,
      payload.remark,
      payload.createdAt,
      payload.createdAt,
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

test('public user record API supports fixed quick slot jumps for the first available records', async () => {
  const { app, pool, config } = await createAdminTestContext();
  const operator = await createAdminUser(pool, {
    login: 'lz',
    email: 'lz@example.com',
    password: 'change-me-now',
    role: 'operator',
  });

  for (let index = 1; index <= 7; index += 1) {
    await insertManagedRecord(pool, config, operator.id, {
      googleAccount: `used-${index}@gmail.com`,
      opValue: `used-${index}`,
      uidValue: `uid-${index}`,
    });
  }

  await insertManagedRecord(pool, config, operator.id, {
    googleAccount: 'available-8@gmail.com',
    opValue: 'op-8',
  });
  await insertManagedRecord(pool, config, operator.id, {
    googleAccount: 'available-9@gmail.com',
    opValue: 'op-9',
  });
  await insertManagedRecord(pool, config, operator.id, {
    googleAccount: 'available-10@gmail.com',
    opValue: 'op-10',
  });

  const firstResponse = await request(app).get('/api/public/user/lz/record');
  const secondSlotResponse = await request(app)
    .get('/api/public/user/lz/record')
    .query({ jumpSlot: 2 });

  assert.equal(firstResponse.status, 200);
  assert.equal(firstResponse.body.record.distributionOrder, 8);
  assert.equal(firstResponse.body.record.availableCount, 3);

  assert.equal(secondSlotResponse.status, 200);
  assert.equal(secondSlotResponse.body.record.distributionOrder, 9);
  assert.equal(secondSlotResponse.body.record.googleAccount, 'available-9@gmail.com');
  assert.equal(secondSlotResponse.body.record.availableCount, 3);
});

test('public user batch API keeps fixed slots after partial submissions', async () => {
  const { app, pool, config } = await createAdminTestContext();
  const operator = await createAdminUser(pool, {
    login: 'lz',
    email: 'lz@example.com',
    password: 'change-me-now',
    role: 'operator',
  });

  const records = [];
  for (let index = 1; index <= 6; index += 1) {
    records.push(
      await insertManagedRecord(pool, config, operator.id, {
        googleAccount: `batch-${index}@gmail.com`,
        opValue: `batch-${index}`,
      }),
    );
  }

  const firstBatchResponse = await request(app).get('/api/public/user/lz/batch');
  assert.equal(firstBatchResponse.status, 200);
  assert.equal(firstBatchResponse.body.batch.slots.length, 6);
  assert.deepEqual(
    firstBatchResponse.body.batch.slots.map((slot) => slot.record && slot.record.id),
    records.map((record) => record.id),
  );
  assert.deepEqual(
    firstBatchResponse.body.batch.slots.map((slot) => slot.status),
    ['available', 'available', 'available', 'available', 'available', 'available'],
  );

  const saveThirdResponse = await request(app)
    .post('/api/public/user/lz/batch/slots/3/uid')
    .send({ uid: 'slot-3-uid', remark: 'done third' });
  const saveSixthResponse = await request(app)
    .post('/api/public/user/lz/batch/slots/6/uid')
    .send({ uid: 'slot-6-uid', remark: 'done sixth' });

  assert.equal(saveThirdResponse.status, 200);
  assert.equal(saveSixthResponse.status, 200);

  const refreshedBatchResponse = await request(app).get('/api/public/user/lz/batch');
  assert.equal(refreshedBatchResponse.status, 200);
  assert.equal(
    refreshedBatchResponse.body.batch.id,
    firstBatchResponse.body.batch.id,
  );
  assert.deepEqual(
    refreshedBatchResponse.body.batch.slots.map((slot) => slot.record && slot.record.id),
    records.map((record) => record.id),
  );
  assert.deepEqual(
    refreshedBatchResponse.body.batch.slots.map((slot) => slot.status),
    ['available', 'available', 'done', 'available', 'available', 'done'],
  );

  const thirdRow = await pool.query(
    'select uid_value, remark from managed_records where id = $1',
    [records[2].id],
  );
  const sixthRow = await pool.query(
    'select uid_value, remark from managed_records where id = $1',
    [records[5].id],
  );
  assert.equal(thirdRow.rows[0].uid_value, 'slot-3-uid');
  assert.equal(thirdRow.rows[0].remark, 'done third');
  assert.equal(sixthRow.rows[0].uid_value, 'slot-6-uid');
  assert.equal(sixthRow.rows[0].remark, 'done sixth');
});

test('public user batch API preserves distribution order for microsecond timestamps', async () => {
  const { app, pool, config } = await createAdminTestContext();
  const operator = await createAdminUser(pool, {
    login: 'lz',
    email: 'lz@example.com',
    password: 'change-me-now',
    role: 'operator',
  });

  await insertManagedRecord(pool, config, operator.id, {
    googleAccount: 'micro-1@gmail.com',
    opValue: 'micro-1',
    createdAt: '2024-01-01T00:00:00.123456Z',
  });
  await insertManagedRecord(pool, config, operator.id, {
    googleAccount: 'micro-2@gmail.com',
    opValue: 'micro-2',
    createdAt: '2024-01-01T00:00:00.123789Z',
  });

  const batchResponse = await request(app).get('/api/public/user/lz/batch');

  assert.equal(batchResponse.status, 200);
  assert.equal(batchResponse.body.batch.slots[0].record.distributionOrder, 1);
  assert.equal(batchResponse.body.batch.slots[0].record.total, 2);
  assert.equal(batchResponse.body.batch.slots[1].record.distributionOrder, 2);
  assert.equal(batchResponse.body.batch.slots[1].record.total, 2);
});

test('public user batch API only includes records with google account, password, op, phone, and blank uid', async () => {
  const { app, pool, config } = await createAdminTestContext();
  const operator = await createAdminUser(pool, {
    login: 'lz',
    email: 'lz@example.com',
    password: 'change-me-now',
    role: 'operator',
  });

  const eligible = await insertManagedRecord(pool, config, operator.id, {
    googleAccount: 'eligible@gmail.com',
    googlePassword: 'eligible-pass',
    opValue: 'eligible-op',
    phoneNumber: '13800000001',
    uidValue: '',
  });
  await insertManagedRecord(pool, config, operator.id, {
    googleAccount: 'missing-password@gmail.com',
    googlePassword: '',
    opValue: 'missing-password-op',
    uidValue: '',
  });
  await insertManagedRecord(pool, config, operator.id, {
    googleAccount: 'missing-op@gmail.com',
    googlePassword: 'has-pass',
    opValue: '',
    uidValue: '',
  });
  await insertManagedRecord(pool, config, operator.id, {
    googleAccount: '',
    googlePassword: 'has-pass',
    opValue: 'missing-google-op',
    uidValue: '',
  });
  await insertManagedRecord(pool, config, operator.id, {
    googleAccount: 'used@gmail.com',
    googlePassword: 'used-pass',
    opValue: 'used-op',
    uidValue: 'already-used',
  });
  await insertManagedRecord(pool, config, operator.id, {
    googleAccount: 'missing-phone@gmail.com',
    googlePassword: 'has-pass',
    opValue: 'missing-phone-op',
    phoneNumber: '',
    uidValue: '',
  });

  const batchResponse = await request(app).get('/api/public/user/lz/batch');

  assert.equal(batchResponse.status, 200);
  assert.equal(batchResponse.body.batch.slots[0].record.id, eligible.id);
  assert.deepEqual(
    batchResponse.body.batch.slots.map((slot) => slot.status),
    ['available', 'empty', 'empty', 'empty', 'empty', 'empty'],
  );
});

test('public user batch API skips records without phone numbers and fills vacant slots with new phone stock', async () => {
  const { app, pool, config } = await createAdminTestContext();
  const operator = await createAdminUser(pool, {
    login: 'wb',
    email: 'wb@example.com',
    password: 'change-me-now',
    role: 'operator',
  });

  const firstWithPhone = await insertManagedRecord(pool, config, operator.id, {
    googleAccount: 'phone-1@gmail.com',
    opValue: 'phone-1',
    phoneNumber: '13800000001',
  });
  const secondWithPhone = await insertManagedRecord(pool, config, operator.id, {
    googleAccount: 'phone-2@gmail.com',
    opValue: 'phone-2',
    phoneNumber: '13800000002',
  });
  for (let index = 1; index <= 6; index += 1) {
    await insertManagedRecord(pool, config, operator.id, {
      googleAccount: `no-phone-${index}@gmail.com`,
      opValue: `no-phone-${index}`,
      phoneNumber: '',
    });
  }

  const firstBatchResponse = await request(app).get('/api/public/user/wb/batch');
  assert.equal(firstBatchResponse.status, 200);
  assert.deepEqual(
    firstBatchResponse.body.batch.slots.map((slot) => slot.record && slot.record.id),
    [firstWithPhone.id, secondWithPhone.id, null, null, null, null],
  );

  const extraWithPhone = [];
  for (let index = 3; index <= 6; index += 1) {
    extraWithPhone.push(
      await insertManagedRecord(pool, config, operator.id, {
        googleAccount: `phone-${index}@gmail.com`,
        opValue: `phone-${index}`,
        phoneNumber: `1380000000${index}`,
      }),
    );
  }

  const refilledResponse = await request(app).get('/api/public/user/wb/batch');
  assert.equal(refilledResponse.status, 200);
  assert.equal(refilledResponse.body.batch.id, firstBatchResponse.body.batch.id);
  assert.deepEqual(
    refilledResponse.body.batch.slots.map((slot) => slot.record && slot.record.id),
    [
      firstWithPhone.id,
      secondWithPhone.id,
      extraWithPhone[0].id,
      extraWithPhone[1].id,
      extraWithPhone[2].id,
      extraWithPhone[3].id,
    ],
  );
});

test('public user batch GET replaces leftover no-phone slot occupants with new phone stock', async () => {
  const { app, pool, config } = await createAdminTestContext();
  const operator = await createAdminUser(pool, {
    login: 'wb',
    email: 'wb@example.com',
    password: 'change-me-now',
    role: 'operator',
  });

  const firstWithPhone = await insertManagedRecord(pool, config, operator.id, {
    googleAccount: 'keep-phone@gmail.com',
    opValue: 'keep-phone',
    phoneNumber: '13800000001',
  });
  const firstBatchResponse = await request(app).get('/api/public/user/wb/batch');
  assert.equal(firstBatchResponse.status, 200);
  assert.equal(firstBatchResponse.body.batch.slots[0].record.id, firstWithPhone.id);

  const leftoverNoPhone = await insertManagedRecord(pool, config, operator.id, {
    googleAccount: 'stuck-no-phone@gmail.com',
    opValue: 'stuck-no-phone',
    phoneNumber: '',
  });
  await pool.query(
    `
      update public_user_batch_slots
      set record_id = $1, status = 'available', updated_at = now()
      where batch_id = $2 and slot_number = 2
    `,
    [leftoverNoPhone.id, firstBatchResponse.body.batch.id],
  );

  const replacementWithPhone = await insertManagedRecord(pool, config, operator.id, {
    googleAccount: 'replacement-phone@gmail.com',
    opValue: 'replacement-phone',
    phoneNumber: '13800000002',
  });

  const refilledResponse = await request(app).get('/api/public/user/wb/batch');
  assert.equal(refilledResponse.status, 200);
  assert.equal(refilledResponse.body.batch.id, firstBatchResponse.body.batch.id);
  assert.deepEqual(
    refilledResponse.body.batch.slots.map((slot) => slot.record && slot.record.id),
    [firstWithPhone.id, replacementWithPhone.id, null, null, null, null],
  );
});

test('public user batch advance drops leftover records without phones and pulls new phone stock', async () => {
  const { app, pool, config } = await createAdminTestContext();
  const operator = await createAdminUser(pool, {
    login: 'wb',
    email: 'wb@example.com',
    password: 'change-me-now',
    role: 'operator',
  });

  const firstWithPhone = await insertManagedRecord(pool, config, operator.id, {
    googleAccount: 'keep-1@gmail.com',
    opValue: 'keep-1',
    phoneNumber: '13800000001',
  });
  const secondWithPhone = await insertManagedRecord(pool, config, operator.id, {
    googleAccount: 'keep-2@gmail.com',
    opValue: 'keep-2',
    phoneNumber: '13800000002',
  });
  await insertManagedRecord(pool, config, operator.id, {
    googleAccount: 'skip-no-phone@gmail.com',
    opValue: 'skip-no-phone',
    phoneNumber: '',
  });
  const nextWithPhone = await insertManagedRecord(pool, config, operator.id, {
    googleAccount: 'next-phone@gmail.com',
    opValue: 'next-phone',
    phoneNumber: '13800000003',
  });

  const firstBatchResponse = await request(app).get('/api/public/user/wb/batch');
  assert.equal(firstBatchResponse.status, 200);

  const nextBatchResponse = await request(app)
    .post('/api/public/user/wb/batch/advance')
    .send({});

  assert.equal(nextBatchResponse.status, 200);
  assert.notEqual(nextBatchResponse.body.batch.id, firstBatchResponse.body.batch.id);
  assert.deepEqual(
    nextBatchResponse.body.batch.slots.map((slot) => slot.record && slot.record.id),
    [firstWithPhone.id, secondWithPhone.id, nextWithPhone.id, null, null, null],
  );
});

test('public user batch API carries abandoned remaining slots into the next batch before filling new stock', async () => {
  const { app, pool, config } = await createAdminTestContext();
  const operator = await createAdminUser(pool, {
    login: 'lz',
    email: 'lz@example.com',
    password: 'change-me-now',
    role: 'operator',
  });

  const records = [];
  for (let index = 1; index <= 8; index += 1) {
    records.push(
      await insertManagedRecord(pool, config, operator.id, {
        googleAccount: `next-${index}@gmail.com`,
        opValue: `next-${index}`,
      }),
    );
  }

  const firstBatchResponse = await request(app).get('/api/public/user/lz/batch');
  assert.equal(firstBatchResponse.status, 200);

  const saveFirstResponse = await request(app)
    .post('/api/public/user/lz/batch/slots/1/uid')
    .send({ uid: 'slot-1-uid' });
  const saveSecondResponse = await request(app)
    .post('/api/public/user/lz/batch/slots/2/uid')
    .send({ uid: 'slot-2-uid' });

  assert.equal(saveFirstResponse.status, 200);
  assert.equal(saveSecondResponse.status, 200);

  const nextBatchResponse = await request(app)
    .post('/api/public/user/lz/batch/advance')
    .send({});

  assert.equal(nextBatchResponse.status, 200);
  assert.notEqual(nextBatchResponse.body.batch.id, firstBatchResponse.body.batch.id);
  assert.deepEqual(
    nextBatchResponse.body.batch.slots.map((slot) => slot.status),
    ['available', 'available', 'available', 'available', 'available', 'available'],
  );
  assert.deepEqual(
    nextBatchResponse.body.batch.slots.map((slot) => slot.record && slot.record.id),
    [
      records[2].id,
      records[3].id,
      records[4].id,
      records[5].id,
      records[6].id,
      records[7].id,
    ],
  );
});

test('public user batch API rebuilds an empty open batch when new eligible records appear', async () => {
  const { app, pool, config } = await createAdminTestContext();
  const operator = await createAdminUser(pool, {
    login: 'lz',
    email: 'lz@example.com',
    password: 'change-me-now',
    role: 'operator',
  });

  const emptyBatchResponse = await request(app).get('/api/public/user/lz/batch');

  assert.equal(emptyBatchResponse.status, 200);
  assert.deepEqual(
    emptyBatchResponse.body.batch.slots.map((slot) => slot.status),
    ['empty', 'empty', 'empty', 'empty', 'empty', 'empty'],
  );

  const eligible = await insertManagedRecord(pool, config, operator.id, {
    googleAccount: 'fresh@gmail.com',
    opValue: 'fresh-op',
  });

  const refreshedBatchResponse = await request(app).get('/api/public/user/lz/batch');

  assert.equal(refreshedBatchResponse.status, 200);
  assert.notEqual(refreshedBatchResponse.body.batch.id, emptyBatchResponse.body.batch.id);
  assert.equal(refreshedBatchResponse.body.batch.slots[0].record.id, eligible.id);
  assert.deepEqual(
    refreshedBatchResponse.body.batch.slots.map((slot) => slot.status),
    ['available', 'empty', 'empty', 'empty', 'empty', 'empty'],
  );
});

test('public user batch API advances past a consumed open batch with cleared slot records when new stock exists', async () => {
  const { app, pool, config } = await createAdminTestContext();
  const operator = await createAdminUser(pool, {
    login: 'lz',
    email: 'lz@example.com',
    password: 'change-me-now',
    role: 'operator',
  });

  const initialRecords = [];
  for (let index = 1; index <= 6; index += 1) {
    initialRecords.push(
      await insertManagedRecord(pool, config, operator.id, {
        googleAccount: `consumed-${index}@gmail.com`,
        opValue: `consumed-${index}`,
      }),
    );
  }

  const firstBatchResponse = await request(app).get('/api/public/user/lz/batch');
  assert.equal(firstBatchResponse.status, 200);

  for (let slotNumber = 1; slotNumber <= 6; slotNumber += 1) {
    const saveResponse = await request(app)
      .post(`/api/public/user/lz/batch/slots/${slotNumber}/uid`)
      .send({ uid: `done-${slotNumber}` });
    assert.equal(saveResponse.status, 200);
  }

  await pool.query(
    'delete from managed_records where id = any($1::uuid[])',
    [initialRecords.map((record) => record.id)],
  );

  const nextRecord = await insertManagedRecord(pool, config, operator.id, {
    googleAccount: 'next-batch@gmail.com',
    opValue: 'next-batch-op',
  });

  const refreshedBatchResponse = await request(app).get('/api/public/user/lz/batch');
  assert.equal(refreshedBatchResponse.status, 200);
  assert.notEqual(refreshedBatchResponse.body.batch.id, firstBatchResponse.body.batch.id);
  assert.equal(refreshedBatchResponse.body.batch.slots[0].record.id, nextRecord.id);
  assert.deepEqual(
    refreshedBatchResponse.body.batch.slots.map((slot) => slot.status),
    ['available', 'empty', 'empty', 'empty', 'empty', 'empty'],
  );
});

test('public user page renders fixed batch slot actions', async () => {
  const { app, pool } = await createAdminTestContext();
  await createAdminUser(pool, {
    login: 'lz',
    email: 'lz@example.com',
    password: 'change-me-now',
    role: 'operator',
  });

  const response = await request(app).get('/lz');

  assert.equal(response.status, 200);
  assert.match(response.text, /id="quickSlotButtons"/);
  assert.match(response.text, /\.quick-slot-buttons\s*\{[\s\S]*grid-template-columns:\s*repeat\(3,\s*minmax\(0,\s*1fr\)\);/);
  assert.match(response.text, /switchSlot\(1\)/);
  assert.match(response.text, /switchSlot\(6\)/);
  assert.match(response.text, /function renderBatchSlots\(/);
  assert.match(response.text, /id="refreshBatchBtn"/);
  assert.match(response.text, /刷新本组/);
  assert.match(response.text, /id="advanceBatchBtn"/);
  assert.match(response.text, /放弃剩余并换组/);
  assert.match(response.text, /quick-slot-button slot-available/);
  assert.match(response.text, /quick-slot-button slot-done/);
  assert.match(response.text, /quick-slot-button slot-empty/);
});

test('public user page disables browser caching and batch fetch uses no-store', async () => {
  const { app, pool } = await createAdminTestContext();
  await createAdminUser(pool, {
    login: 'lz',
    email: 'lz@example.com',
    password: 'change-me-now',
    role: 'operator',
  });

  const response = await request(app).get('/lz');

  assert.equal(response.status, 200);
  assert.equal(
    response.headers['cache-control'],
    'no-store, no-cache, must-revalidate, proxy-revalidate',
  );
  assert.equal(response.headers.pragma, 'no-cache');
  assert.equal(response.headers.expires, '0');
  assert.equal(response.headers['surrogate-control'], 'no-store');
  assert.match(
    response.text,
    /fetch\(`\/api\/public\/user\/\$\{encodeURIComponent\(username\)\}\/batch`,\s*\{\s*cache: 'no-store',/s,
  );
});

test('public user page caches remark input locally', async () => {
  const { app, pool } = await createAdminTestContext();
  await createAdminUser(pool, {
    login: 'lz',
    email: 'lz@example.com',
    password: 'change-me-now',
    role: 'operator',
  });

  const response = await request(app).get('/lz');

  assert.equal(response.status, 200);
  assert.match(response.text, /function getRemarkDraftStorageKey\(\)/);
  assert.match(response.text, /localStorage\.getItem\(getRemarkDraftStorageKey\(\)\)/);
  assert.match(response.text, /localStorage\.setItem\(getRemarkDraftStorageKey\(\), value\)/);
  assert.match(response.text, /document\.getElementById\('remark'\)\.addEventListener\('input'/);
  assert.doesNotMatch(response.text, /document\.getElementById\('uid'\)\.addEventListener\('input'/);
  assert.doesNotMatch(response.text, /localStorage\.removeItem\(getRemarkDraftStorageKey\(\)\)/);
});

test('public user page keeps the current slot selected after saving uid', async () => {
  const { app, pool } = await createAdminTestContext();
  await createAdminUser(pool, {
    login: 'lz',
    email: 'lz@example.com',
    password: 'change-me-now',
    role: 'operator',
  });

  const response = await request(app).get('/lz');

  assert.equal(response.status, 200);
  assert.match(response.text, /currentBatch = data\.batch;/);
  assert.doesNotMatch(response.text, /const nextSlot = getNextAvailableSlot\(currentSlotNumber\);/);
  assert.doesNotMatch(response.text, /currentSlotNumber = nextSlot \|\| currentSlotNumber;/);
});

test('public user page auto-fills uid from numeric clipboard content when uid is unused', async () => {
  const { app, pool } = await createAdminTestContext();
  await createAdminUser(pool, {
    login: 'lz',
    email: 'lz@example.com',
    password: 'change-me-now',
    role: 'operator',
  });

  const response = await request(app).get('/lz');

  assert.equal(response.status, 200);
  assert.match(response.text, /navigator\.clipboard\.readText\(\)/);
  assert.match(response.text, /uid-availability\?uid=\$\{encodeURIComponent\(uidValue\)\}/);
  assert.match(response.text, /!\/\^\\d\+\$\/\.test\(clipboardText\)/);
  assert.match(response.text, /document\.getElementById\('uid'\)\.value = clipboardText;/);
});

test('public user uid availability API rejects existing numeric uid values', async () => {
  const { app, pool, config } = await createAdminTestContext();
  const operator = await createAdminUser(pool, {
    login: 'lz',
    email: 'lz@example.com',
    password: 'change-me-now',
    role: 'operator',
  });
  await insertManagedRecord(pool, config, operator.id, {
    googleAccount: 'used-uid@gmail.com',
    uidValue: '123456',
    opValue: 'used-op',
  });

  const existingResponse = await request(app)
    .get('/api/public/user/lz/uid-availability')
    .query({ uid: '123456' });
  const availableResponse = await request(app)
    .get('/api/public/user/lz/uid-availability')
    .query({ uid: '987654' });

  assert.equal(existingResponse.status, 200);
  assert.equal(
    existingResponse.headers['cache-control'],
    'no-store, no-cache, must-revalidate, proxy-revalidate',
  );
  assert.deepEqual(existingResponse.body, { uid: '123456', available: false });
  assert.equal(availableResponse.status, 200);
  assert.deepEqual(availableResponse.body, { uid: '987654', available: true });
});

test('public user batch submit rejects duplicated uid values', async () => {
  const { app, pool, config } = await createAdminTestContext();
  const operator = await createAdminUser(pool, {
    login: 'lz',
    email: 'lz@example.com',
    password: 'change-me-now',
    role: 'operator',
  });
  await insertManagedRecord(pool, config, operator.id, {
    googleAccount: 'used-uid@gmail.com',
    uidValue: 'dup-uid-001',
    opValue: 'used-op',
  });
  await insertManagedRecord(pool, config, operator.id, {
    googleAccount: 'available-submit@gmail.com',
    opValue: 'submit-op',
  });

  const batchResponse = await request(app).get('/api/public/user/lz/batch');
  const submitResponse = await request(app)
    .post('/api/public/user/lz/batch/slots/1/uid')
    .send({ uid: 'dup-uid-001' });

  assert.equal(batchResponse.status, 200);
  assert.equal(submitResponse.status, 400);
  assert.deepEqual(submitResponse.body, { error: 'UID 已存在，请勿重复提交' });
});

test('public user batch API returns wifi qr config for the user center', async () => {
  const { app, pool, config } = await createAdminTestContext();
  const operator = await createAdminUser(pool, {
    login: 'mxw',
    email: 'mxw@example.com',
    password: 'change-me-now',
    role: 'operator',
  });
  await pool.query(
    `
      update admin_users
      set wifi_type = 'WPA',
          wifi_ssid = '888800000',
          wifi_password = 'qq123456',
          wifi_hidden = false
      where id = $1
    `,
    [operator.id],
  );
  await insertManagedRecord(pool, config, operator.id, {
    googleAccount: 'qr-user@gmail.com',
    opValue: 'qr-op',
  });

  const response = await request(app).get('/api/public/user/mxw/batch');

  assert.equal(response.status, 200);
  assert.equal(
    response.headers['cache-control'],
    'no-store, no-cache, must-revalidate, proxy-revalidate',
  );
  assert.deepEqual(response.body.qrConfig, {
    login: 'mxw',
    wifiQrConfig: {
      type: 'WPA',
      ssid: '888800000',
      password: 'qq123456',
      hidden: false,
    },
  });
});

test('public user batch exposes phone fields and marks phone status bound', async () => {
  const { app, pool, config } = await createAdminTestContext();
  const operator = await createAdminUser(pool, {
    login: 'phone-user',
    email: 'phone-user@example.com',
    password: 'change-me-now',
    role: 'operator',
  });
  const record = await insertManagedRecord(pool, config, operator.id, {
    googleAccount: 'phone-bind@gmail.com',
    opValue: 'phone-bind-op',
    phoneNumber: '+86 13037174892',
    phoneSmsUrl: 'https://sms.example.test/read',
    phoneExpireAt: '2026-10-04T00:00:00.000Z',
    phoneStatus: '未绑定',
    phoneModel: '12mini',
  });

  const batchResponse = await request(app).get('/api/public/user/phone-user/batch');
  assert.equal(batchResponse.status, 200);
  assert.deepEqual(
    {
      phoneNumber: batchResponse.body.batch.slots[0].record.phoneNumber,
      phoneSmsUrl: batchResponse.body.batch.slots[0].record.phoneSmsUrl,
      phoneExpireAt: batchResponse.body.batch.slots[0].record.phoneExpireAt,
      phoneStatus: batchResponse.body.batch.slots[0].record.phoneStatus,
      phoneModel: batchResponse.body.batch.slots[0].record.phoneModel,
    },
    {
      phoneNumber: '+86 13037174892',
      phoneSmsUrl: 'https://sms.example.test/read',
      phoneExpireAt: '2026-10-04T00:00:00.000Z',
      phoneStatus: '未绑定',
      phoneModel: '12mini',
    },
  );

  const bindResponse = await request(app)
    .post('/api/public/user/phone-user/batch/slots/1/phone/bind')
    .send({});
  assert.equal(bindResponse.status, 200);
  const boundRecord = bindResponse.body.batch.slots.find(
    (slot) => slot.record && slot.record.id === record.id,
  );
  assert.equal(boundRecord.record.phoneStatus, '已绑定');
  const boundResult = await pool.query(
    'select phone_status from managed_records where id = $1',
    [record.id],
  );
  assert.equal(boundResult.rows[0].phone_status, '已绑定');

  const unbindResponse = await request(app)
    .post('/api/public/user/phone-user/batch/slots/1/phone/bind')
    .send({ phoneStatus: '未绑定' });
  assert.equal(unbindResponse.status, 200);
  const unboundResult = await pool.query(
    'select phone_status from managed_records where id = $1',
    [record.id],
  );
  assert.equal(unboundResult.rows[0].phone_status, '未绑定');

  const modelResponse = await request(app)
    .put('/api/public/user/phone-user/batch/slots/1/phone-model')
    .send({ phoneModel: '14' });
  assert.equal(modelResponse.status, 200);
  const modelResult = await pool.query(
    'select phone_model from managed_records where id = $1',
    [record.id],
  );
  assert.equal(modelResult.rows[0].phone_model, '14');
});

test('public user phone bind rejects records without a phone number', async () => {
  const { app, pool, config } = await createAdminTestContext();
  const operator = await createAdminUser(pool, {
    login: 'no-phone',
    email: 'no-phone@example.com',
    password: 'change-me-now',
    role: 'operator',
  });
  await insertManagedRecord(pool, config, operator.id, {
    googleAccount: 'no-phone@gmail.com',
    opValue: 'no-phone-op',
    phoneNumber: '',
  });

  const batchResponse = await request(app).get('/api/public/user/no-phone/batch');
  assert.equal(batchResponse.status, 200);
  assert.deepEqual(
    batchResponse.body.batch.slots.map((slot) => slot.status),
    ['empty', 'empty', 'empty', 'empty', 'empty', 'empty'],
  );

  const response = await request(app)
    .post('/api/public/user/no-phone/batch/slots/1/phone/bind')
    .send({});

  assert.equal(response.status, 400);
  assert.deepEqual(response.body, {
    error: '当前槽位没有可提交的数据',
  });
});

test('public user page renders left and right qr card placeholders', async () => {
  const { app, pool } = await createAdminTestContext();
  await createAdminUser(pool, {
    login: 'mxw',
    email: 'mxw@example.com',
    password: 'change-me-now',
    role: 'operator',
  });

  const response = await request(app).get('/mxw');

  assert.equal(response.status, 200);
  assert.match(response.text, /id="userCenterQrImage"/);
  assert.match(response.text, /id="wifiQrImage"/);
  assert.match(response.text, /id="bindPhoneNumberButton"/);
  assert.match(response.text, /id="phoneStatusButton"/);
  assert.match(response.text, /id="phoneSmsUrlLink"/);
  assert.match(response.text, /id="phoneModelSelect"/);
  assert.match(response.text, /<option value="11">11<\/option>/);
  assert.match(response.text, /<option value="12mini" selected>12mini<\/option>/);
  assert.match(response.text, /<option value="14">14<\/option>/);
  assert.match(response.text, /<option value="x">x<\/option>/);
  assert.match(response.text, /buildWifiQrPayload/);
  assert.match(response.text, /buildQrImageUrl/);
});

test('public user page hides qr cards on mobile and highlights selected slot in blue', async () => {
  const { app, pool } = await createAdminTestContext();
  await createAdminUser(pool, {
    login: 'mxw',
    email: 'mxw@example.com',
    password: 'change-me-now',
    role: 'operator',
  });

  const response = await request(app).get('/mxw');

  assert.equal(response.status, 200);
  assert.match(
    response.text,
    /@media \(max-width: 640px\)\s*\{[\s\S]*\.qr-card-grid\s*\{[\s\S]*display:\s*none;/,
  );
  assert.match(response.text, /\.quick-slot-button\.is-active\s*\{[\s\S]*background:\s*#3b82f6;/);
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

test('public user record API rejects duplicated uid values on submit', async () => {
  const { app, pool, config } = await createAdminTestContext();
  const operator = await createAdminUser(pool, {
    login: 'lz',
    email: 'lz@example.com',
    password: 'change-me-now',
    role: 'operator',
  });
  await insertManagedRecord(pool, config, operator.id, {
    googleAccount: 'used-submit@gmail.com',
    uidValue: 'dup-record-uid',
    opValue: 'used-submit-op',
  });
  const record = await insertManagedRecord(pool, config, operator.id, {
    googleAccount: 'new-submit@gmail.com',
    opValue: 'new-submit-op',
  });

  const submitResponse = await request(app)
    .post(`/api/public/user/lz/record/${record.id}/uid`)
    .send({ uid: 'dup-record-uid', remark: 'test remark' });

  assert.equal(submitResponse.status, 400);
  assert.deepEqual(submitResponse.body, { error: 'UID 已存在，请勿重复提交' });
});
