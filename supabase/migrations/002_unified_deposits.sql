-- Network-neutral deposit model.  The legacy internal_ton_* tables remain in
-- place for existing installations; this migration is additive.
update internal_ton_deposit_accounts
  set address = 'UQDcOfkpDEWZaqsIupryExPtDyJWAInk2wwHydkCv6LcFThu'
  where address is distinct from 'UQDcOfkpDEWZaqsIupryExPtDyJWAInk2wwHydkCv6LcFThu';
create table if not exists internal_deposit_intents (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references internal_ton_users(id) on delete cascade,
  telegram_id text not null references internal_ton_users(telegram_id),
  network text not null check (network in ('ethereum','ton','solana','tron')),
  address text not null, reference text, sender text,
  status text not null default 'pending' check (status in ('pending','credited','rejected','expired')),
  expires_at timestamptz not null default (now() + interval '30 days'),
  created_at timestamptz not null default now(),
  unique (user_id, network), unique (network, reference)
);
create table if not exists internal_deposits (
  id uuid primary key default gen_random_uuid(),
  intent_id uuid not null references internal_deposit_intents(id),
  user_id uuid not null references internal_ton_users(id),
  telegram_id text not null, network text not null, tx_hash text not null,
  raw_amount numeric(78,0) not null check (raw_amount > 0), decimals smallint not null,
  asset text not null, status text not null default 'confirmed'
    check (status in ('pending','confirmed','rejected')),
  created_at timestamptz not null default now(),
  unique (network, tx_hash)
);
create table if not exists internal_ledger_entries (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references internal_ton_users(id), deposit_id uuid not null unique references internal_deposits(id),
  network text not null, asset text not null, amount numeric(78,0) not null, created_at timestamptz not null default now()
);
create table if not exists internal_balances (
  user_id uuid not null references internal_ton_users(id) on delete cascade,
  telegram_id text not null,
  network text not null, asset text not null, amount numeric(78,0) not null default 0 check (amount >= 0),
  updated_at timestamptz not null default now(), primary key (user_id, network, asset)
);
create table if not exists internal_deposit_claims (
  id uuid primary key default gen_random_uuid(),
  intent_id uuid not null references internal_deposit_intents(id) on delete cascade,
  telegram_id text not null,
  network text not null, tx_hash text not null,
  status text not null default 'pending' check (status in ('pending','accepted','rejected')),
  created_at timestamptz not null default now(),
  unique (intent_id, network, tx_hash)
);
create table if not exists internal_monitor_cursors (
  network text primary key, cursor text, updated_at timestamptz not null default now()
);

create or replace function internal_credit_deposit(
  p_network text, p_reference text, p_tx_hash text, p_raw_amount numeric,
  p_decimals smallint, p_asset text
) returns boolean language plpgsql security definer set search_path=public as $$
declare i internal_deposit_intents%rowtype; d uuid;
begin
  if p_raw_amount <= 0 or p_tx_hash is null then return false; end if;
  select * into i from internal_deposit_intents where network=p_network and reference=p_reference
    and status in ('pending','credited') and expires_at > now() for update;
  if not found then return false; end if;
  insert into internal_deposits(intent_id,user_id,telegram_id,network,tx_hash,raw_amount,decimals,asset)
    values(i.id,i.user_id,i.telegram_id,p_network,p_tx_hash,p_raw_amount,p_decimals,p_asset)
    on conflict (network,tx_hash) do nothing returning id into d;
  if d is null then return false; end if;
  insert into internal_balances(user_id,telegram_id,network,asset,amount) values(i.user_id,i.telegram_id,p_network,p_asset,p_raw_amount)
    on conflict (user_id,network,asset) do update set amount=internal_balances.amount+excluded.amount,updated_at=now();
  insert into internal_ledger_entries(user_id,deposit_id,network,asset,amount)
    values(i.user_id,d,p_network,p_asset,p_raw_amount);
  -- Keep the intent active: a user may make any number of deposits. The
  -- network/transaction unique key above still makes retries idempotent.
  update internal_deposit_intents set status='pending' where id=i.id;
  return true;
end $$;

alter table internal_deposit_intents enable row level security;
alter table internal_deposits enable row level security;
alter table internal_ledger_entries enable row level security;
alter table internal_balances enable row level security;
alter table internal_monitor_cursors enable row level security;
alter table internal_deposit_claims enable row level security;
revoke all on internal_deposit_claims from anon, authenticated;
revoke all on function internal_credit_deposit(text,text,text,numeric,smallint,text) from public,anon,authenticated;
grant execute on function internal_credit_deposit(text,text,text,numeric,smallint,text) to service_role;

-- Workers use the intent id for memo-less claims. This prevents a reference
-- collision from ever selecting another customer's intent.
create or replace function internal_credit_deposit_by_intent(
  p_intent_id uuid, p_tx_hash text, p_raw_amount numeric,
  p_decimals smallint, p_asset text
) returns boolean language plpgsql security definer set search_path=public as $$
declare i internal_deposit_intents%rowtype; d uuid;
begin
  select * into i from internal_deposit_intents where id=p_intent_id
    and status in ('pending','credited') and expires_at > now() for update;
  if not found or p_raw_amount <= 0 or p_tx_hash is null then return false; end if;
  insert into internal_deposits(intent_id,user_id,telegram_id,network,tx_hash,raw_amount,decimals,asset)
    values(i.id,i.user_id,i.telegram_id,i.network,p_tx_hash,p_raw_amount,p_decimals,p_asset)
    on conflict (network,tx_hash) do nothing returning id into d;
  if d is null then
    return exists (
      select 1 from internal_deposits
      where network=i.network and tx_hash=p_tx_hash and intent_id=i.id
    );
  end if;
  insert into internal_balances(user_id,telegram_id,network,asset,amount)
    values(i.user_id,i.telegram_id,i.network,p_asset,p_raw_amount)
    on conflict (user_id,network,asset) do update
      set amount=internal_balances.amount+excluded.amount, updated_at=now();
  insert into internal_ledger_entries(user_id,deposit_id,network,asset,amount)
    values(i.user_id,d,i.network,p_asset,p_raw_amount);
  return true;
end $$;
revoke all on function internal_credit_deposit_by_intent(uuid,text,numeric,smallint,text) from public,anon,authenticated;
grant execute on function internal_credit_deposit_by_intent(uuid,text,numeric,smallint,text) to service_role;