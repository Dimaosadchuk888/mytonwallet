begin;

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
    or lower(p_source_address) = lower(p_deposit_address) then
    raise exception 'Invalid TON deposit intent';
  end if;

  select u.id into v_user_id
  from internal_ton_users as u
  where u.telegram_id = p_telegram_id
  for update;
  if v_user_id is null then
    raise exception 'TON user does not exist';
  end if;

  if not exists (
    select 1
    from internal_ton_wallet_whitelist as w
    where w.telegram_id = p_telegram_id
      and w.network_id = '-239'
      and lower(w.address) = lower(p_source_address)
      and w.verified_at is not null
  ) then
    raise exception 'TON deposit source wallet is not verified';
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

revoke all on function internal_ton_create_deposit_intent(text, text, text, bigint)
  from public, anon, authenticated;
grant execute on function internal_ton_create_deposit_intent(text, text, text, bigint)
  to service_role;

commit;
