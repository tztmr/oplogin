const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const scriptPath = path.join(__dirname, '..', 'deploy-oplogin.sh');

function runSourcedScript(body, input = '') {
  return spawnSync(
    'bash',
    ['-c', 'source "$1"; shift; eval "$1"', 'bash', scriptPath, body],
    { encoding: 'utf8', input },
  );
}

test('deploy script rejects Node 16 and accepts supported Node majors', () => {
  const result = runSourcedScript(`
    if node_runtime_supported 16; then node16=0; else node16=$?; fi
    if node_runtime_supported 18; then node18=0; else node18=$?; fi
    if node_runtime_supported 22; then node22=0; else node22=$?; fi
    printf '%s %s %s' "$node16" "$node18" "$node22"
  `);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '1 0 0');
});

test('secret defaults are preserved without being rendered', () => {
  const result = runSourcedScript(
    'prompt_secret_default "数据库连接" "do-not-print"',
    '\n',
  );

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'do-not-print');
  assert.doesNotMatch(result.stderr, /do-not-print/);
  assert.match(result.stderr, /已配置，回车保留/);
});

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
