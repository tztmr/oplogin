const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');

const {
  createFixedWindowRateLimiter,
} = require('../lib/fixed-window-rate-limiter');

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

test('large-map cleanup preserves active request windows', () => {
  const limiter = createFixedWindowRateLimiter({
    limit: 2,
    windowMs: 60_000,
    now: () => 10_000,
  });

  function invoke(ip) {
    let statusCode = 200;
    let body;
    let calledNext = false;
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
    limiter({ ip }, res, () => {
      calledNext = true;
    });
    return { statusCode, body, calledNext };
  }

  assert.equal(invoke('active-ip').calledNext, true);
  for (let index = 0; index <= 10_000; index += 1) {
    invoke(`bulk-ip-${index}`);
  }

  assert.equal(invoke('active-ip').calledNext, true);
  assert.deepEqual(invoke('active-ip'), {
    statusCode: 429,
    body: { error: '请求过于频繁，请稍后重试' },
    calledNext: false,
  });
});
