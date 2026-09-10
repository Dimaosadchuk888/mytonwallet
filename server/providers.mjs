import { DEPOSIT_NETWORKS, verifyDepositEvent } from './deposits.mjs';

const rpc = async (url, payload, headers = {}) => {
  const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(payload) });
  if (!response.ok) throw new Error(`Provider request failed (${response.status})`);
  return response.json();
};

// Adapters accept provider-shaped records, making the security checks shared
// by polling and transaction-claim workers (and straightforward to fixture).
export function ethereumEvent(log, intent) {
  return verifyDepositEvent({ network: 'ethereum', txHash: log?.txHash || log?.transactionHash,
    success: log?.success === true, finalized: log?.finalized === true,
    confirmations: log?.confirmations, recipient: log?.recipient, sender: log?.sender,
    asset: 'USDT', tokenStandard: 'ERC-20', tokenContract: log?.tokenContract,
    rawAmount: log?.rawAmount, decimals: log?.decimals, reference: log?.reference }, { network: 'ethereum', intent });
}
export function tonEvent(tx, intent) {
  return verifyDepositEvent({ network: 'ton', txHash: tx?.txHash || tx?.hash, success: tx?.success === true,
    finalized: tx?.finalized === true, confirmations: tx?.confirmations, recipient: tx?.recipient,
    sender: tx?.sender, asset: 'TON', tokenStandard: 'native', rawAmount: tx?.rawAmount || tx?.amount,
    decimals: tx?.decimals, reference: tx?.reference || tx?.comment }, { network: 'ton', intent });
}
export function solanaEvent(tx, intent) {
  return verifyDepositEvent({ network: 'solana', txHash: tx?.txHash || tx?.signature,
    success: tx?.success === true, finalized: tx?.finalized === true, confirmations: tx?.confirmations,
    recipient: tx?.recipient, sender: tx?.sender, asset: 'USDC', tokenStandard: 'SPL',
    tokenContract: tx?.tokenContract || tx?.mint, rawAmount: tx?.rawAmount, decimals: tx?.decimals,
    reference: tx?.reference }, { network: 'solana', intent });
}
export function tronEvent(tx, intent) {
  return verifyDepositEvent({ network: 'tron', txHash: tx?.txHash || tx?.transactionHash,
    success: tx?.success === true, finalized: tx?.finalized === true, confirmations: tx?.confirmations,
    recipient: tx?.recipient, sender: tx?.sender, asset: 'USDT', tokenStandard: 'TRC-20',
    tokenContract: tx?.tokenContract, rawAmount: tx?.rawAmount, decimals: tx?.decimals,
    reference: tx?.reference }, { network: 'tron', intent });
}

const adapters = { ethereum: ethereumEvent, ton: tonEvent, solana: solanaEvent, tron: tronEvent };

/**
 * Resolves an authenticated transaction claim. The provider response is the
 * sole source of transaction facts; the client contributes only its hash.
 * The credit callback must call the database atomic credit RPC.
 */
export async function processDepositClaim({
  claim, intent, fetchTransaction, credit, reject = async () => undefined,
} = {}) {
  if (!claim || !intent || claim.intentId !== intent.id || claim.network !== intent.network) {
    return { ok: false, reason: 'foreign_intent' };
  }
  const adapter = adapters[claim.network];
  if (!adapter || typeof fetchTransaction !== 'function' || typeof credit !== 'function') {
    return { ok: false, reason: 'invalid_request' };
  }
  let transaction;
  try {
    transaction = await fetchTransaction(claim.txHash, claim.network);
  } catch {
    return { ok: false, reason: 'provider_error' };
  }
  const verified = adapter(transaction, intent);
  if (!verified.ok || verified.txHash !== claim.txHash) {
    const reason = verified.ok ? 'hash_mismatch' : verified.reason;
    await reject(claim, reason);
    return { ok: false, reason };
  }
  const credited = await credit(verified, intent);
  return { ok: Boolean(credited), reason: credited ? undefined : 'duplicate_or_conflict' };
}

export async function pollEthereum({ rpcUrl = process.env.ETHEREUM_RPC_URL, fromBlock, toBlock } = {}) {
  if (!rpcUrl) throw new Error('ETHEREUM_RPC_URL is required');
  return rpc(rpcUrl, { jsonrpc: '2.0', id: 1, method: 'eth_getLogs', params: [{ fromBlock, toBlock, address: DEPOSIT_NETWORKS.ethereum.tokenContract }] });
}
export async function pollSolana({ rpcUrl = process.env.SOLANA_RPC_URL || process.env.SOLANA_MAINNET_API_URL, cursor } = {}) {
  if (!rpcUrl) throw new Error('SOLANA_RPC_URL is required');
  return rpc(rpcUrl, { jsonrpc: '2.0', id: 1, method: 'getSignaturesForAddress', params: [DEPOSIT_NETWORKS.solana.address, { until: cursor }] });
}
export async function pollTron({ apiUrl = process.env.TRON_RPC_URL, cursor } = {}) {
  if (!apiUrl) throw new Error('TRON_RPC_URL is required');
  const response = await fetch(`${apiUrl.replace(/\/$/, '')}/v1/accounts/${DEPOSIT_NETWORKS.tron.address}/transactions/trc20?limit=200${cursor ? `&fingerprint=${encodeURIComponent(cursor)}` : ''}`);
  if (!response.ok) throw new Error(`TRON provider request failed (${response.status})`);
  return response.json();
}
export async function pollTon({ apiUrl = process.env.TONCENTER_API_URL, apiKey = process.env.TONCENTER_API_KEY, offset = 0 } = {}) {
  if (!apiUrl || !apiKey) throw new Error('TON provider settings are required');
  const url = new URL('/api/v3/transactions', apiUrl);
  url.searchParams.set('account', DEPOSIT_NETWORKS.ton.address); url.searchParams.set('limit', '100'); url.searchParams.set('offset', String(offset));
  const response = await fetch(url, { headers: { 'X-API-Key': apiKey } });
  if (!response.ok) throw new Error(`TON provider request failed (${response.status})`);
  return response.json();
}