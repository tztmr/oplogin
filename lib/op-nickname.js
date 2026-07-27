const axios = require('axios');
const { parseOpToken } = require('./op-url');

const DOUYIN_APP_ID = '1105602870';
const NICKNAME_URL = 'https://graph.qq.com/user/get_simple_userinfo';

async function lookupOpNickname(opValue, {
  httpClient = axios,
  appId = DOUYIN_APP_ID,
  timeoutMs = 5000,
} = {}) {
  try {
    const token = parseOpToken(opValue);
    const response = await httpClient.get(NICKNAME_URL, {
      params: {
        access_token: token.accessToken,
        oauth_consumer_key: appId,
        openid: token.openid,
      },
      timeout: timeoutMs,
    });
    if (Number(response?.data?.ret) !== 0) {
      return '';
    }
    return String(response.data.nickname || '').trim();
  } catch {
    return '';
  }
}

async function lookupOpNicknames(opValues, {
  lookupOne = lookupOpNickname,
  concurrency = 5,
} = {}) {
  const uniqueValues = Array.from(
    new Set(opValues.map((value) => String(value || '').trim()).filter(Boolean)),
  );
  const nicknameByOpValue = new Map();
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < uniqueValues.length) {
      const index = nextIndex;
      nextIndex += 1;
      const opValue = uniqueValues[index];
      let nickname = '';
      try {
        nickname = String(await lookupOne(opValue) || '').trim();
      } catch {
        nickname = '';
      }
      nicknameByOpValue.set(opValue, nickname);
    }
  }

  const workerCount = Math.min(
    uniqueValues.length,
    Math.max(1, Number(concurrency) || 1),
  );
  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  const detectedCount = Array.from(nicknameByOpValue.values())
    .filter(Boolean).length;
  return {
    nicknameByOpValue,
    detectedCount,
    failedCount: uniqueValues.length - detectedCount,
  };
}

module.exports = {
  DOUYIN_APP_ID,
  lookupOpNickname,
  lookupOpNicknames,
};
