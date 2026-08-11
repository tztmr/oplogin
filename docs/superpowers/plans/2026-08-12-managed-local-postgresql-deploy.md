# Managed Local PostgreSQL Deployment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `deploy-oplogin.sh` repair unsupported Node.js runtimes and provision a secure, dedicated local PostgreSQL database when no working database connection exists.

**Architecture:** Keep orchestration in the existing Bash deployment script, but add small functions for runtime validation, PostgreSQL lifecycle management, scoped authentication configuration, and connection verification. Preserve a working existing `DATABASE_URL`; otherwise generate and store a dedicated local connection before PM2 starts.

**Tech Stack:** Bash 4+, systemd, apt/dnf/yum, PostgreSQL 14+, Node.js 22, PM2, Node.js built-in test runner.

## Global Constraints

- Node.js must be at least 18; install Node.js 22 when missing or too old.
- Never print `DATABASE_URL`, database passwords, session secrets, encryption keys, or administrator passwords.
- Preserve any existing `DATABASE_URL` that passes a real `psql` connection check.
- The managed database is `op_proxy` and its non-superuser owner role is `oplogin`.
- Only add loopback `scram-sha-256` rules scoped to database `op_proxy` and role `oplogin`.
- Stop before PM2 startup when PostgreSQL installation, initialization, authentication reload, or connection verification fails.

---

### Task 1: Supported Node.js runtime and secret-safe prompts

**Files:**
- Modify: `deploy-oplogin.sh`
- Modify: `test/deploy-script.test.js`

**Interfaces:**
- Produces: `node_major_version() -> integer`, `node_runtime_supported() -> exit status`, and `prompt_secret_default(prompt, current_value) -> selected value without echoing current_value`.
- Consumes: existing `command_exists`, `run_root`, `trim`, and package-manager detection.

- [ ] **Step 1: Add failing behavior tests**

Add a `runSourcedScript(body, input)` helper that launches Bash, sources `deploy-oplogin.sh` without executing `main`, and runs the supplied body. Add tests proving that major version 16 is rejected, 18 and 22 are accepted, and `prompt_secret_default` returns the preserved value while its prompt output does not contain that value.

```js
test('deploy script rejects Node 16 and accepts supported Node majors', () => {
  const result = runSourcedScript('node_runtime_supported 16; printf " %s %s" "$?" "$(node_runtime_supported 18; echo $?)"');
  assert.equal(result.stdout.trim(), '1 0');
});

test('secret defaults are preserved without being rendered', () => {
  const result = runSourcedScript('prompt_secret_default "数据库连接" "do-not-print"', '\n');
  assert.equal(result.stdout, 'do-not-print');
  assert.doesNotMatch(result.stderr, /do-not-print/);
});
```

- [ ] **Step 2: Run the focused tests and verify RED**

Run: `node --test --test-name-pattern='Node 16|secret defaults' test/deploy-script.test.js`

Expected: FAIL because the source guard and new functions do not exist.

- [ ] **Step 3: Implement the minimum runtime and prompt behavior**

Guard the entry point with `[[ "${BASH_SOURCE[0]}" == "$0" ]] && main "$@"`. Add version parsing and make `install_node_if_needed` reinstall through NodeSource 22 when the major version is below 18. For apt, dnf, and yum, install `ca-certificates` and `curl`, run the matching NodeSource `setup_22.x`, then install `nodejs`. Add `prompt_secret_default` with `[已配置，回车保留]` instead of the current value and use it for all secret fields in `configure_env`.

- [ ] **Step 4: Verify GREEN**

Run: `node --test --test-name-pattern='Node 16|secret defaults' test/deploy-script.test.js`

Expected: both focused tests PASS.

- [ ] **Step 5: Commit**

```bash
git add deploy-oplogin.sh test/deploy-script.test.js docs/superpowers/plans/2026-08-12-managed-local-postgresql-deploy.md
git commit -m "Harden deployment runtime and secret prompts"
```

### Task 2: Idempotent local PostgreSQL provisioning

**Files:**
- Modify: `deploy-oplogin.sh`
- Modify: `test/deploy-script.test.js`

**Interfaces:**
- Consumes: `PROJECT_DIR`, `read_env_value`, `set_env_value`, `run_root`, `ask_yes_no`, and the supported system package managers.
- Produces: `install_postgresql_server_if_needed()`, `detect_postgresql_service() -> unit name`, `run_as_postgres(command...)`, `write_managed_pg_hba(hba_file)`, `database_url_works(url)`, and `prepare_database(target_dir)`.

- [ ] **Step 1: Add failing behavior tests**

Add a temporary `pg_hba.conf` fixture and source the script to call `write_managed_pg_hba`. Assert that the generated block precedes the original catch-all `ident` rule, contains only the `op_proxy`/`oplogin` loopback SCRAM rules, retains the original line, creates a backup, and remains single-instance after a second call. Add an orchestration test with shell function doubles proving `prepare_database` preserves a working existing URL and does not invoke local provisioning.

```js
assert.match(first, /# BEGIN OPLOGIN MANAGED\nhost\s+op_proxy\s+oplogin\s+127\.0\.0\.1\/32\s+scram-sha-256/);
assert.ok(first.indexOf('# BEGIN OPLOGIN MANAGED') < first.indexOf('127.0.0.1/32 ident'));
assert.equal((second.match(/# BEGIN OPLOGIN MANAGED/g) || []).length, 1);
```

- [ ] **Step 2: Run the focused PostgreSQL tests and verify RED**

Run: `node --test --test-name-pattern='pg_hba|working existing database' test/deploy-script.test.js`

Expected: FAIL because PostgreSQL provisioning and managed HBA functions are absent.

- [ ] **Step 3: Implement PostgreSQL lifecycle management**

Install server and client packages (`postgresql postgresql-client` on apt; `postgresql-server postgresql-contrib` on dnf/yum). Initialize RHEL-family data only when `PG_VERSION` is absent, detect an installed systemd unit from `postgresql`, `postgresql.service`, or versioned units, then enable and start it. Use `runuser -u postgres --` or `sudo -u postgres` from `/tmp` for administrative SQL.

- [ ] **Step 4: Implement scoped authentication and role/database creation**

Generate an alphanumeric password. Set `password_encryption` to `scram-sha-256`, conditionally create or alter role `oplogin` with `LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE`, conditionally create database `op_proxy`, and enforce ownership. Write a marked HBA block before all existing rules, back up the original once, reload PostgreSQL, and construct `postgres://oplogin:<generated>@127.0.0.1:5432/op_proxy`.

- [ ] **Step 5: Implement preservation and replacement flow**

`prepare_database` installs the client, checks an existing URL with `psql "$url" -v ON_ERROR_STOP=1 -tAc 'SELECT 1'`, preserves it on success, and otherwise asks permission before provisioning locally. It writes the managed URL with mode 0600 and verifies it before returning.

- [ ] **Step 6: Verify GREEN**

Run: `node --test --test-name-pattern='pg_hba|working existing database' test/deploy-script.test.js`

Expected: focused tests PASS.

- [ ] **Step 7: Commit**

```bash
git add deploy-oplogin.sh test/deploy-script.test.js
git commit -m "Provision managed local PostgreSQL database"
```

### Task 3: Deployment ordering, diagnostics, and regression verification

**Files:**
- Modify: `deploy-oplogin.sh`
- Modify: `test/deploy-script.test.js`
- Modify: `README.md`

**Interfaces:**
- Consumes: `prepare_database(target_dir)` and existing PM2 readiness flow.
- Produces: deployment order `dependencies -> database preparation -> env configuration -> database verification -> PM2`, plus documented automatic behavior and recovery boundaries.

- [ ] **Step 1: Add a failing deployment-order test**

Source the script, replace orchestration functions with append-only shell doubles, invoke `deploy_app` with prompt defaults, and assert the literal event order ends with `prepare_database configure_env start_or_restart_app wait_for_app_ready` while a failed `prepare_database` prevents the PM2 marker.

- [ ] **Step 2: Run the deployment-order test and verify RED**

Run: `node --test --test-name-pattern='database before PM2' test/deploy-script.test.js`

Expected: FAIL because `deploy_app` does not call `prepare_database`.

- [ ] **Step 3: Wire provisioning into deployment and document it**

Call `prepare_database "$install_dir"` immediately before `configure_env`. Keep the generated URL as the default value without rendering it. Update README prerequisites and quick-start text to explain automatic local PostgreSQL provisioning, preservation of working external URLs, Node.js 18 minimum/22 automatic install, and the non-destructive HBA scope.

- [ ] **Step 4: Verify focused behavior and Shell syntax**

Run: `node --test test/deploy-script.test.js`

Expected: all deployment tests PASS.

Run: `bash -n deploy-oplogin.sh`

Expected: exit 0 with no output.

- [ ] **Step 5: Run the complete regression suite**

Run: `npm test`

Expected: all tests PASS with zero failures.

- [ ] **Step 6: Inspect secrets and diff quality**

Run: `rg -n 'postgres://postgres:|qq123456|prompt_default.*(DATABASE_URL|SESSION_SECRET|ENCRYPTION_KEY|PASSWORD)' deploy-oplogin.sh README.md test`

Expected: no hard-coded or rendered credential defaults.

Run: `git diff --check && git status --short`

Expected: no whitespace errors; only planned files are modified.

- [ ] **Step 7: Commit**

```bash
git add deploy-oplogin.sh test/deploy-script.test.js README.md
git commit -m "Verify managed database before application startup"
```
