const net = require('node:net');

function normalizeIpAddress(value) {
  let address = String(value || '').trim();
  const zoneIndex = address.indexOf('%');
  if (zoneIndex >= 0) address = address.slice(0, zoneIndex);
  if (address.toLowerCase().startsWith('::ffff:')) {
    const ipv4 = address.slice(7);
    if (net.isIP(ipv4) === 4) return ipv4;
  }
  return address;
}

function isTrustedProxyAddress(value) {
  const address = normalizeIpAddress(value);
  if (net.isIP(address) === 4) {
    const octets = address.split('.').map(Number);
    return octets[0] === 10
      || octets[0] === 127
      || (octets[0] === 169 && octets[1] === 254)
      || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31)
      || (octets[0] === 192 && octets[1] === 168);
  }
  if (net.isIP(address) === 6) {
    const lower = address.toLowerCase();
    return lower === '::1'
      || /^f[cd]/.test(lower)
      || /^fe[89ab]/.test(lower);
  }
  return false;
}

function getForwardedClientIp(req) {
  const forwardedHeader = req.headers && req.headers['x-forwarded-for'];
  const forwardedValues = Array.isArray(forwardedHeader)
    ? forwardedHeader
    : String(forwardedHeader || '').split(',');
  for (let index = forwardedValues.length - 1; index >= 0; index -= 1) {
    const address = normalizeIpAddress(forwardedValues[index]);
    if (net.isIP(address)) return address;
  }
  return '';
}

function resolveRateLimitKey(req) {
  const remoteAddress = normalizeIpAddress(
    req.socket && req.socket.remoteAddress,
  );
  if (isTrustedProxyAddress(remoteAddress)) {
    return getForwardedClientIp(req) || remoteAddress;
  }
  return remoteAddress || normalizeIpAddress(req.ip) || 'unknown';
}

function createFixedWindowRateLimiter({
  limit = 20,
  windowMs = 60_000,
  now = Date.now,
} = {}) {
  const windows = new Map();

  return function fixedWindowRateLimiter(req, res, next) {
    const currentTime = now();
    const key = resolveRateLimitKey(req);
    const currentWindow = windows.get(key);

    if (currentWindow && currentWindow.resetAt <= currentTime) {
      windows.delete(key);
    }

    if (windows.size > 10_000) {
      for (const [storedKey, entry] of windows) {
        if (entry.resetAt <= currentTime) {
          windows.delete(storedKey);
        }
      }
    }

    const activeWindow = windows.get(key);
    if (!activeWindow) {
      windows.set(key, { count: 1, resetAt: currentTime + windowMs });
      return next();
    }

    activeWindow.count += 1;
    if (activeWindow.count > limit) {
      return res.status(429).json({ error: '请求过于频繁，请稍后重试' });
    }

    return next();
  };
}

module.exports = { createFixedWindowRateLimiter, resolveRateLimitKey };
