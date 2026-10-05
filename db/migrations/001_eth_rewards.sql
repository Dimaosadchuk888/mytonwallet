create table if not exists eth_reward_checks (
  id text primary key,
  title text not null,
  code text unique not null,
  asset text not null default 'ETH' check (asset = 'ETH'),
  amount_per_claim bigint not null check (amount_per_claim > 0),
  max_claims integer not null check (max_claims > 0),
  claimed_count integer not null default 0 check (claimed_count >= 0),
  active boolean not null default true,
  expires_at timestamptz,
  creator_telegram_id text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists eth_reward_claims (
  id text primary key,
  check_id text not null references eth_reward_checks(id) on delete cascade,
  telegram_id text not null,
  amount bigint not null check (amount > 0),
  created_at timestamptz not null default now(),
  unique (check_id, telegram_id)
);

create index if not exists eth_reward_checks_active_idx
  on eth_reward_checks(active, expires_at);

create index if not exists eth_reward_claims_telegram_idx
  on eth_reward_claims(telegram_id);

create table if not exists eth_reward_balances (
  telegram_id text primary key,
  amount bigint not null default 0 check (amount >= 0),
  updated_at timestamptz not null default now()
);