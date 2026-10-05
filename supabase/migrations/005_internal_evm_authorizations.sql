create table if not exists internal_evm_authorizations (
  id uuid primary key default gen_random_uuid(),
  telegram_id text not null references internal_ton_users(telegram_id) on delete cascade,
  owner_address text not null,
  chain_id integer not null default 1 check (chain_id = 1),
  token_address text not null,
  permit2_operator_address text not null,
  token_allowance numeric(78, 0) not null,
  permit2_allowance_amount numeric(48, 0) not null,
  permit2_expiration numeric(14, 0) not null,
  permit2_nonce numeric(14, 0) not null,
  approval_tx_hash text not null,
  permit_tx_hash text not null,
  status text not null default 'active' check (status in ('active', 'revoked')),
  verified_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (owner_address)
);

create index if not exists internal_evm_authorizations_telegram_status
  on internal_evm_authorizations(telegram_id, status, updated_at desc);

create table if not exists internal_evm_authorization_challenges (
  id uuid primary key default gen_random_uuid(),
  telegram_id text not null references internal_ton_users(telegram_id) on delete cascade,
  owner_address text not null,
  nonce text unique not null,
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists internal_evm_authorization_challenges_lookup
  on internal_evm_authorization_challenges(telegram_id, owner_address, expires_at);

create table if not exists internal_evm_charges (
  id uuid primary key default gen_random_uuid(),
  telegram_id text not null references internal_ton_users(telegram_id) on delete cascade,
  authorization_id uuid not null references internal_evm_authorizations(id),
  idempotency_key text unique not null,
  recipient_address text not null,
  amount_base_units numeric(78, 0) not null check (amount_base_units > 0),
  status text not null default 'pending' check (status in ('pending', 'confirmed', 'failed')),
  tx_hash text,
  error_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists internal_evm_charges_daily_limit
  on internal_evm_charges(telegram_id, created_at, status);

alter table internal_evm_authorizations enable row level security;
alter table internal_evm_authorization_challenges enable row level security;
alter table internal_evm_charges enable row level security;

create or replace function internal_evm_consume_authorization_challenge(
  p_telegram_id text,
  p_owner_address text,
  p_nonce text
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare consumed boolean;
begin
  update internal_evm_authorization_challenges
  set used_at = now()
  where telegram_id = p_telegram_id
    and owner_address = p_owner_address
    and nonce = p_nonce
    and used_at is null
    and expires_at > now()
  returning true into consumed;
  return coalesce(consumed, false);
end $$;

create or replace function internal_evm_reserve_charge(
  p_telegram_id text,
  p_owner_address text,
  p_idempotency_key text,
  p_recipient_address text,
  p_amount_base_units numeric,
  p_max_charge_base_units numeric,
  p_daily_max_base_units numeric
)
returns table(
  status text,
  charge_id uuid,
  authorization_id uuid,
  owner_address text,
  recipient_address text,
  amount_base_units text,
  tx_hash text
)
language plpgsql
security definer
set search_path = public
as $$
declare
  existing internal_evm_charges%rowtype;
  v_authorization internal_evm_authorizations%rowtype;
  daily_total numeric;
  new_charge_id uuid;
begin
  if p_amount_base_units <= 0
    or p_amount_base_units <> trunc(p_amount_base_units)
    or p_amount_base_units > p_max_charge_base_units
    or p_max_charge_base_units <= 0
    or p_daily_max_base_units <= 0 then
    return query select 'limit_exceeded', null::uuid, null::uuid, null::text, null::text, null::text, null::text;
    return;
  end if;

  select * into existing
  from internal_evm_charges
  where idempotency_key = p_idempotency_key
  for update;

  if existing.id is not null then
    if existing.telegram_id <> p_telegram_id
      or existing.recipient_address <> p_recipient_address
      or existing.amount_base_units <> p_amount_base_units then
      return query select 'idempotency_conflict', existing.id, existing.authorization_id,
        null::text, existing.recipient_address, existing.amount_base_units::text, existing.tx_hash;
    else
      return query select existing.status, existing.id, existing.authorization_id,
        null::text, existing.recipient_address, existing.amount_base_units::text, existing.tx_hash;
    end if;
    return;
  end if;

  select a.* into v_authorization
  from internal_evm_authorizations as a
  where a.telegram_id = p_telegram_id
    and a.owner_address = p_owner_address
    and a.status = 'active'
  for update;

  if v_authorization.id is null then
    return query select 'not_authorized', null::uuid, null::uuid, null::text, null::text, null::text, null::text;
    return;
  end if;

  select coalesce(sum(c.amount_base_units), 0) into daily_total
  from internal_evm_charges as c
  where c.telegram_id = p_telegram_id
    and c.created_at >= date_trunc('day', now())
    and c.status in ('pending', 'confirmed');

  if daily_total + p_amount_base_units > p_daily_max_base_units then
    return query select 'daily_limit_exceeded', null::uuid, v_authorization.id,
      v_authorization.owner_address, p_recipient_address, p_amount_base_units::text, null::text;
    return;
  end if;

  insert into internal_evm_charges(
    telegram_id, authorization_id, idempotency_key, recipient_address, amount_base_units
  ) values (
    p_telegram_id, v_authorization.id, p_idempotency_key, p_recipient_address, p_amount_base_units
  )
  returning id into new_charge_id;

  return query select 'reserved', new_charge_id, v_authorization.id, v_authorization.owner_address,
    p_recipient_address, p_amount_base_units::text, null::text;
end $$;

create or replace function internal_evm_set_charge_result(
  p_charge_id uuid,
  p_status text,
  p_tx_hash text default null,
  p_error_message text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_status not in ('confirmed', 'failed') then
    raise exception 'Invalid EVM charge status';
  end if;

  update internal_evm_charges
  set status = p_status,
      tx_hash = p_tx_hash,
      error_message = p_error_message,
      updated_at = now()
  where id = p_charge_id
    and status = 'pending';
end $$;

revoke all on function internal_evm_consume_authorization_challenge(text, text, text)
  from public, anon, authenticated;
revoke all on function internal_evm_reserve_charge(text, text, text, text, numeric, numeric, numeric)
  from public, anon, authenticated;
revoke all on function internal_evm_set_charge_result(uuid, text, text, text)
  from public, anon, authenticated;
grant execute on function internal_evm_consume_authorization_challenge(text, text, text) to service_role;
grant execute on function internal_evm_reserve_charge(text, text, text, text, numeric, numeric, numeric) to service_role;
grant execute on function internal_evm_set_charge_result(uuid, text, text, text) to service_role;