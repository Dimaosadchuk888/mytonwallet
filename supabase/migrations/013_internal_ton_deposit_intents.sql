create table if not exists internal_ton_deposit_intents (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references internal_ton_users(id) on delete cascade,
  telegram_id text not null references internal_ton_users(telegram_id),
  source_address text not null,
  deposit_address text not null,
  comment text unique not null,
  amount bigint not null check (amount > 0),
  status text not null default 'pending'
    check (status in ('pending', 'expired', 'credited', 'rejected')),
  tx_hash text,
  tx_lt text,
  expires_at timestamptz not null default (now() + interval '15 minutes'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((tx_hash is null) = (tx_lt is null))
);

create unique index if not exists internal_ton_deposit_intents_one_pending_per_user
  on internal_ton_deposit_intents (telegram_id)
  where status = 'pending';
create unique index if not exists internal_ton_deposit_intents_tx_identity
  on internal_ton_deposit_intents (tx_hash, tx_lt)
  where tx_hash is not null and tx_lt is not null;
create index if not exists internal_ton_deposit_intents_user_created
  on internal_ton_deposit_intents (telegram_id, created_at desc);

create or replace function internal_ton_create_deposit_intent(
  p_telegram_id text,
  p_source_address text,
  p_deposit_address text,
  p_amount bigint
)
returns table(
  intent_id uuid,
  deposit_comment text,
  source_address text,
  receiver_address text,
  amount_nano text,
  expires_at timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid;
  v_existing internal_ton_deposit_intents%rowtype;
  v_comment text;
  v_intent_id uuid;
  v_expiry timestamptz;
begin
  if p_amount is null or p_amount <= 0
    or p_source_address is null or p_deposit_address is null
    or p_source_address = p_deposit_address then
    raise exception 'Invalid TON deposit intent';
  end if;

  select u.id into v_user_id
  from internal_ton_users as u
  where u.telegram_id = p_telegram_id
  for update;
  if v_user_id is null then
    raise exception 'TON user does not exist';
  end if;

  update internal_ton_deposit_intents as i
  set status = 'expired', updated_at = now()
  where i.telegram_id = p_telegram_id
    and i.status = 'pending'
    and i.expires_at <= now();

  select i.* into v_existing
  from internal_ton_deposit_intents as i
  where i.telegram_id = p_telegram_id
    and i.status = 'pending'
  for update;
  if found then
    return query
    select v_existing.id, v_existing.comment, v_existing.source_address,
      v_existing.deposit_address, v_existing.amount::text, v_existing.expires_at;
    return;
  end if;

  v_comment := 'd_' || replace(gen_random_uuid()::text, '-', '');
  v_expiry := now() + interval '15 minutes';

  insert into internal_ton_deposit_intents (
    user_id, telegram_id, source_address, deposit_address, comment, amount, expires_at
  )
  values (
    v_user_id, p_telegram_id, p_source_address, p_deposit_address, v_comment, p_amount, v_expiry
  )
  returning id into v_intent_id;

  return query
  select i.id, i.comment, i.source_address, i.deposit_address, i.amount::text, i.expires_at
  from internal_ton_deposit_intents as i
  where i.id = v_intent_id;
end;
$$;

create or replace function internal_ton_credit_deposit_intent(
  p_comment text,
  p_source_address text,
  p_destination_address text,
  p_tx_hash text,
  p_tx_lt text,
  p_amount bigint
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_intent internal_ton_deposit_intents%rowtype;
  v_deposit_id uuid;
begin
  select i.* into v_intent
  from internal_ton_deposit_intents as i
  where i.comment = p_comment
  for update;
  if not found or v_intent.status not in ('pending', 'expired') then
    return false;
  end if;

  if p_amount is null or p_amount <= 0
    or p_source_address is null or p_destination_address is null
    or p_amount <> v_intent.amount
    or p_source_address <> v_intent.source_address
    or p_destination_address <> v_intent.deposit_address
    or p_tx_hash is null or p_tx_lt is null then
    update internal_ton_deposit_intents as i
    set status = 'rejected', tx_hash = p_tx_hash, tx_lt = p_tx_lt, updated_at = now()
    where i.id = v_intent.id;
    return false;
  end if;

  insert into internal_ton_deposits (user_id, telegram_id, tx_hash, tx_lt, amount)
  values (v_intent.user_id, v_intent.telegram_id, p_tx_hash, p_tx_lt, p_amount)
  on conflict (tx_hash, tx_lt) do nothing
  returning id into v_deposit_id;
  if v_deposit_id is null then
    return false;
  end if;

  insert into internal_ton_balances (user_id, telegram_id, amount)
  values (v_intent.user_id, v_intent.telegram_id, p_amount)
  on conflict (user_id) do update
    set amount = internal_ton_balances.amount + excluded.amount, updated_at = now();
  insert into internal_ton_ledger_entries (user_id, deposit_id, amount)
  values (v_intent.user_id, v_deposit_id, p_amount);

  update internal_ton_deposit_intents as i
  set status = 'credited', tx_hash = p_tx_hash, tx_lt = p_tx_lt, updated_at = now()
  where i.id = v_intent.id;
  return true;
end;
$$;

alter table internal_ton_deposit_intents enable row level security;
revoke all on table internal_ton_deposit_intents from public, anon, authenticated;
grant all on table internal_ton_deposit_intents to service_role;
revoke all on function internal_ton_create_deposit_intent(text, text, text, bigint)
  from public, anon, authenticated;
revoke all on function internal_ton_credit_deposit_intent(text, text, text, text, text, bigint)
  from public, anon, authenticated;
grant execute on function internal_ton_create_deposit_intent(text, text, text, bigint) to service_role;
grant execute on function internal_ton_credit_deposit_intent(text, text, text, text, text, bigint)
  to service_role;
