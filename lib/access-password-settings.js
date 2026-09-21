const { DEFAULT_ACCESS_PASSWORD } = require('./config');

const ACCESS_PASSWORD_SETTING_KEY = 'access_password';
const ACCESS_PASSWORD_MAX_LENGTH = 64;

function fallbackAccessPassword(config) {
  return (config && config.accessPassword) || DEFAULT_ACCESS_PASSWORD;
}

function normalizeAccessPassword(value) {
  const password = String(value == null ? '' : value).trim();
  if (!password) {
    const error = new Error('密码不能为空');
    error.statusCode = 400;
    throw error;
  }
  if (password.length > ACCESS_PASSWORD_MAX_LENGTH) {
    const error = new Error(`密码最长 ${ACCESS_PASSWORD_MAX_LENGTH} 个字符`);
    error.statusCode = 400;
    throw error;
  }
  return password;
}

async function loadAccessPassword({ pool, config } = {}) {
  if (!pool) {
    const password = fallbackAccessPassword(config);
    if (config) {
      config.accessPassword = password;
    }
    return password;
  }

  const result = await pool.query(
    `select value from app_settings where key = $1`,
    [ACCESS_PASSWORD_SETTING_KEY],
  );
  const stored = result.rows[0] && String(result.rows[0].value || '').trim();
  const password = stored || fallbackAccessPassword(config);
  if (config) {
    config.accessPassword = password;
  }
  return password;
}

async function saveAccessPassword({ pool, config, accessPassword } = {}) {
  const password = normalizeAccessPassword(accessPassword);
  if (pool) {
    await pool.query(
      `
        insert into app_settings (key, value, updated_at)
        values ($1, $2, now())
        on conflict (key) do update
        set value = excluded.value, updated_at = now()
      `,
      [ACCESS_PASSWORD_SETTING_KEY, password],
    );
  }
  if (config) {
    config.accessPassword = password;
  }
  return password;
}

module.exports = {
  ACCESS_PASSWORD_MAX_LENGTH,
  loadAccessPassword,
  normalizeAccessPassword,
  saveAccessPassword,
};
