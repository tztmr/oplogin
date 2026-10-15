const dns = require('node:dns').promises;
const http = require('node:http');
const https = require('node:https');
const { BlockList, isIP } = require('node:net');

const blockedIpv4 = new BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24],
  ['224.0.0.0', 4], ['240.0.0.0', 4],
]) blockedIpv4.addSubnet(address, prefix, 'ipv4');
const globalIpv6 = new BlockList();
globalIpv6.addSubnet('2000::', 3, 'ipv6');
const blockedIpv6 = new BlockList();
// Exclude special-use, documentation, and IPv4 transition ranges as well as
// non-global IPv6. In particular, mapped/NAT64 addresses cannot bypass IPv4 checks.
for (const [address, prefix] of [
  ['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['3fff::', 20],
]) blockedIpv6.addSubnet(address, prefix, 'ipv6');

function isPublicAddress(address) {
  const family = isIP(address);
  if (family === 4) return !blockedIpv4.check(address, 'ipv4');
  return family === 6 && globalIpv6.check(address, 'ipv6') && !blockedIpv6.check(address, 'ipv6');
}

function smsError(message) {
  return Object.assign(new Error(message), { safeSmsMessage: message });
}

function createPhoneSmsRequester({
  lookupImpl = (hostname) => dns.lookup(hostname, { all: true, verbatim: true }),
  requestImpl = (url, options, onResponse) => (url.protocol === 'https:' ? https : http).request(url, options, onResponse),
  timeoutMs = 10000,
  maxBytes = 64 * 1024,
} = {}) {
  return async function requestPhoneSms(rawUrl, { signal } = {}) {
    let request;
    let response;
    let timedOut = false;
    let timer;
    let onAbort;
    try {
      if (signal?.aborted) throw smsError('接码请求已取消');
      const work = async () => {
        let url;
        try { url = new URL(rawUrl); } catch { throw smsError('接码链接不是允许的公网 HTTP(S) 地址'); }
        const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password
          || hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local')) {
          throw smsError('接码链接不是允许的公网 HTTP(S) 地址');
        }
        const family = isIP(hostname);
        const addresses = family ? [{ address: hostname, family }] : await lookupImpl(hostname);
        if (signal?.aborted) throw smsError('接码请求已取消');
        if (timedOut) throw smsError('接码请求超时，请重试');
        if (!addresses.length || addresses.some(({ address }) => !isPublicAddress(address))) {
          throw smsError('接码链接不是允许的公网 HTTP(S) 地址');
        }
        const pinned = addresses[0];
        return new Promise((resolve, reject) => {
          // Native HTTP does not follow redirects. Use a new connection and the
          // checked DNS address; a second lookup must not permit DNS rebinding.
          request = requestImpl(url, {
            method: 'GET', agent: false,
            headers: { Accept: 'text/plain, */*', 'Accept-Encoding': 'identity' },
            lookup: (_hostname, options, callback) => {
              if (typeof options === 'function') { callback = options; options = {}; }
              if (options?.all) callback(null, [pinned]);
              else callback(null, pinned.address, pinned.family);
            },
          }, (incoming) => {
            response = incoming;
            const chunks = [];
            let size = 0;
            incoming.on('error', reject);
            incoming.on('aborted', () => reject(smsError('接码响应中断，请重试')));
            incoming.on('data', (chunk) => {
              size += chunk.length;
              if (size > maxBytes) {
                reject(smsError('接码响应过大，已停止读取'));
                incoming.destroy();
                request.destroy();
                return;
              }
              chunks.push(chunk);
            });
            incoming.on('end', () => resolve({
              status: incoming.statusCode >= 200 && incoming.statusCode < 300 ? 'success' : 'error',
              message: Buffer.concat(chunks).toString('utf8'),
              httpStatus: incoming.statusCode,
            }));
          });
          request.on('error', reject);
          request.end();
        });
      };
      const timeout = new Promise((resolve, reject) => {
        timer = setTimeout(() => {
          timedOut = true;
          reject(smsError('接码请求超时，请重试'));
          response?.destroy();
          request?.destroy();
        }, timeoutMs);
      });
      const cancellation = new Promise((resolve, reject) => {
        onAbort = () => {
          reject(smsError('接码请求已取消'));
          response?.destroy();
          request?.destroy();
        };
        signal?.addEventListener('abort', onAbort, { once: true });
      });
      return await Promise.race([work(), timeout, cancellation]);
    } catch (error) {
      // Native network errors can contain the URL/token. Only our own fixed
      // messages cross this boundary, and nothing is logged here.
      return { status: 'error', message: error.safeSmsMessage || '接码请求失败，请稍后重试' };
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  };
}

module.exports = { createPhoneSmsRequester, requestPhoneSms: createPhoneSmsRequester() };
