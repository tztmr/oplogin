const crypto = require('node:crypto');
const { hashAdminPassword } = require('./admin-password');

async function ensureInitialSuperAdmin({ pool, config }) {
  const existing = await pool.query(`select count(*)::int as count from admin_users`);

  if (Number(existing.rows[0].count) > 0) {
    return;
  }

  const passwordHash = await hashAdminPassword(config.initialSuperAdminPassword);

  await pool.query(
    `
      insert into admin_users (
        id,
        login,
        email,
        password_hash,
        role,
        status
      ) values ($1, $2, $3, $4, 'super_admin', 'active')
    `,
    [
      crypto.randomUUID(),
      config.initialSuperAdminLogin,
      config.initialSuperAdminEmail,
      passwordHash,
    ],
  );
}

module.exports = { ensureInitialSuperAdmin };
