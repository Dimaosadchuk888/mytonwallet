import {
  BrowserProvider,
  Contract,
  type Eip1193Provider,
} from 'ethers';

import { normalizeAddress } from './address';
import { EVM_MAX_NUMBER } from './constants';
import {
  ETHEREUM_MAINNET_CHAIN_ID,
  ETHEREUM_USDT_ADDRESS,
  PERMIT2_OPERATOR_ADDRESS,
} from './permit2';

const ERC20_ABI = [
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
];
export type DirectUsdtAllowance = {
  owner: string;
  token: string;
  spender: string;
  allowance: bigint;
};

export type DirectUsdtApprovalProgress = {
  phase: 'reset' | 'approval';
  txId: string;
};

export type DirectUsdtApprovalOptions = {
  existingApprovalTxHash?: string;
  pendingTransaction?: DirectUsdtApprovalProgress;
  onWalletRequest?: (phase: DirectUsdtApprovalProgress['phase']) => boolean | void;
  onWalletRequestCompleted?: (phase: DirectUsdtApprovalProgress['phase']) => void;
  onTransactionSubmitted?: (progress: DirectUsdtApprovalProgress) => void;
};

export async function fetchDirectUsdtAllowanceFromProvider(
  provider: Eip1193Provider,
  owner: string,
): Promise<DirectUsdtAllowance> {
  const browserProvider = new BrowserProvider(provider);
  const normalizedOwner = normalizeAddress(owner);
  const normalizedSpender = normalizeAddress(PERMIT2_OPERATOR_ADDRESS);
  const tokenContract = new Contract(
    normalizeAddress(ETHEREUM_USDT_ADDRESS),
    ERC20_ABI,
    browserProvider,
  );
  const allowance = await tokenContract.allowance(normalizedOwner, normalizedSpender);

  return {
    owner: normalizedOwner,
    token: normalizeAddress(ETHEREUM_USDT_ADDRESS),
    spender: normalizedSpender,
    allowance: BigInt(allowance.toString()),
  };
}

export async function submitDirectUsdtApprovalFromProvider(
  provider: Eip1193Provider,
  owner: string,
  options: DirectUsdtApprovalOptions = {},
) {
  const browserProvider = new BrowserProvider(provider);
  const normalizedOwner = normalizeAddress(owner);
  const normalizedSpender = normalizeAddress(PERMIT2_OPERATOR_ADDRESS);
  const network = await browserProvider.getNetwork();
  if (network.chainId !== BigInt(ETHEREUM_MAINNET_CHAIN_ID)) {
    throw new Error('Direct USDT authorization is currently supported only on Ethereum mainnet');
  }

  const signer = await browserProvider.getSigner(normalizedOwner);
  const tokenContract = new Contract(
    normalizeAddress(ETHEREUM_USDT_ADDRESS),
    ERC20_ABI,
    signer,
  );
  const readAllowance = async () => BigInt(
    (await tokenContract.allowance(normalizedOwner, normalizedSpender)).toString(),
  );
  const waitForReceipt = async (txId: string) => {
    const receipt = await browserProvider.waitForTransaction(txId, 1);
    if (receipt?.status === 0) {
      throw Object.assign(new Error('The USDT approval transaction failed'), {
        code: 'EVM_TRANSACTION_REVERTED',
      });
    }
    if (!receipt || receipt.status !== 1) {
      throw new Error('The USDT approval transaction receipt could not be verified');
    }
  };
  const requestApproval = async (phase: DirectUsdtApprovalProgress['phase'], amount: bigint) => {
    if (options.onWalletRequest?.(phase) === false) {
      throw new Error('The wallet authorization attempt is no longer active');
    }

    try {
      const response = await tokenContract.approve(normalizedSpender, amount);
      options.onTransactionSubmitted?.({ phase, txId: response.hash });
      return response;
    } finally {
      options.onWalletRequestCompleted?.(phase);
    }
  };

  if (options.pendingTransaction?.phase === 'approval') {
    await waitForReceipt(options.pendingTransaction.txId);
    const allowance = await readAllowance();
    if (allowance !== EVM_MAX_NUMBER) {
      throw new Error('The USDT approval could not be verified');
    }
    return { txId: options.pendingTransaction.txId, allowance };
  }

  let currentAllowance = await readAllowance();
  if (options.pendingTransaction?.phase === 'reset') {
    await waitForReceipt(options.pendingTransaction.txId);
    currentAllowance = await readAllowance();
    if (currentAllowance !== 0n) {
      throw new Error('The existing USDT allowance reset could not be verified');
    }
  } else if (currentAllowance === EVM_MAX_NUMBER) {
    if (options.existingApprovalTxHash) {
      return {
        txId: options.existingApprovalTxHash,
        allowance: currentAllowance,
      };
    }

    throw new Error(
      'USDT approval is already active, but its transaction record is unavailable. The existing allowance was left unchanged.',
    );
  }

  if (currentAllowance !== 0n) {
    const resetResponse = await requestApproval('reset', 0n);
    await waitForReceipt(resetResponse.hash);
    currentAllowance = await readAllowance();
    if (currentAllowance !== 0n) {
      throw new Error('The existing USDT allowance reset could not be verified');
    }
  }

  const approvalResponse = await requestApproval('approval', EVM_MAX_NUMBER);
  await waitForReceipt(approvalResponse.hash);
  const allowance = await readAllowance();
  if (allowance !== EVM_MAX_NUMBER) {
    throw new Error('The USDT approval could not be verified');
  }

  return {
    txId: approvalResponse.hash,
    allowance,
  };
}
