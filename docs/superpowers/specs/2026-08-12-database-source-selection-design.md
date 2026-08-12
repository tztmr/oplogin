# Database Source Selection Design

## Goal

Let the operator explicitly choose between a script-managed local PostgreSQL database and a cloud PostgreSQL `DATABASE_URL` during full deployment. Remember the previous choice, allow switching safely, and keep rebuilds non-interactive with respect to the database source.

## User interaction

Full deployment displays:

```text
数据库类型：
1) 本地 PostgreSQL（自动安装并创建）
2) 云 PostgreSQL（手动输入 DATABASE_URL）
请选择 [1-2] [上次选择]:
```

The default is the saved choice. If no choice has been saved, local PostgreSQL (`1`) is the default. Empty input accepts the default; any value other than `1` or `2` is rejected and prompted again.

Switching between local and cloud mode requires confirmation before changing `.env`. Declining the confirmation preserves the previous mode and connection without starting deployment with a partially changed configuration.

## Local mode

Local mode uses the existing managed-database flow:

- Install and start PostgreSQL 14+ when required.
- Create the non-superuser role `oplogin` and database `op_proxy`.
- Generate a URL-safe password and add only the scoped loopback SCRAM authentication rules.
- Reuse an existing working script-managed local URL instead of rotating credentials on every deployment.
- Verify the connection before continuing.

If the saved mode is local but its connection is unavailable, repair or reprovision the managed local database rather than silently switching to cloud mode.

## Cloud mode

Cloud mode asks for `DATABASE_URL` using a non-echoing secret prompt. An existing cloud URL is preserved on empty input but is never rendered in the prompt or logs.

The submitted URL must begin with `postgres://` or `postgresql://` and must pass a real `psql` connection test. Invalid or unreachable URLs stop deployment before `.env` is replaced and before PM2 starts. PostgreSQL server packages and local authentication configuration are not touched in cloud mode; only the `psql` client may be installed for verification.

## Persistence

Store the selected mode as `DATABASE_MODE=local` or `DATABASE_MODE=cloud` in the mode-0600 `.env` file. Infer a missing legacy mode from the existing URL: loopback host with database `op_proxy` and user `oplogin` is local; all other URLs are cloud. If no URL exists, default to local.

The general `.env` configuration step preserves `DATABASE_MODE` and `DATABASE_URL` but does not ask for the database URL again. Database selection and validation are owned only by the database preparation flow.

## Deployment behavior

- Full deploy (`deploy` or menu option 1): ask for the mode, prepare or validate the selected database, configure the remaining environment values, revalidate the stored URL, then start PM2.
- Rebuild (`rebuild` or menu option 7): read the saved mode and URL, validate them without prompting, and stop if they are unavailable. Rebuild never switches modes or provisions a different database implicitly.
- Environment configuration (`env` or menu option 3): configure non-database settings only, preserve database values, revalidate the database, then restart.

## Safety and tests

Tests cover:

- Default local selection, saved selection reuse, invalid input retry, and switch confirmation.
- Local selection provisioning without requesting a URL.
- Cloud selection secret input, scheme validation, real connection validation, and no local-server provisioning.
- Failed cloud validation leaves the existing `.env` unchanged and prevents PM2 startup.
- `configure_env` preserves database mode and URL without prompting for either.
- Rebuild validates the saved database without asking or switching.
- Secret values remain absent from prompt and error output.

Fresh deployment-script tests, `bash -n`, and the complete Node test suite are required before completion.
