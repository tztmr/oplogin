async function ensureManagedRecordUidUniqueness(pool) {
  const duplicateUidResult = await pool.query(
    `
      select uid_value
      from managed_records
      where uid_value <> ''
      order by uid_value asc
    `,
  );

  const seenUids = new Set();
  const duplicateUids = [];
  for (const row of duplicateUidResult.rows) {
    const uidValue = row.uid_value;
    if (seenUids.has(uidValue)) {
      if (!duplicateUids.includes(uidValue)) {
        duplicateUids.push(uidValue);
      }
      if (duplicateUids.length >= 5) {
        break;
      }
      continue;
    }
    seenUids.add(uidValue);
  }

  if (duplicateUids.length > 0) {
    const duplicateSummary = duplicateUids.join(', ');
    throw new Error(
      `managed_records 存在重复 UID，无法启用唯一约束: ${duplicateSummary}`,
    );
  }

  await pool.query(`
    create unique index if not exists idx_records_uid_value_unique_non_empty
      on managed_records (uid_value)
      where uid_value <> ''
  `);
}

async function ensureDatabaseSchema(pool) {
  await pool.query(`
    create table if not exists admin_users (
      id uuid primary key,
      login text not null unique,
      email text not null unique,
      password_hash text not null,
      role text not null check (role in ('super_admin', 'operator')),
      status text not null check (status in ('active', 'disabled')),
      wifi_type text not null default 'WPA',
      wifi_ssid text not null default '',
      wifi_password text not null default '',
      wifi_hidden boolean not null default false,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      last_login_at timestamptz null
    );

    create table if not exists managed_records (
      id uuid primary key,
      owner_id uuid references admin_users(id) on delete set null,
      google_account text not null,
      google_password_encrypted text not null,
      google_password_search_hash text not null,
      google_assist text not null,
      google_expire_at timestamptz null,
      uid_value text not null,
      uid_created_at timestamptz null,
      op_value text not null,
      op_nickname text not null default '',
      op_link text not null,
      op_expire_at timestamptz null,
      remark text null,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );

    create table if not exists public_user_batches (
      id uuid primary key,
      owner_id uuid not null references admin_users(id) on delete cascade,
      status text not null check (status in ('open', 'released')),
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      released_at timestamptz null
    );

    create table if not exists public_user_batch_slots (
      id uuid primary key,
      batch_id uuid not null references public_user_batches(id) on delete cascade,
      slot_number integer not null check (slot_number between 1 and 6),
      record_id uuid null references managed_records(id) on delete set null,
      status text not null check (status in ('available', 'done', 'released', 'empty')),
      completed_at timestamptz null,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      unique (batch_id, slot_number)
    );

    create table if not exists op_applications (
      id uuid primary key,
      name text not null,
      app_id text not null unique,
      is_default boolean not null default false,
      status text not null check (status in ('active', 'disabled')),
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );

    create table if not exists short_op_records (
      id uuid primary key,
      owner_id uuid not null references admin_users(id),
      code char(8) not null unique check (
        ('1' || code)::bigint between 100000000 and 199999999
      ),
      op_value text not null,
      application_id uuid not null references op_applications(id),
      op_expire_at timestamptz not null,
      status text not null check (status in ('active', 'disabled', 'deleted')),
      remark text not null default '',
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      deleted_at timestamptz null
    );

    alter table managed_records add column if not exists owner_id uuid references admin_users(id) on delete set null;
    alter table managed_records add column if not exists op_nickname text not null default '';
    alter table admin_users add column if not exists wifi_type text not null default 'WPA';
    alter table admin_users add column if not exists wifi_ssid text not null default '';
    alter table admin_users add column if not exists wifi_password text not null default '';
    alter table admin_users add column if not exists wifi_hidden boolean not null default false;

    create index if not exists idx_admin_users_login on admin_users (login);
    create index if not exists idx_admin_users_email on admin_users (email);
    create index if not exists idx_records_owner_id on managed_records (owner_id);
    create index if not exists idx_records_google_account on managed_records (google_account);
    create index if not exists idx_records_uid_value on managed_records (uid_value);
    create index if not exists idx_records_op_value on managed_records (op_value);
    create index if not exists idx_records_google_password_hash
      on managed_records (google_password_search_hash);
    create index if not exists idx_records_updated_at on managed_records (updated_at desc);
    create index if not exists idx_public_user_batches_owner_status
      on public_user_batches (owner_id, status, created_at desc);
    create index if not exists idx_public_user_batch_slots_batch_slot
      on public_user_batch_slots (batch_id, slot_number);
    create index if not exists idx_public_user_batch_slots_record
      on public_user_batch_slots (record_id);
    create unique index if not exists idx_op_applications_single_default
      on op_applications (is_default) where is_default = true;
    create unique index if not exists idx_short_ops_active_value_app
      on short_op_records (op_value, application_id) where status <> 'deleted';
    create index if not exists idx_short_ops_owner_updated
      on short_op_records (owner_id, updated_at desc);
    create index if not exists idx_short_ops_application
      on short_op_records (application_id);

    alter table managed_records alter column uid_created_at drop not null;

    insert into op_applications (id, name, app_id, is_default, status)
    values ('00000000-0000-0000-0000-000000000110', '抖音', '1105602870', false, 'active')
    on conflict (app_id) do nothing;

    update op_applications
    set is_default = true, updated_at = now()
    where app_id = '1105602870'
      and not exists (select 1 from op_applications where is_default = true);
  `);

  await ensureManagedRecordUidUniqueness(pool);
}

module.exports = { ensureDatabaseSchema, ensureManagedRecordUidUniqueness };
