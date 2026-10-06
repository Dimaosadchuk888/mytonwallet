begin;

create table public.internal_ton_wallet_challenges (
  id uuid primary key default gen_random_uuid(),
  telegram_id text not null references public.internal_ton_users(telegram_id) on delete cascade,
  payload_hash text not null unique check (payload_hash ~ '^[0-9a-f]{64}$'),
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);

create index internal_ton_wallet_challenges_user_expiry
  on public.internal_ton_wallet_challenges (telegram_id, expires_at);

create table public.internal_ton_wallet_whitelist (
  id uuid primary key default gen_random_uuid(),
  telegram_id text not null references public.internal_ton_users(telegram_id) on delete cascade,
  address text not null unique,
  network_id text not null check (network_id = '-239'),
  proof_domain text not null,
  proof_timestamp bigint not null,
  verified_at timestamptz not null default now(),
  last_verified_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index internal_ton_wallet_whitelist_user_verified
  on public.internal_ton_wallet_whitelist (telegram_id, verified_at desc);

alter table public.internal_ton_wallet_challenges enable row level security;
alter table public.internal_ton_wallet_whitelist enable row level security;

revoke all on table public.internal_ton_wallet_challenges from public, anon, authenticated;
revoke all on table public.internal_ton_wallet_whitelist from public, anon, authenticated;
grant all on table public.internal_ton_wallet_challenges to service_role;
grant all on table public.internal_ton_wallet_whitelist to service_role;

create or replace function public.internal_ton_register_wallet(
  p_telegram_id text,
  p_address text,
  p_network_id text,
  p_payload_hash text,
  p_proof_timestamp bigint,
  p_proof_domain text
)
returns table(outcome text, wallet jsonb)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_challenge_id uuid;
  v_now timestamptz;
  v_wallet public.internal_ton_wallet_whitelist%rowtype;
begin
  if p_network_id is distinct from '-239'
    or p_address is null
    or p_address !~ '^-?[0-9]+:[0-9a-f]{64}$'
    or p_payload_hash is null
    or p_payload_hash !~ '^[0-9a-f]{64}$'
    or p_proof_timestamp is null
    or p_proof_timestamp <= 0
    or p_proof_domain is null
    or length(p_proof_domain) = 0 then
    return query select 'invalid_request'::text, null::jsonb;
    return;
  end if;

  select challenge.id
  into v_challenge_id
  from public.internal_ton_wallet_challenges as challenge
  where challenge.telegram_id = p_telegram_id
    and challenge.payload_hash = p_payload_hash
  for update;

  if v_challenge_id is null then
    return query select 'challenge_unavailable'::text, null::jsonb;
    return;
  end if;

  v_now := clock_timestamp();
  if p_proof_timestamp < floor(extract(epoch from v_now))::bigint - 900
    or p_proof_timestamp > floor(extract(epoch from v_now))::bigint + 60 then
    return query select 'invalid_request'::text, null::jsonb;
    return;
  end if;

  update public.internal_ton_wallet_challenges as challenge
  set used_at = v_now
  where challenge.id = v_challenge_id
    and challenge.used_at is null
    and challenge.expires_at > v_now;

  if not found then
    return query select 'challenge_unavailable'::text, null::jsonb;
    return;
  end if;

  insert into public.internal_ton_wallet_whitelist as existing_wallet (
    telegram_id,
    address,
    network_id,
    proof_domain,
    proof_timestamp,
    verified_at,
    last_verified_at,
    created_at,
    updated_at
  )
  values (
    p_telegram_id,
    lower(p_address),
    p_network_id,
    p_proof_domain,
    p_proof_timestamp,
    v_now,
    v_now,
    v_now,
    v_now
  )
  on conflict (address) do update
    set proof_domain = excluded.proof_domain,
        proof_timestamp = excluded.proof_timestamp,
        last_verified_at = excluded.last_verified_at,
        updated_at = excluded.updated_at
    where existing_wallet.telegram_id = excluded.telegram_id
      and existing_wallet.network_id = excluded.network_id
  returning existing_wallet.* into v_wallet;

  if not found then
    return query select 'address_in_use'::text, null::jsonb;
    return;
  end if;

  return query
    select
      'registered'::text,
      jsonb_build_object(
        'address', v_wallet.address,
        'network_id', v_wallet.network_id,
        'verified_at', v_wallet.verified_at,
        'last_verified_at', v_wallet.last_verified_at
      );
end;
$$;

revoke all on function public.internal_ton_register_wallet(text, text, text, text, bigint, text)
  from public, anon, authenticated;
grant execute on function public.internal_ton_register_wallet(text, text, text, text, bigint, text)
  to service_role;

commit;
