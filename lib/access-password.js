const crypto = require('node:crypto');
const path = require('node:path');
const express = require('express');
const { createFixedWindowRateLimiter } = require('./fixed-window-rate-limiter');

const DEFAULT_ACCESS_PASSWORD = 'qq123456';

function safeNextPath(value) {
  if (typeof value !== 'string' || !value.startsWith('/')) return '/admin';
  try {
    const decoded = decodeURIComponent(value);
    if (decoded.startsWith('//') || /[\\\x00-\x20\x7f]/.test(decoded)) return '/admin';
    const url = new URL(value, 'http://access.local');
    if (url.origin !== 'http://access.local' || url.pathname.startsWith('//')
      || /^\/access\/?$/i.test(url.pathname)) return '/admin';
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return '/admin';
  }
}

function createAccessPassword({ config = {}, publicDir }) {
  const password = config.accessPassword || DEFAULT_ACCESS_PASSWORD;
  const passwordDigest = crypto.createHash('sha256').update(password).digest();
  // Changing the configured password invalidates previously authorized sessions.
  const fingerprint = crypto.createHmac('sha256', config.sessionSecret || password)
    .update(password).digest('hex');
  const router = express.Router();
  const rateLimit = createFixedWindowRateLimiter({ limit: 10, windowMs: 60_000 });

  function requireAccess(req, res, next) {
    res.set('Cache-Control', 'no-store');
    if (req.session && req.session.accessPasswordFingerprint === fingerprint) return next();
    if (/^\/api(?:\/|$)/i.test(req.path)) {
      return res.status(401).json({
        code: 'ACCESS_PASSWORD_REQUIRED',
        error: '请先输入访问密码',
      });
    }
    return res.redirect(`/access?next=${encodeURIComponent(safeNextPath(req.originalUrl))}`);
  }

  function protectPaths(req, res, next) {
    let decodedPath;
    try {
      // Static serving also decodes and normalizes paths before resolving files.
      decodedPath = decodeURIComponent(req.path).toLowerCase();
    } catch {
      return res.status(400).json({ error: '无效的访问路径' });
    }
    const pathname = path.posix.normalize(decodedPath);
    if (pathname === '/admin/admin.css' && !/^\/api(?:\/|$)/.test(decodedPath)) return next();
    const isProtected = (value) => /^\/admin(?:\/|$)/.test(value)
      || /^\/api\/(?:admin|public\/user)(?:\/|$)/.test(value)
      || value === '/user-page.html';
    // Express can use '..' literally as a route parameter; check the unnormalized
    // path as well as the normalized static-file path.
    if (isProtected(decodedPath) || isProtected(pathname)) {
      return requireAccess(req, res, next);
    }
    return next();
  }

  router.use(['/access', '/api/access'], (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });
  router.get('/access', (req, res) => res.sendFile(path.join(publicDir, 'access.html')));
  router.post('/api/access/login', rateLimit, (req, res, next) => {
    const supplied = req.body && req.body.password;
    if (typeof supplied !== 'string' || !supplied || supplied.length > 1024) {
      return res.status(400).json({ error: '请输入访问密码' });
    }
    const suppliedDigest = crypto.createHash('sha256').update(supplied).digest();
    if (!crypto.timingSafeEqual(suppliedDigest, passwordDigest)) {
      return res.status(401).json({ error: '访问密码错误，请重试' });
    }
    if (!req.session) return res.status(503).json({ error: '会话服务未就绪，请稍后重试' });
    return req.session.regenerate((error) => {
      if (error) return next(error);
      req.session.accessPasswordFingerprint = fingerprint;
      return req.session.save((saveError) => {
        if (saveError) return next(saveError);
        return res.json({ next: safeNextPath(req.body.next) });
      });
    });
  });
  router.post('/api/access/logout', (req, res, next) => {
    if (!req.session) return res.status(204).end();
    return req.session.destroy((error) => {
      if (error) return next(error);
      res.clearCookie('op_admin_session', { path: '/' });
      return res.status(204).end();
    });
  });

  return { router, protectPaths, requireAccess };
}

module.exports = { DEFAULT_ACCESS_PASSWORD, createAccessPassword, safeNextPath };
