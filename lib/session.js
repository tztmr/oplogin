const session = require('express-session');
const connectPgSimple = require('connect-pg-simple');

function createSessionMiddleware({ config, pool, store }) {
  const baseOptions = {
    name: 'op_admin_session',
    secret: config.sessionSecret,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: config.sessionCookieSecure,
      maxAge: 1000 * 60 * 60 * 24 * 7,
    },
  };

  if (store) {
    return session({ ...baseOptions, store });
  }

  const PgStore = connectPgSimple(session);

  return session({
    ...baseOptions,
    store: new PgStore({
      pool,
      tableName: 'admin_sessions',
      createTableIfMissing: true,
    }),
  });
}

module.exports = { createSessionMiddleware };
