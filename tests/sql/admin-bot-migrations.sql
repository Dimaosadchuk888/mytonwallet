-- Run only in an isolated test database after migrations 005 and 008.
-- All test fixtures and control changes are rolled back. No blockchain calls.
begin;
do $$
declare
  result record;
  consent_row internal_evm_autodebit_consents%rowtype;
  manual_id uuid;
  event_id uuid;
  auto_id uuid;
begin
  if not exists (
    select 1 from internal_evm_autodebit_control
    where id = 1 and not enabled and paused
  ) then
    raise exception 'Control must start disabled and paused';
  end if;

  insert into internal_ton_users(telegram_id) values ('sql-test-user');
  insert into internal_evm_authorizations(
    telegram_id, owner_address, token_address, permit2_operator_address,
    token_allowance, permit2_allowance_amount, permit2_expiration,
    permit2_nonce, approval_tx_hash, permit_tx_hash, verified_at
  ) values (
    'sql-test-user', '0x1111111111111111111111111111111111111111',
    'test-token', 'test-operator', 1000000000, 1000000000, 9999999999,
    0, 'test-approval', 'test-permit', now()
  );

  select * into result from internal_evm_reserve_charge(
    'sql-test-user', '0x1111111111111111111111111111111111111111',
    'test-manual', 'test-recipient', 1000000, 100000000, 100000000, 100000000
  );
  if result.status <> 'reserved' then raise exception 'Manual reservation failed: %', result.status; end if;
  manual_id := result.charge_id;

  select * into result from internal_evm_reserve_charge(
    'sql-test-user', '0x1111111111111111111111111111111111111111',
    'test-manual', 'test-recipient', 1000000, 100000000, 100000000, 100000000
  );
  if result.status <> 'pending' or result.charge_id <> manual_id then
    raise exception 'Manual idempotency failed';
  end if;
  select * into result from internal_evm_reserve_charge(
    'sql-test-user', '0x1111111111111111111111111111111111111111',
    'test-manual', 'test-recipient', 2000000, 100000000, 100000000, 100000000
  );
  if result.status <> 'idempotency_conflict' then raise exception 'Conflict not rejected'; end if;

  select * into result from internal_evm_reserve_charge(
    'sql-test-user', '0x1111111111111111111111111111111111111111',
    'test-user-limit', 'test-recipient', 2000000, 100000000, 1000000, 100000000
  );
  if result.status <> 'daily_limit_exceeded' then raise exception 'User limit not enforced'; end if;
  select * into result from internal_evm_reserve_charge(
    'sql-test-user', '0x1111111111111111111111111111111111111111',
    'test-global-limit', 'test-recipient', 2000000, 100000000, 100000000, 1000000
  );
  if result.status <> 'global_daily_limit_exceeded' then raise exception 'Global limit not enforced'; end if;
  perform internal_evm_set_charge_result(manual_id, 'submitted', 'test-hash');
  perform internal_evm_set_charge_result(manual_id, 'confirmed', 'test-hash');

  select * into consent_row from internal_evm_enable_autodebit_consent(
    'sql-test-user', '0x1111111111111111111111111111111111111111',
    'test-recipient', 'test-policy', repeat('a', 64), 100
  );
  -- Replacing consent must retain history and leave just one enabled consent.
  select * into consent_row from internal_evm_enable_autodebit_consent(
    'sql-test-user', '0x1111111111111111111111111111111111111111',
    'test-recipient', 'test-policy', repeat('a', 64), 101
  );
  insert into internal_evm_usdt_incoming_events(
    token_address, tx_hash, log_index, block_number, block_hash,
    from_address, to_address, amount_base_units, consent_id
  ) values (
    'test-token', 'test-incoming', 0, 102, 'test-block', 'test-sender',
    consent_row.owner_address, 10000000, consent_row.id
  ) returning id into event_id;

  select * into result from internal_evm_reserve_autodebit_charge(
    event_id, 10000000, 9800000, 100000000, 100000000, 'test-recipient'
  );
  if result.status <> 'globally_disabled' then raise exception 'Kill switch not enforced'; end if;
  update internal_evm_usdt_incoming_events set status = 'confirmed' where id = event_id;
  update internal_evm_autodebit_control set enabled = true, paused = false where id = 1;
  select * into result from internal_evm_reserve_autodebit_charge(
    event_id, 10000000, 9800000, 100000000, 100000000, 'test-recipient'
  );
  if result.status <> 'reserved' or result.amount_base_units <> '9800000' then
    raise exception 'Auto reservation failed: %', result.status;
  end if;
  auto_id := result.charge_id;
  select * into result from internal_evm_reserve_autodebit_charge(
    event_id, 10000000, 9800000, 100000000, 100000000, 'test-recipient'
  );
  if result.charge_id <> auto_id or result.status <> 'pending' then raise exception 'Auto idempotency failed'; end if;
  if not internal_evm_revoke_autodebit_consent('sql-test-user', consent_row.owner_address) then
    raise exception 'Consent revoke failed';
  end if;

  insert into internal_evm_authorization_challenges(telegram_id, owner_address, nonce, expires_at)
  values ('sql-test-user', consent_row.owner_address, 'test-nonce', now() + interval '1 minute');
  if not internal_evm_consume_authorization_challenge('sql-test-user', consent_row.owner_address, 'test-nonce') then
    raise exception 'Challenge consumption failed';
  end if;
  if internal_evm_consume_authorization_challenge('sql-test-user', consent_row.owner_address, 'test-nonce') then
    raise exception 'Challenge reused';
  end if;

  insert into internal_admin_bot_pending_actions(
    action_type, confirmation_hash, payload, created_by_telegram_id, expires_at
  ) values ('manual_evm_charge', 'test-confirmation', '{}'::jsonb, 'test-admin', now() + interval '1 minute');
  select * into result from internal_admin_bot_consume_pending_action('test-confirmation', 'wrong-admin');
  if result.result_status <> 'wrong_actor' then raise exception 'Wrong admin accepted'; end if;
  select * into result from internal_admin_bot_consume_pending_action('test-confirmation', 'test-admin');
  if result.result_status <> 'consumed' then raise exception 'Confirmation failed'; end if;
  select * into result from internal_admin_bot_consume_pending_action('test-confirmation', 'test-admin');
  if result.result_status <> 'already_used' then raise exception 'Confirmation reused'; end if;
  perform internal_admin_bot_get_stats();
  raise notice 'PASS: manual and auto reservations, limits, idempotency, kill switch, consent, challenges, confirmations and stats';
end $$;
rollback;