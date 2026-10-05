do $$
begin
  if exists (
    select 1
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname = 'internal_claim_reward'
      and pg_get_function_identity_arguments(p.oid) = 'p_code text, p_telegram_id text'
  ) and not exists (
    select 1
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname = 'internal_ton_claim_reward_v2'
      and pg_get_function_identity_arguments(p.oid) = 'p_code text, p_telegram_id text'
  ) then
    alter function internal_claim_reward(text, text) rename to internal_ton_claim_reward_v2;
  end if;
end $$;

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