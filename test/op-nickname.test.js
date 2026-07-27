const test = require('node:test');
const assert = require('node:assert/strict');

const {
  DOUYIN_APP_ID,
  lookupOpNickname,
  lookupOpNicknames,
} = require('../lib/op-nickname');
const { importManagedRecordText } = require('../lib/managed-records');

const OP =
  'OPENID00000000000000000000000001|ACCESS000000000000000000000000001|PAY00000000000000000000000000001|PFKEY00000000000000000000000001|1780747973';

test('lookupOpNickname maps OP openid and access token to the Douyin request', async () => {
  const calls = [];
  const nickname = await lookupOpNickname(OP, {
    httpClient: {
      async get(url, options) {
        calls.push({ url, options });
        return { data: { ret: 0, nickname: '  测试昵称  ' } };
      },
    },
  });

  assert.equal(nickname, '测试昵称');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://graph.qq.com/user/get_simple_userinfo');
  assert.deepEqual(calls[0].options.params, {
    access_token: 'ACCESS000000000000000000000000001',
    oauth_consumer_key: DOUYIN_APP_ID,
    openid: 'OPENID00000000000000000000000001',
  });
  assert.equal(calls[0].options.timeout, 5000);
});

test('lookupOpNickname returns blank for Tencent errors and network errors', async () => {
  const rejected = await lookupOpNickname(OP, {
    httpClient: {
      async get() {
        return { data: { ret: -22, msg: 'openid is invalid' } };
      },
    },
  });
  const failed = await lookupOpNickname(OP, {
    httpClient: {
      async get() {
        throw new Error('network unavailable');
      },
    },
  });

  assert.equal(rejected, '');
  assert.equal(failed, '');
});

test('lookupOpNicknames deduplicates OP values and reports result counts', async () => {
  const calls = [];
  const secondOp = OP.replaceAll('1', '2');
  const result = await lookupOpNicknames([OP, OP, secondOp, ''], {
    lookupOne: async (opValue) => {
      calls.push(opValue);
      return opValue === OP ? '昵称A' : '';
    },
  });

  assert.deepEqual(calls.sort(), [OP, secondOp].sort());
  assert.equal(result.nicknameByOpValue.get(OP), '昵称A');
  assert.equal(result.nicknameByOpValue.get(secondOp), '');
  assert.equal(result.detectedCount, 1);
  assert.equal(result.failedCount, 1);
});

test('lookupOpNicknames never exceeds configured concurrency', async () => {
  let active = 0;
  let maximumActive = 0;
  const values = Array.from({ length: 9 }, (_, index) => `${OP}-${index}`);

  await lookupOpNicknames(values, {
    concurrency: 3,
    lookupOne: async () => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise((resolve) => setImmediate(resolve));
      active -= 1;
      return '';
    },
  });

  assert.equal(maximumActive, 3);
});

test('managed record import completes nickname lookup before opening a database connection', async () => {
  let connected = false;
  const pool = {
    async connect() {
      connected = true;
      throw new Error('stop after ordering assertion');
    },
  };

  await assert.rejects(
    importManagedRecordText(
      pool,
      {},
      OP,
      null,
      async () => {
        assert.equal(connected, false);
        return {
          nicknameByOpValue: new Map([[OP, '顺序昵称']]),
          detectedCount: 1,
          failedCount: 0,
        };
      },
    ),
    /stop after ordering assertion/,
  );
  assert.equal(connected, true);
});
