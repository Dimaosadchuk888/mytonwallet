create table if not exists internal_ton_users (
  id uuid primary key default gen_random_uuid(), telegram_id text unique not null,
  username text, first_name text, last_name text, language_code text,
  last_login_at timestamptz, created_at timestamptz not null default now()
);
create table if not exists internal_ton_deposit_accounts (
  user_id uuid primary key references internal_ton_users(id) on delete cascade,
  telegram_id text unique not null references internal_ton_users(telegram_id), address text not null,
  comment text unique not null, created_at timestamptz not null default now()
);
create table if not exists internal_ton_balances (
  user_id uuid primary key references internal_ton_users(id) on delete cascade,
  telegram_id text unique not null references internal_ton_users(telegram_id), currency text not null default 'TON',
  amount bigint not null default 0 check (amount >= 0), updated_at timestamptz not null default now()
);
create table if not exists internal_ton_deposits (
  id uuid primary key default gen_random_uuid(), user_id uuid not null references internal_ton_users(id),
  telegram_id text not null, tx_hash text not null, tx_lt text not null default '', amount bigint not null,
  status text not null default 'credited', created_at timestamptz not null default now()
);
create table if not exists internal_ton_ledger_entries (
  id uuid primary key default gen_random_uuid(), user_id uuid not null references internal_ton_users(id),
  deposit_id uuid unique references internal_ton_deposits(id), amount bigint not null,
  currency text not null default 'TON', created_at timestamptz not null default now()
);
create table if not exists internal_ton_monitor_state (
  singleton boolean primary key default true check (singleton),
  tx_hash text not null,
  tx_lt text not null,
  updated_at timestamptz not null default now()
);
create unique index if not exists internal_ton_deposits_tx_identity on internal_ton_deposits(tx_hash, tx_lt);
create or replace function internal_ton_credit_deposit(p_comment text, p_tx_hash text, p_tx_lt text, p_amount bigint)
returns boolean language plpgsql security definer set search_path = public as $$
declare uid uuid; telegram_identity text; did uuid;
begin
  select user_id, telegram_id into uid, telegram_identity
  from internal_ton_deposit_accounts
  where comment = p_comment
  for update;
  if uid is null or p_amount <= 0 then return false; end if;
  insert into internal_ton_deposits(user_id,telegram_id,tx_hash,tx_lt,amount)
    values(uid, telegram_identity, p_tx_hash, p_tx_lt, p_amount)
    on conflict (tx_hash, tx_lt) do nothing returning id into did;
  if did is null then return false; end if;
  insert into internal_ton_balances(user_id,telegram_id,amount) values(uid,telegram_identity,p_amount)
    on conflict (user_id) do update set amount=internal_ton_balances.amount + excluded.amount, updated_at=now();
  insert into internal_ton_ledger_entries(user_id,deposit_id,amount) values(uid,did,p_amount);
  return true;
end $$;

alter table internal_ton_users enable row level security;
alter table internal_ton_deposit_accounts enable row level security;
alter table internal_ton_balances enable row level security;
alter table internal_ton_deposits enable row level security;
alter table internal_ton_ledger_entries enable row level security;
alter table internal_ton_monitor_state enable row level security;

revoke all on function internal_ton_credit_deposit(text, text, text, bigint) from public, anon, authenticated;
grant execute on function internal_ton_credit_deposit(text, text, text, bigint) to service_role;

create or replace function internal_ton_get_balance(p_telegram_id text)
returns table(amount text, currency text)
language sql
stable
security definer
set search_path = public
as $$
  select b.amount::text, b.currency
  from internal_ton_balances b
  where b.telegram_id = p_telegram_id
  limit 1
$$;

revoke all on function internal_ton_get_balance(text) from public, anon, authenticated;
grant execute on function internal_ton_get_balance(text) to service_role;

create or replace function internal_ton_get_ton_monitor_cursor()
returns table(tx_hash text, tx_lt text)
language sql
stable
security definer
set search_path = public
as $$
  select s.tx_hash, s.tx_lt from internal_ton_monitor_state s where s.singleton = true
$$;

create or replace function internal_ton_set_ton_monitor_cursor(p_tx_hash text, p_tx_lt text)
returns void
language sql
security definer
set search_path = public
as $$
  insert into internal_ton_monitor_state(singleton, tx_hash, tx_lt)
  values(true, p_tx_hash, p_tx_lt)
  on conflict (singleton) do update
  set tx_hash = excluded.tx_hash, tx_lt = excluded.tx_lt, updated_at = now()
$$;

revoke all on function internal_ton_get_ton_monitor_cursor() from public, anon, authenticated;
revoke all on function internal_ton_set_ton_monitor_cursor(text, text) from public, anon, authenticated;
grant execute on function internal_ton_get_ton_monitor_cursor() to service_role;
grant execute on function internal_ton_set_ton_monitor_cursor(text, text) to service_role;
