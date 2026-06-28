const test = require('node:test');
const assert = require('node:assert/strict');

const { createAdminTestContext } = require('./helpers/create-admin-test-context');

test('bootstraps exactly one super admin from env', async () => {
  const { pool } = await createAdminTestContext();

  const result = await pool.query(`
    select login, role, status
    from admin_users
    order by created_at asc
  `);

  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].login, 'root');
  assert.equal(result.rows[0].role, 'super_admin');
  assert.equal(result.rows[0].status, 'active');
});

test('login with username creates a session and me returns the admin summary', async () => {
  const { agent, config } = await createAdminTestContext();

  const loginResponse = await agent.post('/api/admin/auth/login').send({
    identifier: config.initialSuperAdminLogin,
    password: config.initialSuperAdminPassword,
  });
  const meResponse = await agent.get('/api/admin/auth/me');

  assert.equal(loginResponse.status, 200);
  assert.equal(meResponse.status, 200);
  assert.equal(meResponse.body.user.login, config.initialSuperAdminLogin);
  assert.equal(meResponse.body.user.role, 'super_admin');
});

test('disabled admins cannot log in', async () => {
  const { agent, pool, config } = await createAdminTestContext();

  await pool.query(
    `update admin_users set status = 'disabled' where login = $1`,
    [config.initialSuperAdminLogin],
  );

  const loginResponse = await agent.post('/api/admin/auth/login').send({
    identifier: config.initialSuperAdminLogin,
    password: config.initialSuperAdminPassword,
  });

  assert.equal(loginResponse.status, 401);
  assert.match(loginResponse.body.error, /Invalid credentials|disabled/i);
});

test('secure admin session cookie is issued correctly behind https reverse proxy', async () => {
  const { app, config } = await createAdminTestContext({
    SESSION_COOKIE_SECURE: 'true',
  });

  const loginResponse = await require('supertest')(app)
    .post('/api/admin/auth/login')
    .set('X-Forwarded-Proto', 'https')
    .send({
      identifier: config.initialSuperAdminLogin,
      password: config.initialSuperAdminPassword,
    });

  assert.equal(loginResponse.status, 200);
  assert.ok(
    (loginResponse.headers['set-cookie'] || []).some((cookie) =>
      cookie.includes('op_admin_session='),
    ),
  );
});

test('logged-in admin can change own password with the current password', async () => {
  const { agent, config } = await createAdminTestContext();

  const loginResponse = await agent.post('/api/admin/auth/login').send({
    identifier: config.initialSuperAdminLogin,
    password: config.initialSuperAdminPassword,
  });
  const changeResponse = await agent.post('/api/admin/auth/change-password').send({
    currentPassword: config.initialSuperAdminPassword,
    newPassword: 'new-secret-pass',
  });
  await agent.post('/api/admin/auth/logout').send();
  const reloginResponse = await agent.post('/api/admin/auth/login').send({
    identifier: config.initialSuperAdminLogin,
    password: 'new-secret-pass',
  });

  assert.equal(loginResponse.status, 200);
  assert.equal(changeResponse.status, 204);
  assert.equal(reloginResponse.status, 200);
});

test('changing own password requires the correct current password', async () => {
  const { agent, config } = await createAdminTestContext();

  await agent.post('/api/admin/auth/login').send({
    identifier: config.initialSuperAdminLogin,
    password: config.initialSuperAdminPassword,
  });
  const changeResponse = await agent.post('/api/admin/auth/change-password').send({
    currentPassword: 'wrong-password',
    newPassword: 'new-secret-pass',
  });

  assert.equal(changeResponse.status, 401);
  assert.match(changeResponse.body.error, /当前密码不正确/);
});
