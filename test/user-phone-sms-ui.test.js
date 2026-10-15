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

test('217api new codes appear in their original slots while default, repeated and empty responses stay hidden', async () => {
  const sms = (code) => `[抖音] ${code} is your verification code, valid for 5 minutes.\n`;
  const responses = [
    ['0|0\n', '0|0\n'],
    [sms('2468'), sms('1357')],
    [sms('2468'), sms('1357')],
    [sms('8642'), '0|0\n'],
    ['0|0\n', '0|0\n'],
    [sms('8642'), '0|0\n'],
  ];
  const ui = loadPage(async (url, options) => ({ ok: true, json: async () => {
    if (options.method === 'GET') return { batchId, slots };
    const [first, third] = responses.shift();
    return { batchId, results: [
      { ...slots[0], status: 'success', message: first },
      { ...slots[1], status: 'skipped', message: '尚未提取手机号' },
      { ...slots[2], status: 'success', message: third },
    ] };
  } }));
  await ui.sandbox.initializePhoneSmsPage();
  const cards = () => ui.element('phoneSmsSlots').children;
  const tick = async () => { ui.intervals.get(1).callback(); await flush(); };
  assert.equal(cards().length, 0);
  assert.doesNotMatch(ui.element('phoneSmsPollingStatus').textContent, /无法识别|读取失败/);
  await tick();
  assert.deepEqual(cards().map((card) => Number(card.dataset.slot)), [1, 3]);
  assert.match(texts(cards()[0]), /2468/);
  assert.match(texts(cards()[1]), /1357/);
  await tick();
  assert.equal(cards().length, 0);
  await tick();
  assert.deepEqual(cards().map((card) => Number(card.dataset.slot)), [1]);
  assert.match(texts(cards()[0]), /8642/);
  await tick();
  assert.equal(cards().length, 0);
  assert.doesNotMatch(ui.element('phoneSmsPollingStatus').textContent, /无法识别|读取失败/);
  await tick();
  assert.equal(cards().length, 0, 'a repeated code stays hidden after the default response');
  assert.equal(ui.intervals.get(1).delay, 1000);
});

test('only fresh SMS cards appear, retain original slot numbers, and disappear on later rounds without new codes', async () => {
  const rounds = [
    [
      { ...slots[2], status: 'success', message: '<img src=x onerror=alert(1)>验证码：123456' },
      { ...slots[0], status: 'success', message: '0|0' },
      { ...slots[1], status: 'skipped', message: '尚未提取手机号' },
    ],
    [{ ...slots[2], status: 'success', message: '<img src=x onerror=alert(1)>验证码：123456' }],
    [{ ...slots[2], status: 'success', message: '验证码：654321' }],
    [{ ...slots[2], status: 'error', message: '本次接码请求超时' }],
    [{ ...slots[2], status: 'success', message: '0|0' }],
    [{ ...slots[2], status: 'success', message: '验证码：654321' }],
    [
      { slot: 18, recordId: 'record-18', phoneNumber: '13000000018', status: 'success', message: '验证码：181818' },
      { ...slots[2], status: 'success', message: '验证码：333333' },
    ],
    [],
  ];
  const ui = loadPage(async (url, options) => ({ ok: true, json: async () => options.method === 'GET'
    ? { batchId, slots } : { batchId, results: rounds.shift() } }));
  await ui.sandbox.initializePhoneSmsPage();
  await flush();
  const cards = () => ui.element('phoneSmsSlots').children;
  const thirdCard = cards()[0];
  const thirdRaw = thirdCard.children.find((node) => node.className === 'sms-raw');
  assert.deepEqual(cards().map((card) => Number(card.dataset.slot)), [3]);
  assert.match(texts(cards()[0]), /第 3 个/);
  assert.match(texts(cards()[0]), /13000000003/);
  assert.match(texts(cards()[0]), /本次收到新码/);
  assert.match(texts(cards()[0]), /<img src=x onerror=alert\(1\)>验证码：123456/);
  assert.equal(ui.element('phoneSmsEmptyState').hidden, true);
  const tick = async () => { ui.intervals.get(1).callback(); await flush(); };
  await tick();
  assert.equal(cards().length, 0, 'same code disappears on the next round');
  assert.equal(ui.element('phoneSmsEmptyState').hidden, false);
  assert.match(ui.element('phoneSmsPollingStatus').textContent, /新码 0/);
  await tick();
  assert.equal(cards()[0], thirdCard, 'a new code reuses the original slot card');
  assert.equal(cards()[0].children.find((node) => node.className === 'sms-raw'), thirdRaw);
  assert.match(texts(cards()[0]), /本次收到新码/);
  assert.match(texts(cards()[0]), /654321/);
  await tick();
  assert.equal(cards().length, 0, 'failed reads remove old cards');
  assert.match(ui.element('phoneSmsPollingStatus').textContent, /读取失败/);
  await tick();
  assert.equal(cards().length, 0, 'waiting responses do not show old messages');
  await tick();
  assert.equal(cards().length, 0, 'same code must not reappear after empty/error responses');
  await tick();
  assert.deepEqual(cards().map((card) => Number(card.dataset.slot)), [3, 18]);
  assert.match(texts(cards()[1]), /第 18 个/);
  await tick();
  assert.equal(cards().length, 0, 'missing results also clear previous cards');
});

test('message deduplication displays arbitrary text and treats changed text with the same OTP as new', async () => {
  const messages = [
    '任意非数字通知内容',
    '  任意非数字通知内容\n',
    '0|0',
    '任意非数字通知内容',
    '验证码：2468，第一条通知',
    '验证码：2468，第二条通知',
    '验证码：2468，第二条通知',
    '',
    '验证码：2468，第二条通知',
  ];
  const ui = loadPage(async (url, options) => ({ ok: true, json: async () => options.method === 'GET'
    ? { batchId, slots: [slots[2]] } : { batchId, results: [{ ...slots[2], status: 'success', message: messages.shift() }] } }));
  await ui.sandbox.initializePhoneSmsPage();
  const cards = () => ui.element('phoneSmsSlots').children;
  const tick = async () => { ui.intervals.get(1).callback(); await flush(); };
  assert.deepEqual(cards().map((card) => Number(card.dataset.slot)), [3]);
  assert.match(texts(cards()[0]), /任意非数字通知内容/);
  assert.doesNotMatch(ui.element('phoneSmsPollingStatus').textContent, /无法识别|读取失败/);
  await tick();
  assert.equal(cards().length, 0, 'outer whitespace does not create a new message');
  await tick();
  assert.equal(cards().length, 0, 'the default marker hides old messages');
  await tick();
  assert.equal(cards().length, 0, 'the previous message stays deduplicated after the default marker');
  await tick();
  assert.match(texts(cards()[0]), /第一条通知/);
  await tick();
  assert.match(texts(cards()[0]), /第二条通知/);
  assert.match(texts(cards()[0]), /2468/);
  await tick();
  assert.equal(cards().length, 0, 'identical message text is hidden');
  await tick();
  assert.equal(cards().length, 0, 'empty responses hide old messages');
  await tick();
  assert.equal(cards().length, 0, 'the same message is still deduplicated after an empty response');
});

test('HTTP and item-level failures stay hidden and do not consume a successful message deduplication key', async () => {
  const message = '供应商返回的非数字新内容';
  let round = 0;
  const ui = loadPage(async (url, options) => {
    if (options.method === 'GET') return { ok: true, json: async () => ({ batchId, slots }) };
    round += 1;
    if (round === 1) return { ok: false, status: 503, json: async () => ({ error: message }) };
    return { ok: true, json: async () => ({ batchId, results: [{ ...slots[0], status: round === 2 ? 'error' : round === 3 ? 'skipped' : 'success', message }] }) };
  });
  await ui.sandbox.initializePhoneSmsPage();
  const cards = () => ui.element('phoneSmsSlots').children;
  const tick = async () => { ui.intervals.get(1).callback(); await flush(); };
  assert.equal(cards().length, 0);
  assert.match(ui.element('phoneSmsPollingStatus').textContent, /读取失败/);
  await tick();
  assert.equal(cards().length, 0, 'an upstream HTTP failure remains hidden even if it includes content');
  await tick();
  assert.equal(cards().length, 0, 'skipped items do not show content');
  await tick();
  assert.equal(cards().length, 1, 'the first successful nonempty response must be shown');
  assert.match(texts(cards()[0]), /供应商返回的非数字新内容/);
  await tick();
  assert.equal(cards().length, 0, 'the successful response now participates in deduplication');
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

test('SMS page hides old messages after a request failure while retaining message deduplication and retrying', async () => {
  let round = 0;
  const ui = loadPage(async (url, options) => {
    if (options.method === 'GET') return { ok: true, json: async () => ({ batchId, slots }) };
    round += 1;
    if (round === 2) throw new Error('network failed');
    return { ok: true, json: async () => ({ batchId, results: [{ ...slots[0], status: 'success', message: round === 4 ? '验证码：654321' : '验证码：123456' }] }) };
  });
  await ui.sandbox.initializePhoneSmsPage();
  await flush();
  ui.intervals.get(1).callback(); await flush();
  assert.equal(ui.element('phoneSmsSlots').children.length, 0);
  assert.match(ui.element('phoneSmsPollingStatus').textContent, /读取失败/);
  assert.equal(ui.intervals.size, 1);
  ui.intervals.get(1).callback(); await flush();
  assert.equal(round, 3);
  assert.equal(ui.element('phoneSmsSlots').children.length, 0);
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
