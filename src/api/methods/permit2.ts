import { parseAccountId } from '../../util/account';
import {
  fetchPermit2Allowance as fetchPermit2AllowanceOnChain,
  signPermit2Allowance as signPermit2AllowanceOnChain,
  submitPermit2Approval as submitPermit2ApprovalOnChain,
} from '../chains/evm/permit2';
import { fetchStoredAddress } from '../common/accounts';

const EVM_CHAIN = 'ethereum' as const;

export async function fetchPermit2Allowance(options: {
  accountId: string;
  spender: string;
}) {
  const { accountId, spender } = options;
  const { network } = parseAccountId(accountId);
  const owner = await fetchStoredAddress(accountId, EVM_CHAIN);

  return fetchPermit2AllowanceOnChain(EVM_CHAIN, network, owner, spender);
}

export function submitPermit2Approval(options: {
  accountId: string;
  enclaveToken?: string;
}) {
  return submitPermit2ApprovalOnChain(EVM_CHAIN, options);
}

export function signPermit2Allowance(options: Parameters<typeof signPermit2AllowanceOnChain>[1]) {
  return signPermit2AllowanceOnChain(EVM_CHAIN, options);
}
