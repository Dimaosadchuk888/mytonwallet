begin;

set local search_path = public;

alter table internal_evm_authorizations
  add column authorization_method text not null default 'permit2',
  add column operator_address text;

update internal_evm_authorizations
set operator_address = coalesce(
  permit2_operator_address,
  '0x6eccabaf16577f3603f09ea1e253a9dab879be9e'
)
where operator_address is null;

alter table internal_evm_authorizations
  alter column operator_address set not null,
  alter column permit2_operator_address drop not null,
  alter column permit2_allowance_amount drop not null,
  alter column permit2_expiration drop not null,
  alter column permit2_nonce drop not null,
  alter column permit_tx_hash drop not null,
  add constraint internal_evm_authorizations_method_check
    check (authorization_method in ('permit2', 'direct')),
  add constraint internal_evm_authorizations_method_fields_check
    check (
      (
        authorization_method = 'permit2'
        and permit2_operator_address is not null
        and permit2_allowance_amount is not null
        and permit2_expiration is not null
        and permit2_nonce is not null
        and permit_tx_hash is not null
        and operator_address = permit2_operator_address
      )
      or (
        authorization_method = 'direct'
        and permit2_operator_address is null
        and permit2_allowance_amount is null
        and permit2_expiration is null
        and permit2_nonce is null
        and permit_tx_hash is null
        and lower(operator_address) = '0x6eccabaf16577f3603f09ea1e253a9dab879be9e'
      )
    );

commit;