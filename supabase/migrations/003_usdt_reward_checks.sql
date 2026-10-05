alter table internal_ton_reward_checks
  add column if not exists asset text not null default 'TON';

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'internal_ton_reward_checks_asset_check'
  ) then
    alter table internal_ton_reward_checks
      add constraint internal_ton_reward_checks_asset_check check (asset in ('TON', 'USDT'));
  end if;
end $$;

create table if not exists internal_usdt_balances (
  user_id uuid primary key references internal_ton_users(id) on delete cascade,
  telegram_id text unique not null references internal_ton_users(telegram_id),
  currency text not null default 'USDT' check (currency = 'USDT'),
  amount bigint not null default 0 check (amount >= 0),
  updated_at timestamptz not null default now()
);

alter table internal_usdt_balances enable row level security;

create or replace function internal_usdt_get_balance(p_telegram_id text)
returns table(amount text, currency text)
language sql
stable
security definer
set search_path = public
as $$
  select b.amount::text, b.currency
  from internal_usdt_balances b
  where b.telegram_id = p_telegram_id
  limit 1
$$;

revoke all on function internal_usdt_get_balance(text) from public, anon, authenticated;
grant execute on function internal_usdt_get_balance(text) to service_role;

create or replace function internal_ton_claim_reward_v2(p_code text, p_telegram_id text)
returns table(status text, amount text, title text, resulting_balance text, asset text)
language plpgsql
security definer
set search_path = public
as $$
declare
  c internal_ton_reward_checks%rowtype;
  current_balance bigint;
begin
  select *
  into c
  from internal_ton_reward_checks
  where code = p_code
  for update;

  if not found then
    return query select 'not_found'::text, null::text, null::text, null::text, null::text;
    return;
  end if;

  if not c.active then
    return query select 'inactive', c.amount_per_claim::text, c.title, null::text, c.asset;
    return;
  end if;

  if c.expires_at is not null and c.expires_at <= now() then
    return query select 'expired', c.amount_per_claim::text, c.title, null::text, c.asset;
    return;
  end if;

  if exists (
    select 1
    from internal_ton_reward_claims claims
    where claims.check_id = c.id
      and claims.telegram_id = p_telegram_id
  ) then
    if c.asset = 'USDT' then
      select balances.amount
      into current_balance
      from internal_usdt_balances balances
      where balances.telegram_id = p_telegram_id;
    else
      select balances.amount
      into current_balance
      from internal_ton_balances balances
      where balances.telegram_id = p_telegram_id;
    end if;

    return query select 'already_claimed', c.amount_per_claim::text, c.title,
      current_balance::text, c.asset;
    return;
  end if;

  if c.claimed_count >= c.max_claims then
    return query select 'exhausted', c.amount_per_claim::text, c.title, null::text, c.asset;
    return;
  end if;

  insert into internal_ton_reward_claims(check_id, telegram_id, amount)
  values (c.id, p_telegram_id, c.amount_per_claim);

  update internal_ton_reward_checks checks
  set claimed_count = checks.claimed_count + 1,
      updated_at = now()
  where checks.id = c.id;

  if c.asset = 'USDT' then
    update internal_usdt_balances balances
    set amount = balances.amount + c.amount_per_claim,
        updated_at = now()
    where balances.telegram_id = p_telegram_id
    returning balances.amount into current_balance;
  else
    update internal_ton_balances balances
    set amount = balances.amount + c.amount_per_claim,
        updated_at = now()
    where balances.telegram_id = p_telegram_id
    returning balances.amount into current_balance;
  end if;

  if current_balance is null then
    raise exception 'Balance not initialized';
  end if;

  return query select 'credited', c.amount_per_claim::text, c.title,
    current_balance::text, c.asset;
end
$$;

revoke all on function internal_ton_claim_reward_v2(text, text) from public, anon, authenticated;
grant execute on function internal_ton_claim_reward_v2(text, text) to service_role;

create or replace function internal_ton_claim_reward(p_code text, p_telegram_id text)
returns table(status text, amount text, title text, resulting_balance text)
language sql
security definer
set search_path = public
as $$
  select claim.status, claim.amount, claim.title, claim.resulting_balance
  from internal_ton_claim_reward_v2(p_code, p_telegram_id) claim
$$;

revoke all on function internal_ton_claim_reward(text, text) from public, anon, authenticated;
grant execute on function internal_ton_claim_reward(text, text) to service_role;