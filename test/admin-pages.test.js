const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const request = require('supertest');

const { createApp } = require('../app');

function createTestApp() {
  return createApp({
    buildWakeUrlImpl: () => 'tencent1105602870://qzapp/mqzone/0?pasteboard=test',
  });
}

function loadAdminRecordsScript() {
  const script = fs.readFileSync(
    path.join(__dirname, '..', 'public', 'admin', 'records.js'),
    'utf8',
  );
  const sandbox = {
    console,
    URLSearchParams,
    window: {
      addEventListener() {},
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(script, sandbox);
  return sandbox;
}

function loadAdminShellScript() {
  const script = fs.readFileSync(
    path.join(__dirname, '..', 'public', 'admin', 'admin-shell.js'),
    'utf8',
  );
  const listeners = new Map();
  const sessionStorage = new Map();
  const shownSections = [];
  const createElement = (id, dataset = {}) => {
    const elementListeners = new Map();
    return {
      id,
      dataset,
      hidden: false,
      classList: {
        values: new Set(),
        add(value) { this.values.add(value); },
        remove(value) { this.values.delete(value); },
        toggle(value, force) {
          if (force) this.values.add(value);
          else this.values.delete(value);
        },
        contains(value) { return this.values.has(value); },
      },
      addEventListener(type, listener) {
        elementListeners.set(type, listener);
      },
      click() {
        elementListeners.get('click')?.({ currentTarget: this });
      },
    };
  };
  const buttons = [
    createElement('recordsNav', { sectionTarget: 'recordsSection' }),
    createElement('shortOpsNav', { sectionTarget: 'shortOpsSection' }),
    createElement('opApplicationsNav', { sectionTarget: 'opApplicationsSection', superAdminOnly: '' }),
  ];
  const sections = [
    createElement('recordsSection', { adminSection: '' }),
    createElement('shortOpsSection', { adminSection: '' }),
    createElement('opApplicationsSection', { adminSection: '' }),
  ];
  const elements = new Map([...buttons, ...sections].map((element) => [element.id, element]));
  const sandbox = {
    CustomEvent: class CustomEvent {
      constructor(type, init) {
        this.type = type;
        this.detail = init.detail;
      }
    },
    document: {
      addEventListener(type, listener) {
        listeners.set(type, listener);
      },
      getElementById(id) {
        return elements.get(id) || null;
      },
      querySelectorAll(selector) {
        if (selector === '[data-section-target]') return buttons;
        if (selector === '[data-admin-section]') return sections;
        if (selector === '[data-super-admin-only]') return [buttons[2]];
        return [];
      },
    },
    requireAdminSession: async () => ({ login: 'operator', role: 'operator' }),
    window: {
      addEventListener(type, listener) {
        listeners.set(type, listener);
      },
      sessionStorage: {
        getItem(key) { return sessionStorage.get(key) || null; },
        setItem(key, value) { sessionStorage.set(key, value); },
      },
      dispatchEvent(event) {
        if (event.type === 'admin-section-shown') shownSections.push(event.detail.sectionId);
      },
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(script, sandbox);
  return { sandbox, buttons, sections, sessionStorage, shownSections, listeners };
}

function loadAdminManagementScript(fileName) {
  const script = fs.readFileSync(
    path.join(__dirname, '..', 'public', 'admin', fileName),
    'utf8',
  );
  const createdElements = [];
  const sandbox = {
    console,
    URLSearchParams,
    document: {
      createElement(tagName) {
        const element = {
          tagName: tagName.toUpperCase(),
          className: '',
          textContent: '',
        };
        createdElements.push(element);
        return element;
      },
    },
    window: {
      addEventListener() {},
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(script, sandbox);
  return { sandbox, createdElements };
}

function createManagementElement(tagName = 'div') {
  const listeners = new Map();
  const element = {
    tagName: tagName.toUpperCase(),
    children: [],
    className: '',
    textContent: '',
    value: '',
    title: '',
    style: {},
    disabled: false,
    open: false,
    resetCount: 0,
    selected: false,
    addEventListener(type, listener) {
      const values = listeners.get(type) || [];
      values.push(listener);
      listeners.set(type, values);
    },
    listenerCount(type) {
      return (listeners.get(type) || []).length;
    },
    click() {
      (listeners.get('click') || []).forEach((listener) => listener({ currentTarget: this }));
    },
    appendChild(child) {
      child.parentNode = this;
      this.children.push(child);
      return child;
    },
    replaceChildren(...children) {
      this.children = children;
      children.forEach((child) => { child.parentNode = this; });
      if (children.length && children[0].value !== undefined) {
        this.value = children[0].value;
      }
    },
    reset() {
      this.resetCount += 1;
    },
    showModal() {
      this.open = true;
    },
    close() {
      this.open = false;
    },
    select() {
      this.selected = true;
    },
    remove() {
      if (!this.parentNode) return;
      this.parentNode.children = this.parentNode.children.filter((child) => child !== this);
      this.parentNode = null;
    },
  };
  return element;
}

function loadManagementBehaviorScript(fileName, options = {}) {
  const script = fs.readFileSync(
    path.join(__dirname, '..', 'public', 'admin', fileName),
    'utf8',
  );
  const elements = new Map();
  const windowListeners = new Map();
  const toastMessages = [];
  const body = createManagementElement('body');
  const document = {
    body,
    createElement: (tagName) => createManagementElement(tagName),
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, createManagementElement());
      return elements.get(id);
    },
    execCommand: options.execCommand || (() => true),
  };
  const window = {
    location: { origin: 'https://admin.example.test' },
    addEventListener(type, listener) {
      const values = windowListeners.get(type) || [];
      values.push(listener);
      windowListeners.set(type, values);
    },
    dispatchEvent(event) {
      (windowListeners.get(event.type) || []).forEach((listener) => listener(event));
    },
  };
  const sandbox = {
    console,
    URL,
    URLSearchParams,
    CustomEvent: class CustomEvent {
      constructor(type, init = {}) {
        this.type = type;
        this.detail = init.detail;
      }
    },
    document,
    navigator: options.navigator || {},
    window,
    adminFetch: options.adminFetch || (async () => ({ items: [], total: 0, pageSize: 20 })),
    requireAdminSession: options.requireAdminSession || (async () => ({ role: 'super_admin' })),
    showConfirm: options.showConfirm || (async () => true),
    showToast(message) {
      toastMessages.push(message);
    },
    formatDateTime: (value) => value || '',
  };
  vm.createContext(sandbox);
  vm.runInContext(script, sandbox);
  return { sandbox, elements, windowListeners, toastMessages, document };
}

async function flushManagementPromises() {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

test('GET /admin/login serves the admin login shell', async () => {
  const response = await request(createTestApp()).get('/admin/login');

  assert.equal(response.status, 200);
  assert.match(response.text, /管理员登录/);
  assert.match(response.text, /id="loginForm"/);
  assert.match(response.text, /\/admin\/login\.js/);
});

test('GET /admin serves the record management shell', async () => {
  const response = await request(createTestApp()).get('/admin');

  assert.equal(response.status, 200);
  assert.match(response.text, /谷歌号/);
  assert.match(response.text, /UID创建时间/);
  assert.match(response.text, /id="recordTable"/);
  assert.match(response.text, /批量导入/);
  assert.match(response.text, /导出勾选/);
  assert.match(response.text, /按筛选导出全部/);
  assert.match(response.text, /id="exportCsvButton"[^>]*class="btn-primary"/);
  assert.match(response.text, /id="exportFilteredCsvButton"[^>]*class="btn-cancel"/);
  assert.match(response.text, /id="pageSizeSelect"/);
  assert.match(response.text, /<option value="20" selected>20<\/option>/);
  assert.match(response.text, /<option value="50">50<\/option>/);
  assert.match(response.text, /<option value="100">100<\/option>/);
  assert.match(response.text, /<option value="all">全部<\/option>/);
  assert.match(response.text, /id="batchImportProgressSection"/);
  assert.match(response.text, /id="batchImportProgressBar"/);
  assert.match(response.text, /id="batchImportProgressText"/);
  assert.match(response.text, /id="batchDeleteProgressSection"/);
  assert.match(response.text, /id="batchDeleteProgressBar"/);
  assert.match(response.text, /id="batchDeleteProgressText"/);
  assert.match(response.text, /id="batchClearGoogleButton"/);
  assert.match(response.text, /批量删除谷歌号/);
  assert.match(response.text, /id="batchClearOpButton"/);
  assert.match(response.text, /批量删除OP/);
  assert.match(response.text, /id="publicBatchEligibilityCard"/);
  assert.match(response.text, /id="publicBatchEligibilitySummary"/);
  assert.match(response.text, /id="changeOwnWifiButton"/);
  assert.match(response.text, /设置Wi-Fi/);
  assert.match(response.text, /id="selfWifiDialog"/);
  assert.match(response.text, /id="selfWifiSsid"/);
  assert.match(response.text, /id="selfWifiPreviewImage"/);
  assert.match(response.text, /id="selfWifiPreviewText"/);
  assert.match(response.text, /\/user-center-qr\.js/);
  assert.match(response.text, /id="openOwnUserPageButton"/);
  assert.match(response.text, /进入我的页面/);
});

test('GET /admin serves sidebar navigation and independent management sections', async () => {
  const response = await request(createTestApp()).get('/admin');

  assert.equal(response.status, 200);
  assert.match(response.text, /id="adminSidebar"/);
  assert.match(response.text, /data-section-target="recordsSection"/);
  assert.match(response.text, /data-section-target="shortOpsSection"/);
  assert.match(response.text, /data-section-target="opApplicationsSection"/);
  assert.match(response.text, /id="recordsSection"/);
  assert.match(response.text, /id="shortOpsSection"/);
  assert.match(response.text, /id="opApplicationsSection"/);
  assert.match(response.text, /id="shortOpsPageStatus"/);
  assert.match(response.text, /id="opApplicationsPageStatus"/);
  assert.match(response.text, /id="recordTable"/);
  assert.match(response.text, /id="pageStatus"/);
  assert.match(response.text, /\/admin\/admin-shell\.js/);
  assert.match(response.text, /\/admin\/short-ops\.js/);
  assert.match(response.text, /\/admin\/op-applications\.js/);
  assert.match(response.text, /\/admin\/records\.js/);
});

test('GET /admin exposes complete short OP and application management controls', async () => {
  const response = await request(createTestApp()).get('/admin');

  assert.equal(response.status, 200);
  [
    'shortOpsSearch',
    'shortOpsStatusFilter',
    'shortOpsApplicationFilter',
    'createShortOpButton',
    'shortOpTable',
    'shortOpTableBody',
    'shortOpsPageSizeSelect',
    'shortOpsPreviousPageButton',
    'shortOpsNextPageButton',
    'shortOpDialog',
    'shortOpForm',
    'shortOpValue',
    'shortOpApplicationId',
    'shortOpRemark',
    'shortOpImportDialog',
    'shortOpImportForm',
    'shortOpImportText',
    'shortOpImportSummary',
    'shortOpImportErrors',
    'opApplicationsSearch',
    'opApplicationsStatusFilter',
    'createOpApplicationButton',
    'opApplicationTable',
    'opApplicationTableBody',
    'opApplicationsPageSizeSelect',
    'opApplicationsPreviousPageButton',
    'opApplicationsNextPageButton',
    'opApplicationDialog',
    'opApplicationForm',
    'opApplicationName',
    'opApplicationAppId',
  ].forEach((id) => assert.match(response.text, new RegExp(`id="${id}"`)));
});

test('short OP and application scripts use independent pagination and required APIs', async () => {
  const app = createTestApp();
  const [shortOpsScript, applicationsScript] = await Promise.all([
    request(app).get('/admin/short-ops.js'),
    request(app).get('/admin/op-applications.js'),
  ]);

  assert.equal(shortOpsScript.status, 200);
  assert.equal(applicationsScript.status, 200);
  assert.match(shortOpsScript.text, /let shortOpsPage = 1/);
  assert.match(shortOpsScript.text, /let shortOpsPageSize = '20'/);
  assert.match(shortOpsScript.text, /let shortOpsLoaded = false/);
  assert.match(shortOpsScript.text, /\/api\/admin\/short-ops/);
  assert.match(shortOpsScript.text, /\/import-text/);
  assert.match(shortOpsScript.text, /maskedOpValue/);
  assert.match(shortOpsScript.text, /admin-section-shown/);
  assert.doesNotMatch(shortOpsScript.text, /loadRecords\s*\(/);

  assert.match(applicationsScript.text, /let opApplicationsPage = 1/);
  assert.match(applicationsScript.text, /let opApplicationsPageSize = '20'/);
  assert.match(applicationsScript.text, /let opApplicationsLoaded = false/);
  assert.match(applicationsScript.text, /\/api\/admin\/op-applications/);
  assert.match(applicationsScript.text, /\/default/);
  assert.match(applicationsScript.text, /user\.role !== 'super_admin'/);
  assert.match(applicationsScript.text, /admin-section-shown/);
  assert.doesNotMatch(applicationsScript.text, /loadRecords\s*\(/);
});

test('management scripts create user-controlled cells with textContent', () => {
  const shortOps = loadAdminManagementScript('short-ops.js');
  const applications = loadAdminManagementScript('op-applications.js');
  const attack = '<img src=x onerror=alert(1)>';

  const shortOpCell = shortOps.sandbox.createShortOpsCell(attack, 'cell-truncate');
  const applicationCell = applications.sandbox.createOpApplicationCell(attack);

  assert.equal(shortOpCell.textContent, attack);
  assert.equal(shortOpCell.className, 'cell-truncate');
  assert.equal(applicationCell.textContent, attack);
  assert.doesNotMatch(
    fs.readFileSync(path.join(__dirname, '..', 'public', 'admin', 'short-ops.js'), 'utf8'),
    /\.innerHTML\s*=/,
  );
  assert.doesNotMatch(
    fs.readFileSync(path.join(__dirname, '..', 'public', 'admin', 'op-applications.js'), 'utf8'),
    /\.innerHTML\s*=/,
  );
});

test('management table CSS fixes short OP widths and truncates long values', async () => {
  const response = await request(createTestApp()).get('/admin/admin.css');

  assert.equal(response.status, 200);
  assert.match(response.text, /#shortOpTable\s*\{[^}]*table-layout:\s*fixed/s);
  assert.match(response.text, /#shortOpTable[^}]*\.cell-truncate[^}]*text-overflow:\s*ellipsis/s);
  assert.match(response.text, /#opApplicationTable\s*\{[^}]*min-width:\s*0/s);
});

test('short OP section lazily loads once, builds filters, populates defaults, and retries options', async () => {
  const requests = [];
  let optionAttempts = 0;
  const harness = loadManagementBehaviorScript('short-ops.js', {
    adminFetch: async (url) => {
      requests.push(url);
      if (url.startsWith('/api/admin/op-applications')) {
        optionAttempts += 1;
        if (optionAttempts === 1) throw new Error('temporary options failure');
        return {
          items: [
            { id: 'app-other', name: '其他', isDefault: false },
            { id: 'app-default', name: '默认应用', isDefault: true },
          ],
        };
      }
      return { items: [], total: 100, page: 1, pageSize: 20 };
    },
  });

  harness.sandbox.window.dispatchEvent({
    type: 'admin-section-shown', detail: { sectionId: 'shortOpsSection' },
  });
  await flushManagementPromises();
  assert.deepEqual(requests, ['/api/admin/op-applications?status=active&pageSize=all']);

  harness.sandbox.window.dispatchEvent({
    type: 'admin-section-shown', detail: { sectionId: 'shortOpsSection' },
  });
  await flushManagementPromises();
  assert.equal(requests.filter((url) => url.startsWith('/api/admin/short-ops?')).length, 1);
  const applicationFilter = harness.document.getElementById('shortOpsApplicationFilter');
  assert.equal(applicationFilter.children.length, 3);
  assert.equal(applicationFilter.children[1].value, 'app-default');
  assert.equal(harness.document.getElementById('shortOpApplicationId').value, 'app-default');
  assert.equal(harness.document.getElementById('createShortOpButton').listenerCount('click'), 1);

  harness.document.getElementById('shortOpsSearch').value = 'needle value';
  harness.document.getElementById('shortOpsStatusFilter').value = 'disabled';
  harness.document.getElementById('shortOpsApplicationFilter').value = 'app-other';
  vm.runInContext("shortOpsPage = 2; shortOpsPageSize = '50'", harness.sandbox);
  await harness.sandbox.loadShortOps();
  const query = new URL(requests.at(-1), 'https://admin.example.test').searchParams;
  assert.equal(query.get('page'), '2');
  assert.equal(query.get('pageSize'), '50');
  assert.equal(query.get('search'), 'needle value');
  assert.equal(query.get('status'), 'disabled');
  assert.equal(query.get('applicationId'), 'app-other');
});

test('short OP copy uses an absolute URL and a safe fallback', async () => {
  const clipboardWrites = [];
  const preferred = loadManagementBehaviorScript('short-ops.js', {
    navigator: { clipboard: { writeText: async (value) => clipboardWrites.push(value) } },
  });

  assert.equal(await preferred.sandbox.copyShortOpLink('/op/12345678'), true);
  assert.deepEqual(clipboardWrites, ['https://admin.example.test/op/12345678']);
  preferred.sandbox.renderShortOps([{
    id: 'copy-id', code: '12345678', shortLink: '/op/12345678',
    maskedOpValue: 'abc****', appName: '应用', appId: 'app-id', owner: 'root',
    opExpireAt: 'future', status: 'active', remark: '',
  }]);
  preferred.document.getElementById('shortOpTableBody')
    .children[0].children.at(-1).children[0].children[0].click();
  await flushManagementPromises();
  assert.equal(preferred.toastMessages.at(-1), '短链接已复制');

  let fallbackCalls = 0;
  const fallback = loadManagementBehaviorScript('short-ops.js', {
    navigator: { clipboard: { writeText: async () => { throw new Error('denied'); } } },
    execCommand(command) {
      fallbackCalls += 1;
      assert.equal(command, 'copy');
      return true;
    },
  });
  assert.equal(await fallback.sandbox.copyShortOpLink('/op/87654321'), true);
  assert.equal(fallbackCalls, 1);
  assert.equal(fallback.document.body.children.length, 0);

  const failure = loadManagementBehaviorScript('short-ops.js', {
    navigator: {},
    execCommand: () => false,
  });
  failure.sandbox.renderShortOps([{
    id: 'copy-fail-id', code: '87654321', shortLink: '/op/87654321',
    maskedOpValue: 'def****', appName: '应用', appId: 'app-id', owner: 'root',
    opExpireAt: 'future', status: 'active', remark: '',
  }]);
  failure.document.getElementById('shortOpTableBody')
    .children[0].children.at(-1).children[0].children[0].click();
  await flushManagementPromises();
  assert.equal(failure.toastMessages.at(-1), '复制失败，请手动复制');
});

test('short OP mutation refreshes, resets the dialog, and import errors stay text', async () => {
  const requests = [];
  const harness = loadManagementBehaviorScript('short-ops.js', {
    adminFetch: async (url, options) => {
      requests.push({ url, options });
      if (url === '/api/admin/short-ops') return { item: { id: 'created' } };
      return { items: [], total: 0, page: 1, pageSize: 20 };
    },
  });
  harness.document.getElementById('shortOpDialog').open = true;
  harness.document.getElementById('shortOpValue').value = 'full-op';
  harness.document.getElementById('shortOpApplicationId').value = 'app-id';
  harness.document.getElementById('shortOpRemark').value = 'remark';
  await harness.sandbox.submitShortOpForm({ preventDefault() {} });

  assert.equal(requests[0].url, '/api/admin/short-ops');
  assert.deepEqual(JSON.parse(requests[0].options.body), {
    opValue: 'full-op', applicationId: 'app-id', remark: 'remark',
  });
  assert.equal(requests.filter(({ url }) => url.startsWith('/api/admin/short-ops?')).length, 1);
  assert.equal(harness.document.getElementById('shortOpDialog').open, false);
  assert.equal(harness.document.getElementById('shortOpForm').resetCount, 1);

  harness.sandbox.renderShortOpImportResult({
    importedCount: 1,
    duplicateCount: 2,
    failedCount: 1,
    errors: [{ lineNumber: 4, message: '<img src=x onerror=alert(1)>' }],
  });
  assert.equal(harness.document.getElementById('shortOpImportSummary').textContent, '成功 1，重复 2，失败 1');
  assert.equal(
    harness.document.getElementById('shortOpImportErrors').children[0].textContent,
    '第 4 行：<img src=x onerror=alert(1)>',
  );
});

test('short OP and application lists clamp stale pages and refetch once', async () => {
  const shortRequests = [];
  const shortHarness = loadManagementBehaviorScript('short-ops.js', {
    adminFetch: async (url) => {
      shortRequests.push(url);
      return { items: [], total: 20, pageSize: 20 };
    },
  });
  vm.runInContext('shortOpsPage = 3', shortHarness.sandbox);
  await shortHarness.sandbox.loadShortOps();
  assert.deepEqual(
    shortRequests.map((url) => new URL(url, 'https://admin.example.test').searchParams.get('page')),
    ['3', '1'],
  );

  const applicationRequests = [];
  const applicationHarness = loadManagementBehaviorScript('op-applications.js', {
    adminFetch: async (url) => {
      applicationRequests.push(url);
      return { items: [], total: 20, pageSize: 20 };
    },
  });
  vm.runInContext('opApplicationsAuthorized = true; opApplicationsPage = 4', applicationHarness.sandbox);
  await applicationHarness.sandbox.loadOpApplications();
  assert.deepEqual(
    applicationRequests.map((url) => new URL(url, 'https://admin.example.test').searchParams.get('page')),
    ['4', '1'],
  );
});

test('application section gates operators, loads super admins once, and protects default stop action', async () => {
  let operatorRequests = 0;
  const operatorHarness = loadManagementBehaviorScript('op-applications.js', {
    requireAdminSession: async () => ({ role: 'operator' }),
    adminFetch: async () => { operatorRequests += 1; return {}; },
  });
  operatorHarness.sandbox.window.dispatchEvent({
    type: 'admin-section-shown', detail: { sectionId: 'opApplicationsSection' },
  });
  await flushManagementPromises();
  assert.equal(operatorRequests, 0);

  const requests = [];
  const adminHarness = loadManagementBehaviorScript('op-applications.js', {
    adminFetch: async (url, options = {}) => {
      requests.push({ url, options });
      return { items: [], total: 100, pageSize: 20 };
    },
  });
  adminHarness.sandbox.window.dispatchEvent({
    type: 'admin-section-shown', detail: { sectionId: 'opApplicationsSection' },
  });
  await flushManagementPromises();
  adminHarness.sandbox.window.dispatchEvent({
    type: 'admin-section-shown', detail: { sectionId: 'opApplicationsSection' },
  });
  await flushManagementPromises();
  assert.equal(requests.length, 1);

  adminHarness.document.getElementById('opApplicationsSearch').value = 'target app';
  adminHarness.document.getElementById('opApplicationsStatusFilter').value = 'disabled';
  vm.runInContext("opApplicationsPage = 2; opApplicationsPageSize = '50'", adminHarness.sandbox);
  await adminHarness.sandbox.loadOpApplications();
  const listQuery = new URL(requests.at(-1).url, 'https://admin.example.test').searchParams;
  assert.equal(listQuery.get('page'), '2');
  assert.equal(listQuery.get('pageSize'), '50');
  assert.equal(listQuery.get('search'), 'target app');
  assert.equal(listQuery.get('status'), 'disabled');

  adminHarness.document.getElementById('opApplicationDialog').open = true;
  adminHarness.document.getElementById('opApplicationName').value = '新应用';
  adminHarness.document.getElementById('opApplicationAppId').value = 'new-app-id';
  await adminHarness.sandbox.submitOpApplicationForm({ preventDefault() {} });
  const mutation = requests.find(({ url }) => url === '/api/admin/op-applications');
  assert.deepEqual(JSON.parse(mutation.options.body), {
    name: '新应用', appId: 'new-app-id',
  });
  assert.equal(
    requests.filter(({ url }) => url.startsWith('/api/admin/op-applications?')).length,
    3,
  );
  assert.equal(adminHarness.document.getElementById('opApplicationDialog').open, false);
  assert.equal(adminHarness.document.getElementById('opApplicationForm').resetCount, 1);

  adminHarness.sandbox.renderOpApplications([{
    id: 'default-id', name: '<default>', appId: 'app-id', isDefault: true,
    status: 'active', updatedAt: 'now',
  }]);
  const row = adminHarness.elements.get('opApplicationTableBody').children[0];
  const buttons = row.children.at(-1).children[0].children;
  const stopButton = buttons.find((button) => button.textContent.includes('停用'));
  assert.equal(stopButton.disabled, true);
  assert.match(stopButton.title, /默认应用/);
});

test('admin shell limits operator navigation and restores an authorized saved section', () => {
  const { sandbox, buttons, sections, sessionStorage, shownSections } = loadAdminShellScript();

  sessionStorage.set('admin.activeSection', 'opApplicationsSection');
  sandbox.initializeAdminShell({ login: 'operator', role: 'operator' });

  assert.equal(buttons[2].hidden, true);
  assert.equal(sections[0].hidden, false);
  assert.equal(sections[1].hidden, true);
  assert.equal(sections[2].hidden, true);
  assert.equal(buttons[0].classList.contains('is-active'), true);
  assert.equal(sessionStorage.get('admin.activeSection'), 'recordsSection');
  assert.deepEqual(shownSections, ['recordsSection']);

  buttons[1].click();
  assert.equal(sections[1].hidden, false);
  assert.equal(buttons[1].classList.contains('is-active'), true);
  assert.equal(sessionStorage.get('admin.activeSection'), 'shortOpsSection');
  assert.deepEqual(shownSections, ['recordsSection', 'shortOpsSection']);
});

test('admin records UI truncates long OP fields in the table', async () => {
  const app = createTestApp();
  const shellResponse = await request(app).get('/admin');
  const pageResponse = await request(app).get('/admin/records.js');
  const styleResponse = await request(app).get('/admin/admin.css');

  assert.equal(shellResponse.status, 200);
  assert.equal(pageResponse.status, 200);
  assert.equal(styleResponse.status, 200);
  assert.match(shellResponse.text, /record-col-op/);
  assert.match(shellResponse.text, /record-col-op-link/);
  assert.match(pageResponse.text, /renderTruncatedText\(item\.opValue, 'cell-truncate-op'\)/);
  assert.match(pageResponse.text, /cell-truncate cell-truncate-link/);
  assert.match(styleResponse.text, /\.cell-truncate\s*\{/);
  assert.match(styleResponse.text, /text-overflow:\s*ellipsis/);
  assert.match(styleResponse.text, /#recordTable\s*\{\s*table-layout:\s*fixed;/);
  assert.match(styleResponse.text, /#recordTable col\.record-col-op-link\s*\{/);
});

test('admin record row actions expose separate Google and OP delete buttons', async () => {
  const app = createTestApp();
  const pageResponse = await request(app).get('/admin/records.js');

  assert.equal(pageResponse.status, 200);
  assert.match(pageResponse.text, /删除谷歌号/);
  assert.match(pageResponse.text, /删除OP/);
  assert.match(pageResponse.text, /clearRecordGoogleFields/);
  assert.match(pageResponse.text, /clearRecordOpFields/);
  assert.match(pageResponse.text, /clearSelectedGoogleFields/);
  assert.match(pageResponse.text, /clearSelectedOpFields/);
});

test('admin record delete confirmation names the google account and OP value', () => {
  const sandbox = loadAdminRecordsScript();

  assert.equal(typeof sandbox.buildDeleteRecordConfirmMessage, 'function');

  const message = sandbox.buildDeleteRecordConfirmMessage({
    googleAccount: 'delete-target@gmail.com',
    opValue: 'openid|access-token|pay-token',
  });

  assert.match(message, /确认永久删除这条记录/);
  assert.match(message, /谷歌号：delete-target@gmail\.com/);
  assert.match(message, /OP：openid\|access-token\|pay-token/);
});

test('admin common UI exposes custom feedback dialogs for export confirmation and toast', async () => {
  const app = createTestApp();
  const pageResponse = await request(app).get('/admin/records.js');
  const commonResponse = await request(app).get('/admin/common.js');

  assert.equal(pageResponse.status, 200);
  assert.equal(commonResponse.status, 200);
  assert.match(pageResponse.text, /showConfirm\('已导出勾选数据，是否删除这些数据？'\)/);
  assert.match(pageResponse.text, /window\.location\.href = `\/api\/admin\/records\/export\.csv/);
  assert.match(pageResponse.text, /function setBatchImportProgressState\(/);
  assert.match(pageResponse.text, /setBatchImportProgressState\(15,\s*'正在上传导入数据\.\.\.'\)/);
  assert.match(pageResponse.text, /setBatchImportProgressState\(100,\s*'导入完成'\)/);
  assert.match(pageResponse.text, /function setBatchDeleteProgressState\(/);
  assert.match(pageResponse.text, /startText\s*=\s*'正在删除勾选记录\.\.\.'/);
  assert.match(pageResponse.text, /setBatchDeleteProgressState\(100,\s*'删除完成'\)/);
  assert.match(pageResponse.text, /\/api\/admin\/records\/batch-clear-google/);
  assert.match(pageResponse.text, /\/api\/admin\/records\/batch-clear-op/);
  assert.match(pageResponse.text, /function renderPublicBatchEligibility\(/);
  assert.match(pageResponse.text, /publicBatchEligibilitySummary/);
  assert.match(commonResponse.text, /function showConfirm\(/);
  assert.match(commonResponse.text, /function showToast\(/);
});

test('GET /admin/users serves the super admin user management shell', async () => {
  const response = await request(createTestApp()).get('/admin/users');

  assert.equal(response.status, 200);
  assert.match(response.text, /账号管理/);
  assert.match(response.text, /id="userTable"/);
  assert.match(response.text, /id="selfPasswordDialog"/);
  assert.match(response.text, /二维码配置/);
  assert.match(response.text, /id="qrConfigDialog"/);
  assert.match(response.text, /id="wifiSsid"/);
  assert.match(response.text, /id="wifiQrPreviewImage"/);
  assert.match(response.text, /id="wifiQrPreviewText"/);
  assert.match(response.text, /\/user-center-qr\.js/);
  assert.match(response.text, /实时预览/);
  assert.match(response.text, /id="openOwnUserPageButton"/);
  assert.match(response.text, /进入我的页面/);
});

test('admin common UI exposes wifi qr preview helpers', async () => {
  const response = await request(createTestApp()).get('/admin/common.js');

  assert.equal(response.status, 200);
  assert.match(response.text, /function initializeWifiQrPreview\(/);
  assert.match(response.text, /window\.buildWifiQrPayload/);
  assert.match(response.text, /window\.buildQrImageUrl/);
});

test('admin common UI exposes navigation to the current admin user page', async () => {
  const response = await request(createTestApp()).get('/admin/common.js');

  assert.equal(response.status, 200);
  assert.match(response.text, /function initializeOwnUserPageButton\(/);
  assert.match(response.text, /document\.getElementById\('openOwnUserPageButton'\)/);
  assert.match(response.text, /window\.open\(`\/\$\{encodeURIComponent\(user\.login\)\}`,\s*'_blank',\s*'noopener'\);/);
});

test('admin common UI hides own user page button for admin login', async () => {
  const response = await request(createTestApp()).get('/admin/common.js');

  assert.equal(response.status, 200);
  assert.match(response.text, /const normalizedLogin = String\(user\.login \|\| ''\)\.trim\(\)\.toLowerCase\(\);/);
  assert.match(response.text, /openButton\.hidden = normalizedLogin === 'admin';/);
  assert.match(response.text, /if \(openButton\.hidden\) \{\s*return;\s*\}/);
});
