const { Pool } = require('pg');

function createDbPool(config, PoolClass = Pool) {
  const useLocalSslBypass =
    config.databaseUrl.includes('localhost') ||
    config.databaseUrl.includes('127.0.0.1');

  return new PoolClass({
    connectionString: config.databaseUrl,
    ssl: useLocalSslBypass ? false : { rejectUnauthorized: false },
  });
}

module.exports = { createDbPool };
