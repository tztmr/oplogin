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

function loadPage(fetcher, { now = Date.now() } = {}) {
  let currentTime = now;
  class ClockDate extends Date { static now() { return currentTime; } }
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
    URLSearchParams, AbortController, Date: ClockDate, console,
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
  return { sandbox, element, intervals, windowListeners, setNow(value) { currentTime = value; } };
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
  assert.equal(ui.element('phoneSmsSlots').children.length, 0, 'pending and empty phone slots stay hidden');
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

test('SMS recognizes every nonempty response except the exact default marker and retains a trimmed message key', () => {
  const { sandbox } = loadPage(async () => {});
  assert.equal(typeof sandbox.identifyPhoneSms, 'function');
  const cases = [
    ['', 'waiting', ''],
    [' \r\n ', 'waiting', ''],
    ['0|0\n', 'waiting', ''],
    [' 0 | 0 \r\n', 'waiting', ''],
    ['暂无短信，请等待验证码', 'received', ''],
    ['任意非数字通知内容', 'received', ''],
    ['{"code":200,"message":"暂无短信"}', 'received', ''],
    ['{"code":1001,"message":"暂无短信"}', 'received', ''],
    ['{"code":1000,"data":{"sms":"验证码：654321"}}', 'received', '654321'],
    ['验证码：123456，5分钟后失效，请勿泄露', 'received', '123456'],
    ['{"code":0,"data":{"sms":"【测试】验证码：123456，请勿泄露。"}}', 'received', '123456'],
    ['{"code":"654321"}', 'received', '654321'],
    ['{"message":"您的验证码是 234567"}', 'received', '234567'],
    ['{"msg":"Verification code: 456789"}', 'received', '456789'],
    ['{"data":{"content":"567890（验证码），请勿泄露"}}', 'received', '567890'],
    ['  1234  ', 'received', '1234'],
    ['{"code":500,"message":"验证码 123456"}', 'received', '123456'],
    ['{"success":false,"data":{"code":"123456"}}', 'received', '123456'],
    ['{"error":"token expired","message":"123456"}', 'received', '123456'],
    ['{"code":0,"message":"操作失败：请求 123456"}', 'received', ''],
    ['手机号 13000000001，订单 123456 已提交', 'received', ''],
    ['{"code":200,"data":null}', 'received', ''],
    ['{"code":0,"message":"success"}', 'received', ''],
    ['{"message":"0|0"}', 'received', ''],
    ['1|0', 'received', ''],
    ['0|1234', 'received', ''],
    ['0|01', 'received', ''],
    ['10|0', 'received', ''],
    ['0|0|1234', 'received', ''],
    ['123456789 is your verification code', 'received', ''],
    ['[抖音] 2468 is your verification code, valid for 5 minutes.\n', 'received', '2468'],
    ['[抖音] 1357 is your verification code, valid for 5 minutes.\n', 'received', '1357'],
  ];
  for (const [raw, state, code] of cases) {
    const identified = sandbox.identifyPhoneSms(raw);
    assert.equal(identified.state, state, raw);
    assert.equal(identified.code, code, raw);
    assert.equal(identified.messageKey, state === 'received' ? raw.trim() : '', raw);
  }
});

test('217api messages remain visible across repeats, clear only on the default marker, and can return unchanged', async () => {
  const sms = (code) => `[抖音] ${code} is your verification code, valid for 5 minutes.\n`;
  const responses = [
    ['0|0\n', '0|0\n'],
    [sms('2468'), sms('1357')],
    [sms('2468'), sms('1357')],
    [sms('8642'), '0|0\n'],
    ['0|0\n', '0|0\n'],
    [sms('8642'), '0|0\n'],
  ];
  const start = Date.UTC(2026, 0, 1);
  const ui = loadPage(async (url, options) => ({ ok: true, json: async () => {
    if (options.method === 'GET') return { batchId, slots };
    const [first, third] = responses.shift();
    return { batchId, results: [
      { ...slots[0], status: 'success', message: first },
      { ...slots[1], status: 'skipped', message: '尚未提取手机号' },
      { ...slots[2], status: 'success', message: third },
    ] };
  } }), { now: start });
  await ui.sandbox.initializePhoneSmsPage();
  const cards = () => ui.element('phoneSmsSlots').children;
  const timeOf = (card) => card.children.find((node) => node.className === 'note').textContent;
  const tick = async (elapsed) => { ui.setNow(start + elapsed); ui.intervals.get(1).callback(); await flush(); };
  assert.equal(cards().length, 0);
  await tick(1000);
  assert.deepEqual(cards().map((card) => Number(card.dataset.slot)), [1, 3]);
  assert.match(texts(cards()[0]), /2468/);
  assert.match(texts(cards()[1]), /1357/);
  const firstTime = timeOf(cards()[0]);
  await tick(2000);
  assert.deepEqual(cards().map((card) => Number(card.dataset.slot)), [1, 3], 'repeats retain both cards');
  assert.equal(timeOf(cards()[0]), firstTime, 'repeats do not update the original new-message time');
  await tick(3000);
  assert.deepEqual(cards().map((card) => Number(card.dataset.slot)), [1]);
  assert.match(texts(cards()[0]), /8642/);
  const changedTime = timeOf(cards()[0]);
  await tick(4000);
  assert.equal(cards().length, 0, 'only an explicit default response clears the cards');
  await tick(5000);
  assert.deepEqual(cards().map((card) => Number(card.dataset.slot)), [1], 'same content returns visibly after 0|0');
  assert.match(texts(cards()[0]), /8642/);
  assert.equal(timeOf(cards()[0]), changedTime, 'returning content keeps its deduplicated new-message time');
  assert.equal(ui.intervals.get(1).delay, 1000);
});

test('stored SMS snapshots survive empty, error, skipped and missing results without replacing safe raw text', async () => {
  const raw = '<img src=x onerror=alert(1)>验证码：123456';
  const rounds = [
    [{ ...slots[2], status: 'success', message: raw }],
    [{ ...slots[2], status: 'success', message: raw }],
    [{ ...slots[2], status: 'success', message: '' }],
    [{ ...slots[2], status: 'error', message: '本次接码请求超时' }],
    [{ ...slots[2], status: 'skipped', message: '没有接码链接' }],
    [],
    [{ ...slots[2], status: 'success', message: ' 0 | 0 \n' }],
  ];
  const ui = loadPage(async (url, options) => ({ ok: true, json: async () => options.method === 'GET'
    ? { batchId, slots: [slots[2]] } : { batchId, results: rounds.shift() } }));
  await ui.sandbox.initializePhoneSmsPage();
  const cards = () => ui.element('phoneSmsSlots').children;
  const originalCard = cards()[0];
  const originalRaw = originalCard.children.find((node) => node.className === 'sms-raw');
  assert.deepEqual(cards().map((card) => Number(card.dataset.slot)), [3]);
  assert.match(texts(originalCard), /第 3 个/);
  assert.equal(originalRaw.textContent, raw);
  for (let round = 1; round <= 5; round += 1) {
    ui.intervals.get(1).callback(); await flush();
    assert.equal(cards().length, 1, `round ${round} must retain the previous message`);
    assert.equal(cards()[0], originalCard);
    assert.equal(cards()[0].children.find((node) => node.className === 'sms-raw'), originalRaw);
    assert.equal(originalRaw.textContent, raw, 'status text must not overwrite the displayed message');
    if (round === 3 || round === 5) assert.match(ui.element('phoneSmsPollingStatus').textContent, /读取失败/);
  }
  ui.intervals.get(1).callback(); await flush();
  assert.equal(cards().length, 0);
  assert.equal(ui.element('phoneSmsEmptyState').hidden, false);
});

test('new message content moves its original slot to the top while repeated content preserves time and ordering', async () => {
  const start = Date.UTC(2026, 0, 1);
  const result = (slot, message) => ({ ...slot, status: 'success', message });
  const rounds = [
    [result(slots[0], '0|0'), result(slots[2], '第三个初始消息')],
    [result(slots[0], '第一个后来消息'), result(slots[2], '第三个初始消息')],
    [result(slots[2], '第三个初始消息'), result(slots[0], '第一个后来消息')],
    [result(slots[0], '第一个后来消息'), result(slots[2], '第三个更新消息')],
    [result(slots[2], '第三个再次更新消息'), result(slots[0], '第一个同时更新消息')],
  ];
  const ui = loadPage(async (url, options) => ({ ok: true, json: async () => options.method === 'GET'
    ? { batchId, slots: [slots[0], slots[2]] } : { batchId, results: rounds.shift() } }), { now: start });
  await ui.sandbox.initializePhoneSmsPage();
  const cards = () => ui.element('phoneSmsSlots').children;
  const order = () => cards().map((card) => Number(card.dataset.slot));
  const timeOf = (slot) => cards().find((card) => Number(card.dataset.slot) === slot).children.find((node) => node.className === 'note').textContent;
  const tick = async (elapsed) => { ui.setNow(start + elapsed); ui.intervals.get(1).callback(); await flush(); };
  assert.deepEqual(order(), [3]);
  const thirdCard = cards()[0];
  await tick(1000);
  assert.deepEqual(order(), [1, 3], 'the later message moves its original slot above older messages');
  const firstTime = timeOf(1);
  const thirdTime = timeOf(3);
  await tick(2000);
  assert.deepEqual(order(), [1, 3], 'provider result order and repeated contents do not reorder cards');
  assert.equal(timeOf(1), firstTime);
  assert.equal(timeOf(3), thirdTime);
  await tick(3000);
  assert.deepEqual(order(), [3, 1]);
  assert.equal(cards()[0], thirdCard, 'new content updates the existing card for that slot');
  assert.match(texts(cards()[0]), /第三个更新消息/);
  await tick(4000);
  assert.deepEqual(order(), [1, 3], 'simultaneous new messages use slot number as a stable tie-break');
});

test('same-OTP text changes update the visible message and blank responses keep the last snapshot', async () => {
  const messages = ['任意非数字通知内容', '  任意非数字通知内容\n', '验证码：2468，第一条通知', '验证码：2468，第二条通知', '', '验证码：2468，第二条通知'];
  const ui = loadPage(async (url, options) => ({ ok: true, json: async () => options.method === 'GET'
    ? { batchId, slots: [slots[2]] } : { batchId, results: [{ ...slots[2], status: 'success', message: messages.shift() }] } }));
  await ui.sandbox.initializePhoneSmsPage();
  const cards = () => ui.element('phoneSmsSlots').children;
  const tick = async () => { ui.intervals.get(1).callback(); await flush(); };
  assert.match(texts(cards()[0]), /任意非数字通知内容/);
  await tick();
  assert.equal(cards().length, 1);
  await tick();
  assert.match(texts(cards()[0]), /第一条通知/);
  await tick();
  assert.match(texts(cards()[0]), /第二条通知/);
  await tick();
  assert.equal(cards().length, 1);
  assert.match(texts(cards()[0]), /第二条通知/);
  await tick();
  assert.equal(cards().length, 1);
  assert.match(texts(cards()[0]), /2468/);
});

test('initial HTTP errors and skipped items remain hidden until a successful message arrives', async () => {
  const message = '供应商返回的非数字新内容';
  let round = 0;
  const ui = loadPage(async (url, options) => {
    if (options.method === 'GET') return { ok: true, json: async () => ({ batchId, slots: [slots[0]] }) };
    round += 1;
    if (round === 1) return { ok: false, status: 503, json: async () => ({ error: message }) };
    return { ok: true, json: async () => ({ batchId, results: [{ ...slots[0], status: round === 2 ? 'error' : round === 3 ? 'skipped' : 'success', message }] }) };
  });
  await ui.sandbox.initializePhoneSmsPage();
  const cards = () => ui.element('phoneSmsSlots').children;
  const tick = async () => { ui.intervals.get(1).callback(); await flush(); };
  assert.equal(cards().length, 0);
  await tick();
  assert.equal(cards().length, 0);
  await tick();
  assert.equal(cards().length, 0);
  await tick();
  assert.equal(cards().length, 1);
  assert.match(texts(cards()[0]), /供应商返回的非数字新内容/);
  await tick();
  assert.equal(cards().length, 1);
});

test('slot identity changes clear the previous phone snapshot before a new phone receives a message', async () => {
  const replacement = { slot: 3, recordId: 'replacement-record', phoneNumber: '13000000004' };
  const rounds = [
    [{ ...slots[2], status: 'success', message: '原手机号消息' }],
    [{ ...replacement, status: 'error', message: '本次请求失败' }],
    [{ ...replacement, status: 'success', message: '新手机号消息' }],
  ];
  const ui = loadPage(async (url, options) => ({ ok: true, json: async () => options.method === 'GET'
    ? { batchId, slots: [slots[2]] } : { batchId, results: rounds.shift() } }));
  await ui.sandbox.initializePhoneSmsPage();
  assert.equal(ui.element('phoneSmsSlots').children.length, 1);
  ui.intervals.get(1).callback(); await flush();
  assert.equal(ui.element('phoneSmsSlots').children.length, 0);
  ui.intervals.get(1).callback(); await flush();
  const card = ui.element('phoneSmsSlots').children[0];
  assert.match(texts(card), /13000000004/);
  assert.match(texts(card), /新手机号消息/);
  assert.doesNotMatch(texts(card), /原手机号消息|13000000003/);
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

test('network and HTTP failures retain the last message while polling continues', async () => {
  let round = 0;
  const ui = loadPage(async (url, options) => {
    if (options.method === 'GET') return { ok: true, json: async () => ({ batchId, slots: [slots[0]] }) };
    round += 1;
    if (round === 2) throw new Error('network failed');
    if (round === 3) return { ok: false, status: 503, json: async () => ({ error: 'gateway unavailable' }) };
    return { ok: true, json: async () => ({ batchId, results: [{ ...slots[0], status: 'success', message: round === 5 ? '验证码：654321' : '验证码：123456' }] }) };
  });
  await ui.sandbox.initializePhoneSmsPage();
  for (let failedRound = 0; failedRound < 2; failedRound += 1) {
    ui.intervals.get(1).callback(); await flush();
    assert.equal(ui.element('phoneSmsSlots').children.length, 1);
    assert.match(texts(ui.element('phoneSmsSlots').children[0]), /123456/);
    assert.match(ui.element('phoneSmsPollingStatus').textContent, /读取失败/);
    assert.equal(ui.intervals.size, 1);
  }
  ui.intervals.get(1).callback(); await flush();
  assert.equal(ui.element('phoneSmsSlots').children.length, 1);
  assert.match(texts(ui.element('phoneSmsSlots').children[0]), /123456/);
  ui.intervals.get(1).callback(); await flush();
  assert.match(texts(ui.element('phoneSmsSlots').children[0]), /654321/);
});

test('terminal errors clear the last fresh message instead of leaving a stopped page showing a stale code', async () => {
  let round = 0;
  const ui = loadPage(async (url, options) => {
    if (options.method === 'GET') return { ok: true, json: async () => ({ batchId, slots }) };
    round += 1;
    return round === 1
      ? { ok: true, json: async () => ({ batchId, results: [{ ...slots[2], status: 'success', message: '验证码：123456' }] }) }
      : { ok: false, status: 409, json: async () => ({ error: '批次已变更' }) };
  });
  await ui.sandbox.initializePhoneSmsPage();
  assert.equal(ui.element('phoneSmsSlots').children.length, 1);
  ui.intervals.get(1).callback(); await flush();
  assert.equal(ui.element('phoneSmsSlots').children.length, 0);
  assert.equal(ui.intervals.size, 0);
  assert.match(ui.element('phoneSmsPollingStatus').textContent, /当前组已变更/);
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
