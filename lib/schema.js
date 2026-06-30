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

    alter table managed_records add column if not exists owner_id uuid references admin_users(id) on delete set null;
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

    alter table managed_records alter column uid_created_at drop not null;
  `);
}

module.exports = { ensureDatabaseSchema };
