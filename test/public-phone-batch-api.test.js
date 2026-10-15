const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createAdminTestContext } = require('./helpers/create-admin-test-context');
const { createAdminUser } = require('../lib/admin-users');
const { encryptGooglePassword, buildGooglePasswordSearchHash } = require('../lib/google-password-crypto');

async function fixture(t, { recordCount = 6, groupCount = 2, requestPhoneSmsImpl } = {}) {
  const context = await createAdminTestContext({}, { requestPhoneSmsImpl });
  t.after(() => context.pool.end());
  // pg-mem otherwise selects the partial active-record index for history reads.
  await context.pool.query('drop index idx_phone_inventory_active_record');
  const user = await createAdminUser(context.pool, {
    login: 'batch-phones', email: 'batch-phones@example.test', password: 'change-me-now', role: 'operator',
  });
  await context.pool.query('update admin_users set queue_group_count=$1 where id=$2', [groupCount, user.id]);
  for (let index = 0; index < recordCount; index += 1) {
    await context.pool.query(`insert into managed_records
      (id,owner_id,google_account,google_password_encrypted,google_password_search_hash,created_at,google_assist,uid_value,phone_number,op_value,op_link,remark)
      values ($1,$2,$3,$4,$5,$6,'','','','','','')`, [
      crypto.randomUUID(), user.id, `batch-${index}@example.test`,
      encryptGooglePassword('secret', context.config.googlePasswordEncryptionKey),
      buildGooglePasswordSearchHash('secret', context.config.googlePasswordEncryptionKey),
      new Date(Date.UTC(2024, 0, index + 1)),
    ]);
  }
  const view = await context.agent.get('/api/public/user/batch-phones/batch');
  assert.equal(view.status, 200);
  return { ...context, user, batch: view.body.batch };
}

async function addPhone(f, overrides = {}) {
  const row = {
    id: crypto.randomUUID(), ownerId: f.user.id, phoneNumber: crypto.randomUUID(),
    phoneSmsUrl: 'https://sms.example.test/read', status: 'available', recordId: null,
    createdAt: '2024-01-01T00:00:00Z', expireAt: '2099-01-01T00:00:00Z', ...overrides,
  };
  await f.pool.query(`insert into phone_inventory
    (id,owner_id,phone_number,phone_sms_url,status,reserved_record_id,created_at,phone_expire_at)
    values ($1,$2,$3,$4,$5,$6,$7,$8)`, [
    row.id, row.ownerId, row.phoneNumber, row.phoneSmsUrl, row.status, row.recordId, row.createdAt, row.expireAt,
  ]);
  return row;
}
const endpoint = (action) => `/api/public/user/batch-phones/batch/phone/${action}`;
const post = (f, action, body = { batchId: f.batch.id }) => f.agent.post(endpoint(action)).send(body);

test('batch extraction preserves occupied/locked slots and allocates only own unexpired FIFO inventory in slot order', async (t) => {
  const f = await fixture(t, { recordCount: 7, groupCount: 3 });
  const ids = f.batch.slots.map((slot) => slot.record?.id);
  const existing = await addPhone(f, { status: 'reserved', recordId: ids[0], phoneNumber: '13000000001' });
  await f.pool.query("update managed_records set phone_status='已绑定',phone_number='13000000002' where id=$1", [ids[1]]);
  await f.pool.query("update managed_records set uid_value='already-saved' where id=$1", [ids[2]]);
  await f.pool.query(`insert into phone_inventory_legacy_archive
    (id,migration_name,source_record_id,owner_id,phone_number,phone_model,phone_connected,phone_status,source_created_at,source_updated_at,archive_reason)
    values ($1,'batch-test',$2,$3,'legacy-bound','12mini','未连接','已绑定',now(),now(),'duplicate')`,
  [crypto.randomUUID(), ids[3], f.user.id]);
  const foreign = await createAdminUser(f.pool, { login: 'foreign', email: 'foreign@example.test', password: 'change-me-now', role: 'operator' });
  await addPhone(f, { ownerId: foreign.id, createdAt: '2020-01-01T00:00:00Z' });
  await addPhone(f, { expireAt: '2020-01-01T00:00:00Z' });
  const second = await addPhone(f, { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', phoneNumber: '13000000006' });
  const first = await addPhone(f, { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', phoneNumber: '13000000005' });
  const response = await post(f, 'extract');
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.equal(response.body.batch.id, f.batch.id);
  assert.deepEqual(response.body.results.map(({ slot, status }) => [slot, status]), [
    [1, 'skipped'], [2, 'skipped'], [3, 'skipped'], [4, 'skipped'], [5, 'success'],
    [6, 'success'], [7, 'error'], [8, 'skipped'], [9, 'skipped'],
  ]);
  assert.equal(response.body.batch.slots[0].record.phoneInventoryId, existing.id);
  assert.equal(response.body.batch.slots[4].record.phoneInventoryId, first.id);
  assert.equal(response.body.batch.slots[5].record.phoneInventoryId, second.id);
  assert.deepEqual(response.body.results[4], {
    slot: 5, recordId: ids[4], phoneNumber: '13000000005', status: 'success', message: '已提取手机号',
  });
  assert.match(response.body.results[6].message, /库存不足/);
  const retry = await post(f, 'extract');
  assert.equal(retry.status, 200);
  assert.equal(retry.body.results.filter((result) => result.status === 'success').length, 0);
  const inventory = await f.pool.query("select id from phone_inventory where owner_id=$1 and status='reserved'", [f.user.id]);
  assert.equal(inventory.rows.length, 3);
  const restocked = await addPhone(f, { phoneNumber: '13000000007' });
  const completed = await post(f, 'extract');
  assert.equal(completed.body.results[6].status, 'success');
  assert.equal(completed.body.batch.slots[6].record.phoneInventoryId, restocked.id);
});

test('batch phone actions require a current owned UUID and never create or advance a batch', async (t) => {
  let smsRequests = 0;
  const f = await fixture(t, { requestPhoneSmsImpl: async () => { smsRequests += 1; return { status: 'success', message: 'unused' }; } });
  const stranger = await createAdminUser(f.pool, { login: 'stranger', email: 'stranger@example.test', password: 'change-me-now', role: 'operator' });
  const foreignBatchId = crypto.randomUUID();
  await f.pool.query("insert into public_user_batches (id,owner_id,status) values ($1,$2,'open')", [foreignBatchId, stranger.id]);
  for (const action of ['extract', 'sms']) {
    for (const body of [{}, { batchId: 'invalid' }, { batchId: [] }]) {
      assert.equal((await post(f, action, body)).status, 400);
    }
    for (const batchId of [crypto.randomUUID(), foreignBatchId]) {
      assert.equal((await post(f, action, { batchId })).status, 409);
    }
  }
  await f.pool.query("update public_user_batches set status='released' where id=$1", [f.batch.id]);
  for (const action of ['extract', 'sms']) assert.equal((await post(f, action)).status, 409);
  assert.equal((await f.pool.query('select id from public_user_batches where owner_id=$1', [f.user.id])).rows.length, 1);
  assert.equal(smsRequests, 0);
});

test('batch SMS preserves raw responses and slot numbers, reads saved slots, ignores supplied URLs, and limits concurrency', async (t) => {
  let active = 0;
  let peak = 0;
  const rawMessage = '  <script>alert("sms")</script>\n{"code":0,"message":"暂无短信"}\n';
  const f = await fixture(t, { requestPhoneSmsImpl: async (url) => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 30));
    active -= 1;
    if (url === 'https://sms.example.test/fail?token=stored-secret') throw new Error(`request failed at ${url}`);
    if (url === 'https://sms.example.test/saved') return { status: 'success', message: 'saved phone response' };
    if (url === 'https://sms.example.test/raw') return { status: 'success', message: rawMessage };
    if (url === 'https://sms.example.test/http-error') return { status: 'error', message: '供应商完整错误原文\n', httpStatus: 503 };
    throw new Error('Unexpected request URL');
  } });
  const ids = f.batch.slots.map((slot) => slot.record.id);
  await addPhone(f, { recordId: ids[0], status: 'reserved', phoneNumber: '13000000001', phoneSmsUrl: 'https://sms.example.test/raw' });
  await f.pool.query(`update managed_records set uid_value='saved',phone_status='已绑定',phone_number='13000000002',phone_sms_url='https://sms.example.test/saved' where id=$1`, [ids[1]]);
  await addPhone(f, { recordId: ids[2], status: 'reserved', phoneNumber: '13000000003', phoneSmsUrl: 'https://sms.example.test/fail?token=stored-secret' });
  await addPhone(f, { recordId: ids[3], status: 'reserved', phoneNumber: '13000000004', phoneSmsUrl: 'https://sms.example.test/http-error' });
  await addPhone(f, { recordId: ids[4], status: 'reserved', phoneNumber: '13000000005', phoneSmsUrl: '' });
  const response = await post(f, 'sms', { batchId: f.batch.id, phoneSmsUrl: 'http://127.0.0.1/private', urls: ['http://127.0.0.1/private'] });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.equal(response.body.batchId, f.batch.id);
  assert.deepEqual(response.body.results.map(({ slot, status }) => [slot, status]), [
    [1, 'success'], [2, 'success'], [3, 'error'], [4, 'error'], [5, 'skipped'], [6, 'skipped'],
  ]);
  assert.equal(response.body.results[0].message, rawMessage);
  assert.equal(response.body.results[1].message, 'saved phone response');
  assert.equal(response.body.results[2].phoneNumber, '13000000003');
  assert.doesNotMatch(response.body.results[2].message, /stored-secret|https:/);
  assert.equal(response.body.results[3].message, '供应商完整错误原文\n');
  assert.equal(peak, 3);
});

test('batch SMS rejects results if another browser advances the batch while requests are in flight', async (t) => {
  let release;
  let started;
  const start = new Promise((resolve) => { started = resolve; });
  const finish = new Promise((resolve) => { release = resolve; });
  const f = await fixture(t, { requestPhoneSmsImpl: async () => {
    started();
    await finish;
    return { status: 'success', message: 'old batch response' };
  } });
  await addPhone(f, { status: 'reserved', recordId: f.batch.slots[0].record.id });
  const responsePromise = post(f, 'sms').then((response) => response);
  await start;
  const advance = await f.agent.post('/api/public/user/batch-phones/batch/advance').send({});
  assert.equal(advance.status, 200);
  release();
  const response = await responsePromise;
  assert.equal(response.status, 409);
  assert.equal(response.body.results, undefined);
});

test('batch phone page reads only phone slots without generating batches or exposing account secrets', async (t) => {
  const f = await fixture(t);
  await addPhone(f, { status: 'reserved', recordId: f.batch.slots[0].record.id, phoneNumber: '13000000001' });
  const path = '/api/public/user/batch-phones/batch/phone';
  const view = await f.agent.get(path).query({ batchId: f.batch.id });
  assert.equal(view.status, 200);
  assert.equal(view.body.batchId, f.batch.id);
  assert.deepEqual(view.body.slots[0], { slot: 1, recordId: f.batch.slots[0].record.id, phoneNumber: '13000000001' });
  assert.equal(view.body.slots.length, 6);
  assert.doesNotMatch(JSON.stringify(view.body), /googlePassword|googleAccount|phoneSmsUrl|secret/);
  assert.equal((await f.agent.get(path)).status, 409);
  assert.equal((await f.agent.get(path).query({ batchId: crypto.randomUUID() })).status, 409);
  await f.pool.query("update public_user_batches set status='released' where id=$1", [f.batch.id]);
  assert.equal((await f.agent.get(path).query({ batchId: f.batch.id })).status, 409);
  assert.equal((await f.pool.query('select id from public_user_batches where owner_id=$1', [f.user.id])).rows.length, 1);
});

test('batch SMS cancellation stops active requests and leaves later slots unqueried', async (t) => {
  const { readBatchPhoneSms } = require('../lib/public-user-batches');
  const f = await fixture(t);
  for (const slot of f.batch.slots) await addPhone(f, { status: 'reserved', recordId: slot.record.id });
  const controller = new AbortController();
  let started;
  let startedCount = 0;
  const start = new Promise((resolve) => { started = resolve; });
  const pending = readBatchPhoneSms(f.pool, f.config, f.user, { batchId: f.batch.id }, async (url, { signal } = {}) => {
    startedCount += 1;
    if (startedCount === 3) started();
    if (!signal) throw new Error('Abort signal missing');
    await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
    return { status: 'error', message: '已取消' };
  }, { signal: controller.signal });
  const rejected = assert.rejects(pending, { statusCode: 499 });
  await start;
  controller.abort();
  await rejected;
  assert.equal(startedCount, 3);
});

test('batch SMS rejects results if the stored phone URL changes during the request', async (t) => {
  let release;
  let started;
  const start = new Promise((resolve) => { started = resolve; });
  const finish = new Promise((resolve) => { release = resolve; });
  const f = await fixture(t, { requestPhoneSmsImpl: async () => {
    started();
    await finish;
    return { status: 'success', message: 'previous phone response' };
  } });
  const phone = await addPhone(f, { status: 'reserved', recordId: f.batch.slots[0].record.id });
  const responsePromise = post(f, 'sms').then((response) => response);
  await start;
  await f.pool.query('update phone_inventory set phone_sms_url=$1 where id=$2', ['https://sms.example.test/replaced', phone.id]);
  release();
  const response = await responsePromise;
  assert.equal(response.status, 409);
  assert.equal(response.body.results, undefined);
});

test('closing the HTTP response aborts the backend SMS operation', async (t) => {
  const http = require('node:http');
  let started;
  let cancelled;
  const start = new Promise((resolve) => { started = resolve; });
  const cancellation = new Promise((resolve) => { cancelled = resolve; });
  const f = await fixture(t, { requestPhoneSmsImpl: async (url, { signal }) => {
    started();
    await new Promise((resolve) => signal.addEventListener('abort', () => { cancelled(); resolve(); }, { once: true }));
    return { status: 'error', message: 'cancelled' };
  } });
  await addPhone(f, { status: 'reserved', recordId: f.batch.slots[0].record.id });
  const server = f.app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const request = http.request({
    hostname: '127.0.0.1', port: server.address().port, method: 'POST', path: endpoint('sms'),
    headers: { 'Content-Type': 'application/json' },
  });
  request.on('error', () => {});
  request.end(JSON.stringify({ batchId: f.batch.id }));
  await start;
  request.destroy();
  await Promise.race([cancellation, new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Backend did not cancel after disconnect')), 1000);
    cancellation.then(() => { clearTimeout(timer); resolve(); });
  })]);
});
