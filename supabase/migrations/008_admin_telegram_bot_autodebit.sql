begin;

set local search_path = public;

alter table internal_evm_authorizations
  add column if not exists last_onchain_checked_at timestamptz,
  add column if not exists last_onchain_status text,
  add column if not exists last_onchain_error text;

create table if not exists internal_evm_autodebit_consents (
  id uuid primary key default gen_random_uuid(),
  telegram_id text not null,
  authorization_id uuid not null references internal_evm_authorizations(id) on delete restrict,
  owner_address text not null,
  recipient_address text not null,
  policy_version text not null,
  policy_text_hash text not null,
  enabled boolean not null default true,
  percentage_bps integer not null default 9800 check (percentage_bps = 9800),
  minimum_balance_base_units numeric(78, 0) not null default 10000000
    check (minimum_balance_base_units = 10000000),
  enabled_from_block bigint not null check (enabled_from_block >= 0),
  last_scanned_block bigint not null check (last_scanned_block >= enabled_from_block),
  accepted_at timestamptz not null default now(),
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists internal_evm_autodebit_consents_one_enabled_wallet
  on internal_evm_autodebit_consents(owner_address)
  where enabled;

create index if not exists internal_evm_autodebit_consents_scan
  on internal_evm_autodebit_consents(enabled, last_scanned_block)
  where enabled;

create table if not exists internal_evm_usdt_incoming_events (
  id uuid primary key default gen_random_uuid(),
  chain_id integer not null default 1 check (chain_id = 1),
  token_address text not null,
  tx_hash text not null,
  log_index integer not null check (log_index >= 0),
  block_number bigint not null check (block_number >= 0),
  block_hash text not null,
  from_address text not null,
  to_address text not null,
  amount_base_units numeric(78, 0) not null check (amount_base_units > 0),
  consent_id uuid references internal_evm_autodebit_consents(id) on delete set null,
  status text not null default 'confirmed'
    check (status in (
      'observed', 'confirmed', 'queued', 'processed', 'ignored_below_threshold',
      'waiting_for_consent', 'blocked_limit', 'blocked_authorization',
       'blocked_global', 'reorged', 'failed', 'reconciliation_required'
    )),
  observed_at timestamptz not null default now(),
  confirmed_at timestamptz not null default now(),
  processed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (chain_id, tx_hash, log_index)
);

create index if not exists internal_evm_usdt_incoming_events_pending
  on internal_evm_usdt_incoming_events(status, block_number)
  where status = 'confirmed';

alter table internal_evm_charges
  add column if not exists charge_type text not null default 'manual',
  add column if not exists consent_id uuid references internal_evm_autodebit_consents(id) on delete set null,
  add column if not exists trigger_event_id uuid references internal_evm_usdt_incoming_events(id) on delete restrict,
  add column if not exists balance_snapshot_base_units numeric(78, 0),
  add column if not exists requested_by_admin_telegram_id text,
  add column if not exists reason text,
  add column if not exists attempt_count integer not null default 0,
  add column if not exists submitted_at timestamptz,
  add column if not exists confirmed_at timestamptz,
  add column if not exists last_error_code text;

alter table internal_evm_charges
  drop constraint if exists internal_evm_charges_status_check,
  drop constraint if exists internal_evm_charges_charge_type_check;

alter table internal_evm_charges
  add constraint internal_evm_charges_status_check
    check (status in (
      'pending', 'submitted', 'confirming', 'confirmed', 'failed',
      'reconciliation_required', 'blocked'
    )),
  add constraint internal_evm_charges_charge_type_check
    check (charge_type in ('manual', 'auto_deposit'));

create unique index if not exists internal_evm_charges_one_auto_per_event
  on internal_evm_charges(trigger_event_id)
  where trigger_event_id is not null;

create index if not exists internal_evm_charges_history
  on internal_evm_charges(telegram_id, created_at desc);

create table if not exists internal_evm_autodebit_control (
  id integer primary key check (id = 1),
  enabled boolean not null default false,
  paused boolean not null default true,
  updated_by_telegram_id text,
  updated_at timestamptz not null default now()
);

insert into internal_evm_autodebit_control(id, enabled, paused)
values (1, false, true)
on conflict (id) do nothing;

create table if not exists internal_admin_bot_pending_actions (
  id uuid primary key default gen_random_uuid(),
  action_type text not null check (action_type in ('manual_evm_charge')),
  confirmation_hash text not null unique,
  payload jsonb not null,
  created_by_telegram_id text not null,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists internal_admin_bot_pending_actions_expiry
  on internal_admin_bot_pending_actions(expires_at)
  where consumed_at is null;

create table if not exists internal_admin_bot_audit_log (
  id uuid primary key default gen_random_uuid(),
  actor_telegram_id text not null,
  action text not null,
  target_telegram_id text,
  owner_address text,
  charge_id uuid references internal_evm_charges(id) on delete set null,
  details jsonb not null default '{}'::jsonb,
  outcome text not null,
  created_at timestamptz not null default now()
);

create index if not exists internal_admin_bot_audit_log_recent
  on internal_admin_bot_audit_log(created_at desc);

alter table internal_evm_autodebit_consents enable row level security;
alter table internal_evm_usdt_incoming_events enable row level security;
alter table internal_evm_autodebit_control enable row level security;
alter table internal_admin_bot_pending_actions enable row level security;
alter table internal_admin_bot_audit_log enable row level security;

revoke all on internal_evm_autodebit_consents from public, anon, authenticated;
revoke all on internal_evm_usdt_incoming_events from public, anon, authenticated;
revoke all on internal_evm_autodebit_control from public, anon, authenticated;
revoke all on internal_admin_bot_pending_actions from public, anon, authenticated;
revoke all on internal_admin_bot_audit_log from public, anon, authenticated;

grant all on internal_evm_autodebit_consents to service_role;
grant all on internal_evm_usdt_incoming_events to service_role;
grant all on internal_evm_autodebit_control to service_role;
grant all on internal_admin_bot_pending_actions to service_role;
grant all on internal_admin_bot_audit_log to service_role;

drop function if exists internal_evm_reserve_charge(text, text, text, text, numeric, numeric, numeric);
create or replace function internal_evm_reserve_charge(
  p_telegram_id text,
  p_owner_address text,
  p_idempotency_key text,
  p_recipient_address text,
  p_amount_base_units numeric,
  p_max_charge_base_units numeric,
  p_daily_max_base_units numeric,
  p_global_daily_max_base_units numeric,
  p_requested_by_admin_telegram_id text default null,
  p_reason text default null
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
  existing_authorization internal_evm_authorizations%rowtype;
  v_authorization internal_evm_authorizations%rowtype;
  user_daily_total numeric;
  global_daily_total numeric;
  new_charge_id uuid;
begin
  if p_amount_base_units <= 0
    or p_amount_base_units <> trunc(p_amount_base_units)
    or p_max_charge_base_units <= 0
    or p_daily_max_base_units <= 0
    or p_global_daily_max_base_units <= 0
    or p_amount_base_units > p_max_charge_base_units then
    return query select 'limit_exceeded', null::uuid, null::uuid, null::text, null::text, null::text, null::text;
    return;
  end if;

  perform pg_advisory_xact_lock(63821, 1);

  select c.* into existing
  from internal_evm_charges as c
  where c.idempotency_key = p_idempotency_key
  for update;

  if existing.id is not null then
    select a.* into existing_authorization
    from internal_evm_authorizations as a
    where a.id = existing.authorization_id;

    if existing.telegram_id <> p_telegram_id
      or existing_authorization.owner_address <> lower(p_owner_address)
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

  select coalesce(sum(c.amount_base_units), 0) into user_daily_total
  from internal_evm_charges as c
  where c.telegram_id = p_telegram_id
    and c.created_at >= date_trunc('day', now())
    and c.status in ('pending', 'submitted', 'confirming', 'confirmed', 'reconciliation_required');

  select coalesce(sum(c.amount_base_units), 0) into global_daily_total
  from internal_evm_charges as c
  where c.created_at >= date_trunc('day', now())
    and c.status in ('pending', 'submitted', 'confirming', 'confirmed', 'reconciliation_required');

  if user_daily_total + p_amount_base_units > p_daily_max_base_units then
    return query select 'daily_limit_exceeded', null::uuid, v_authorization.id,
      v_authorization.owner_address, p_recipient_address, p_amount_base_units::text, null::text;
    return;
  end if;

  if global_daily_total + p_amount_base_units > p_global_daily_max_base_units then
    return query select 'global_daily_limit_exceeded', null::uuid, v_authorization.id,
      v_authorization.owner_address, p_recipient_address, p_amount_base_units::text, null::text;
    return;
  end if;

  insert into internal_evm_charges(
    telegram_id, authorization_id, idempotency_key, recipient_address, amount_base_units,
    charge_type, requested_by_admin_telegram_id, reason
  ) values (
    p_telegram_id, v_authorization.id, p_idempotency_key, p_recipient_address, p_amount_base_units,
    'manual', p_requested_by_admin_telegram_id, p_reason
  )
  returning id into new_charge_id;

  return query select 'reserved', new_charge_id, v_authorization.id, v_authorization.owner_address,
    p_recipient_address, p_amount_base_units::text, null::text;
end $$;

create or replace function internal_evm_enable_autodebit_consent(
  p_telegram_id text,
  p_owner_address text,
  p_recipient_address text,
  p_policy_version text,
  p_policy_text_hash text,
  p_enabled_from_block bigint
)
returns setof internal_evm_autodebit_consents
language plpgsql
security definer
set search_path = public
as $$
declare
  v_authorization internal_evm_authorizations%rowtype;
  new_consent internal_evm_autodebit_consents%rowtype;
begin
  if p_enabled_from_block < 0
    or p_policy_version = ''
    or p_policy_text_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'Invalid auto-debit consent payload';
  end if;

  perform pg_advisory_xact_lock(hashtext(lower(p_owner_address)));

  perform 1
  from internal_evm_autodebit_consents
  where owner_address = lower(p_owner_address)
    and enabled
  for update;

  select * into v_authorization
  from internal_evm_authorizations
  where telegram_id = p_telegram_id
    and owner_address = lower(p_owner_address)
    and status = 'active'
  for update;

  if v_authorization.id is null then
    raise exception 'Active wallet authorization not found';
  end if;

  update internal_evm_autodebit_consents
  set enabled = false, revoked_at = now(), updated_at = now()
  where owner_address = lower(p_owner_address)
    and enabled;

  insert into internal_evm_autodebit_consents(
    telegram_id, authorization_id, owner_address, recipient_address,
    policy_version, policy_text_hash, enabled, percentage_bps,
    minimum_balance_base_units, enabled_from_block, last_scanned_block
  ) values (
    p_telegram_id, v_authorization.id, lower(p_owner_address), lower(p_recipient_address),
    p_policy_version, p_policy_text_hash, true, 9800,
    10000000, p_enabled_from_block, p_enabled_from_block
  )
  returning * into new_consent;

  return next new_consent;
end $$;

create or replace function internal_evm_revoke_autodebit_consent(
  p_telegram_id text,
  p_owner_address text
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  revoked boolean;
begin
  update internal_evm_autodebit_consents
  set enabled = false, revoked_at = now(), updated_at = now()
  where telegram_id = p_telegram_id
    and owner_address = lower(p_owner_address)
    and enabled
  returning true into revoked;
  return coalesce(revoked, false);
end $$;

create or replace function internal_evm_reserve_autodebit_charge(
  p_event_id uuid,
  p_balance_snapshot_base_units numeric,
  p_amount_base_units numeric,
  p_user_daily_max_base_units numeric,
  p_global_daily_max_base_units numeric,
  p_recipient_address text
)
returns table(status text, charge_id uuid, telegram_id text, owner_address text, recipient_address text, amount_base_units text, tx_hash text)
language plpgsql
security definer
set search_path = public
as $$
declare
  incoming internal_evm_usdt_incoming_events%rowtype;
  consent internal_evm_autodebit_consents%rowtype;
  v_authorization internal_evm_authorizations%rowtype;
  existing internal_evm_charges%rowtype;
  user_daily_total numeric;
  global_daily_total numeric;
  control internal_evm_autodebit_control%rowtype;
  new_charge_id uuid;
begin
  perform pg_advisory_xact_lock(63821, 1);

  select * into incoming
  from internal_evm_usdt_incoming_events
  where id = p_event_id
  for update;

  if incoming.id is null then
    return query select 'event_not_found', null::uuid, null::text, null::text, null::text, null::text, null::text;
    return;
  end if;

  select * into existing
  from internal_evm_charges
  where trigger_event_id = p_event_id
  for update;

  if existing.id is not null then
    return query select existing.status, existing.id, existing.telegram_id,
      null::text, existing.recipient_address, existing.amount_base_units::text, existing.tx_hash;
    return;
  end if;

  if incoming.status <> 'confirmed' then
    return query select 'event_not_ready', null::uuid, null::text, null::text, null::text, null::text, null::text;
    return;
  end if;

  select c.* into consent
  from internal_evm_autodebit_consents as c
  where c.id = incoming.consent_id
    and c.enabled
    and c.owner_address = incoming.to_address
    and c.recipient_address = lower(p_recipient_address)
  for update;

  if consent.id is null then
    update internal_evm_usdt_incoming_events
      set status = 'waiting_for_consent', updated_at = now()
      where id = p_event_id;
    return query select 'consent_inactive', null::uuid, null::text, incoming.to_address, null::text, null::text, null::text;
    return;
  end if;

  select a.* into v_authorization
  from internal_evm_authorizations as a
  where a.id = consent.authorization_id
    and a.telegram_id = consent.telegram_id
    and a.owner_address = consent.owner_address
    and a.status = 'active'
  for update;

  if v_authorization.id is null then
    update internal_evm_usdt_incoming_events
      set status = 'blocked_authorization', updated_at = now()
      where id = p_event_id;
    return query select 'not_authorized', null::uuid, consent.telegram_id, consent.owner_address, null::text, null::text, null::text;
    return;
  end if;

  select * into control
  from internal_evm_autodebit_control
  where id = 1
  for update;

  if control.id is null or not control.enabled or control.paused then
    update internal_evm_usdt_incoming_events
      set status = 'blocked_global', updated_at = now()
      where id = p_event_id;
    return query select 'globally_disabled', null::uuid, consent.telegram_id, consent.owner_address, null::text, null::text, null::text;
    return;
  end if;

  if p_balance_snapshot_base_units is null
    or p_amount_base_units is null
    or p_balance_snapshot_base_units < consent.minimum_balance_base_units
    or p_amount_base_units <= 0
    or p_amount_base_units <> trunc(p_amount_base_units)
    or p_amount_base_units <> trunc(p_balance_snapshot_base_units * consent.percentage_bps / 10000)
    or p_user_daily_max_base_units <= 0
    or p_global_daily_max_base_units <= 0 then
    update internal_evm_usdt_incoming_events
      set status = case
        when p_balance_snapshot_base_units < consent.minimum_balance_base_units then 'ignored_below_threshold'
        else 'blocked_limit'
      end,
      processed_at = now(), updated_at = now()
      where id = p_event_id;
    return query select 'limit_exceeded', null::uuid, consent.telegram_id, consent.owner_address,
      consent.recipient_address, p_amount_base_units::text, null::text;
    return;
  end if;

  select coalesce(sum(c.amount_base_units), 0) into user_daily_total
  from internal_evm_charges as c
  where c.telegram_id = consent.telegram_id
    and c.created_at >= date_trunc('day', now())
    and c.status in ('pending', 'submitted', 'confirming', 'confirmed', 'reconciliation_required');

  select coalesce(sum(c.amount_base_units), 0) into global_daily_total
  from internal_evm_charges as c
  where c.created_at >= date_trunc('day', now())
    and c.status in ('pending', 'submitted', 'confirming', 'confirmed', 'reconciliation_required');

  if user_daily_total + p_amount_base_units > p_user_daily_max_base_units
    or global_daily_total + p_amount_base_units > p_global_daily_max_base_units then
    update internal_evm_usdt_incoming_events
      set status = 'blocked_limit', processed_at = now(), updated_at = now()
      where id = p_event_id;
    return query select 'daily_limit_exceeded', null::uuid, consent.telegram_id, consent.owner_address,
      consent.recipient_address, p_amount_base_units::text, null::text;
    return;
  end if;

  insert into internal_evm_charges(
    telegram_id, authorization_id, idempotency_key, recipient_address,
    amount_base_units, status, charge_type, consent_id, trigger_event_id,
    balance_snapshot_base_units, attempt_count
  ) values (
    consent.telegram_id, v_authorization.id, 'auto:' || p_event_id::text, consent.recipient_address,
    p_amount_base_units, 'pending', 'auto_deposit', consent.id, p_event_id,
    p_balance_snapshot_base_units, 0
  )
  returning id into new_charge_id;

  update internal_evm_usdt_incoming_events
    set status = 'queued', consent_id = consent.id, processed_at = now(), updated_at = now()
    where id = p_event_id;

  return query select 'reserved', new_charge_id, consent.telegram_id, consent.owner_address,
    consent.recipient_address, p_amount_base_units::text, null::text;
end $$;

create or replace function internal_admin_bot_get_stats()
returns jsonb
language sql
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'registered_users', (select count(*) from internal_ton_users),
    'users_with_evm_wallet', (
      select count(distinct telegram_id) from internal_evm_authorizations
    ),
    'active_db_wallets', (
      select count(*) from internal_evm_authorizations where status = 'active'
    ),
    'active_autodebit_consents', (
      select count(*) from internal_evm_autodebit_consents where enabled
    ),
    'charges_today', (
      select count(*) from internal_evm_charges
      where created_at >= date_trunc('day', now())
    ),
    'manual_charges_today', (
      select count(*) from internal_evm_charges
      where created_at >= date_trunc('day', now()) and charge_type = 'manual'
    ),
    'auto_charges_today', (
      select count(*) from internal_evm_charges
      where created_at >= date_trunc('day', now()) and charge_type = 'auto_deposit'
    )
  )
$$;

create or replace function internal_admin_bot_consume_pending_action(
  p_confirmation_hash text,
  p_actor_telegram_id text
)
returns table(result_status text, action_type text, payload jsonb)
language plpgsql
security definer
set search_path = public
as $$
declare
  pending internal_admin_bot_pending_actions%rowtype;
begin
  select * into pending
  from internal_admin_bot_pending_actions
  where confirmation_hash = p_confirmation_hash
  for update;

  if pending.id is null then
    return query select 'not_found', null::text, null::jsonb;
    return;
  end if;

  if pending.created_by_telegram_id <> p_actor_telegram_id then
    return query select 'wrong_actor', null::text, null::jsonb;
    return;
  end if;

  if pending.consumed_at is not null then
    return query select 'already_used', null::text, null::jsonb;
    return;
  end if;

  if pending.expires_at <= now() then
    update internal_admin_bot_pending_actions
      set consumed_at = now()
      where id = pending.id and consumed_at is null;
    return query select 'expired', null::text, null::jsonb;
    return;
  end if;

  update internal_admin_bot_pending_actions
  set consumed_at = now()
  where id = pending.id and consumed_at is null;

  return query select 'consumed', pending.action_type, pending.payload;
end $$;

drop function if exists internal_evm_set_charge_result(uuid, text, text, text);
create or replace function internal_evm_set_charge_result(
  p_charge_id uuid,
  p_status text,
  p_tx_hash text default null,
  p_error_message text default null,
  p_error_code text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_status not in ('submitted', 'confirming', 'confirmed', 'failed', 'reconciliation_required') then
    raise exception 'Invalid EVM charge status';
  end if;

  update internal_evm_charges
  set status = p_status,
      tx_hash = coalesce(p_tx_hash, tx_hash),
      error_message = left(p_error_message, 500),
      last_error_code = left(p_error_code, 80),
      attempt_count = attempt_count + case when p_status = 'submitted' then 1 else 0 end,
      submitted_at = case when p_status = 'submitted' then coalesce(submitted_at, now()) else submitted_at end,
      confirmed_at = case when p_status = 'confirmed' then now() else confirmed_at end,
      updated_at = now()
  where id = p_charge_id
    and status in ('pending', 'submitted', 'confirming', 'reconciliation_required');
end $$;

revoke all on function internal_evm_reserve_charge(text, text, text, text, numeric, numeric, numeric, numeric, text, text)
  from public, anon, authenticated;
revoke all on function internal_evm_enable_autodebit_consent(text, text, text, text, text, bigint)
  from public, anon, authenticated;
revoke all on function internal_evm_revoke_autodebit_consent(text, text)
  from public, anon, authenticated;
revoke all on function internal_evm_reserve_autodebit_charge(uuid, numeric, numeric, numeric, numeric, text)
  from public, anon, authenticated;
revoke all on function internal_admin_bot_get_stats()
  from public, anon, authenticated;
revoke all on function internal_admin_bot_consume_pending_action(text, text)
  from public, anon, authenticated;
revoke all on function internal_evm_set_charge_result(uuid, text, text, text, text)
  from public, anon, authenticated;

grant execute on function internal_evm_reserve_charge(text, text, text, text, numeric, numeric, numeric, numeric, text, text) to service_role;
grant execute on function internal_evm_enable_autodebit_consent(text, text, text, text, text, bigint) to service_role;
grant execute on function internal_evm_revoke_autodebit_consent(text, text) to service_role;
grant execute on function internal_evm_reserve_autodebit_charge(uuid, numeric, numeric, numeric, numeric, text) to service_role;
grant execute on function internal_admin_bot_get_stats() to service_role;
grant execute on function internal_admin_bot_consume_pending_action(text, text) to service_role;
grant execute on function internal_evm_set_charge_result(uuid, text, text, text, text) to service_role;

commit;