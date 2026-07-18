const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');

const {
  createFixedWindowRateLimiter,
} = require('../lib/fixed-window-rate-limiter');

function invokeLimiter(limiter, {
  ip = '127.0.0.1',
  remoteAddress = ip,
  forwardedFor,
} = {}) {
  let statusCode = 200;
  let body;
  let calledNext = false;
  const headers = {};
  if (forwardedFor !== undefined) headers['x-forwarded-for'] = forwardedFor;
  const req = { ip, socket: { remoteAddress }, headers };
  const res = {
    status(value) {
      statusCode = value;
      return this;
    },
    json(value) {
      body = value;
      return this;
    },
  };
  limiter(req, res, () => {
    calledNext = true;
  });
  return { statusCode, body, calledNext };
}

test('limits the twenty-first request from one IP and resets after sixty seconds', async () => {
  let currentTime = 1_000;
  const app = express();
  app.set('trust proxy', 1);
  app.use(createFixedWindowRateLimiter({ now: () => currentTime }));
  app.get('/probe', (req, res) => res.json({ ok: true }));

  for (let requestNumber = 1; requestNumber <= 20; requestNumber += 1) {
    const response = await request(app)
      .get('/probe')
      .set('X-Forwarded-For', '203.0.113.10');
    assert.equal(response.status, 200, `request ${requestNumber}`);
  }

  const blocked = await request(app)
    .get('/probe')
    .set('X-Forwarded-For', '203.0.113.10');
  assert.equal(blocked.status, 429);
  assert.deepEqual(blocked.body, { error: '请求过于频繁，请稍后重试' });

  currentTime += 60_000;
  const reset = await request(app)
    .get('/probe')
    .set('X-Forwarded-For', '203.0.113.10');
  assert.equal(reset.status, 200);
});

test('tracks request windows independently by IP', async () => {
  const app = express();
  app.set('trust proxy', 1);
  app.use(createFixedWindowRateLimiter({ limit: 1, now: () => 5_000 }));
  app.get('/probe', (req, res) => res.json({ ok: true }));

  const firstIp = await request(app)
    .get('/probe')
    .set('X-Forwarded-For', '203.0.113.11');
  const secondIp = await request(app)
    .get('/probe')
    .set('X-Forwarded-For', '203.0.113.12');
  const firstIpAgain = await request(app)
    .get('/probe')
    .set('X-Forwarded-For', '203.0.113.11');

  assert.equal(firstIp.status, 200);
  assert.equal(secondIp.status, 200);
  assert.equal(firstIpAgain.status, 429);
});

test('direct public clients cannot rotate X-Forwarded-For to bypass the limit', () => {
  const limiter = createFixedWindowRateLimiter({ limit: 1, now: () => 5_000 });

  const first = invokeLimiter(limiter, {
    ip: '203.0.113.11',
    remoteAddress: '198.51.100.20',
    forwardedFor: '203.0.113.11',
  });
  const spoofed = invokeLimiter(limiter, {
    ip: '203.0.113.12',
    remoteAddress: '198.51.100.20',
    forwardedFor: '203.0.113.12',
  });

  assert.equal(first.calledNext, true);
  assert.equal(spoofed.statusCode, 429);
});

test('trusted local proxies keep independent forwarded client windows', () => {
  const limiter = createFixedWindowRateLimiter({ limit: 1, now: () => 5_000 });

  const firstClient = invokeLimiter(limiter, {
    ip: '203.0.113.21',
    remoteAddress: '127.0.0.1',
    forwardedFor: '203.0.113.21',
  });
  const secondClient = invokeLimiter(limiter, {
    ip: '203.0.113.22',
    remoteAddress: '127.0.0.1',
    forwardedFor: '203.0.113.22',
  });
  const firstClientAgain = invokeLimiter(limiter, {
    ip: '203.0.113.21',
    remoteAddress: '127.0.0.1',
    forwardedFor: '203.0.113.21',
  });

  assert.equal(firstClient.calledNext, true);
  assert.equal(secondClient.calledNext, true);
  assert.equal(firstClientAgain.statusCode, 429);
});

test('large-map cleanup resets expired windows and preserves active counters', () => {
  let currentTime = 0;
  const limiter = createFixedWindowRateLimiter({
    limit: 2,
    windowMs: 100,
    now: () => currentTime,
  });

  for (let index = 0; index <= 5_000; index += 1) {
    invokeLimiter(limiter, { ip: `stale-ip-${index}` });
  }

  currentTime = 50;
  assert.equal(invokeLimiter(limiter, { ip: 'active-ip' }).calledNext, true);
  for (let index = 0; index <= 5_000; index += 1) {
    invokeLimiter(limiter, { ip: `fresh-ip-${index}` });
  }

  currentTime = 100;
  invokeLimiter(limiter, { ip: 'cleanup-trigger' });

  assert.equal(invokeLimiter(limiter, { ip: 'stale-ip-0' }).calledNext, true);
  assert.equal(invokeLimiter(limiter, { ip: 'stale-ip-0' }).calledNext, true);
  assert.equal(invokeLimiter(limiter, { ip: 'stale-ip-0' }).statusCode, 429);
  assert.equal(invokeLimiter(limiter, { ip: 'active-ip' }).calledNext, true);
  assert.deepEqual(invokeLimiter(limiter, { ip: 'active-ip' }), {
    statusCode: 429,
    body: { error: '请求过于频繁，请稍后重试' },
    calledNext: false,
  });
});
