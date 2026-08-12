const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const scriptPath = path.join(__dirname, '..', 'deploy-oplogin.sh');

function runSourcedScript(body, input = '', env = {}) {
  return spawnSync(
    'bash',
    ['-c', 'source "$1"; shift; eval "$1"', 'bash', scriptPath, body],
    { encoding: 'utf8', input, env: { ...process.env, ...env } },
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

test('RHEL Node upgrade disables AppStream and retries package conflicts with allowerasing', (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oplogin-node-'));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const callsPath = path.join(tempDir, 'calls.log');

  const result = runSourcedScript(`
    run_root() {
      printf '%s\n' "$*" >> "$TEST_CALLS"
      if [[ "$1" == 'dnf' && "$2" == 'install' && "$3" == '-y' && "$4" == 'nodejs' ]]; then
        return 1
      fi
      if [[ "$*" == 'bash -' ]]; then
        cat >/dev/null
      fi
      return 0
    }
    curl() { printf '# repository setup'; }
    install_node_with_dnf
  `, '', { TEST_CALLS: callsPath });

  assert.equal(result.status, 0, result.stderr);
  const calls = fs.readFileSync(callsPath, 'utf8');
  assert.match(calls, /^dnf install -y ca-certificates curl$/m);
  assert.match(calls, /^dnf module disable -y nodejs$/m);
  assert.match(calls, /^dnf install -y nodejs$/m);
  assert.match(calls, /^dnf install -y --allowerasing nodejs$/m);
  assert.match(result.stdout, /旧版 Node\.js\/npm 软件包冲突/);
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

test('managed pg_hba rules are scoped, first-match, backed up, and idempotent', (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oplogin-hba-'));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const hbaPath = path.join(tempDir, 'pg_hba.conf');
  const original = [
    '# PostgreSQL Client Authentication Configuration File',
    'local all all peer',
    'host all all 127.0.0.1/32 ident',
    '',
  ].join('\n');
  fs.writeFileSync(hbaPath, original);

  const result = runSourcedScript(
    'write_managed_pg_hba "$TEST_HBA"; write_managed_pg_hba "$TEST_HBA"',
    '',
    { TEST_HBA: hbaPath },
  );

  assert.equal(result.status, 0, result.stderr);
  const updated = fs.readFileSync(hbaPath, 'utf8');
  assert.match(
    updated,
    /# BEGIN OPLOGIN MANAGED\nhost\s+op_proxy\s+oplogin\s+127\.0\.0\.1\/32\s+scram-sha-256\nhost\s+op_proxy\s+oplogin\s+::1\/128\s+scram-sha-256\n# END OPLOGIN MANAGED/,
  );
  assert.ok(
    updated.indexOf('# BEGIN OPLOGIN MANAGED')
      < updated.indexOf('host all all 127.0.0.1/32 ident'),
  );
  assert.equal((updated.match(/# BEGIN OPLOGIN MANAGED/g) || []).length, 1);
  assert.equal(
    fs.readFileSync(`${hbaPath}.oplogin.bak`, 'utf8'),
    original,
  );
});

test('prepare_database preserves a working existing database URL', (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oplogin-db-'));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const envPath = path.join(tempDir, '.env');
  fs.writeFileSync(envPath, 'DATABASE_URL=postgres://existing.example/op_proxy\n');

  const result = runSourcedScript(`
    install_psql_if_needed() { return 0; }
    database_url_works() { return 0; }
    provision_managed_local_database() { printf 'PROVISION_CALLED'; return 99; }
    prepare_database "$TEST_PROJECT"
  `, '', { TEST_PROJECT: tempDir });

  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout, /PROVISION_CALLED/);
  assert.equal(
    fs.readFileSync(envPath, 'utf8'),
    'DATABASE_URL=postgres://existing.example/op_proxy\n',
  );
});

test('managed database rejects PostgreSQL older than 14', () => {
  const result = runSourcedScript(`
    if postgresql_server_supported 13; then pg13=0; else pg13=$?; fi
    if postgresql_server_supported 14; then pg14=0; else pg14=$?; fi
    if postgresql_server_supported 17; then pg17=0; else pg17=$?; fi
    printf '%s %s %s' "$pg13" "$pg14" "$pg17"
  `);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '1 0 0');
});

test('deploy prepares and verifies the database before PM2 startup', () => {
  const orchestrationDoubles = `
    events=''
    record() { events="\${events} $1"; }
    install_git_if_needed() { :; }
    install_node_if_needed() { :; }
    install_pm2_if_needed() { :; }
    ensure_pm2_startup() { :; }
    load_state() { return 1; }
    prompt_default() { printf '%s' "$2"; }
    port_owner() { :; }
    sync_project_code() { PROJECT_DIR="$1"; record sync; }
    assert_project_layout() { :; }
    install_app_dependencies() { record dependencies; }
    configure_env() { record configure_env; }
    verify_configured_database() { record verify_configured_database; }
    start_or_restart_app() { record start_or_restart_app; }
    wait_for_app_ready() { record wait_for_app_ready; }
    save_state() { record save_state; }
  `;

  const success = runSourcedScript(`${orchestrationDoubles}
    prepare_database() { record prepare_database; }
    deploy_app >/dev/null
    printf '%s' "$events"
  `);
  assert.equal(success.status, 0, success.stderr);
  assert.match(
    success.stdout,
    /dependencies prepare_database configure_env verify_configured_database start_or_restart_app wait_for_app_ready save_state$/,
  );

  const failure = runSourcedScript(`${orchestrationDoubles}
    prepare_database() { record prepare_database; return 23; }
    if deploy_app >/dev/null; then deploy_status=0; else deploy_status=$?; fi
    printf 'status=%s events=%s' "$deploy_status" "$events"
  `);
  assert.equal(failure.status, 0, failure.stderr);
  assert.match(failure.stdout, /^status=23 /);
  assert.doesNotMatch(failure.stdout, /start_or_restart_app/);
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
