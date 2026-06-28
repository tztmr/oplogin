const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const { createAdminTestContext } = require('./helpers/create-admin-test-context');
const { hashAdminPassword } = require('../lib/admin-password');

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
  const { agent, pool, config } = await createAdminTestContext();

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
  assert.equal(response.body.items[0].opExpireAt, '2026-06-11T21:09:19.000Z');
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
  assert.equal(updateResponse.body.item.opExpireAt, '2026-06-11T21:09:19.000Z');
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
    /谷歌号,谷歌密码,谷歌辅助,谷歌到期时间,UID,UID创建时间,OP,OP链接,OP到期时间,备注/,
  );
  assert.match(response.text, /csv-match@gmail\.com/);
  assert.match(response.text, /csv-pass-1/);
  assert.match(response.text, /assist-1/);
  assert.match(response.text, /remark-1/);
  assert.doesNotMatch(response.text, /csv-other@gmail\.com/);
});
