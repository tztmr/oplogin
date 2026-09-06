const test = require('node:test');
const assert = require('node:assert/strict');
const { parseManagedRecordImportText } = require('../lib/managed-records');
const { createAdminTestContext } = require('./helpers/create-admin-test-context');

for (const days of [30, 60, 90, 120, 150]) {
  test(`phone import uses the selected ${days}-day duration for every phone row`, () => {
    const before = Date.now();
    const records = parseManagedRecordImportText(
      '85251964683----https://example.com/sms/1\n85251964684----https://example.com/sms/2',
      { phoneDurationDays: days },
    );
    const after = Date.now();
    assert.equal(records.length, 2);
    for (const record of records) {
      const expires = Date.parse(record.data.phoneExpireAt);
      assert.ok(expires >= before + days * 86400000);
      assert.ok(expires <= after + days * 86400000);
    }
  });
}

test('phone duration does not change Google or OP expiry in mixed imports', () => {
  const before = Date.now();
  const records = parseManagedRecordImportText(
    '85251964683----https://example.com/sms\nkeep@example.com----password----assist\nopenid|access|pay|unused|1900000000',
    { phoneDurationDays: 120 },
  );
  const after = Date.now();
  const googleExpires = Date.parse(records[1].data.googleExpireAt);
  assert.ok(googleExpires >= before + 7 * 86400000);
  assert.ok(googleExpires <= after + 7 * 86400000);
  assert.equal(Date.parse(records[2].data.opExpireAt), 1900000000000 + 30 * 86400000);
});

test('phone import API stores selected duration and rejects unsupported durations without importing', async () => {
  const { agent, config } = await createAdminTestContext();
  await agent.post('/api/admin/auth/login').send({
    identifier: config.initialSuperAdminLogin,
    password: config.initialSuperAdminPassword,
  });
  for (const days of [0, 45, -30, 151, 'invalid', null, [30]]) {
    const response = await agent.post('/api/admin/records/import-text').send({
      rowsText: '85251964683----https://example.com/sms',
      phoneDurationDays: days,
    });
    assert.equal(response.status, 400);
  }
  assert.equal((await agent.get('/api/admin/records')).body.total, 0);

  const before = Date.now();
  const response = await agent.post('/api/admin/records/import-text').send({
    rowsText: '85251964683----https://example.com/sms',
    phoneDurationDays: 90,
  });
  const after = Date.now();
  assert.equal(response.status, 201);
  const stored = await agent.get(`/api/admin/records/${response.body.items[0].id}`);
  const expires = Date.parse(stored.body.item.phoneExpireAt);
  assert.ok(expires >= before + 90 * 86400000);
  assert.ok(expires <= after + 90 * 86400000);
});
