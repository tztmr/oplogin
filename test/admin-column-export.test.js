const test = require('node:test');
const assert = require('node:assert/strict');
const { createAdminTestContext } = require('./helpers/create-admin-test-context');
const { buildManagedRecordsCsv } = require('../lib/managed-records');
const columns = require('../public/admin/record-columns');

test('selected and filtered CSV exports keep custom header/value order and stable distribution positions', async () => {
  const { agent, config } = await createAdminTestContext();
  await agent.post('/api/admin/auth/login').send({ identifier: config.initialSuperAdminLogin, password: config.initialSuperAdminPassword });
  await agent.post('/api/admin/records').send({ googleAccount: 'unselected@example.com' });
  const created = await agent.post('/api/admin/records').send({
    googleAccount: 'ordered@example.com', googlePassword: 'ordered-password', uidValue: 'UID-ordered',
    phoneNumber: '13800138000', phoneSmsUrl: 'https://example.com/sms/ordered', phoneStatus: '已绑定', phoneModel: '14',
    googleExpireAt: '2026-10-01T08:00:00.000Z', remark: 'custom export',
  });
  assert.equal(created.status, 201);
  const order = ['phoneNumber', 'uidValue', 'remark', 'distributionOrder',
    ...columns.map((column) => column.key).filter((key) => !['phoneNumber', 'uidValue', 'remark', 'distributionOrder'].includes(key))];
  for (const response of [
    await agent.post('/api/admin/records/export.csv').send({ ids: [created.body.item.id], columns: order }),
    await agent.get('/api/admin/records/export.csv').query({ googleAccount: 'ordered@example.com', columns: order.join(',') }),
  ]) {
    assert.equal(response.status, 200);
    const [header, row, ...rest] = response.text.replace(/^\uFEFF/, '').split('\n');
    assert.match(header, /^"手机号","UID","备注","分发顺位","谷歌号","谷歌密码","谷歌辅助","谷歌到期时间"/);
    assert.match(row, /^"13800138000","UID-ordered","custom export","2","ordered@example.com","ordered-password","","2026\/10\/01 16:00:00"/);
    assert.equal(header.split(',').length, 17);
    assert.equal(rest.length, 0);
    assert.doesNotMatch(response.text, /unselected@example/);
  }
});

test('custom CSV order respects operator ownership and never exports an owner field', async () => {
  const { agent, config } = await createAdminTestContext();
  await agent.post('/api/admin/auth/login').send({ identifier: config.initialSuperAdminLogin, password: config.initialSuperAdminPassword });
  const other = await agent.post('/api/admin/records').send({ googleAccount: 'private@example.com' });
  await agent.post('/api/admin/users').send({ login: 'column-operator', email: 'columns@example.com', password: 'operator-password', role: 'operator', status: 'active' });
  await agent.post('/api/admin/auth/login').send({ identifier: 'column-operator', password: 'operator-password' });
  const own = await agent.post('/api/admin/records').send({ googleAccount: 'own@example.com', phoneNumber: '12345' });
  const response = await agent.post('/api/admin/records/export.csv').send({
    ids: [own.body.item.id, other.body.item.id], columns: ['distributionOrder', 'phoneNumber'],
  });
  assert.equal(response.status, 200);
  assert.match(response.text, /"1","12345","own@example.com"/);
  assert.doesNotMatch(response.text, /private@example/);
  for (const order of [['ownerId'], ['googlePasswordEncrypted'], [], {}, ['phoneNumber', 1], '__proto__']) {
    const invalid = await agent.post('/api/admin/records/export.csv').send({ columns: order });
    assert.equal(invalid.status, 400);
    assert.match(invalid.body.error, /导出列顺序无效/);
  }
  const invalidGet = await agent.get('/api/admin/records/export.csv').query({ columns: 'phoneNumber,unknown' });
  assert.equal(invalidGet.status, 400);
});

test('CSV reordering deduplicates fields, appends missing fields and retains CSV escaping', () => {
  const csv = buildManagedRecordsCsv([{ remark: '备注,"一"\n第二行', phoneNumber: '123', googleAccount: 'test@example.com' }], ['remark', 'phoneNumber', 'remark']);
  assert.match(csv, /^\uFEFF"备注","手机号","谷歌号","谷歌密码"/);
  assert.match(csv, /\n"备注,""一""\n第二行","123","test@example.com"/);
  const header = csv.split('\n')[0];
  assert.equal(header.match(/"备注"/g).length, 1);
  assert.equal(header.split(',').length, 16);
});
