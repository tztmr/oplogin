const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

function loadPage(record) {
  const html = fs.readFileSync(path.join(__dirname, '../public/user-page.html'), 'utf8');
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  const elements = new Map();
  function element(id) {
    if (!elements.has(id)) elements.set(id, {
      value: '', textContent: '', disabled: false, hidden: false, style: {},
      classList: { toggle() {}, add() {}, remove() {} },
      removeAttribute(name) { delete this[name]; },
      addEventListener() {},
    });
    return elements.get(id);
  }
  const requests = [];
  const batch = { id: 'batch-1', slots: [{ slot: 1, status: 'available', record }] };
  const sandbox = {
    URL, URLSearchParams, console, setTimeout() {}, clearInterval() {},
    navigator: {}, localStorage: { getItem() { return ''; }, setItem() {} },
    document: { getElementById: element, querySelectorAll() { return []; } },
    window: {
      addEventListener() {}, location: { pathname: '/tester', origin: 'http://localhost' },
      createWakeUrlCache() { return { prefetch: async () => '', get: () => '' }; },
      buildUserCenterUrl: () => '', buildQrImageUrl: () => '', buildWifiQrPayload: () => '',
    },
    fetch: async (url, options) => {
      requests.push({ url, body: options.body ? JSON.parse(options.body) : undefined });
      return { ok: true, json: async () => ({ batch }) };
    },
    seedBatch: batch,
  };
  vm.createContext(sandbox);
  vm.runInContext(script, sandbox);
  vm.runInContext("username = 'tester'; currentBatch = seedBatch; currentSlotNumber = 1;", sandbox);
  return { sandbox, element, requests };
}

const baseRecord = {
  id: 'record-1', googleAccount: 'slot@example.test', googlePassword: 'password',
  opValue: 'op-test', distributionOrder: 1, total: 1,
  phoneNumber: '', phoneStatus: '', phoneInventoryId: null,
};

test('phone-less slot is selectable and offers extraction while UID is disabled', () => {
  const { sandbox, element } = loadPage({ ...baseRecord });
  assert.equal(sandbox.getFirstSelectableSlot(), 1);
  sandbox.renderSelectedSlot();
  assert.equal(element('googleAccountText').textContent, 'slot@example.test');
  assert.equal(element('extractPhoneButton').hidden, false);
  assert.equal(element('submitUidBtn').disabled, true);
});

test('reserved phone offers bind and after-sale actions, bound phone is read-only', () => {
  for (const status of ['未绑定', '已绑定']) {
    const { sandbox, element } = loadPage({
      ...baseRecord, phoneNumber: '13000000001', phoneStatus: status,
      phoneInventoryId: 'phone-1', phoneSmsUrl: 'https://example.test/sms',
    });
    sandbox.renderSelectedSlot();
    assert.equal(element('extractPhoneButton').hidden, true);
    assert.equal(element('markPhoneBoundButton').hidden, status === '已绑定');
    assert.equal(element('markPhoneAfterSaleButton').hidden, status === '已绑定');
    assert.equal(element('phoneModelSelect').disabled, status === '已绑定');
    assert.equal(element('submitUidBtn').disabled, status !== '已绑定');
  }
});

test('phone status mutation carries exact identities and preserves the UID draft', async () => {
  const { sandbox, element, requests } = loadPage({
    ...baseRecord, phoneNumber: '13000000001', phoneStatus: '未绑定', phoneInventoryId: 'phone-1',
  });
  sandbox.renderSelectedSlot();
  element('uid').value = '123456789';
  element('remark').value = 'keep my draft';
  await sandbox.setCurrentSlotPhoneStatus('已绑定');
  assert.equal(requests[0].url, '/api/public/user/tester/batch/slots/1/phone/status');
  assert.deepEqual(requests[0].body, {
    batchId: 'batch-1', recordId: 'record-1', phoneInventoryId: 'phone-1', phoneStatus: '已绑定',
  });
  assert.equal(element('uid').value, '123456789');
  assert.equal(element('remark').value, 'keep my draft');
});

function delayedFetch(sandbox) {
  const pending = [];
  sandbox.fetch = (url, options = {}) => new Promise((resolve) => {
    pending.push({ url, options, respond(batch, status = 200) {
      resolve({ ok: status < 400, status, json: async () => ({ batch, error: status === 409 ? '数据已变更' : undefined }) });
    } });
  });
  return pending;
}

test('delayed refresh excludes phone writes, UID saves, switching and other batch requests, preserving same-record drafts', async () => {
  const { sandbox, element } = loadPage({ ...baseRecord, phoneNumber: '13000000001', phoneStatus: '已绑定', phoneInventoryId: 'phone-1' });
  sandbox.seedBatch.slots.push({ slot: 2, status: 'available', record: { ...baseRecord, id: 'record-2' } });
  sandbox.renderSelectedSlot();
  element('uid').value = 'draft-uid';
  element('remark').value = 'draft-remark';
  const pending = delayedFetch(sandbox);
  const refresh = sandbox.refreshBatch();
  assert.equal(element('refreshBatchBtn').disabled, true);
  assert.equal(element('advanceBatchBtn').disabled, true);
  assert.equal(element('submitUidBtn').disabled, true);
  sandbox.switchSlot(2);
  await sandbox.mutateCurrentSlotPhone('phone/status', { phoneStatus: '已绑定' }, 'saved');
  await sandbox.submitUid();
  await sandbox.refreshBatch();
  await sandbox.advanceBatchGroup();
  await sandbox.loadBatch();
  assert.equal(pending.length, 1);
  assert.equal(vm.runInContext('currentSlotNumber', sandbox), 1);
  pending[0].respond(sandbox.seedBatch);
  await refresh;
  assert.equal(element('uid').value, 'draft-uid');
  assert.equal(element('remark').value, 'draft-remark');
  assert.equal(element('submitUidBtn').disabled, false);
});

test('delayed advance excludes overlapping requests and clears drafts when refreshing a changed record', async () => {
  const { sandbox, element } = loadPage({ ...baseRecord });
  sandbox.renderSelectedSlot();
  const pending = delayedFetch(sandbox);
  const advance = sandbox.advanceBatchGroup();
  assert.equal(element('refreshBatchBtn').disabled, true);
  await sandbox.extractCurrentSlotPhone();
  await sandbox.refreshBatch();
  await sandbox.advanceBatchGroup();
  assert.equal(pending.length, 1);
  const newBatch = { id: 'batch-2', slots: [{ slot: 1, status: 'available', record: { ...baseRecord, id: 'record-2' } }] };
  pending[0].respond(newBatch);
  await advance;
  assert.equal(element('refreshBatchBtn').disabled, false);
  element('uid').value = 'old-draft';
  element('remark').value = 'old-remark';
  const refresh = sandbox.refreshBatch();
  pending[1].respond({ ...newBatch, slots: [{ ...newBatch.slots[0], record: { ...baseRecord, id: 'record-3' } }] });
  await refresh;
  assert.equal(element('uid').value, '');
  assert.equal(element('remark').value, '');
});

test('UID conflict refreshes current state and preserves drafts only for matching batch and record identities', async () => {
  for (const changed of ['none', 'batch', 'record']) {
    const { sandbox, element } = loadPage({ ...baseRecord, phoneNumber: '13000000001', phoneStatus: '已绑定', phoneInventoryId: 'phone-1' });
    sandbox.renderSelectedSlot();
    element('uid').value = 'draft-uid';
    element('remark').value = 'draft-remark';
    const pending = delayedFetch(sandbox);
    const save = sandbox.submitUid();
    pending[0].respond(undefined, 409);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(pending.length, 2);
    assert.equal(pending[1].url, '/api/public/user/tester/batch');
    await sandbox.refreshBatch();
    assert.equal(pending.length, 2);
    const fresh = { id: changed === 'batch' ? 'batch-2' : 'batch-1', slots: [{ slot: 1, status: 'available', record: { ...baseRecord, id: changed === 'record' ? 'record-2' : 'record-1' } }] };
    pending[1].respond(fresh);
    await save;
    assert.equal(vm.runInContext('currentBatch.id', sandbox), fresh.id);
    assert.equal(element('uid').value, changed === 'none' ? 'draft-uid' : '');
    assert.equal(element('remark').value, changed === 'none' ? 'draft-remark' : '');
    assert.equal(element('submitUidBtn').disabled, true);
    assert.equal(element('extractPhoneButton').hidden, false);
    assert.equal(element('toast').textContent, '数据已变更');
  }
});

test('failed delayed refresh releases all controls without losing current drafts', async () => {
  const { sandbox, element } = loadPage({ ...baseRecord, phoneNumber: '13000000001', phoneStatus: '未绑定', phoneInventoryId: 'phone-1' });
  sandbox.renderSelectedSlot();
  element('uid').value = 'draft';
  element('remark').value = 'remark';
  const pending = delayedFetch(sandbox);
  const refresh = sandbox.refreshBatch();
  assert.equal(element('markPhoneBoundButton').disabled, true);
  pending[0].respond(undefined, 500);
  await refresh;
  assert.equal(element('refreshBatchBtn').disabled, false);
  assert.equal(element('markPhoneBoundButton').disabled, false);
  assert.equal(element('uid').value, 'draft');
  assert.equal(element('remark').value, 'remark');
});
