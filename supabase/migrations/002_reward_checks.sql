create table if not exists internal_ton_reward_checks (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  code text unique not null,
  amount_per_claim bigint not null check (amount_per_claim > 0),
  max_claims integer not null check (max_claims > 0),
  claimed_count integer not null default 0 check (claimed_count >= 0),
  active boolean not null default true,
  expires_at timestamptz,
  creator_telegram_id text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create table if not exists internal_ton_reward_claims (
  id uuid primary key default gen_random_uuid(),
  check_id uuid not null references internal_ton_reward_checks(id) on delete cascade,
  telegram_id text not null references internal_ton_users(telegram_id),
  amount bigint not null,
  created_at timestamptz not null default now(),
  unique(check_id, telegram_id)
);
create index if not exists internal_ton_reward_checks_active_idx on internal_ton_reward_checks(active, expires_at);
create index if not exists internal_ton_reward_claims_telegram_idx on internal_ton_reward_claims(telegram_id);
alter table internal_ton_reward_checks enable row level security;
alter table internal_ton_reward_claims enable row level security;

create or replace function internal_ton_claim_reward(p_code text, p_telegram_id text)
returns table(status text, amount text, title text, resulting_balance text)
language plpgsql security definer set search_path = public as $$
declare c internal_ton_reward_checks%rowtype; balance bigint;
begin
  select * into c from internal_ton_reward_checks where code = p_code for update;
  if not found then return query select 'not_found'::text, null::text, null::text, null::text; return; end if;
  if not c.active then return query select 'inactive', c.amount_per_claim::text, c.title, null::text; return; end if;
  if c.expires_at is not null and c.expires_at <= now() then return query select 'expired', c.amount_per_claim::text, c.title, null::text; return; end if;
  if exists (select 1 from internal_ton_reward_claims where check_id = c.id and telegram_id = p_telegram_id) then
    select b.amount into balance from internal_ton_balances b where b.telegram_id = p_telegram_id;
    return query select 'already_claimed', c.amount_per_claim::text, c.title, balance::text; return;
  end if;
  if c.claimed_count >= c.max_claims then return query select 'exhausted', c.amount_per_claim::text, c.title, null::text; return; end if;
  insert into internal_ton_reward_claims(check_id, telegram_id, amount) values(c.id, p_telegram_id, c.amount_per_claim);
  update internal_ton_reward_checks set claimed_count = claimed_count + 1, updated_at = now() where id = c.id;
  update internal_ton_balances b
  set amount = b.amount + c.amount_per_claim, updated_at = now()
  where b.telegram_id = p_telegram_id
  returning b.amount into balance;
  if balance is null then raise exception 'Balance not initialized'; end if;
  return query select 'credited', c.amount_per_claim::text, c.title, balance::text;
end $$;

revoke all on function internal_ton_claim_reward(text, text) from public, anon, authenticated;
grant execute on function internal_ton_claim_reward(text, text) to service_role;