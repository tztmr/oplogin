const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');

function transport({ statusCode = 200, body = '', headers = {}, hang = false, observe } = {}) {
  return (url, options, onResponse) => {
    if (observe) observe(url, options);
    const request = new EventEmitter();
    request.destroy = () => {};
    request.end = () => {
      if (hang) return;
      process.nextTick(() => {
        const response = new PassThrough();
        response.statusCode = statusCode;
        response.headers = headers;
        onResponse(response);
        response.end(body);
      });
    };
    return request;
  };
}
function service(options = {}) {
  const { createPhoneSmsRequester } = require('../lib/phone-sms');
  return createPhoneSmsRequester({
    lookupImpl: async () => [{ address: '93.184.216.34', family: 4 }],
    ...options,
  });
}

test('SMS requester rejects private, mapped, special-use, credential and non-HTTP targets before connecting', async () => {
  const request = service({ requestImpl: () => { throw new Error('Unexpected connection'); } });
  for (const url of [
    'http://localhost/read', 'http://127.0.0.1', 'http://2130706433', 'http://0x7f000001',
    'http://10.0.0.1', 'http://172.16.0.1', 'http://192.168.1.1', 'http://169.254.169.254',
    'http://100.64.0.1', 'http://0.0.0.0', 'http://198.18.0.1', 'http://224.0.0.1',
    'http://[::1]', 'http://[::ffff:127.0.0.1]', 'http://[fc00::1]', 'http://[fe80::1]',
    'http://[2002:7f00:1::]', 'http://[64:ff9b::7f00:1]', 'http://[2001:db8::1]',
    'file:///etc/passwd', 'ftp://public.example.test/read', 'https://user:secret@public.example.test/read',
  ]) {
    const result = await request(url);
    assert.equal(result.status, 'error', url);
    assert.match(result.message, /公网 HTTP/);
    assert.doesNotMatch(result.message, /secret|127\.0\.0\.1/);
  }
});

test('SMS requester rejects hostnames with any private DNS answer and pins allowed DNS results to the connection', async () => {
  let connections = 0;
  const denied = service({
    lookupImpl: async () => [{ address: '93.184.216.34', family: 4 }, { address: '10.0.0.1', family: 4 }],
    requestImpl: () => { connections += 1; throw new Error('Unexpected connection'); },
  });
  assert.equal((await denied('https://sms.example.test/read?token=secret')).status, 'error');
  assert.equal(connections, 0);
  const raw = '  {"code":0,"message":"暂无验证码"}\n<script>raw</script>\n';
  const accepted = service({ requestImpl: transport({ body: raw, observe(url, options) {
    assert.equal(url.hostname, 'sms.example.test');
    assert.equal(options.agent, false);
    options.lookup('sms.example.test', { all: true }, (error, records) => {
      assert.ifError(error);
      assert.deepEqual(records, [{ address: '93.184.216.34', family: 4 }]);
    });
    options.lookup('sms.example.test', {}, (error, address, family) => {
      assert.ifError(error);
      assert.equal(address, '93.184.216.34');
      assert.equal(family, 4);
    });
  } }) });
  const result = await accepted('https://sms.example.test/read?token=secret');
  assert.deepEqual(result, { status: 'success', message: raw, httpStatus: 200 });
});

test('SMS requester preserves HTTP errors as text and never follows redirect destinations', async () => {
  let requests = 0;
  const redirect = service({ requestImpl: transport({ statusCode: 302, body: 'provider redirect text\n', headers: { location: 'http://127.0.0.1/private' }, observe() { requests += 1; } }) });
  assert.deepEqual(await redirect('https://sms.example.test/read'), { status: 'error', message: 'provider redirect text\n', httpStatus: 302 });
  assert.equal(requests, 1);
  const failure = service({ requestImpl: transport({ statusCode: 503, body: '{"error":"维护中"}\n' }) });
  assert.deepEqual(await failure('https://sms.example.test/read'), { status: 'error', message: '{"error":"维护中"}\n', httpStatus: 503 });
});

test('SMS requester bounds DNS/network time and response bytes without leaking request URLs', async () => {
  const timedOut = service({ timeoutMs: 20, requestImpl: transport({ hang: true }) });
  assert.match((await timedOut('https://sms.example.test/read?token=secret')).message, /超时/);
  const slowDns = service({ timeoutMs: 20, lookupImpl: () => new Promise(() => {}) });
  assert.match((await slowDns('https://sms.example.test/read?token=secret')).message, /超时/);
  const tooLarge = service({ requestImpl: transport({ body: 'a'.repeat(65537) }) });
  assert.match((await tooLarge('https://sms.example.test/read')).message, /过大/);
  const exact = service({ requestImpl: transport({ body: 'a'.repeat(65536) }) });
  assert.equal((await exact('https://sms.example.test/read')).message.length, 65536);
  const dnsFailure = service({ lookupImpl: async () => { throw new Error('https://sms.example.test/read?token=secret'); } });
  const result = await dnsFailure('https://sms.example.test/read?token=secret');
  assert.equal(result.status, 'error');
  assert.doesNotMatch(result.message, /secret|https:/);
});

test('SMS requester cancels active connections and does not start a connection after cancelled DNS', async () => {
  let connected;
  let destroyed = false;
  const start = new Promise((resolve) => { connected = resolve; });
  const controller = new AbortController();
  const request = service({ requestImpl: (url, options, onResponse) => {
    const stream = transport({ hang: true })(url, options, onResponse);
    stream.destroy = () => { destroyed = true; };
    stream.end = () => connected();
    return stream;
  } });
  const pending = request('https://sms.example.test/read', { signal: controller.signal });
  await start;
  controller.abort();
  assert.match((await pending).message, /取消/);
  assert.equal(destroyed, true);
  let resolveDns;
  let requestCount = 0;
  const dnsController = new AbortController();
  const slowDns = service({
    lookupImpl: () => new Promise((resolve) => { resolveDns = resolve; }),
    requestImpl: () => { requestCount += 1; throw new Error('Unexpected request'); },
  });
  const dnsPending = slowDns('https://sms.example.test/read', { signal: dnsController.signal });
  dnsController.abort();
  assert.match((await dnsPending).message, /取消/);
  resolveDns([{ address: '93.184.216.34', family: 4 }]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(requestCount, 0);
});
