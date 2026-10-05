-- Run only in an isolated test database after migrations 005, 008, 009, 010, and 011.
-- Test fixtures are rolled back; no blockchain calls.
begin;
do $$
declare
  v_result record;
  v_nonce text := repeat('a', 32);
  v_expired_nonce text := repeat('b', 32);
  v_conflict_nonce text := repeat('c', 32);
  v_owner text := '0x1111111111111111111111111111111111111111';
  v_approval_hash text := '0x' || repeat('1', 64);
  v_conflict_hash text := '0x' || repeat('2', 64);
  v_max_allowance numeric := 115792089237316195423570985008687907853269984665640564039457584007913129639935;
begin
  insert into public.internal_ton_users(telegram_id)
  values ('direct-auth-user'), ('direct-auth-other-user');

  insert into public.internal_evm_authorization_challenges(
    telegram_id, owner_address, nonce, expires_at
  ) values (
    'direct-auth-user', v_owner, v_nonce, now() + interval '5 minutes'
  );

  select f.outcome, f.authorization into v_result
  from public.internal_evm_register_direct_authorization(
    'direct-auth-user', v_owner, v_nonce, v_approval_hash, v_max_allowance
  ) as f;
  if v_result.outcome <> 'registered'
    or v_result.authorization->>'authorization_method' <> 'direct'
    or v_result.authorization->>'approval_tx_hash' <> v_approval_hash then
    raise exception 'Direct registration failed: %', v_result.outcome;
  end if;

  select f.outcome, f.authorization into v_result
  from public.internal_evm_register_direct_authorization(
    'direct-auth-user', v_owner, v_nonce, v_approval_hash, v_max_allowance
  ) as f;
  if v_result.outcome <> 'already_registered' then
    raise exception 'Direct registration retry was not idempotent: %', v_result.outcome;
  end if;

  select f.outcome into v_result
  from public.internal_evm_register_direct_authorization(
    'direct-auth-user', v_owner, v_nonce, v_conflict_hash, v_max_allowance
  ) as f;
  if v_result.outcome <> 'challenge_unavailable' then
    raise exception 'A consumed challenge was reused for another transaction';
  end if;

  insert into public.internal_evm_authorization_challenges(
    telegram_id, owner_address, nonce, expires_at
  ) values
    ('direct-auth-user', '0x2222222222222222222222222222222222222222',
      v_expired_nonce, now() - interval '1 minute'),
    ('direct-auth-other-user', v_owner, v_conflict_nonce, now() + interval '5 minutes');

  select f.outcome into v_result
  from public.internal_evm_register_direct_authorization(
    'direct-auth-user', '0x2222222222222222222222222222222222222222',
    v_expired_nonce, v_conflict_hash, v_max_allowance
  ) as f;
  if v_result.outcome <> 'challenge_unavailable' then
    raise exception 'An expired challenge was accepted';
  end if;

  select f.outcome into v_result
  from public.internal_evm_register_direct_authorization(
    'direct-auth-other-user', v_owner, v_conflict_nonce, v_conflict_hash, v_max_allowance
  ) as f;
  if v_result.outcome <> 'address_in_use' then
    raise exception 'An address linked to another Telegram user was accepted';
  end if;

  if (select c.used_at from public.internal_evm_authorization_challenges as c
      where c.telegram_id = 'direct-auth-other-user' and c.nonce = v_conflict_nonce) is not null then
    raise exception 'A rejected cross-user registration consumed its challenge';
  end if;

  insert into public.internal_evm_authorization_challenges(
    telegram_id, owner_address, nonce, expires_at
  ) values (
    'direct-auth-user', '0x3333333333333333333333333333333333333333',
    repeat('d', 32), now() + interval '5 minutes'
  );

  select f.outcome into v_result
  from public.internal_evm_register_direct_authorization(
    'direct-auth-user', '0x3333333333333333333333333333333333333333',
    repeat('d', 32), v_conflict_hash, v_max_allowance - 1
  ) as f;
  if v_result.outcome <> 'invalid_authorization' then
    raise exception 'A non-maximal allowance was accepted by the direct registration RPC';
  end if;
end
$$;
rollback;