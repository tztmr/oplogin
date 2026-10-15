const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const batchId = '11111111-1111-4111-8111-111111111111';
const slots = [
  { slot: 1, recordId: 'record-1', phoneNumber: '13000000001' },
  { slot: 2, recordId: 'record-2', phoneNumber: '' },
  { slot: 3, recordId: 'record-3', phoneNumber: '13000000003' },
];
const flush = () => new Promise((resolve) => setImmediate(resolve));

function loadPage(fetcher) {
  const elements = new Map();
  const windowListeners = new Map();
  const intervals = new Map();
  const makeElement = () => ({
    textContent: '', children: [], dataset: {}, hidden: false,
    appendChild(child) { this.children.push(child); },
    replaceChildren(...children) { this.children = children; },
    setAttribute(name, value) { this[name] = value; },
  });
  const element = (id) => {
    if (!elements.has(id)) elements.set(id, makeElement());
    return elements.get(id);
  };
  const sandbox = {
    URLSearchParams, AbortController, Date, console,
    fetch: fetcher,
    setInterval(callback, delay) { intervals.set(1, { callback, delay }); return 1; },
    clearInterval(id) { intervals.delete(id); },
    document: { getElementById: element, createElement: makeElement, addEventListener() {} },
    window: {
      location: { search: `?username=tester&batchId=${batchId}` },
      addEventListener(name, listener) { windowListeners.set(name, listener); },
    },
  };
  vm.createContext(sandbox);
  const script = path.join(__dirname, '../public/user-phone-sms.js');
  if (fs.existsSync(script)) vm.runInContext(fs.readFileSync(script, 'utf8'), sandbox);
  return { sandbox, element, intervals, windowListeners };
}

function texts(node) {
  return [node.textContent || '', ...node.children.map(texts)].join('\n');
}

test('SMS page polls each second with one in-flight request and aborts when leaving', async () => {
  const requests = [];
  let completeSms;
  const ui = loadPage(async (url, options) => {
    requests.push({ url, options });
    if (options.method === 'GET') return { ok: true, json: async () => ({ batchId, slots }) };
    return new Promise((resolve) => { completeSms = resolve; });
  });
  assert.equal(typeof ui.sandbox.initializePhoneSmsPage, 'function');
  void ui.sandbox.initializePhoneSmsPage();
  await flush();
  assert.equal(ui.intervals.get(1).delay, 1000);
  assert.equal(requests.length, 2);
  assert.equal(requests[0].url, `/api/public/user/tester/batch/phone?batchId=${batchId}`);
  assert.equal(requests[1].url, '/api/public/user/tester/batch/phone/sms');
  assert.deepEqual(JSON.parse(requests[1].options.body), { batchId });
  const tick = ui.intervals.get(1).callback;
  tick(); tick();
  await flush();
  assert.equal(requests.length, 2, 'pending requests must not overlap');
  completeSms({ ok: true, json: async () => ({ batchId, results: [] }) });
  await flush();
  tick();
  await flush();
  assert.equal(requests.length, 3);
  ui.windowListeners.get('pagehide')();
  assert.equal(requests[2].options.signal.aborted, true);
  assert.equal(ui.intervals.size, 0);
  tick();
  await flush();
  assert.equal(requests.length, 3);
  ui.windowListeners.get('beforeunload')();
});

test('SMS recognition ignores status codes and errors, recognizes codes only with clear evidence', () => {
  const { sandbox } = loadPage(async () => {});
  assert.equal(typeof sandbox.identifyPhoneSms, 'function');
  const cases = [
    ['', 'waiting', ''],
    ['暂无短信，请等待验证码', 'waiting', ''],
    ['{"code":200,"message":"暂无短信"}', 'waiting', ''],
    ['{"code":1001,"message":"暂无短信"}', 'waiting', ''],
    ['{"code":1000,"data":{"sms":"验证码：654321"}}', 'received', '654321'],
    ['验证码：123456，5分钟后失效，请勿泄露', 'received', '123456'],
    ['{"code":0,"data":{"sms":"【测试】验证码：123456，请勿泄露。"}}', 'received', '123456'],
    ['{"code":"654321"}', 'received', '654321'],
    ['{"message":"您的验证码是 234567"}', 'received', '234567'],
    ['{"msg":"Verification code: 456789"}', 'received', '456789'],
    ['{"data":{"content":"567890（验证码），请勿泄露"}}', 'received', '567890'],
    ['  1234  ', 'received', '1234'],
    ['{"code":500,"message":"验证码 123456"}', 'error', ''],
    ['{"success":false,"data":{"code":"123456"}}', 'error', ''],
    ['{"error":"token expired","message":"123456"}', 'error', ''],
    ['{"code":0,"message":"操作失败：请求 123456"}', 'error', ''],
    ['手机号 13000000001，订单 123456 已提交', 'unknown', ''],
    ['{"code":200,"data":null}', 'unknown', ''],
    ['{"code":0,"message":"success"}', 'unknown', ''],
  ];
  for (const [raw, state, code] of cases) {
    const identified = sandbox.identifyPhoneSms(raw);
    assert.equal(identified.state, state, raw);
    assert.equal(identified.code, code, raw);
  }
});

test('SMS results stay attached to original slots and distinguish new, repeated, changed and missing codes', async () => {
  const rounds = [
    [
      { ...slots[2], status: 'success', message: '<img src=x onerror=alert(1)>验证码：123456' },
      { ...slots[0], status: 'success', message: '暂无短信' },
      { ...slots[1], status: 'skipped', message: '尚未提取手机号' },
    ],
    [{ ...slots[2], status: 'success', message: '验证码：123456' }],
    [{ ...slots[2], status: 'success', message: '验证码：654321' }],
    [{ ...slots[2], status: 'error', message: '本次接码请求超时' }],
    [{ ...slots[2], status: 'success', message: '暂无短信' }],
    [{ ...slots[2], status: 'success', message: '验证码：654321' }],
  ];
  const ui = loadPage(async (url, options) => ({ ok: true, json: async () => options.method === 'GET'
    ? { batchId, slots } : { batchId, results: rounds.shift() } }));
  await ui.sandbox.initializePhoneSmsPage();
  await flush();
  const cards = () => ui.element('phoneSmsSlots').children;
  const thirdCard = cards()[2];
  const thirdRaw = thirdCard.children.find((node) => node.className === 'sms-raw');
  assert.deepEqual(cards().map((card) => Number(card.dataset.slot)), [1, 2, 3]);
  assert.match(texts(cards()[2]), /13000000003/);
  assert.match(texts(cards()[2]), /本次收到新码/);
  assert.match(texts(cards()[2]), /<img src=x onerror=alert\(1\)>验证码：123456/);
  assert.match(texts(cards()[0]), /等待验证码/);
  assert.match(texts(cards()[1]), /尚未提取手机号/);
  const tick = async () => { ui.intervals.get(1).callback(); await flush(); };
  await tick();
  assert.equal(cards()[2], thirdCard, 'polling keeps the same slot card');
  assert.equal(cards()[2].children.find((node) => node.className === 'sms-raw'), thirdRaw, 'polling reuses the original message element');
  assert.match(texts(cards()[2]), /与上次相同/);
  await tick();
  assert.match(texts(cards()[2]), /本次收到新码/);
  assert.match(texts(cards()[2]), /654321/);
  await tick();
  assert.match(texts(cards()[2]), /本次读取失败/);
  assert.match(texts(cards()[2]), /上次收到的验证码/);
  assert.match(texts(cards()[2]), /654321/);
  await tick();
  assert.match(texts(cards()[2]), /等待验证码/);
  assert.match(texts(cards()[2]), /654321/);
  await tick();
  assert.match(texts(cards()[2]), /与上次相同/);
});

for (const status of [409, 404]) {
  test(`SMS page stops permanently on ${status} without switching the batch`, async () => {
    const requests = [];
    const ui = loadPage(async (url, options) => {
      requests.push(url);
      return options.method === 'GET'
        ? { ok: true, json: async () => ({ batchId, slots }) }
        : { ok: false, status, json: async () => ({ error: status === 409 ? '批次已变更' : '用户不可用' }) };
    });
    await ui.sandbox.initializePhoneSmsPage();
    await flush();
    assert.equal(ui.intervals.size, 0);
    assert.match(ui.element('phoneSmsPollingStatus').textContent, status === 409 ? /当前组已变更/ : /不存在或已禁用/);
    assert.equal(ui.element('phoneSmsReturnLink').href, '/tester');
    await ui.sandbox.pollPhoneSms();
    assert.equal(requests.length, 2);
    ui.windowListeners.get('pagehide')();
    ui.windowListeners.get('pageshow')({ persisted: true });
    await flush();
    assert.equal(requests.length, 2, 'page cache never revives a terminal batch or user error');
    assert.equal(ui.intervals.size, 0);
    assert.ok(requests.every((url) => !url.endsWith('/batch')));
  });
}

test('SMS page retries transient request failures while retaining previous received messages', async () => {
  let round = 0;
  const ui = loadPage(async (url, options) => {
    if (options.method === 'GET') return { ok: true, json: async () => ({ batchId, slots }) };
    round += 1;
    if (round === 2) throw new Error('network failed');
    return { ok: true, json: async () => ({ batchId, results: [{ ...slots[0], status: 'success', message: '验证码：123456' }] }) };
  });
  await ui.sandbox.initializePhoneSmsPage();
  await flush();
  ui.intervals.get(1).callback(); await flush();
  assert.match(texts(ui.element('phoneSmsSlots').children[0]), /本次读取失败/);
  assert.match(texts(ui.element('phoneSmsSlots').children[0]), /123456/);
  assert.equal(ui.intervals.size, 1);
  ui.intervals.get(1).callback(); await flush();
  assert.equal(round, 3);
  assert.match(texts(ui.element('phoneSmsSlots').children[0]), /与上次相同/);
});

test('returning from page cache revalidates the fixed batch and ignores a response from before leaving', async () => {
  let smsCount = 0;
  let finishOldRequest;
  const requests = [];
  const ui = loadPage(async (url, options) => {
    requests.push(url);
    if (options.method === 'GET') return { ok: true, json: async () => ({ batchId, slots }) };
    smsCount += 1;
    if (smsCount === 1) return new Promise((resolve) => { finishOldRequest = resolve; });
    return { ok: true, json: async () => ({ batchId, results: [{ ...slots[0], status: 'success', message: '验证码：222222' }] }) };
  });
  void ui.sandbox.initializePhoneSmsPage();
  await flush();
  ui.windowListeners.get('pagehide')();
  assert.equal(ui.intervals.size, 0);
  assert.equal(typeof ui.windowListeners.get('pageshow'), 'function');
  ui.windowListeners.get('pageshow')({ persisted: true });
  await flush();
  assert.equal(ui.intervals.size, 1);
  assert.equal(requests.length, 4);
  assert.match(texts(ui.element('phoneSmsSlots').children[0]), /222222/);
  finishOldRequest({ ok: true, json: async () => ({ batchId, results: [{ ...slots[0], status: 'success', message: '验证码：111111' }] }) });
  await flush();
  assert.doesNotMatch(texts(ui.element('phoneSmsSlots').children[0]), /111111/);
  ui.windowListeners.get('pageshow')({ persisted: false });
  await flush();
  assert.equal(requests.length, 4, 'normal pageshow does not restart polling');
});
