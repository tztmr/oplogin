const crypto = require('node:crypto');
const { hashAdminPassword, verifyAdminPassword } = require('./admin-password');

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
    wifiQrConfig: {
      type: String(row.wifi_type || 'WPA').trim() || 'WPA',
      ssid: String(row.wifi_ssid || '').trim(),
      password: String(row.wifi_password || '').trim(),
      hidden: Boolean(row.wifi_hidden),
    },
  };
}

function normalizeWifiQrConfig(payload = {}) {
  return {
    type: String(payload.wifiType || 'WPA').trim().toUpperCase() || 'WPA',
    ssid: String(payload.wifiSsid || '').trim(),
    password: String(payload.wifiPassword || '').trim(),
    hidden: Boolean(payload.wifiHidden),
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
  const wifiQrConfig = normalizeWifiQrConfig(payload);
  const result = await pool.query(
    `
      insert into admin_users (
        id,
        login,
        email,
        password_hash,
        role,
        status,
        wifi_type,
        wifi_ssid,
        wifi_password,
        wifi_hidden
      )
      values ($1, $2, $3, $4, $5, 'active', $6, $7, $8, $9)
      returning *
    `,
    [
      crypto.randomUUID(),
      payload.login,
      payload.email,
      passwordHash,
      payload.role || 'operator',
      wifiQrConfig.type,
      wifiQrConfig.ssid,
      wifiQrConfig.password,
      wifiQrConfig.hidden,
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

async function updateAdminUserQrConfig(pool, id, payload) {
  const wifiQrConfig = normalizeWifiQrConfig(payload);
  const result = await pool.query(
    `
      update admin_users
      set
        wifi_type = $2,
        wifi_ssid = $3,
        wifi_password = $4,
        wifi_hidden = $5,
        updated_at = now()
      where id = $1
      returning *
    `,
    [
      id,
      wifiQrConfig.type,
      wifiQrConfig.ssid,
      wifiQrConfig.password,
      wifiQrConfig.hidden,
    ],
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

async function changeOwnAdminPassword(pool, id, currentPassword, newPassword) {
  if (!String(currentPassword || '').trim() || !String(newPassword || '').trim()) {
    const error = new Error('请填写当前密码和新密码');
    error.statusCode = 400;
    throw error;
  }

  const user = await findAdminById(pool, id);
  if (!user) {
    const error = new Error('User not found');
    error.statusCode = 404;
    throw error;
  }

  const passwordMatches = await verifyAdminPassword(
    currentPassword,
    user.password_hash,
  );
  if (!passwordMatches) {
    const error = new Error('当前密码不正确');
    error.statusCode = 401;
    throw error;
  }

  await resetAdminPassword(pool, id, newPassword);
}

module.exports = {
  changeOwnAdminPassword,
  createAdminUser,
  findAdminByIdentifier,
  findAdminById,
  listAdminUsers,
  normalizeWifiQrConfig,
  resetAdminPassword,
  serializeAdminUser,
  updateAdminUser,
  updateAdminUserQrConfig,
};
