const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const { parsePhoneInventoryImportText } = require('../lib/phone-inventory');
const { hashAdminPassword } = require('../lib/admin-password');
const { createAdminTestContext } = require('./helpers/create-admin-test-context');

const FIXED_NOW = Date.parse('2026-09-08T00:00:00.000Z');

async function login(agent, identifier, password) {
  const response = await agent.post('/api/admin/auth/login').send({ identifier, password });
  assert.equal(response.status, 200);
}

for (const days of [30, 60, 90, 120, 150]) {
  test(`dedicated phone parser applies the selected ${days}-day duration`, () => {
    const items = parsePhoneInventoryImportText(
      '85251964683----https://example.com/sms/1\n+86 139 0013 9000----http://example.com/sms/2',
      { durationDays: days, now: FIXED_NOW },
    );

    assert.deepEqual(items, [
      {
        phoneNumber: '85251964683',
        phoneSmsUrl: 'https://example.com/sms/1',
        phoneExpireAt: new Date(FIXED_NOW + days * 86400000).toISOString(),
        phoneModel: '12mini',
      },
      {
        phoneNumber: '+86 139 0013 9000',
        phoneSmsUrl: 'http://example.com/sms/2',
        phoneExpireAt: new Date(FIXED_NOW + days * 86400000).toISOString(),
        phoneModel: '12mini',
      },
    ]);
  });
}

test('dedicated phone parser rejects malformed phones, rows, URLs, and durations with line numbers', () => {
  const cases = [
    { text: '', options: {}, message: /请先输入要导入的手机号/ },
    { text: 'not-a-phone----https://example.com', options: {}, message: /第 1 行.*手机号/ },
    { text: '123----https://example.com----extra', options: {}, message: /第 1 行/ },
    { text: '123----ftp://example.com', options: {}, message: /第 1 行.*HTTP/ },
    { text: '123----not-a-url', options: {}, message: /第 1 行.*接码链接/ },
    { text: '123----https://example.com', options: { durationDays: null }, message: /30.*60.*90.*120.*150/ },
    { text: '123----https://example.com', options: { durationDays: [30] }, message: /30.*60.*90.*120.*150/ },
    { text: '123----https://example.com', options: { durationDays: 45 }, message: /30.*60.*90.*120.*150/ },
  ];

  for (const { text, options, message } of cases) {
    assert.throws(
      () => parsePhoneInventoryImportText(text, { ...options, now: FIXED_NOW }),
      (error) => error.statusCode === 400 && message.test(error.message),
    );
  }
});

test('dedicated phone import stores inventory for the authenticated owner and no managed records', async () => {
  const { agent, pool, config } = await createAdminTestContext();
  await login(agent, config.initialSuperAdminLogin, config.initialSuperAdminPassword);
  const owner = await pool.query('select id from admin_users where login = $1', [config.initialSuperAdminLogin]);

  const response = await agent.post('/api/admin/records/phone-inventory/import-text').send({
    rowsText: '85251964683----https://example.com/sms',
    phoneDurationDays: 90,
    ownerId: crypto.randomUUID(),
  });

  assert.equal(response.status, 201);
  assert.deepEqual(
    [response.body.importedCount, response.body.updatedCount, response.body.skippedCount],
    [1, 0, 0],
  );
  assert.equal(response.body.items[0].ownerId, owner.rows[0].id);
  assert.equal(response.body.items[0].phoneNumber, '85251964683');
  assert.equal(response.body.items[0].status, 'available');
  assert.equal(response.body.items[0].phoneModel, '12mini');
  assert.equal((await agent.get('/api/admin/records')).body.total, 0);
  assert.equal((await pool.query('select count(*)::int as count from phone_inventory')).rows[0].count, 1);
});

test('same phone is owner-scoped and duplicate import updates available inventory', async () => {
  const { agent, pool, config } = await createAdminTestContext();
  await login(agent, config.initialSuperAdminLogin, config.initialSuperAdminPassword);
  const first = await agent.post('/api/admin/records/phone-inventory/import-text').send({
    rowsText: '85251964683----https://example.com/first',
    phoneDurationDays: 30,
  });
  const second = await agent.post('/api/admin/records/phone-inventory/import-text').send({
    rowsText: '85251964683----https://example.com/renewed',
    phoneDurationDays: 150,
  });

  const operatorId = crypto.randomUUID();
  await pool.query(
    `insert into admin_users (id, login, email, password_hash, role, status)
     values ($1, 'inventory-owner', 'inventory-owner@example.com', $2, 'operator', 'active')`,
    [operatorId, await hashAdminPassword('operator-pass')],
  );
  await login(agent, 'inventory-owner', 'operator-pass');
  const third = await agent.post('/api/admin/records/phone-inventory/import-text').send({
    rowsText: '85251964683----https://example.com/operator',
  });

  assert.deepEqual([first.body.importedCount, first.body.updatedCount], [1, 0]);
  assert.deepEqual(
    [second.body.importedCount, second.body.updatedCount, second.body.skippedCount],
    [0, 1, 0],
  );
  assert.equal(second.body.items[0].phoneSmsUrl, 'https://example.com/renewed');
  assert.deepEqual(
    [third.body.importedCount, third.body.updatedCount, third.body.skippedCount],
    [1, 0, 0],
  );
  assert.equal(third.body.items[0].ownerId, operatorId);
  const inventory = await pool.query(
    'select owner_id from phone_inventory where phone_number = $1 order by owner_id',
    ['85251964683'],
  );
  assert.equal(inventory.rowCount, 2);
});

test('duplicate reserved inventory refreshes import fields but terminal history is immutable', async () => {
  const { agent, pool, config } = await createAdminTestContext();
  await login(agent, config.initialSuperAdminLogin, config.initialSuperAdminPassword);
  const initial = await agent.post('/api/admin/records/phone-inventory/import-text').send({
    rowsText: [
      '10001----https://example.com/reserved',
      '10002----https://example.com/after-sale',
      '10003----https://example.com/bound',
    ].join('\n'),
  });
  const reservedAt = '2026-09-01T00:00:00.000Z';
  const afterSaleAt = '2026-09-02T00:00:00.000Z';
  const boundAt = '2026-09-03T00:00:00.000Z';
  await pool.query(
    `update phone_inventory
     set status = 'reserved', reserved_at = $1, phone_model = '14'
     where id = $2`,
    [reservedAt, initial.body.items[0].id],
  );
  await pool.query(
    `update phone_inventory set status = 'after_sale', after_sale_at = $1 where id = $2`,
    [afterSaleAt, initial.body.items[1].id],
  );
  await pool.query(
    `update phone_inventory set status = 'bound', bound_at = $1 where id = $2`,
    [boundAt, initial.body.items[2].id],
  );

  const response = await agent.post('/api/admin/records/phone-inventory/import-text').send({
    rowsText: [
      '10001----https://example.com/reserved-new',
      '10002----https://example.com/after-sale-new',
      '10003----https://example.com/bound-new',
    ].join('\n'),
    phoneDurationDays: 60,
  });

  assert.deepEqual(
    [response.body.importedCount, response.body.updatedCount, response.body.skippedCount],
    [0, 1, 2],
  );
  assert.equal(response.body.items[0].status, 'reserved');
  assert.equal(response.body.items[0].reservedAt, reservedAt);
  assert.equal(response.body.items[0].phoneModel, '14');
  assert.equal(response.body.items[0].phoneSmsUrl, 'https://example.com/reserved-new');
  assert.equal(response.body.items[1].status, 'after_sale');
  assert.equal(response.body.items[1].afterSaleAt, afterSaleAt);
  assert.equal(response.body.items[1].phoneSmsUrl, 'https://example.com/after-sale');
  assert.equal(response.body.items[2].status, 'bound');
  assert.equal(response.body.items[2].boundAt, boundAt);
  assert.equal(response.body.items[2].phoneSmsUrl, 'https://example.com/bound');
});

test('invalid phone import validates the whole request before writing rows', async () => {
  const { agent, pool, config } = await createAdminTestContext();
  await login(agent, config.initialSuperAdminLogin, config.initialSuperAdminPassword);

  for (const body of [
    {
      rowsText: '10001----https://example.com/valid\ninvalid----https://example.com/invalid',
      phoneDurationDays: 30,
    },
    { rowsText: '10001----https://example.com/valid', phoneDurationDays: 45 },
  ]) {
    const response = await agent.post('/api/admin/records/phone-inventory/import-text').send(body);
    assert.equal(response.status, 400);
  }

  assert.equal((await pool.query('select * from phone_inventory')).rowCount, 0);
  assert.equal((await agent.get('/api/admin/records')).body.total, 0);
});

test('dedicated phone import requires authentication', async () => {
  const { agent } = await createAdminTestContext();
  const response = await agent.post('/api/admin/records/phone-inventory/import-text').send({
    rowsText: '10001----https://example.com/sms',
  });
  assert.equal(response.status, 401);
});
