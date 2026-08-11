# Managed Local PostgreSQL Deployment Design

## Goal

Make `deploy-oplogin.sh` complete a safe first deployment on a fresh Linux server without requiring the operator to manually create PostgreSQL roles, databases, or edit `pg_hba.conf`. The same script must also repair the observed Node.js 16 incompatibility and avoid printing secrets in prompts.

## Selected approach

The deployment script manages a dedicated local PostgreSQL database only when no working `DATABASE_URL` already exists. A working existing connection, including a remote database, is preserved unchanged. If an existing connection fails, the script asks once before replacing it with the managed local database; the default answer is yes for the interactive deployment flow.

Alternatives considered:

- Reuse the `postgres` superuser and globally replace `ident` with `md5`. This is simple but grants the application excessive privileges and changes authentication for unrelated databases.
- Run PostgreSQL in Docker. This provides isolation but introduces Docker as a new runtime dependency and does not match the current PM2/system-package deployment model.
- Require operators to prepare PostgreSQL manually. This preserves maximum control but is the failure-prone workflow this change is intended to remove.

## Runtime flow

1. Verify Git and a supported Node.js runtime before installing application dependencies. Node.js must be at least 18; Node.js 22 is installed when Node is missing or too old.
2. Clone or update the application and install npm dependencies.
3. Read the current `.env` without printing credential values.
4. If `DATABASE_URL` exists and a `psql` connection succeeds, preserve it.
5. If the URL is absent, or the operator approves replacing a failed URL, install and initialize the local PostgreSQL server.
6. Start and enable the detected PostgreSQL systemd service.
7. Create or update a non-superuser login role named `oplogin`, create database `op_proxy` owned by that role, and grant it database ownership. Generate a URL-safe random password and store it only in the mode-0600 `.env` file.
8. Add narrowly scoped, first-match `pg_hba.conf` rules for database `op_proxy` and role `oplogin` on loopback addresses using `scram-sha-256`. Do not modify authentication for other users or databases.
9. Reload PostgreSQL and verify the generated connection using `psql` before starting PM2.
10. Configure the remaining environment variables without echoing existing secret values, start PM2, and retain the existing HTTP readiness check.

## Distribution support

- Debian/Ubuntu: install `postgresql` and `postgresql-client`; use the active `postgresql` systemd unit or cluster tooling already supplied by the packages.
- RHEL/CentOS/Fedora: install server and client packages; initialize `/var/lib/pgsql/data` only when it has not already been initialized; use an available `postgresql` or versioned PostgreSQL systemd unit.
- Unsupported package managers or hosts without systemd fail with a direct diagnostic and do not write a misleading `DATABASE_URL`.

## Idempotency and failure handling

- A successful existing `DATABASE_URL` is never replaced.
- The managed role and database use conditional SQL, so reruns do not fail because objects already exist.
- Authentication rules are marked and replaced as one managed block, preventing duplicate entries.
- The original `pg_hba.conf` is backed up before the first managed edit.
- A failed package install, service start, SQL command, configuration reload, or connection check stops deployment before PM2 reports success.
- Generated credentials are not printed in informational or error output.

## Tests

Static deployment-script tests will require:

- Node major-version validation and a Node.js 22 installation path.
- PostgreSQL server installation, initialization, enable/start, and service detection.
- A dedicated `oplogin` role and `op_proxy` database rather than application use of the `postgres` superuser.
- Scoped `scram-sha-256` loopback rules with a managed marker and backup.
- Existing connection validation and managed connection validation before PM2 startup.
- Secret-preserving prompts that do not render the current secret values.

Fresh `bash -n` and the full Node test suite are required before completion.
