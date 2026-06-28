# Admin Backoffice Design

## Goal

Add a multi-account admin backoffice to the existing Express project without changing the current public `index.html` OP login page. The backoffice must support server-first deployment, use a Neon PostgreSQL connection from `.env`, encrypt sensitive business fields at rest, and provide separate `super_admin` and `operator` roles.

## Existing Project Constraints

- The current project is a lightweight `Express + static public files` app.
- The current public OP page at `public/index.html` stays in place and keeps its current behavior.
- The admin area should be introduced as a separate surface rather than merging into the public page.
- The primary deployment target is a regular Node server. Vercel compatibility is useful but secondary.

## Product Scope

### Business Record Fields

The admin backoffice manages one business record with these visible columns:

- Google account
- Google password
- Google assist
- Google expiry time
- UID
- UID created time
- OP
- OP link
- OP expiry time
- Remark
- Operation

`Operation` is a UI-only column with row actions such as edit and delete. It is not stored as database data.

### Roles

- `super_admin`
  - Can log in to the admin backoffice
  - Can create, edit, view, and delete business records
  - Can access account management
  - Can create operator accounts
  - Can reset passwords
  - Can disable or enable admin users
- `operator`
  - Can log in to the admin backoffice
  - Can create, edit, view, and delete business records
  - Can view and edit all business fields, including sensitive fields
  - Cannot access account management

### First Version Functional Scope

- Admin login with username or email plus password
- Admin session persistence with secure cookies
- Business record list page
- Independent filter controls for each business field
- Pagination
- Create, edit, and delete business records
- Super-admin-only account management
- Bootstrap the first super admin from `.env` when no admin users exist
- Encrypt sensitive business fields before storing them in PostgreSQL

### Out of Scope

- Public user registration
- Soft delete and restore
- Import or export
- Audit logs
- Fine-grained field-level permissions
- Team, org, or tenant isolation

## Recommended Architecture

### High-Level Structure

Keep the current Express application and add an isolated admin backoffice:

- Public page:
  - Existing OP page under the current public site
- Admin frontend:
  - `GET /admin/login`
  - `GET /admin`
  - `GET /admin/users`
- Admin API:
  - `POST /api/admin/auth/login`
  - `POST /api/admin/auth/logout`
  - `GET /api/admin/auth/me`
  - `GET /api/admin/records`
  - `POST /api/admin/records`
  - `GET /api/admin/records/:id`
  - `PUT /api/admin/records/:id`
  - `DELETE /api/admin/records/:id`
  - `GET /api/admin/users`
  - `POST /api/admin/users`
  - `PUT /api/admin/users/:id`
  - `PUT /api/admin/users/:id/password`

### Server Organization

Refactor the server into two layers:

- Reusable Express app module
  - Creates the app
  - Registers middleware
  - Registers public routes and admin routes
  - Registers error handling
- Runtime entry module
  - Reads `PORT`
  - Calls `app.listen(...)` for local or server deployment

This keeps the business code deployable on a regular server and easier to adapt later if a serverless target is added.

### Admin Frontend Approach

Use a small structured admin frontend rather than a single giant inline script:

- Static HTML pages for login, record management, and account management
- Shared admin CSS for layout and table styling
- Shared admin JavaScript utilities for API calls, session checks, form submission, toast messages, and table refresh
- Page-specific JavaScript modules for login, record list and form handling, and user management

This stays consistent with the current project style while preventing the admin code from becoming hard to maintain.

## Data Model

### Table: `admin_users`

Purpose: stores backoffice login accounts.

Columns:

- `id` UUID primary key
- `login` text unique not null
- `email` text unique not null
- `password_hash` text not null
- `role` text not null
- `status` text not null
- `created_at` timestamptz not null
- `updated_at` timestamptz not null
- `last_login_at` timestamptz null

Column rules:

- `role` is restricted to `super_admin` or `operator`
- `status` is restricted to `active` or `disabled`
- `login` is used for username login
- `email` is used for email login

### Table: `managed_records`

Purpose: stores the business data rows shown in the backoffice.

Columns:

- `id` UUID primary key
- `google_account` text not null
- `google_password_encrypted` text not null
- `google_password_search_hash` text not null
- `google_assist_encrypted` text not null
- `google_assist_search_hash` text not null
- `google_expire_at` timestamptz null
- `uid_value` text not null
- `uid_created_at` timestamptz null
- `op_value` text not null
- `op_link_encrypted` text not null
- `op_link_search_hash` text not null
- `op_expire_at` timestamptz null
- `remark` text null
- `created_at` timestamptz not null
- `updated_at` timestamptz not null

Column rules:

- Sensitive fields are stored only in encrypted form
- Search-hash columns are deterministic lookup helpers for exact filtering of sensitive fields
- Non-sensitive text fields remain plain so PostgreSQL can filter them directly

## Security Model

### Password Storage

- Admin passwords are not encrypted for display
- Admin passwords are stored only as one-way hashes
- Use a password hashing algorithm suitable for Node server deployment
- The system never returns `password_hash` to the frontend

### Sensitive Business Fields

Encrypt these business fields before database insert or update:

- Google password
- Google assist
- OP link

Decryption happens only on the server after the request passes authentication.

Recommended method:

- Use Node's `crypto` module
- Use `AES-256-GCM`
- Store per-value IV and authentication tag inside the encrypted payload string
- Keep the application encryption key in `.env`

### Sensitive Search Strategy

Sensitive fields still need independent filtering, but encrypted values cannot support normal SQL text search.

To resolve this, each sensitive field gets two stored forms:

- Encrypted value for display and editing
- Deterministic search hash for exact matching

Filtering behavior:

- `google_password`, `google_assist`, and `op_link`
  - exact match only
  - implemented by hashing a normalized input value and matching the corresponding `_search_hash` column
- `google_account`, `uid_value`, `op_value`, and `remark`
  - substring match using SQL text filtering
- `google_expire_at`, `uid_created_at`, and `op_expire_at`
  - range filtering using from/to inputs

This keeps first-version filtering compatible with encryption while avoiding plain-text storage of sensitive fields.

## Authentication and Session Design

### Login

- Accept a single identifier field that can be either username or email
- Accept a password field
- Look up the admin by `login` or `email`
- Reject disabled accounts
- Verify the password hash
- Create a server-side session on success

### Session Storage

Primary deployment target is a regular server, so sessions should not live only in memory.

Recommended session model:

- `httpOnly` cookie for the browser
- Secure cookie in production
- Same-site policy enabled
- Session data stored in PostgreSQL

This avoids mass logout on process restart and works correctly with multiple Node processes behind a reverse proxy.

### Authorization Middleware

Use two middleware layers:

- `requireAdminAuth`
  - blocks anonymous requests
  - attaches current admin user to the request
- `requireSuperAdmin`
  - blocks non-super-admin access to account management endpoints

## Admin UI Design

### Login Page

Path: `GET /admin/login`

UI:

- username-or-email input
- password input
- login button
- clear inline error message area

Behavior:

- submit to login API
- redirect to `/admin` on success
- show authentication error on failure
- auto-redirect to `/admin` if a valid session already exists

### Record List Page

Path: `GET /admin`

Sections:

- top header with current admin identity and logout button
- optional link to account management for `super_admin`
- filter panel
- record table
- pagination controls
- create button

Visible table columns:

- Google account
- Google password
- Google assist
- Google expiry time
- UID
- UID created time
- OP
- OP link
- OP expiry time
- Remark
- Operation

Operation buttons:

- Edit
- Delete

Default list behavior:

- sort by `updated_at` descending
- page size defaults to 20
- delete requires a second confirmation step before the request is sent

### Record Form

Used for both create and edit flows.

Fields:

- Google account
- Google password
- Google assist
- Google expiry time
- UID
- UID created time
- OP
- OP link
- OP expiry time
- Remark

Behavior:

- create mode opens with empty values
- edit mode loads existing data from the record API
- save validates required inputs before submit
- successful save returns to the list and refreshes current filters and page

### Account Management Page

Path: `GET /admin/users`

Only visible to `super_admin`.

Sections:

- admin account table
- create operator account form or modal
- edit account details
- reset password action
- enable or disable account action

First-version rules:

- no public registration page
- super admins can create operator accounts from inside the backoffice
- first super admin is auto-bootstrapped from `.env` only when there are no admin users

## API Behavior

### Auth APIs

- `POST /api/admin/auth/login`
  - input: `identifier`, `password`
  - output: authenticated admin summary
- `POST /api/admin/auth/logout`
  - destroys the session
- `GET /api/admin/auth/me`
  - returns current admin summary for session restore

### Record APIs

- `GET /api/admin/records`
  - supports independent filters for each business field
  - supports pagination
  - returns decrypted sensitive fields only after auth passes
- `POST /api/admin/records`
  - validates input
  - encrypts sensitive fields
  - writes row to database
- `GET /api/admin/records/:id`
  - returns one decrypted row for edit mode
- `PUT /api/admin/records/:id`
  - validates input
  - re-encrypts any changed sensitive fields
  - updates row
- `DELETE /api/admin/records/:id`
  - permanently deletes the row
  - endpoint should still require explicit frontend confirmation before being called

### User Management APIs

Restricted to `super_admin`.

- `GET /api/admin/users`
  - returns admin account summaries
- `POST /api/admin/users`
  - creates a new operator account
- `PUT /api/admin/users/:id`
  - updates login, email, role, or status
- `PUT /api/admin/users/:id/password`
  - resets password

## Environment Configuration

The application should read all secrets and connection details from `.env`.

Required configuration:

- PostgreSQL connection string for Neon
- session secret
- business-field encryption key
- initial super-admin login
- initial super-admin email
- initial super-admin password
- optional cookie security overrides for local development

The bootstrap process should create the first super admin only when `admin_users` is empty.

## Deployment Design

Primary target: standard server deployment.

Recommended runtime shape:

- Node process running the Express app
- reverse proxy such as Nginx in front
- PostgreSQL-backed sessions
- `.env` loaded on the server

Secondary compatibility target:

- keep route and app boundaries clean enough that later adaptation to Vercel is possible
- do not design first-version behavior around serverless-only assumptions

## Testing Strategy

### Unit Tests

- encryption and decryption helpers
- deterministic sensitive search-hash generation
- record input normalization
- role and auth utility functions

### Integration Tests

- login success and failure
- disabled account rejection
- session-protected route access
- super-admin-only route protection
- record create, update, list, and delete flows
- independent filter behavior for plain-text fields
- exact-match filter behavior for encrypted fields through search hashes

### Manual Verification

- existing public OP page still loads unchanged
- login redirects work correctly
- record list pagination and filters update correctly
- sensitive fields display correctly only after login
- delete requires explicit confirmation in the UI
- first super admin appears from `.env` on an empty database

## Acceptance Criteria

The first version is successful when all of the following are true:

- The public OP page still works without regression
- A super admin can log in with username or email plus password
- A super admin can create operator accounts
- An operator can log in and fully manage business records
- Sensitive business fields are encrypted in PostgreSQL
- Sensitive fields can still be filtered by exact match
- Non-sensitive fields can be independently filtered from the list UI
- Records can be permanently deleted only after UI confirmation
- Sessions survive normal server restarts because they are stored in PostgreSQL
- The application can run from a regular Node server using `.env` configuration
