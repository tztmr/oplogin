const express = require('express');
const cors = require('cors');
const path = require('path');
const { createSubmitRouter } = require('./routes/api-submit');
const { createPublicFallbackRouter } = require('./routes/public-fallback');
const { createAdminAuthRouter } = require('./routes/admin-auth');
const { createRequireAdminAuth } = require('./lib/auth-middleware');
const { createAdminRecordsRouter } = require('./routes/admin-records');
const { createAdminUsersRouter } = require('./routes/admin-users');
const { createAdminPagesRouter } = require('./routes/admin-pages');
const { createUserPublicRouter } = require('./routes/user-public');
const { findAdminByIdentifier } = require('./lib/admin-users');

function createApp({ config, pool, sessionMiddleware, buildWakeUrlImpl } = {}) {
  const app = express();
  const publicDir = path.join(__dirname, 'public');

  app.use(cors());
  app.use(express.json());

  app.get('/health', (req, res) => {
    return res.status(200).json({ status: 'ok' });
  });

  if (sessionMiddleware) {
    app.use(sessionMiddleware);
  }

  if (pool && sessionMiddleware) {
    const requireAdminAuth = createRequireAdminAuth(pool);
    app.use('/api/admin/auth', createAdminAuthRouter({ pool, requireAdminAuth }));
    app.use(
      '/api/admin/records',
      createAdminRecordsRouter({ pool, config, requireAdminAuth }),
    );
    app.use(
      '/api/admin/users',
      createAdminUsersRouter({ pool, requireAdminAuth }),
    );
  }

  app.use(express.static(publicDir, { index: false, redirect: false }));
  app.use(createAdminPagesRouter(publicDir));
  app.use('/api', createSubmitRouter({ buildWakeUrlImpl }));
  app.use('/api/public/user', createUserPublicRouter({ pool, config }));

  // 用户专属页面拦截路由
  app.use('/:username', async (req, res, next) => {
    const username = req.params.username;
    // 排除特定路径
    if (['admin', 'api', 'favicon.ico', 'oplogin'].includes(username)) {
      return next();
    }
    try {
      const user = await findAdminByIdentifier(pool, username);
      if (user && user.status === 'active') {
        return res.sendFile(path.join(publicDir, 'user-page.html'));
      }
    } catch (e) {
      console.error(e);
    }
    next();
  });

  app.use(createPublicFallbackRouter(path.join(publicDir, 'index.html')));
  app.use((error, req, res, next) => {
    if (res.headersSent) {
      return next(error);
    }

    if (error.statusCode) {
      return res.status(error.statusCode).json({ error: error.message });
    }

    console.error(error);
    return res.status(500).json({ error: 'Internal server error' });
  });

  return app;
}

module.exports = { createApp };
