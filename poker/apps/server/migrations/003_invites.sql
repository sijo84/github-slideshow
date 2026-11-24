create table invite_codes (code text primary key, created_by uuid references users on delete cascade,
  used_by uuid references users on delete set null, created_at timestamptz not null default now());
