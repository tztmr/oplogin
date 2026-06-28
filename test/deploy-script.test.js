const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const scriptPath = path.join(__dirname, '..', 'deploy-oplogin.sh');

test('deploy script targets the current GitHub repository over HTTPS and installs runtime dependencies', () => {
  const script = fs.readFileSync(scriptPath, 'utf8');

  assert.match(script, /https:\/\/github\.com\/tztmr\/oplogin\.git/);
  assert.match(script, /pm2/);
  assert.match(script, /nginx/);
  assert.match(script, /npm ci|npm install/);
  assert.match(script, /certbot/);
});

test('deploy script and app both default to port 4399', () => {
  const script = fs.readFileSync(scriptPath, 'utf8');
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

  assert.match(script, /DEFAULT_PORT="4399"/);
  assert.match(server, /const PORT = process\.env\.PORT \|\| 4399;/);
});

test('deploy script preserves all required super-admin env fields when writing .env', () => {
  const script = fs.readFileSync(scriptPath, 'utf8');

  assert.match(script, /INITIAL_SUPER_ADMIN_EMAIL/);
  assert.match(
    script,
    /INITIAL_SUPER_ADMIN_EMAIL=\$\{new_admin_email\}/,
  );
});

test('deploy script can enable secure cookies for HTTPS deployments', () => {
  const script = fs.readFileSync(scriptPath, 'utf8');

  assert.match(script, /SESSION_COOKIE_SECURE/);
  assert.match(script, /set_env_value "\$PROJECT_DIR" "SESSION_COOKIE_SECURE" "true"/);
});

test('deploy script verifies the app is reachable before reporting success', () => {
  const script = fs.readFileSync(scriptPath, 'utf8');

  assert.match(script, /wait_for_app_ready\(\)/);
  assert.match(script, /local url="http:\/\/127\.0\.0\.1:\$\{APP_PORT\}\/"/);
  assert.match(script, /curl -fsS "\$url"/);
  assert.match(script, /wait_for_app_ready/);
});

test('deploy script verifies domain DNS before requesting HTTPS certificates', () => {
  const script = fs.readFileSync(scriptPath, 'utf8');

  assert.match(script, /check_domain_dns\(\)/);
  assert.match(script, /check_domain_dns "\$DOMAIN"/);
  assert.match(script, /getent hosts|dig \+short|host /);
});

test('deploy script configures PM2 startup for reboot persistence', () => {
  const script = fs.readFileSync(scriptPath, 'utf8');

  assert.match(script, /pm2 startup/);
  assert.match(script, /ensure_pm2_startup/);
  assert.match(script, /ensure_pm2_startup/);
});

test('deploy script can install psql client and reset the admin password from DATABASE_URL', () => {
  const script = fs.readFileSync(scriptPath, 'utf8');

  assert.match(script, /install_psql_if_needed\(\)/);
  assert.match(script, /reset_admin_password\(\)/);
  assert.match(script, /postgresql-client/);
  assert.match(script, /psql "\$database_url" -c/);
  assert.match(script, /node -e "require\('bcryptjs'\)\.hash/);
});
