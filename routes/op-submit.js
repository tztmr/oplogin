const express = require('express');

const { createFixedWindowRateLimiter } = require('../lib/fixed-window-rate-limiter');
const { buildWakeUrl } = require('../lib/op-url');
const { resolveActiveShortOpByCode } = require('../lib/short-op-records');

const INVALID_SHORT_OP_ERROR = { error: '短 OP 无效或已过期' };

function createOpSubmitRouter({
  pool,
  buildWakeUrlImpl = buildWakeUrl,
  rateLimitMiddleware = createFixedWindowRateLimiter(),
}) {
  const router = express.Router();

  router.post('/submit', rateLimitMiddleware, async (req, res, next) => {
    const code = String(req.body && req.body.code || '').trim();
    if (!/^\d{8}$/.test(code)) {
      return res.status(400).json({ error: '请输入正确的 8 位短码' });
    }

    let record;
    try {
      record = await resolveActiveShortOpByCode(pool, code);
    } catch (error) {
      return next(error);
    }

    if (!record) {
      return res.status(404).json(INVALID_SHORT_OP_ERROR);
    }

    try {
      const url = buildWakeUrlImpl(record.opValue, record.appId);
      return res.json({ status: 'success', appName: record.appName, url });
    } catch (error) {
      console.error('Short OP wake URL generation failed', {
        code,
        recordId: record.id,
      });
      return res.status(404).json(INVALID_SHORT_OP_ERROR);
    }
  });

  return router;
}

module.exports = { createOpSubmitRouter };
