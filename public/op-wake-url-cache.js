function buildWakeUrlCacheKey(opValue, game) {
  return `${String(opValue || '').trim()}\n${String(game || '').trim()}`;
}

function createWakeUrlCache({
  endpoint = '/api/submit',
  fetchImpl = (...args) => fetch(...args),
} = {}) {
  const resolvedCache = new Map();
  const inflightCache = new Map();

  async function requestWakeUrl(opValue, game) {
    const response = await fetchImpl(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: opValue, game }),
    });
    const data = await response.json();

    if (!response.ok || data.status !== 'success' || !data.url) {
      throw new Error(
        data.error ||
          (response.status === 400
            ? '提取失败或数据号无效'
            : response.status === 500
              ? '服务器编码失败'
              : '网络异常，请重试'),
      );
    }

    return data.url;
  }

  return {
    get(opValue, game) {
      return resolvedCache.get(buildWakeUrlCacheKey(opValue, game)) || '';
    },
    async prefetch(opValue, game) {
      const normalizedOpValue = String(opValue || '').trim();
      const normalizedGame = String(game || '').trim();
      if (!normalizedOpValue || !normalizedGame) {
        return '';
      }

      const key = buildWakeUrlCacheKey(normalizedOpValue, normalizedGame);
      if (resolvedCache.has(key)) {
        return resolvedCache.get(key);
      }
      if (inflightCache.has(key)) {
        return inflightCache.get(key);
      }

      const request = requestWakeUrl(normalizedOpValue, normalizedGame)
        .then((wakeUrl) => {
          resolvedCache.set(key, wakeUrl);
          inflightCache.delete(key);
          return wakeUrl;
        })
        .catch((error) => {
          inflightCache.delete(key);
          throw error;
        });

      inflightCache.set(key, request);
      return request;
    },
    clear() {
      resolvedCache.clear();
      inflightCache.clear();
    },
  };
}

if (typeof window !== 'undefined') {
  window.buildWakeUrlCacheKey = buildWakeUrlCacheKey;
  window.createWakeUrlCache = createWakeUrlCache;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    buildWakeUrlCacheKey,
    createWakeUrlCache,
  };
}
