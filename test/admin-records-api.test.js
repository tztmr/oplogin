const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const { createAdminTestContext } = require('./helpers/create-admin-test-context');
const { hashAdminPassword } = require('../lib/admin-password');
const {
  encryptGooglePassword,
  buildGooglePasswordSearchHash,
} = require('../lib/google-password-crypto');

async function loginAsSuperAdmin(agent, config) {
  await agent.post('/api/admin/auth/login').send({
    identifier: config.initialSuperAdminLogin,
    password: config.initialSuperAdminPassword,
  });
}

test('record CRUD decrypts Google password and preserves uidCreatedAt', async () => {
  const { agent, config } = await createAdminTestContext();
  await loginAsSuperAdmin(agent, config);

  const createResponse = await agent.post('/api/admin/records').send({
    googleAccount: 'user@gmail.com',
    googlePassword: 'secret-pass',
    googleAssist: 'assist text',
    googleExpireAt: '2026-12-31T00:00:00.000Z',
    uidValue: 'uid-001',
    opValue: 'op-001',
    opLink: 'https://example.com/op/001',
    opExpireAt: '2026-12-31T00:00:00.000Z',
    remark: 'first row',
  });

  const created = createResponse.body.item;
  const updateResponse = await agent.put(`/api/admin/records/${created.id}`).send({
    googleAccount: 'user@gmail.com',
    googlePassword: 'secret-pass',
    googleAssist: 'assist text updated',
    googleExpireAt: '2026-12-31T00:00:00.000Z',
    uidValue: 'uid-001',
    opValue: 'op-001',
    opLink: 'https://example.com/op/001-updated',
    opExpireAt: '2026-12-31T00:00:00.000Z',
    remark: 'updated row',
  });

  assert.equal(createResponse.status, 201);
  assert.equal(created.googlePassword, 'secret-pass');
  assert.ok(created.uidCreatedAt);
  assert.equal(updateResponse.body.item.uidCreatedAt, created.uidCreatedAt);
});

test('record list supports plain-text filters, exact Google password filter, and date filters', async () => {
  const { agent, config } = await createAdminTestContext();
  await loginAsSuperAdmin(agent, config);

  await agent.post('/api/admin/records').send({
    googleAccount: 'filter-me@gmail.com',
    googlePassword: 'pw-123',
    googleAssist: 'assist searchable',
    googleExpireAt: '2026-12-31T00:00:00.000Z',
    uidValue: 'uid-filter',
    opValue: 'op-filter',
    opLink: 'https://example.com/filter',
    opExpireAt: '2026-12-31T00:00:00.000Z',
    remark: 'keyword',
  });

  const accountFilter = await agent
    .get('/api/admin/records')
    .query({ googleAccount: 'filter-me' });
  const passwordFilter = await agent
    .get('/api/admin/records')
    .query({ googlePassword: 'pw-123' });
  const uidDateFilter = await agent.get('/api/admin/records').query({
    uidCreatedFrom: '2000-01-01T00:00:00.000Z',
    uidCreatedTo: '2100-01-01T00:00:00.000Z',
  });
  const googleExpireFilter = await agent.get('/api/admin/records').query({
    googleExpireFrom: '2026-01-01T00:00:00.000Z',
    googleExpireTo: '2026-12-31T23:59:59.000Z',
  });
  const opExpireFilter = await agent.get('/api/admin/records').query({
    opExpireFrom: '2026-01-01T00:00:00.000Z',
    opExpireTo: '2026-12-31T23:59:59.000Z',
  });

  assert.equal(accountFilter.status, 200);
  assert.equal(accountFilter.body.items.length, 1);
  assert.equal(passwordFilter.body.items.length, 1);
  assert.equal(uidDateFilter.body.items.length, 1);
  assert.equal(googleExpireFilter.body.items.length, 1);
  assert.equal(opExpireFilter.body.items.length, 1);
});

test('operator can create and read managed records', async () => {
  const { agent, pool } = await createAdminTestContext();

  await pool.query(
    `
      insert into admin_users (id, login, email, password_hash, role, status)
      values ($1, $2, $3, $4, 'operator', 'active')
    `,
    [
      crypto.randomUUID(),
      'records-operator',
      'records-operator@example.com',
      await hashAdminPassword('operator-pass'),
    ],
  );

  await agent.post('/api/admin/auth/login').send({
    identifier: 'records-operator',
    password: 'operator-pass',
  });

  const createResponse = await agent.post('/api/admin/records').send({
    googleAccount: 'operator@gmail.com',
    googlePassword: 'operator-secret',
    googleAssist: 'operator assist',
    googleExpireAt: '2026-12-31T00:00:00.000Z',
    uidValue: 'uid-operator',
    opValue: 'op-operator',
    opLink: 'https://example.com/operator',
    opExpireAt: '2026-12-31T00:00:00.000Z',
    remark: 'operator row',
  });
  const listResponse = await agent.get('/api/admin/records');

  assert.equal(createResponse.status, 201);
  assert.equal(listResponse.status, 200);
  assert.equal(listResponse.body.items.length, 1);
});

test('record list returns stable distribution order independent from display order', async () => {
  const { agent, pool } = await createAdminTestContext();

  await pool.query(
    `
      insert into admin_users (id, login, email, password_hash, role, status)
      values ($1, $2, $3, $4, 'operator', 'active')
    `,
    [
      crypto.randomUUID(),
      'distribution-operator',
      'distribution-operator@example.com',
      await hashAdminPassword('operator-pass'),
    ],
  );

  await agent.post('/api/admin/auth/login').send({
    identifier: 'distribution-operator',
    password: 'operator-pass',
  });

  const first = await agent.post('/api/admin/records').send({
    googleAccount: 'distribution-1@gmail.com',
    googlePassword: 'distribution-pass-1',
    googleAssist: 'assist-1',
    googleExpireAt: '2026-12-31T00:00:00.000Z',
    uidValue: '',
    opValue: 'distribution-op-1',
    opLink: 'https://example.com/distribution-1',
    opExpireAt: '2026-12-31T00:00:00.000Z',
    remark: 'row-1',
  });
  const second = await agent.post('/api/admin/records').send({
    googleAccount: 'distribution-2@gmail.com',
    googlePassword: 'distribution-pass-2',
    googleAssist: 'assist-2',
    googleExpireAt: '2026-12-31T00:00:00.000Z',
    uidValue: '',
    opValue: 'distribution-op-2',
    opLink: 'https://example.com/distribution-2',
    opExpireAt: '2026-12-31T00:00:00.000Z',
    remark: 'row-2',
  });
  const third = await agent.post('/api/admin/records').send({
    googleAccount: 'distribution-3@gmail.com',
    googlePassword: 'distribution-pass-3',
    googleAssist: 'assist-3',
    googleExpireAt: '2026-12-31T00:00:00.000Z',
    uidValue: '',
    opValue: 'distribution-op-3',
    opLink: 'https://example.com/distribution-3',
    opExpireAt: '2026-12-31T00:00:00.000Z',
    remark: 'row-3',
  });

  await agent.put(`/api/admin/records/${second.body.item.id}`).send({
    googleAccount: 'distribution-2@gmail.com',
    googlePassword: 'distribution-pass-2',
    googleAssist: 'assist-2-updated',
    googleExpireAt: '2026-12-31T00:00:00.000Z',
    uidValue: '',
    opValue: 'distribution-op-2',
    opLink: 'https://example.com/distribution-2',
    opExpireAt: '2026-12-31T00:00:00.000Z',
    remark: 'row-2-updated',
  });

  const listResponse = await agent.get('/api/admin/records');

  assert.equal(listResponse.status, 200);
  assert.equal(listResponse.body.items.length, 3);

  const distributionOrderById = new Map(
    listResponse.body.items.map((item) => [item.id, item.distributionOrder]),
  );
  assert.equal(distributionOrderById.get(first.body.item.id), 1);
  assert.equal(distributionOrderById.get(second.body.item.id), 2);
  assert.equal(distributionOrderById.get(third.body.item.id), 3);
});

test('batch delete removes selected records and keeps unselected rows', async () => {
  const { agent, config } = await createAdminTestContext();
  await loginAsSuperAdmin(agent, config);

  const first = await agent.post('/api/admin/records').send({
    googleAccount: 'delete-1@gmail.com',
    googlePassword: 'delete-pass-1',
    googleAssist: 'assist-1',
    googleExpireAt: '2026-12-31T00:00:00.000Z',
    uidValue: '',
    opValue: 'op-delete-1',
    opLink: 'https://example.com/delete-1',
    opExpireAt: '2026-12-31T00:00:00.000Z',
    remark: 'delete-1',
  });
  const second = await agent.post('/api/admin/records').send({
    googleAccount: 'delete-2@gmail.com',
    googlePassword: 'delete-pass-2',
    googleAssist: 'assist-2',
    googleExpireAt: '2026-12-31T00:00:00.000Z',
    uidValue: '',
    opValue: 'op-delete-2',
    opLink: 'https://example.com/delete-2',
    opExpireAt: '2026-12-31T00:00:00.000Z',
    remark: 'delete-2',
  });
  const third = await agent.post('/api/admin/records').send({
    googleAccount: 'keep@gmail.com',
    googlePassword: 'keep-pass',
    googleAssist: 'assist-3',
    googleExpireAt: '2026-12-31T00:00:00.000Z',
    uidValue: '',
    opValue: 'op-keep',
    opLink: 'https://example.com/keep',
    opExpireAt: '2026-12-31T00:00:00.000Z',
    remark: 'keep',
  });

  const deleteResponse = await agent.post('/api/admin/records/batch-delete').send({
    ids: [first.body.item.id, second.body.item.id],
  });
  const listResponse = await agent.get('/api/admin/records');

  assert.equal(deleteResponse.status, 200);
  assert.equal(deleteResponse.body.deletedCount, 2);
  assert.equal(listResponse.body.items.length, 1);
  assert.equal(listResponse.body.items[0].id, third.body.item.id);
});

test('record list stays available when historical passwords cannot be decrypted', async () => {
  const { agent, pool, config } = await createAdminTestContext();
  await loginAsSuperAdmin(agent, config);

  const legacyKey =
    'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789';
  await pool.query(
    `
      insert into managed_records (
        id,
        owner_id,
        google_account,
        google_password_encrypted,
        google_password_search_hash,
        google_assist,
        google_expire_at,
        uid_value,
        uid_created_at,
        op_value,
        op_link,
        op_expire_at,
        remark
      ) values (
        $1, null, $2, $3, $4, $5, null, '', null, '', '', null, $6
      )
    `,
    [
      crypto.randomUUID(),
      'legacy@gmail.com',
      encryptGooglePassword('legacy-pass', legacyKey),
      buildGooglePasswordSearchHash('legacy-pass', legacyKey),
      'legacy assist',
      'legacy row',
    ],
  );

  const response = await agent.get('/api/admin/records');

  assert.equal(response.status, 200);
  assert.equal(response.body.items.length, 1);
  assert.equal(response.body.items[0].googleAccount, 'legacy@gmail.com');
  assert.equal(response.body.items[0].googlePassword, '');
  assert.equal(response.body.items[0].googlePasswordDecryptionFailed, true);
});

test('record list returns public batch eligibility stats for incomplete inventory', async () => {
  const { agent, pool, config } = await createAdminTestContext();
  const operatorId = crypto.randomUUID();
  await pool.query(
    `
      insert into admin_users (id, login, email, password_hash, role, status)
      values ($1, $2, $3, $4, 'operator', 'active')
    `,
    [
      operatorId,
      'eligibility-operator',
      'eligibility-operator@example.com',
      await hashAdminPassword('operator-pass'),
    ],
  );
  await agent.post('/api/admin/auth/login').send({
    identifier: 'eligibility-operator',
    password: 'operator-pass',
  });

  const values = [
    [
      crypto.randomUUID(),
      'eligible@gmail.com',
      'eligible-pass',
      'eligible assist',
      '',
      'eligible-op',
      'eligible row',
    ],
    [
      crypto.randomUUID(),
      'missing-password@gmail.com',
      '',
      'missing password assist',
      '',
      'missing-password-op',
      'missing password row',
    ],
    [
      crypto.randomUUID(),
      'missing-op@gmail.com',
      'missing-op-pass',
      'missing op assist',
      '',
      '',
      'missing op row',
    ],
    [
      crypto.randomUUID(),
      'used@gmail.com',
      'used-pass',
      'used assist',
      'uid-used',
      'used-op',
      'used row',
    ],
  ];

  for (const [id, googleAccount, googlePassword, googleAssist, uidValue, opValue, remark] of values) {
    await pool.query(
      `
        insert into managed_records (
          id,
          owner_id,
          google_account,
          google_password_encrypted,
          google_password_search_hash,
          google_assist,
          google_expire_at,
          uid_value,
          uid_created_at,
          op_value,
          op_link,
          op_expire_at,
          remark
        ) values (
          $1, $2, $3, $4, $5, $6, null, $7, null, $8, '', null, $9
        )
      `,
      [
        id,
        operatorId,
        googleAccount,
        encryptGooglePassword(googlePassword, config.googlePasswordEncryptionKey),
        buildGooglePasswordSearchHash(googlePassword, config.googlePasswordEncryptionKey),
        googleAssist,
        uidValue,
        opValue,
        remark,
      ],
    );
  }

  const response = await agent.get('/api/admin/records');

  assert.equal(response.status, 200);
  assert.deepEqual(response.body.publicBatchEligibility, {
    eligibleCount: 1,
    missingGoogleAccountCount: 0,
    missingGooglePasswordCount: 1,
    missingOpCount: 1,
    filledUidCount: 1,
    blockedTotalCount: 3,
  });
});

test('text import creates records and derives op link plus op expiry time', async () => {
  const { agent, config } = await createAdminTestContext();
  await loginAsSuperAdmin(agent, config);

  const opValue =
    'AD9E11313002BC4FC8C01217A304D6A9|BA8E369FEE524F5D6A4DCD3496590019|242A2540CED09DD813D0D01CCE0A6593|f131d4565ab3470029209feab7437bc8|1781212159';
  const response = await agent.post('/api/admin/records/import-text').send({
    rowsText:
      `ezbprtcqxcgpn@goosttle.top----xowyiihpoe1fx----ehi3dzlerlyki@outlook.com----${opValue}`,
  });

  assert.equal(response.status, 201);
  assert.equal(response.body.importedCount, 1);
  assert.equal(response.body.items[0].googleAccount, 'ezbprtcqxcgpn@goosttle.top');
  assert.equal(response.body.items[0].googlePassword, 'xowyiihpoe1fx');
  assert.equal(response.body.items[0].googleAssist, 'ehi3dzlerlyki@outlook.com');
  assert.equal(response.body.items[0].uidValue, '');
  assert.equal(response.body.items[0].uidCreatedAt, null);
  assert.equal(response.body.items[0].opValue, opValue);
  assert.equal(
    response.body.items[0].opLink,
    `/oplogin/${encodeURIComponent(opValue)}`,
  );
  assert.equal(response.body.items[0].opExpireAt, '2026-07-11T21:09:19.000Z');
});

test('text import keeps google account and op value unique for the same owner', async () => {
  const { agent, config } = await createAdminTestContext();
  await loginAsSuperAdmin(agent, config);

  const opValue =
    'E664A92F61406CBFACBC6731501CB3C7|E7ECF19761C547C56F64C1F7F8859075|CFCFDD188F536A7F093169DD5C20D052|523d749e2523f41e0c07cf56207837b8|1781212159';
  const rowsText = [
    `bdmcrfujvluip@goosttle.top----gqlpinw1pilsy----zdsys3rzyvbh3@outlook.com----${opValue}`,
    `bdmcrfujvluip@goosttle.top----gqlpinw1pilsy----zdsys3rzyvbh3@outlook.com----${opValue}`,
  ].join('\n');

  const response = await agent.post('/api/admin/records/import-text').send({
    rowsText,
  });
  const listResponse = await agent.get('/api/admin/records');

  assert.equal(response.status, 201);
  assert.equal(response.body.importedCount, 1);
  assert.equal(response.body.skippedCount, 1);
  assert.equal(listResponse.body.total, 1);
  assert.equal(listResponse.body.items[0].googleAccount, 'bdmcrfujvluip@goosttle.top');
  assert.equal(listResponse.body.items[0].opValue, opValue);
});

test('text import keeps google account unique across repeated import requests', async () => {
  const { agent, config } = await createAdminTestContext();
  await loginAsSuperAdmin(agent, config);

  const firstResponse = await agent.post('/api/admin/records/import-text').send({
    rowsText:
      'repeat@gmail.com----first-pass----first-assist@outlook.com',
  });
  const secondResponse = await agent.post('/api/admin/records/import-text').send({
    rowsText:
      'repeat@gmail.com----second-pass----second-assist@outlook.com',
  });
  const listResponse = await agent.get('/api/admin/records').query({
    googleAccount: 'repeat@gmail.com',
  });

  assert.equal(firstResponse.status, 201);
  assert.equal(secondResponse.status, 201);
  assert.equal(firstResponse.body.importedCount, 1);
  assert.equal(secondResponse.body.importedCount, 1);
  assert.equal(listResponse.body.total, 1);
  assert.equal(listResponse.body.items[0].googleAccount, 'repeat@gmail.com');
  assert.equal(listResponse.body.items[0].googlePassword, 'second-pass');
  assert.equal(
    listResponse.body.items[0].googleAssist,
    'second-assist@outlook.com',
  );
});

test('uidCreatedAt is written the first time a blank-uid imported record gets a uid', async () => {
  const { agent, config } = await createAdminTestContext();
  await loginAsSuperAdmin(agent, config);

  const opValue =
    'AD9E11313002BC4FC8C01217A304D6A9|BA8E369FEE524F5D6A4DCD3496590019|242A2540CED09DD813D0D01CCE0A6593|f131d4565ab3470029209feab7437bc8|1781212159';
  const importResponse = await agent.post('/api/admin/records/import-text').send({
    rowsText:
      `ezbprtcqxcgpn@goosttle.top----xowyiihpoe1fx----ehi3dzlerlyki@outlook.com----${opValue}`,
  });

  const recordId = importResponse.body.items[0].id;
  const updateResponse = await agent.put(`/api/admin/records/${recordId}`).send({
    googleAccount: 'ezbprtcqxcgpn@goosttle.top',
    googlePassword: 'xowyiihpoe1fx',
    googleAssist: 'ehi3dzlerlyki@outlook.com',
    googleExpireAt: null,
    uidValue: 'uid-filled-later',
    opValue,
    opLink: '',
    opExpireAt: null,
    remark: '',
  });

  assert.equal(updateResponse.status, 200);
  assert.equal(updateResponse.body.item.uidValue, 'uid-filled-later');
  assert.ok(updateResponse.body.item.uidCreatedAt);
  assert.equal(
    updateResponse.body.item.opLink,
    `/oplogin/${encodeURIComponent(opValue)}`,
  );
  assert.equal(updateResponse.body.item.opExpireAt, '2026-07-11T21:09:19.000Z');
});

test('CSV export returns all matching records with full columns', async () => {
  const { agent, config } = await createAdminTestContext();
  await loginAsSuperAdmin(agent, config);

  await agent.post('/api/admin/records').send({
    googleAccount: 'csv-match@gmail.com',
    googlePassword: 'csv-pass-1',
    googleAssist: 'assist-1',
    googleExpireAt: '2026-12-31T00:00:00.000Z',
    uidValue: 'uid-csv-1',
    opValue: 'op-csv-1',
    opLink: 'https://example.com/op/csv-1',
    opExpireAt: '2026-12-31T00:00:00.000Z',
    remark: 'remark-1',
  });
  await agent.post('/api/admin/records').send({
    googleAccount: 'csv-other@gmail.com',
    googlePassword: 'csv-pass-2',
    googleAssist: 'assist-2',
    googleExpireAt: '2027-01-01T00:00:00.000Z',
    uidValue: 'uid-csv-2',
    opValue: 'op-csv-2',
    opLink: 'https://example.com/op/csv-2',
    opExpireAt: '2027-01-01T00:00:00.000Z',
    remark: 'remark-2',
  });

  const response = await agent
    .get('/api/admin/records/export.csv')
    .query({ googleAccount: 'csv-match' });

  assert.equal(response.status, 200);
  assert.match(response.headers['content-type'], /^text\/csv/);
  assert.match(
    response.headers['content-disposition'],
    /attachment; filename="managed-records\.csv"/,
  );
  assert.match(
    response.text,
    /"谷歌号","谷歌密码","谷歌辅助","谷歌到期时间","UID","UID创建时间","OP","OP链接","OP到期时间","备注"/,
  );
  assert.match(response.text, /csv-match@gmail\.com/);
  assert.match(response.text, /csv-pass-1/);
  assert.match(response.text, /assist-1/);
  assert.match(response.text, /remark-1/);
  assert.doesNotMatch(response.text, /csv-other@gmail\.com/);
});

test('record list accepts pageSize=all and returns every matching row', async () => {
  const { agent, config } = await createAdminTestContext();
  await loginAsSuperAdmin(agent, config);

  for (let index = 0; index < 120; index += 1) {
    await agent.post('/api/admin/records').send({
      googleAccount: `all-${index}@gmail.com`,
      googlePassword: `all-pass-${index}`,
      googleAssist: `assist-${index}`,
      googleExpireAt: '2026-12-31T00:00:00.000Z',
      uidValue: '',
      opValue: `all-op-${index}`,
      opLink: `https://example.com/all-${index}`,
      opExpireAt: '2026-12-31T00:00:00.000Z',
      remark: `row-${index}`,
    });
  }

  const response = await agent.get('/api/admin/records').query({ pageSize: 'all' });

  assert.equal(response.status, 200);
  assert.equal(response.body.total, 120);
  assert.equal(response.body.items.length, 120);
  assert.equal(response.body.page, 1);
  assert.equal(response.body.pageSize, 120);
  assert.equal(response.body.items[0].googleAccount, 'all-119@gmail.com');
  assert.equal(response.body.items[0].distributionOrder, 120);
  assert.equal(response.body.items[119].googleAccount, 'all-0@gmail.com');
  assert.equal(response.body.items[119].distributionOrder, 1);
});

test('CSV export can return only the selected record ids', async () => {
  const { agent, config } = await createAdminTestContext();
  await loginAsSuperAdmin(agent, config);

  const first = await agent.post('/api/admin/records').send({
    googleAccount: 'selected-a@gmail.com',
    googlePassword: 'selected-pass-a',
    googleAssist: 'selected-assist-a',
    googleExpireAt: '2026-12-31T00:00:00.000Z',
    uidValue: 'selected-uid-a',
    opValue: 'selected-op-a',
    opLink: 'https://example.com/selected-a',
    opExpireAt: '2026-12-31T00:00:00.000Z',
    remark: 'selected-a',
  });
  await agent.post('/api/admin/records').send({
    googleAccount: 'selected-b@gmail.com',
    googlePassword: 'selected-pass-b',
    googleAssist: 'selected-assist-b',
    googleExpireAt: '2026-12-31T00:00:00.000Z',
    uidValue: 'selected-uid-b',
    opValue: 'selected-op-b',
    opLink: 'https://example.com/selected-b',
    opExpireAt: '2026-12-31T00:00:00.000Z',
    remark: 'selected-b',
  });

  const response = await agent.post('/api/admin/records/export.csv').send({
    ids: [first.body.item.id],
  });

  assert.equal(response.status, 200);
  assert.match(response.headers['content-type'], /^text\/csv/);
  assert.match(response.text, /selected-a@gmail\.com/);
  assert.doesNotMatch(response.text, /selected-b@gmail\.com/);
});
