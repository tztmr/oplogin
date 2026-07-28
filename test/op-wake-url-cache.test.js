const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildWakeUrlCacheKey,
  createWakeUrlCache,
} = require('../public/op-wake-url-cache');

test('buildWakeUrlCacheKey normalizes op value and game', () => {
  assert.equal(
    buildWakeUrlCacheKey('  aaa|bbb|ccc  ', ' 1105602870 '),
    'aaa|bbb|ccc\n1105602870',
  );
});

test('createWakeUrlCache deduplicates inflight requests and reuses cached url', async () => {
  let callCount = 0;
  const fetchImpl = async () => {
    callCount += 1;
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          status: 'success',
          url: 'tencent1105602870://qzapp/mqzone/0?pasteboard=cached',
        };
      },
    };
  };

  const cache = createWakeUrlCache({ fetchImpl });
  const promiseA = cache.prefetch('op-token', '1105602870');
  const promiseB = cache.prefetch('op-token', '1105602870');

  const [urlA, urlB] = await Promise.all([promiseA, promiseB]);

  assert.equal(callCount, 1);
  assert.equal(urlA, 'tencent1105602870://qzapp/mqzone/0?pasteboard=cached');
  assert.equal(urlB, 'tencent1105602870://qzapp/mqzone/0?pasteboard=cached');
  assert.equal(
    cache.get('op-token', '1105602870'),
    'tencent1105602870://qzapp/mqzone/0?pasteboard=cached',
  );

  const cachedUrl = await cache.prefetch('op-token', '1105602870');
  assert.equal(callCount, 1);
  assert.equal(cachedUrl, 'tencent1105602870://qzapp/mqzone/0?pasteboard=cached');
});

test('createWakeUrlCache surfaces API errors and avoids poisoning the cache', async () => {
  let callCount = 0;
  const cache = createWakeUrlCache({
    fetchImpl: async () => {
      callCount += 1;
      return {
        ok: false,
        status: 400,
        async json() {
          return { error: '提取失败或数据号无效' };
        },
      };
    },
  });

  await assert.rejects(
    cache.prefetch('bad-token', '1105602870'),
    /提取失败或数据号无效/,
  );
  assert.equal(cache.get('bad-token', '1105602870'), '');

  await assert.rejects(
    cache.prefetch('bad-token', '1105602870'),
    /提取失败或数据号无效/,
  );
  assert.equal(callCount, 2);
});

test('createWakeUrlCache times out stuck requests and allows a retry', async () => {
  const scheduledTimeouts = [];
  let callCount = 0;
  const cache = createWakeUrlCache({
    timeoutMs: 1500,
    setTimeoutImpl(callback) {
      scheduledTimeouts.push(callback);
      return scheduledTimeouts.length;
    },
    clearTimeoutImpl() {},
    fetchImpl: async () => {
      callCount += 1;
      if (callCount === 1) {
        return await new Promise(() => {});
      }

      return {
        ok: true,
        status: 200,
        async json() {
          return {
            status: 'success',
            url: 'tencent1105602870://qzapp/mqzone/0?pasteboard=retry-ok',
          };
        },
      };
    },
  });

  const firstAttempt = cache.prefetch('slow-token', '1105602870');
  assert.equal(scheduledTimeouts.length, 1);

  scheduledTimeouts[0]();

  await assert.rejects(firstAttempt, /请求超时/);
  assert.equal(cache.get('slow-token', '1105602870'), '');

  const retryUrl = await cache.prefetch('slow-token', '1105602870');
  assert.equal(callCount, 2);
  assert.equal(retryUrl, 'tencent1105602870://qzapp/mqzone/0?pasteboard=retry-ok');
});
