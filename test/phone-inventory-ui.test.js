const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadUi(fetcher) {
  const elements = new Map();
  const listeners = new Map();
  const make = () => ({ value: '', textContent: '', disabled: false, hidden: false, children: [],
    appendChild(child) { this.children.push(child); },
    replaceChildren(...children) { this.children = children; },
    addEventListener() {}, close() { this.closed = true; },
  });
  const element = (id) => { if (!elements.has(id)) elements.set(id, make()); return elements.get(id); };
  const sandbox = {
    URL, URLSearchParams, document: { getElementById: element, createElement: make },
    window: { addEventListener(name, fn) { listeners.set(name, fn); } },
    adminFetch: fetcher, formatDateTime: (value) => value || '', showToast() {},
  };
  vm.createContext(sandbox);
  const file = path.join(__dirname, '../public/admin/phone-inventory.js');
  if (fs.existsSync(file)) vm.runInContext(fs.readFileSync(file, 'utf8'), sandbox);
  return { sandbox, element, listeners };
}
const data = (number = '13000000001') => ({ page: 1, pageSize: 20, total: 1, items: [{
  phoneNumber: number, phoneSmsUrl: 'https://example.test/sms', status: 'available', phoneModel: '14',
}] });

test('phone inventory renders real rows with three status labels and safe SMS links', async () => {
  const response = data();
  response.items = ['available', 'reserved', 'bound', 'after_sale'].map((status) => ({ ...response.items[0], status }));
  response.items[3].phoneSmsUrl = 'javascript:alert(1)';
  response.items[3].phoneNumber = '<img src=x onerror=alert(1)>';
  const { sandbox, element } = loadUi(async () => response);
  assert.equal(typeof sandbox.loadPhoneInventory, 'function');
  await sandbox.loadPhoneInventory();
  const rows = element('phoneInventoryTableBody').children;
  assert.equal(rows.length, 4);
  assert.deepEqual(rows.map((row) => row.children[1].textContent), ['未绑定', '未绑定', '已绑定', '老号售后']);
  assert.equal(rows[1].children[2].textContent, '已提取');
  assert.equal(rows[0].children[3].children[0].href, 'https://example.test/sms');
  assert.equal(rows[3].children[3].children.length, 0);
  assert.equal(rows[3].children[0].textContent, '<img src=x onerror=alert(1)>');
});

test('phone inventory ignores stale responses and reports fetch failure without claiming an empty stock', async () => {
  const pending = [];
  const { sandbox, element } = loadUi(() => new Promise((resolve, reject) => pending.push({ resolve, reject })));
  assert.equal(typeof sandbox.loadPhoneInventory, 'function');
  const old = sandbox.loadPhoneInventory();
  const recent = sandbox.loadPhoneInventory();
  pending[1].resolve(data('20002')); await recent;
  pending[0].resolve(data('10001')); await old;
  assert.equal(element('phoneInventoryTableBody').children[0].children[0].textContent, '20002');
  const failed = sandbox.loadPhoneInventory(); pending[2].reject(new Error('network test')); await failed;
  assert.match(element('phoneInventoryLoadStatus').textContent, /加载失败/);
  const retry = sandbox.loadPhoneInventory(); pending[3].resolve(data('30003')); await retry;
  assert.equal(element('phoneInventoryTableBody').children[0].children[0].textContent, '30003');
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
  assert.equal(element('phoneInventoryTableBody').children[0].children[0].textContent, '40004');
  assert.equal(element('phoneImportDialog').closed, true);
});
