# Database Source Selection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an explicit, remembered choice between a managed local PostgreSQL database and a validated cloud PostgreSQL URL during full deployment.

**Architecture:** Extend the existing Bash deployment orchestrator with mode inference, a validated two-choice prompt, mode-specific preparation functions, and non-interactive saved-database validation for rebuilds. Keep `.env` updates atomic and leave the prior database configuration untouched until the selected replacement has passed validation.

**Tech Stack:** Bash 4+, PostgreSQL `psql`, Node.js built-in test runner.

## Global Constraints

- Full deployment asks for local or cloud mode and defaults to the remembered choice.
- A legacy managed loopback URL infers local mode; all other existing URLs infer cloud mode; no URL defaults to local.
- Local mode provisions or repairs `oplogin`/`op_proxy`; cloud mode never installs a PostgreSQL server or edits `pg_hba.conf`.
- Cloud URLs must use `postgres://` or `postgresql://`, remain hidden, and pass a real connection check before `.env` changes.
- Rebuild validates the saved mode and URL without prompting or switching.
- General `.env` configuration preserves `DATABASE_MODE` and `DATABASE_URL` without asking for them.
- Database failure stops before PM2 startup.

---

### Task 1: Mode inference and selection

**Files:**
- Modify: `deploy-oplogin.sh`
- Modify: `test/deploy-script.test.js`

**Interfaces:**
- Produces: `infer_database_mode(url) -> local|cloud`, `prompt_database_mode(default_mode) -> local|cloud`, and `database_url_scheme_valid(url) -> exit status`.
- Consumes: existing `trim`, `warn`, and non-echoing secret prompt.

- [ ] **Step 1: Add failing behavior tests**

Test literal URL cases: `postgres://oplogin:x@127.0.0.1:5432/op_proxy` and `localhost` infer `local`; cloud hosts infer `cloud`; empty URL infers `local`. Test invalid selection followed by `2` and assert output `cloud`. Test URL scheme acceptance for `postgres://` and `postgresql://` and rejection of `mysql://` and empty input.

- [ ] **Step 2: Verify RED**

Run: `node --test --test-name-pattern='database mode|database URL scheme' test/deploy-script.test.js`

Expected: FAIL because mode and scheme functions are missing.

- [ ] **Step 3: Implement mode helpers**

Parse the managed URL using a strict Bash regex limited to role `oplogin`, host `127.0.0.1` or `localhost`, optional port `5432`, and database `op_proxy`. Render the numbered menu to stderr, map `1` to `local` and `2` to `cloud`, retry invalid values, and validate only the two PostgreSQL URL prefixes.

- [ ] **Step 4: Verify GREEN and commit**

Run: `node --test --test-name-pattern='database mode|database URL scheme' test/deploy-script.test.js`

Expected: focused tests PASS.

Commit: `git commit -m "Add database source selection helpers"`

### Task 2: Safe local and cloud preparation

**Files:**
- Modify: `deploy-oplogin.sh`
- Modify: `test/deploy-script.test.js`

**Interfaces:**
- Consumes: `provision_managed_local_database(target_dir)`, `database_url_works(url)`, `set_env_value`, `prompt_secret_default`, and the Task 1 helpers.
- Produces: `prepare_local_database(target_dir, current_url)`, `prepare_cloud_database(target_dir, current_url)`, and `prepare_database(target_dir, interactive=true)`.

- [ ] **Step 1: Add failing local and cloud tests**

For local mode, double provisioning and assert it is called without a secret URL prompt. For cloud mode, feed a valid URL, double `database_url_works`, assert local provisioning is not called, and assert `.env` contains `DATABASE_MODE=cloud` and the URL only after validation. Add invalid-scheme and failed-connection cases and assert the prior `.env` bytes are unchanged.

- [ ] **Step 2: Verify RED**

Run: `node --test --test-name-pattern='local database selection|cloud database selection|failed cloud' test/deploy-script.test.js`

Expected: FAIL because the current `prepare_database` has no explicit mode flow.

- [ ] **Step 3: Implement atomic mode-specific preparation**

Install only the `psql` client before selection. Read saved mode or infer it, prompt only in interactive mode, confirm a mode switch, then call the selected preparer. Cloud preparation validates into local variables before writing `DATABASE_URL` and `DATABASE_MODE`. Local preparation reuses a working managed URL; otherwise it provisions and then writes local mode. Declined switching returns failure without changing `.env`.

- [ ] **Step 4: Verify GREEN and commit**

Run: `node --test --test-name-pattern='local database selection|cloud database selection|failed cloud' test/deploy-script.test.js`

Expected: focused tests PASS.

Commit: `git commit -m "Add local and cloud database deployment modes"`

### Task 3: Configuration preservation and rebuild behavior

**Files:**
- Modify: `deploy-oplogin.sh`
- Modify: `test/deploy-script.test.js`
- Modify: `README.md`

**Interfaces:**
- Consumes: `prepare_database(target_dir, interactive)` and existing deploy/rebuild/env orchestration.
- Produces: full deploy with `interactive=true`; rebuild with `interactive=false`; `.env` configuration that preserves database mode and URL.

- [ ] **Step 1: Add failing orchestration tests**

Create a temporary `.env`, run `configure_env` with non-database prompt doubles, and assert the database mode and URL are byte-for-byte preserved. Double `prepare_database` during rebuild and assert it receives `false` and runs before PM2; assert failure prevents PM2.

- [ ] **Step 2: Verify RED**

Run: `node --test --test-name-pattern='preserves database settings|rebuild validates saved database' test/deploy-script.test.js`

Expected: FAIL because `configure_env` currently asks for the URL and rebuild does not call database preparation.

- [ ] **Step 3: Wire orchestration and documentation**

Remove the database URL prompt from `configure_env`; require and retain both stored database fields in its atomic rewrite. Call `prepare_database "$install_dir" true` during full deployment and `prepare_database "$PROJECT_DIR" false` during rebuild before dependency/startup completion. Update README with the exact two-option interaction and cloud/local behavior.

- [ ] **Step 4: Final verification**

Run: `bash -n deploy-oplogin.sh`

Run: `node --test test/deploy-script.test.js`

Run: `npm test`

Run: `git diff --check`

Expected: all commands exit 0; deployment tests and full suite have zero failures.

- [ ] **Step 5: Commit**

Commit: `git commit -m "Remember database source across deployments"`
