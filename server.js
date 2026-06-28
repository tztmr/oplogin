require('dotenv').config();

const { createApp } = require('./app');
const { loadConfig } = require('./lib/config');
const { createDbPool } = require('./lib/db');
const { ensureDatabaseSchema } = require('./lib/schema');
const { ensureInitialSuperAdmin } = require('./lib/bootstrap-admin');
const { createSessionMiddleware } = require('./lib/session');

const PORT = process.env.PORT || 4399;

async function start() {
  const config = loadConfig({ ...process.env, PORT });
  const pool = createDbPool(config);

  await ensureDatabaseSchema(pool);
  await ensureInitialSuperAdmin({ pool, config });

  const sessionMiddleware = createSessionMiddleware({ config, pool });
  const app = createApp({ config, pool, sessionMiddleware });

  app.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${config.port}`);
  });
}

start().catch((error) => {
  console.error(error);
  process.exit(1);
});
