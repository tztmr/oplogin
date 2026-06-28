const crypto = require('node:crypto');
const { hashAdminPassword } = require('./admin-password');

function serializeAdminUser(row) {
  return {
    id: row.id,
    login: row.login,
    email: row.email,
    role: row.role,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastLoginAt: row.last_login_at,
  };
}

async function findAdminByIdentifier(pool, identifier) {
  const result = await pool.query(
    `select * from admin_users where login = $1 or email = $1 limit 1`,
    [String(identifier || '').trim()],
  );

  return result.rows[0] || null;
}

async function findAdminById(pool, id) {
  const result = await pool.query(
    `select * from admin_users where id = $1 limit 1`,
    [id],
  );

  return result.rows[0] || null;
}

async function listAdminUsers(pool) {
  const result = await pool.query(
    `select * from admin_users order by created_at desc`,
  );

  return result.rows.map(serializeAdminUser);
}

async function createAdminUser(pool, payload) {
  const passwordHash = await hashAdminPassword(payload.password);
  const result = await pool.query(
    `
      insert into admin_users (id, login, email, password_hash, role, status)
      values ($1, $2, $3, $4, $5, 'active')
      returning *
    `,
    [
      crypto.randomUUID(),
      payload.login,
      payload.email,
      passwordHash,
      payload.role || 'operator',
    ],
  );

  return serializeAdminUser(result.rows[0]);
}

async function updateAdminUser(pool, id, payload) {
  const result = await pool.query(
    `
      update admin_users
      set
        login = $2,
        email = $3,
        role = $4,
        status = $5,
        updated_at = now()
      where id = $1
      returning *
    `,
    [id, payload.login, payload.email, payload.role, payload.status],
  );

  return result.rows[0] ? serializeAdminUser(result.rows[0]) : null;
}

async function resetAdminPassword(pool, id, password) {
  const passwordHash = await hashAdminPassword(password);

  await pool.query(
    `update admin_users set password_hash = $2, updated_at = now() where id = $1`,
    [id, passwordHash],
  );
}

module.exports = {
  createAdminUser,
  findAdminByIdentifier,
  findAdminById,
  listAdminUsers,
  resetAdminPassword,
  serializeAdminUser,
  updateAdminUser,
};
