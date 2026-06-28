function loadConfig(env = process.env) {
  const requiredKeys = [
    'DATABASE_URL',
    'SESSION_SECRET',
    'GOOGLE_PASSWORD_ENCRYPTION_KEY',
    'INITIAL_SUPER_ADMIN_LOGIN',
    'INITIAL_SUPER_ADMIN_EMAIL',
    'INITIAL_SUPER_ADMIN_PASSWORD',
  ];

  for (const key of requiredKeys) {
    if (!env[key]) {
      throw new Error(`Missing required env: ${key}`);
    }
  }

  return {
    port: Number(env.PORT || 4399),
    databaseUrl: env.DATABASE_URL,
    sessionSecret: env.SESSION_SECRET,
    googlePasswordEncryptionKey: env.GOOGLE_PASSWORD_ENCRYPTION_KEY,
    initialSuperAdminLogin: env.INITIAL_SUPER_ADMIN_LOGIN,
    initialSuperAdminEmail: env.INITIAL_SUPER_ADMIN_EMAIL,
    initialSuperAdminPassword: env.INITIAL_SUPER_ADMIN_PASSWORD,
    sessionCookieSecure: env.SESSION_COOKIE_SECURE === 'true',
  };
}

module.exports = { loadConfig };
