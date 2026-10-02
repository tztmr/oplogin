const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadUi(fetcher, extras = {}) {
  const elements = new Map();
  const listeners = new Map();
  const make = () => ({
    value: '',
    textContent: '',
    disabled: false,
    hidden: false,
    checked: false,
    indeterminate: false,
    children: [],
    dataset: {},
    attributes: {},
    listeners: new Map(),
    appendChild(child) { this.children.push(child); },
    replaceChildren(...children) { this.children = children; },
    setAttribute(name, value) { this.attributes[name] = value; },
    addEventListener(name, listener) { this.listeners.set(name, listener); },
    dispatchEvent(event) { this.listeners.get(event.type)?.(event); },
    close() { this.closed = true; this.opened = false; this.dispatchEvent({ type: 'close' }); },
    showModal() { this.opened = true; this.closed = false; },
    querySelectorAll() { return []; },
  });
  const element = (id) => { if (!elements.has(id)) elements.set(id, make()); return elements.get(id); };
  const toasts = [];
  const sandbox = {
    URL, URLSearchParams, document: { getElementById: element, createElement: make },
    window: { addEventListener(name, fn) { listeners.set(name, fn); } },
    adminFetch: fetcher,
    formatDateTime: (value) => value || '',
    showToast(message) { toasts.push(message); },
    showConfirm: extras.showConfirm || (async () => true),
  };
  vm.createContext(sandbox);
  const file = path.join(__dirname, '../public/admin/phone-inventory.js');
  if (fs.existsSync(file)) vm.runInContext(fs.readFileSync(file, 'utf8'), sandbox);
  return { sandbox, element, listeners, toasts };
}
const data = (number = '13000000001') => ({ page: 1, pageSize: 20, total: 1, items: [{
  id: '11111111-1111-4111-8111-111111111111',
  phoneNumber: number, phoneSmsUrl: 'https://example.test/sms', status: 'available', phoneModel: '14',
}] });

test('phone inventory renders real rows with three status labels and safe SMS links', async () => {
  const response = data();
  response.items = ['available', 'reserved', 'bound', 'after_sale'].map((status, index) => ({
    ...response.items[0],
    id: `11111111-1111-4111-8111-11111111111${index}`,
    status,
  }));
  response.items[3].phoneSmsUrl = 'javascript:alert(1)';
  response.items[3].phoneNumber = '<img src=x onerror=alert(1)>';
  const { sandbox, element } = loadUi(async () => response);
  assert.equal(typeof sandbox.loadPhoneInventory, 'function');
  await sandbox.loadPhoneInventory();
  const rows = element('phoneInventoryTableBody').children;
  assert.equal(rows.length, 4);
  assert.equal(rows[0].children[0].children[0].type, 'checkbox');
  assert.deepEqual(rows.map((row) => row.children[2].textContent), ['未绑定', '未绑定', '已绑定', '老号售后']);
  assert.equal(rows[1].children[3].textContent, '已提取');
  assert.equal(rows[0].children[4].children[0].href, 'https://example.test/sms');
  assert.equal(rows[3].children[4].children.length, 0);
  assert.equal(rows[3].children[1].textContent, '<img src=x onerror=alert(1)>');
});

test('phone inventory row status action updates only that phone and preserves other selections', async () => {
  const response = data();
  const first = response.items[0];
  const second = { ...first, id: '22222222-2222-4222-8222-222222222222', phoneNumber: '13000000002', status: 'bound' };
  response.items.push(second);
  const requests = [];
  const { sandbox, element } = loadUi(async (url, options = {}) => {
    if (url.endsWith('/batch-status')) {
      requests.push(JSON.parse(options.body));
      second.status = 'reserved';
      return { updatedCount: 1 };
    }
    return response;
  });
  await sandbox.loadPhoneInventory();
  sandbox.togglePhoneInventorySelection(first.id, true);
  const extractionCell = element('phoneInventoryTableBody').children[1].children[3];
  const button = extractionCell.children.find((child) => child.textContent === '修改状态');
  assert.ok(button, 'each extraction cell has a status action');
  button.dispatchEvent({ type: 'click' });
  assert.equal(element('phoneInventoryStatusDialog').opened, true);
  assert.equal(element('phoneInventoryStatusDialogTitle').textContent, '修改手机号状态');
  assert.match(element('phoneInventoryStatusTarget').textContent, /13000000002.*已入库/);
  assert.equal(element('phoneInventoryStatusSelect').value, 'bound');
  element('phoneInventoryStatusSelect').value = 'reserved';
  await sandbox.submitPhoneInventoryStatusForm({ preventDefault() {} });
  assert.deepEqual(requests, [{ ids: [second.id], status: 'reserved' }]);
  assert.equal(element('phoneInventoryTableBody').children[1].children[3].textContent, '已提取');
  assert.deepEqual(Array.from(sandbox.getSelectedPhoneInventoryIds()), [first.id]);
  assert.equal(element('phoneInventoryTableBody').children[0].children[0].children[0].checked, true);
});

test('phone inventory status dialog keeps its target while saving and allows retry on failure', async () => {
  const item = { ...data().items[0], status: 'reserved' };
  const pending = [];
  const requests = [];
  const { sandbox, element } = loadUi(async (url, options = {}) => {
    if (!url.endsWith('/batch-status')) return { ...data(), items: [item] };
    requests.push(JSON.parse(options.body));
    return new Promise((resolve, reject) => pending.push({ resolve, reject }));
  });
  sandbox.initializePhoneInventory();
  await sandbox.loadPhoneInventory();
  const button = element('phoneInventoryTableBody').children[0].children[3].children[0];
  assert.ok(button, 'reserved phones have a status action');
  button.dispatchEvent({ type: 'click' });
  assert.equal(element('phoneInventoryStatusSelect').value, 'reserved');
  assert.match(element('phoneInventoryStatusTarget').textContent, /已提取/);
  element('phoneInventoryStatusSelect').value = 'unbound';
  const saving = sandbox.submitPhoneInventoryStatusForm({ preventDefault() {} });
  assert.equal(element('phoneInventoryStatusSubmitButton').disabled, true);
  assert.equal(element('phoneInventoryStatusCancelButton').disabled, true);
  await sandbox.submitPhoneInventoryStatusForm({ preventDefault() {} });
  assert.equal(requests.length, 1);
  const failed = assert.rejects(saving, /network test/);
  pending[0].reject(new Error('network test'));
  await failed;
  assert.equal(element('phoneInventoryStatusDialog').opened, true);
  assert.equal(element('phoneInventoryStatusSubmitButton').disabled, false);
  const retry = sandbox.submitPhoneInventoryStatusForm({ preventDefault() {} });
  pending[1].resolve({ updatedCount: 1 });
  await retry;
  assert.deepEqual(requests, [
    { ids: [item.id], status: 'unbound' },
    { ids: [item.id], status: 'unbound' },
  ]);
  assert.equal(element('phoneInventoryStatusDialog').closed, true);
});

test('phone inventory batch status targets the selection captured when the dialog opened', async () => {
  const first = data().items[0];
  const second = { ...first, id: '22222222-2222-4222-8222-222222222222', phoneNumber: '13000000002' };
  const requests = [];
  const { sandbox, element } = loadUi(async (url, options = {}) => {
    if (url.endsWith('/batch-status')) {
      requests.push(JSON.parse(options.body));
      return { updatedCount: 1 };
    }
    return { ...data(), items: [first, second] };
  });
  await sandbox.loadPhoneInventory();
  sandbox.togglePhoneInventorySelection(first.id, true);
  sandbox.openPhoneInventoryStatusDialog();
  sandbox.togglePhoneInventorySelection(first.id, false);
  sandbox.togglePhoneInventorySelection(second.id, true);
  element('phoneInventoryStatusSelect').value = 'after_sale';
  await sandbox.submitPhoneInventoryStatusForm({ preventDefault() {} });
  assert.deepEqual(requests, [{ ids: [first.id], status: 'after_sale' }]);
  assert.deepEqual(Array.from(sandbox.getSelectedPhoneInventoryIds()), [second.id]);
});

test('phone inventory ignores stale responses and reports fetch failure without claiming an empty stock', async () => {
  const pending = [];
  const { sandbox, element } = loadUi(() => new Promise((resolve, reject) => pending.push({ resolve, reject })));
  assert.equal(typeof sandbox.loadPhoneInventory, 'function');
  const old = sandbox.loadPhoneInventory();
  const recent = sandbox.loadPhoneInventory();
  pending[1].resolve(data('20002')); await recent;
  pending[0].resolve(data('10001')); await old;
  assert.equal(element('phoneInventoryTableBody').children[0].children[1].textContent, '20002');
  const failed = sandbox.loadPhoneInventory(); pending[2].reject(new Error('network test')); await failed;
  assert.match(element('phoneInventoryLoadStatus').textContent, /加载失败/);
  const retry = sandbox.loadPhoneInventory(); pending[3].resolve(data('30003')); await retry;
  assert.equal(element('phoneInventoryTableBody').children[0].children[1].textContent, '30003');
});

test('successful phone import refreshes the actual inventory table and clears hiding filters', async () => {
  let imported = false;
  const { sandbox, element } = loadUi(async (url) => {
    if (url.endsWith('/import-text')) { imported = true; return { importedCount: 1, updatedCount: 0, skippedCount: 0 }; }
    const query = new URL(url, 'http://localhost').searchParams;
    assert.equal(query.get('search'), null);
    assert.equal(query.get('status'), null);
    assert.equal(query.get('page'), '1');
    return imported ? data('40004') : { ...data(), items: [], total: 0 };
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/admin/records.js'), 'utf8'), sandbox);
  element('phoneInventorySearch').value = 'old filter';
  element('phoneInventoryStatusFilter').value = 'bound';
  element('phoneImportText').value = '40004----https://example.test/sms';
  element('phoneImportDurationDays').value = '30';
  await sandbox.submitPhoneImportForm({ preventDefault() {} });
  assert.equal(element('phoneInventoryTableBody').children.length, 1);
  assert.equal(element('phoneInventoryTableBody').children[0].children[1].textContent, '40004');
  assert.equal(element('phoneImportDialog').closed, true);
});

test('phone inventory batch delete and status actions follow the selected ids', async () => {
  const requests = [];
  const item = data().items[0];
  const { sandbox, element, toasts } = loadUi(async (url, options = {}) => {
    requests.push({ url, options });
    if (String(url).includes('/batch-delete')) return { deletedCount: 1 };
    if (String(url).includes('/batch-status')) return { updatedCount: 1 };
    if (requests.some((request) => String(request.url).includes('/batch-'))) {
      return { ...data(), items: [], total: 0 };
    }
    return data();
  });
  await sandbox.loadPhoneInventory();
  assert.equal(element('phoneInventoryBatchDeleteButton').disabled, true);
  assert.equal(element('phoneInventoryBatchStatusButton').disabled, true);
  sandbox.togglePhoneInventorySelection(item.id, true);
  assert.equal(element('phoneInventoryBatchDeleteButton').disabled, false);
  assert.match(element('phoneInventoryBatchDeleteButton').textContent, /批量删除手机号 \(1\)/);
  assert.match(element('phoneInventoryBatchStatusButton').textContent, /批量更改手机号状态 \(1\)/);
  await sandbox.deleteSelectedPhoneInventory();
  assert.equal(requests[1].url, '/api/admin/records/phone-inventory/batch-delete');
  assert.deepEqual(JSON.parse(requests[1].options.body), { ids: [item.id] });
  assert.match(toasts[0], /已删除 1 个手机号/);
  sandbox.togglePhoneInventorySelection(item.id, true);
  sandbox.openPhoneInventoryStatusDialog();
  element('phoneInventoryStatusSelect').value = 'after_sale';
  assert.equal(element('phoneInventoryStatusDialog').opened, true);
  await sandbox.submitPhoneInventoryStatusForm({ preventDefault() {} });
  const statusRequest = requests.find((request) => String(request.url).includes('/batch-status'));
  assert.deepEqual(JSON.parse(statusRequest.options.body), { ids: [item.id], status: 'after_sale' });
  assert.equal(element('phoneInventoryStatusDialog').closed, true);
});
