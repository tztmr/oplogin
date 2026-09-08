const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

for (const succeeds of [true, false]) {
  test(`phone import freezes submitted fields and restores them after ${succeeds ? 'success' : 'failure'}`, async () => {
    const elements = new Map();
    const element = (id) => {
      if (!elements.has(id)) elements.set(id, { value: '', disabled: false, close() {} });
      return elements.get(id);
    };
    let resolve;
    let reject;
    const pending = new Promise((yes, no) => { resolve = yes; reject = no; });
    const sandbox = {
      document: { getElementById: element, addEventListener() {} },
      window: { addEventListener() {} },
      adminFetch: () => pending, showToast() {},
      refreshPhoneInventoryAfterImport: async () => {},
    };
    vm.createContext(sandbox);
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/admin/records.js'), 'utf8'), sandbox);
    element('phoneImportText').value = '13000000001----https://example.test/sms';
    element('phoneImportDurationDays').value = '60';
    const request = sandbox.submitPhoneImportForm({ preventDefault() {} });
    assert.equal(element('phoneImportText').disabled, true);
    assert.equal(element('phoneImportDurationDays').disabled, true);
    if (succeeds) resolve({ importedCount: 1, updatedCount: 0, skippedCount: 0 });
    else reject(new Error('test failure'));
    await request;
    assert.equal(element('phoneImportText').disabled, false);
    assert.equal(element('phoneImportDurationDays').disabled, false);
    assert.equal(element('phoneImportText').value, succeeds ? '' : '13000000001----https://example.test/sms');
  });
}
