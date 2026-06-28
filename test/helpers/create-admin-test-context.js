const session = require('express-session');
const request = require('supertest');
const { newDb } = require('pg-mem');

const { createApp } = require('../../app');
const { loadConfig } = require('../../lib/config');
const { ensureDatabaseSchema } = require('../../lib/schema');
const { ensureInitialSuperAdmin } = require('../../lib/bootstrap-admin');
const { createSessionMiddleware } = require('../../lib/session');

async function createAdminTestContext(envOverrides = {}) {
  const db = newDb();
  const { Pool } = db.adapters.createPg();
  const pool = new Pool();
  const config = loadConfig({
    DATABASE_URL: 'postgres://user:pass@localhost:5432/op_proxy',
    SESSION_SECRET: 's'.repeat(32),
    GOOGLE_PASSWORD_ENCRYPTION_KEY:
      '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    INITIAL_SUPER_ADMIN_LOGIN: 'root',
    INITIAL_SUPER_ADMIN_EMAIL: 'root@example.com',
    INITIAL_SUPER_ADMIN_PASSWORD: 'change-me-now',
    ...envOverrides,
  });

  await ensureDatabaseSchema(pool);
  await ensureInitialSuperAdmin({ pool, config });

  const sessionMiddleware = createSessionMiddleware({
    config,
    store: new session.MemoryStore(),
  });
  const app = createApp({ config, pool, sessionMiddleware });

  return {
    app,
    agent: request.agent(app),
    pool,
    config,
  };
}

module.exports = { createAdminTestContext };
