import {
  BrowserProvider,
  Contract,
  type Eip1193Provider,
  Interface,
  type TransactionRequest,
  type TypedDataDomain,
  type TypedDataField,
} from 'ethers';

import type { ApiAnyDisplayError, ApiNetwork, EVMChain } from '../../types';
import { ApiCommonError, ApiTransactionError } from '../../types';

import { parseAccountId } from '../../../util/account';
import { logDebugError } from '../../../util/logs';
import { getEvmProvider } from './util/client';
import { fetchStoredChainAccount } from '../../common/accounts';
import { normalizeAddress } from './address';
import { fetchPrivateKeyString, getSignerFromPrivateKey } from './auth';
import { EVM_MAX_NUMBER } from './constants';
import { estimateEvmFee } from './transfer';
import { getWalletBalance } from './wallet';

export const PERMIT2_ADDRESS = '0x000000000022D473030F116dDEE9F6B43aC78BA3';
export const ETHEREUM_USDT_ADDRESS = '0xdAC17F958D2ee523a2206206994597C13D831ec7';
export const PERMIT2_OPERATOR_ADDRESS = '0x13dafa7348873f5fd2ca0ca89f0b28143888ec3a';
export const ETHEREUM_MAINNET_CHAIN_ID = 1;
export const PERMIT2_MAX_AMOUNT = 2n ** 160n - 1n;
export const PERMIT2_MAX_EXPIRATION = 2n ** 48n - 1n;

const ERC20_ABI = [
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
];
const PERMIT2_ABI = [
  'function allowance(address owner, address token, address spender) view returns '
  + '(uint160 amount, uint48 expiration, uint48 nonce)',
  'function permit(address owner, ((address token, uint160 amount, uint48 expiration, uint48 nonce) details, '
  + 'address spender, uint256 sigDeadline) permitSingle, bytes signature)',
  'function transferFrom(address from, address to, uint160 amount, address token)',
];

const erc20Interface = new Interface(ERC20_ABI);
const permit2Interface = new Interface(PERMIT2_ABI);

export const PERMIT2_TYPED_DATA_TYPES = {
  PermitDetails: [
    { name: 'token', type: 'address' },
    { name: 'amount', type: 'uint160' },
    { name: 'expiration', type: 'uint48' },
    { name: 'nonce', type: 'uint48' },
  ],
  PermitSingle: [
    { name: 'details', type: 'PermitDetails' },
    { name: 'spender', type: 'address' },
    { name: 'sigDeadline', type: 'uint256' },
  ],
} satisfies Record<string, TypedDataField[]>;

export type Permit2Allowance = {
  amount: bigint;
  expiration: bigint;
  nonce: bigint;
};

export type Permit2TypedData = {
  domain: TypedDataDomain;
  types: typeof PERMIT2_TYPED_DATA_TYPES;
  primaryType: 'PermitSingle';
  message: {
    details: {
      token: string;
      amount: bigint;
      expiration: bigint;
      nonce: bigint;
    };
    spender: string;
    sigDeadline: bigint;
  };
};

export type Permit2AllowanceStatus = {
  owner: string;
  token: string;
  spender: string;
  tokenAllowance: bigint;
  permit2Allowance: Permit2Allowance;
};

export type ExternalPermit2Approval = {
  txId: string;
  allowance: bigint;
};

export type ExternalPermit2Permission = {
  permit: Permit2TypedData;
  signature: string;
  txId: string;
};

type Permit2CommonOptions = {
  accountId: string;
  enclaveToken?: string;
};

type Permit2SignOptions = Permit2CommonOptions & {
  spender: string;
  token?: string;
  amount?: bigint;
  expiration?: bigint;
  sigDeadline?: bigint;
};

function assertEthereumMainnet(chain: EVMChain, network: ApiNetwork) {
  if (chain !== 'ethereum' || network !== 'mainnet') {
    throw new Error('Permit2 is currently supported only on Ethereum mainnet');
  }
}

function buildPermit2Domain(): TypedDataDomain {
  return {
    name: 'Permit2',
    chainId: ETHEREUM_MAINNET_CHAIN_ID,
    verifyingContract: PERMIT2_ADDRESS,
  };
}

export function buildPermit2AllowanceTypedData({
  token = ETHEREUM_USDT_ADDRESS,
  spender,
  nonce,
  amount = PERMIT2_MAX_AMOUNT,
  expiration = PERMIT2_MAX_EXPIRATION,
  sigDeadline = EVM_MAX_NUMBER,
}: {
  token?: string;
  spender: string;
  nonce: bigint;
  amount?: bigint;
  expiration?: bigint;
  sigDeadline?: bigint;
}): Permit2TypedData {
  return {
    domain: buildPermit2Domain(),
    types: PERMIT2_TYPED_DATA_TYPES,
    primaryType: 'PermitSingle',
    message: {
      details: {
        token: normalizeAddress(token),
        amount,
        expiration,
        nonce,
      },
      spender: normalizeAddress(spender),
      sigDeadline,
    },
  };
}

export function buildUsdtPermit2ApprovalTransaction({
  owner,
  amount = EVM_MAX_NUMBER,
}: {
  owner: string;
  amount?: bigint;
}): TransactionRequest {
  return {
    from: normalizeAddress(owner),
    to: ETHEREUM_USDT_ADDRESS,
    value: 0n,
    data: erc20Interface.encodeFunctionData('approve', [PERMIT2_ADDRESS, amount]),
  };
}

export function buildPermit2TransferFromTransaction({
  from,
  to,
  token = ETHEREUM_USDT_ADDRESS,
  amount,
}: {
  from: string;
  to: string;
  token?: string;
  amount: bigint;
}): TransactionRequest {
  return {
    from: normalizeAddress(from),
    to: PERMIT2_ADDRESS,
    value: 0n,
    data: permit2Interface.encodeFunctionData('transferFrom', [
      normalizeAddress(from),
      normalizeAddress(to),
      amount,
      normalizeAddress(token),
    ]),
  };
}

export function buildPermit2PermitTransaction({
  owner,
  permit,
  signature,
}: {
  owner: string;
  permit: Permit2TypedData;
  signature: string;
}): TransactionRequest {
  return {
    to: PERMIT2_ADDRESS,
    value: 0n,
    data: permit2Interface.encodeFunctionData('permit', [
      normalizeAddress(owner),
      [
        [
          normalizeAddress(permit.message.details.token),
          permit.message.details.amount,
          permit.message.details.expiration,
          permit.message.details.nonce,
        ],
        normalizeAddress(permit.message.spender),
        permit.message.sigDeadline,
      ],
      signature,
    ]),
  };
}

export async function fetchPermit2Allowance(
  chain: EVMChain,
  network: ApiNetwork,
  owner: string,
  spender: string,
): Promise<Permit2AllowanceStatus> {
  assertEthereumMainnet(chain, network);

  const normalizedOwner = normalizeAddress(owner);
  const normalizedSpender = normalizeAddress(spender);
  const normalizedToken = normalizeAddress(ETHEREUM_USDT_ADDRESS);
  const provider = getEvmProvider(network, chain);
  const tokenContract = new Contract(normalizedToken, ERC20_ABI, provider);
  const permit2Contract = new Contract(PERMIT2_ADDRESS, PERMIT2_ABI, provider);

  const [tokenAllowance, permit2Allowance] = await Promise.all([
    tokenContract.allowance(normalizedOwner, PERMIT2_ADDRESS),
    permit2Contract.allowance(normalizedOwner, normalizedToken, normalizedSpender),
  ]);

  return {
    owner: normalizedOwner,
    token: normalizedToken,
    spender: normalizedSpender,
    tokenAllowance: BigInt(tokenAllowance.toString()),
    permit2Allowance: {
      amount: BigInt(permit2Allowance.amount.toString()),
      expiration: BigInt(permit2Allowance.expiration.toString()),
      nonce: BigInt(permit2Allowance.nonce.toString()),
    },
  };
}

export async function fetchPermit2AllowanceFromProvider(
  provider: Eip1193Provider,
  owner: string,
  spender: string,
): Promise<Permit2AllowanceStatus> {
  const browserProvider = new BrowserProvider(provider);
  const normalizedOwner = normalizeAddress(owner);
  const normalizedSpender = normalizeAddress(spender);
  const normalizedToken = normalizeAddress(ETHEREUM_USDT_ADDRESS);
  const tokenContract = new Contract(normalizedToken, ERC20_ABI, browserProvider);
  const permit2Contract = new Contract(PERMIT2_ADDRESS, PERMIT2_ABI, browserProvider);

  const [tokenAllowance, permit2Allowance] = await Promise.all([
    tokenContract.allowance(normalizedOwner, PERMIT2_ADDRESS),
    permit2Contract.allowance(normalizedOwner, normalizedToken, normalizedSpender),
  ]);

  return {
    owner: normalizedOwner,
    token: normalizedToken,
    spender: normalizedSpender,
    tokenAllowance: BigInt(tokenAllowance.toString()),
    permit2Allowance: {
      amount: BigInt(permit2Allowance.amount.toString()),
      expiration: BigInt(permit2Allowance.expiration.toString()),
      nonce: BigInt(permit2Allowance.nonce.toString()),
    },
  };
}

export async function submitPermit2ApprovalFromProvider(
  provider: Eip1193Provider,
  owner: string,
): Promise<ExternalPermit2Approval> {
  const browserProvider = new BrowserProvider(provider);
  const normalizedOwner = normalizeAddress(owner);
  const network = await browserProvider.getNetwork();
  if (network.chainId !== BigInt(ETHEREUM_MAINNET_CHAIN_ID)) {
    throw new Error('Permit2 is currently supported only on Ethereum mainnet');
  }

  const signer = await browserProvider.getSigner(normalizedOwner);
  const tokenContract = new Contract(ETHEREUM_USDT_ADDRESS, ERC20_ABI, signer);
  const currentAllowance = BigInt(
    (await tokenContract.allowance(normalizedOwner, PERMIT2_ADDRESS)).toString(),
  );

  if (currentAllowance !== 0n && currentAllowance !== EVM_MAX_NUMBER) {
    const resetResponse = await tokenContract.approve(PERMIT2_ADDRESS, 0n);
    await resetResponse.wait();
  }

  const response = await tokenContract.approve(PERMIT2_ADDRESS, EVM_MAX_NUMBER);
  await response.wait();

  return {
    txId: response.hash,
    allowance: BigInt(
      (await tokenContract.allowance(normalizedOwner, PERMIT2_ADDRESS)).toString(),
    ),
  };
}

export async function signAndSubmitPermit2AllowanceFromProvider(
  provider: Eip1193Provider,
  owner: string,
  spender: string = PERMIT2_OPERATOR_ADDRESS,
): Promise<ExternalPermit2Permission> {
  const browserProvider = new BrowserProvider(provider);
  const normalizedOwner = normalizeAddress(owner);
  const network = await browserProvider.getNetwork();
  if (network.chainId !== BigInt(ETHEREUM_MAINNET_CHAIN_ID)) {
    throw new Error('Permit2 is currently supported only on Ethereum mainnet');
  }

  const current = await fetchPermit2AllowanceFromProvider(provider, normalizedOwner, spender);
  const permit = buildPermit2AllowanceTypedData({
    spender,
    nonce: current.permit2Allowance.nonce,
  });
  const signer = await browserProvider.getSigner(normalizedOwner);
  const signature = await signer.signTypedData(permit.domain, permit.types, permit.message);
  const response = await signer.sendTransaction(buildPermit2PermitTransaction({
    owner: normalizedOwner,
    permit,
    signature,
  }));
  await response.wait();

  return {
    permit,
    signature,
    txId: response.hash,
  };
}

export async function submitPermit2Approval(
  chain: EVMChain,
  options: Permit2CommonOptions,
): Promise<{ txId: string } | { error: ApiAnyDisplayError }> {
  const { accountId, enclaveToken = '' } = options;
  const { network } = parseAccountId(accountId);

  try {
    assertEthereumMainnet(chain, network);

    const account = await fetchStoredChainAccount(accountId, chain);
    if (account.type === 'ledger') throw new Error('Not supported by Ledger accounts');
    if (account.type === 'view') throw new Error('Not supported by View accounts');

    const owner = account.byChain[chain].address;
    const provider = getEvmProvider(network, chain);
    const tokenContract = new Contract(ETHEREUM_USDT_ADDRESS, ERC20_ABI, provider);
    const currentAllowance = BigInt((await tokenContract.allowance(owner, PERMIT2_ADDRESS)).toString());

    const privateKey = await fetchPrivateKeyString(chain, accountId, enclaveToken, account);
    if (!privateKey) return { error: ApiCommonError.InvalidPassword };

    const signer = getSignerFromPrivateKey(network, privateKey).connect(provider);
    const approval = buildUsdtPermit2ApprovalTransaction({ owner });

    if (currentAllowance !== 0n && currentAllowance !== EVM_MAX_NUMBER) {
      const reset = await signer.sendTransaction(buildUsdtPermit2ApprovalTransaction({ owner, amount: 0n }));
      await reset.wait();
    }

    const [nativeBalance, fee] = await Promise.all([
      getWalletBalance(chain, network, owner),
      estimateEvmFee(provider, approval),
    ]);

    if (nativeBalance < fee) {
      return { error: ApiTransactionError.InsufficientBalance };
    }

    const response = await signer.sendTransaction(approval);

    return { txId: response.hash };
  } catch (err) {
    logDebugError(`evm:${chain}:submitPermit2Approval`, err);

    if (err instanceof Error && err.message.includes('Ethereum mainnet')) {
      return { error: ApiTransactionError.WrongNetwork };
    }

    return { error: ApiTransactionError.UnsuccesfulTransfer };
  }
}

export async function signPermit2Allowance(
  chain: EVMChain,
  options: Permit2SignOptions,
): Promise<{ owner: string; permit: Permit2TypedData; signature: string } | { error: ApiAnyDisplayError }> {
  const {
    accountId,
    enclaveToken,
    spender,
    token,
    amount,
    expiration,
    sigDeadline,
  } = options;
  const { network } = parseAccountId(accountId);

  try {
    assertEthereumMainnet(chain, network);

    const account = await fetchStoredChainAccount(accountId, chain);
    if (account.type === 'ledger') throw new Error('Not supported by Ledger accounts');
    if (account.type === 'view') throw new Error('Not supported by View accounts');

    const owner = normalizeAddress(account.byChain[chain].address);
    const current = await fetchPermit2Allowance(chain, network, owner, spender);
    const permit = buildPermit2AllowanceTypedData({
      token,
      spender,
      nonce: current.permit2Allowance.nonce,
      amount,
      expiration,
      sigDeadline,
    });

    if (enclaveToken === undefined) return { error: ApiCommonError.InvalidPassword };

    const privateKey = await fetchPrivateKeyString(chain, accountId, enclaveToken, account);
    if (!privateKey) return { error: ApiCommonError.InvalidPassword };

    const signer = getSignerFromPrivateKey(network, privateKey);
    const signature = await signer.signTypedData(permit.domain, permit.types, permit.message);

    return { owner, permit, signature };
  } catch (err) {
    logDebugError(`evm:${chain}:signPermit2Allowance`, err);

    if (err instanceof Error && err.message.includes('Ethereum mainnet')) {
      return { error: ApiTransactionError.WrongNetwork };
    }

    return { error: ApiCommonError.Unexpected };
  }
}
