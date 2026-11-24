create table users (id uuid primary key default gen_random_uuid(), email text unique not null, password_hash text not null,
  display_name text not null check (length(display_name) between 2 and 24), avatar_path text, created_at timestamptz not null default now());
create table sessions (id text primary key, user_id uuid not null references users on delete cascade, ip text not null,
  device_id text not null, created_at timestamptz not null default now(), expires_at timestamptz not null);
create table friendships (requester uuid not null references users on delete cascade, addressee uuid not null references users on delete cascade,
  status text not null check (status in ('pending','accepted')), created_at timestamptz not null default now(),
  primary key (requester, addressee), check (requester <> addressee));
create table notes (author uuid not null references users on delete cascade, subject uuid not null references users on delete cascade,
  text text not null default '' check (length(text) <= 2000), color text check (color in ('red','orange','yellow','green','blue','purple')),
  updated_at timestamptz not null default now(), primary key (author, subject));
create table games (id uuid primary key default gen_random_uuid(), host uuid not null references users, name text not null,
  settings jsonb not null, starts_at timestamptz not null, status text not null default 'scheduled'
  check (status in ('scheduled','open','running','paused','finished','cancelled')), created_at timestamptz not null default now());
create table game_invites (game_id uuid not null references games on delete cascade, user_id uuid not null references users on delete cascade,
  rsvp text not null default 'pending' check (rsvp in ('pending','yes','no','maybe')), primary key (game_id, user_id));
create table ledger_accounts (id uuid primary key default gen_random_uuid(), kind text not null check (kind in ('wallet','table','bank')),
  user_id uuid references users, game_id uuid references games, unique nulls not distinct (kind, user_id, game_id));
create table ledger_entries (id bigserial primary key, tx_id uuid not null, account_id uuid not null references ledger_accounts,
  amount bigint not null check (amount <> 0), reason text not null, created_at timestamptz not null default now());
create index on ledger_entries (account_id);
create table hands (id uuid primary key, game_id uuid not null references games on delete cascade, hand_number int not null,
  record jsonb not null, started_at timestamptz not null, ended_at timestamptz not null, unique (game_id, hand_number));
create table hand_players (hand_id uuid not null references hands on delete cascade, user_id uuid not null references users,
  seat int not null, net bigint not null, primary key (hand_id, user_id));
create table chat_messages (id bigserial primary key, game_id uuid not null references games on delete cascade,
  user_id uuid not null references users, text text not null, created_at timestamptz not null default now());
create table notifications (id bigserial primary key, user_id uuid not null references users on delete cascade, kind text not null,
  text text not null, link text, read boolean not null default false, created_at timestamptz not null default now());
create table integrity_flags (id bigserial primary key, game_id uuid not null references games on delete cascade, kind text not null,
  players uuid[] not null, score real not null, evidence uuid[] not null, summary text not null, created_at timestamptz not null default now(),
  unique (game_id, kind, players));
create table tournament_results (game_id uuid not null references games on delete cascade, user_id uuid not null references users,
  place int not null, prize bigint not null, primary key (game_id, user_id));
create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now());
