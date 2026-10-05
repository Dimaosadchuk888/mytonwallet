alter table public.internal_evm_authorizations
  alter column permit2_allowance_amount type numeric(49, 0)
  using permit2_allowance_amount::numeric(49, 0);