function createFixedWindowRateLimiter({
  limit = 20,
  windowMs = 60_000,
  now = Date.now,
} = {}) {
  const windows = new Map();

  return function fixedWindowRateLimiter(req, res, next) {
    const currentTime = now();
    const key = req.ip;
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

module.exports = { createFixedWindowRateLimiter };
