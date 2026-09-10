/**
 * The only source of truth for internal deposit destinations.  This module is
 * deliberately dependency-free so it can also be used by workers and tests.
 */
export const DEPOSIT_NETWORKS = Object.freeze({
  ethereum: Object.freeze({
    id: 'ethereum', name: 'Ethereum', address: '0x13dafa7348873f5fd2ca0ca89f0b28143888ec3a',
    asset: 'USDT', tokenStandard: 'ERC-20', decimals: 6, confirmations: 12,
    tokenContract: process.env.ETHEREUM_USDT_CONTRACT || null,
  }),
  ton: Object.freeze({
    id: 'ton', name: 'TON', address: 'UQDcOfkpDEWZaqsIupryExPtDyJWAInk2wwHydkCv6LcFThu',
    asset: 'TON', tokenStandard: 'native', decimals: 9, confirmations: 1,
  }),
  solana: Object.freeze({
    id: 'solana', name: 'Solana', address: '4m94e2MzH5ydhEoqLquc1QtPkAkPFE7pFLZmvvNXSd6J',
    asset: 'USDC', tokenStandard: 'SPL', decimals: 6, confirmations: 32,
    tokenContract: process.env.SOLANA_USDC_MINT || null,
  }),
  tron: Object.freeze({
    id: 'tron', name: 'TRON', address: 'TTjd2f7NLRpFcKRQCR8ciPUwp4HusY4hym',
    asset: 'USDT', tokenStandard: 'TRC-20', decimals: 6, confirmations: 19,
    tokenContract: process.env.TRON_USDT_CONTRACT || null,
  }),
});

export function validateDepositRegistry(registry = DEPOSIT_NETWORKS) {
  const required = ['ethereum', 'ton', 'solana', 'tron'];
  for (const network of required) {
    const item = registry[network];
    if (!item?.address || !item.asset || !Number.isInteger(item.decimals)
      || !Number.isInteger(item.confirmations) || item.confirmations < 1) {
      throw new Error(`Invalid deposit registry entry: ${network}`);
    }
  }
  if (!/^0x[0-9a-f]{40}$/.test(registry.ethereum.address)) throw new Error('Invalid Ethereum deposit address');
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(registry.solana.address)) throw new Error('Invalid Solana deposit address');
  if (!/^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(registry.tron.address)) throw new Error('Invalid TRON deposit address');
  if (!registry.ton.address.startsWith('UQ')) throw new Error('Invalid TON deposit address');
  if (process.env.ETHEREUM_MONITOR_ENABLED === '1' && !registry.ethereum.tokenContract) throw new Error('ETHEREUM_USDT_CONTRACT is required');
  if (process.env.SOLANA_MONITOR_ENABLED === '1' && !registry.solana.tokenContract) throw new Error('SOLANA_USDC_MINT is required');
  if (process.env.TRON_MONITOR_ENABLED === '1' && !registry.tron.tokenContract) throw new Error('TRON_USDT_CONTRACT is required');
  return true;
}
validateDepositRegistry();

export function networkInfo(network) {
  return DEPOSIT_NETWORKS[String(network || '').toLowerCase()];
}

/**
 * Provider adapters must normalize into this shape before crediting.  The
 * verifier intentionally ignores client supplied amount and recipient data.
 */
export function verifyDepositEvent(event, {
  network, intent, now = Date.now(), authorizedClaim = false,
} = {}) {
  const config = networkInfo(network);
  if (!config || !event || !intent) return { ok: false, reason: 'invalid_request' };
  if (config.tokenStandard !== 'native' && !config.tokenContract) return { ok: false, reason: 'asset_allowlist_not_configured' };
  if (String(event.network).toLowerCase() !== config.id) return { ok: false, reason: 'wrong_network' };
  if (!event.txHash || event.success !== true || event.finalized !== true) return { ok: false, reason: 'not_final' };
  if (!Number.isInteger(Number(event.confirmations))
    || Number(event.confirmations) < config.confirmations) return { ok: false, reason: 'insufficient_confirmations' };
  if (String(event.recipient || '').toLowerCase() !== config.address.toLowerCase()) return { ok: false, reason: 'wrong_recipient' };
  if (String(event.asset || '').toUpperCase() !== config.asset.toUpperCase()
    || String(event.tokenStandard || '').toUpperCase() !== config.tokenStandard.toUpperCase()) return { ok: false, reason: 'unsupported_asset' };
  if (!/^\d+$/.test(String(event.rawAmount || '')) || BigInt(event.rawAmount) <= 0) return { ok: false, reason: 'invalid_amount' };
  if (Number(event.decimals) !== config.decimals) return { ok: false, reason: 'invalid_decimals' };
  if (config.tokenContract && String(event.tokenContract || '').toLowerCase() !== config.tokenContract.toLowerCase()) return { ok: false, reason: 'wrong_token_contract' };
  if (intent.network !== config.id || intent.status === 'rejected' || intent.status === 'credited') return { ok: false, reason: 'invalid_intent' };
  if (intent.expiresAt && new Date(intent.expiresAt).getTime() < now) return { ok: false, reason: 'expired_intent' };
  if (intent.sender && event.sender && String(intent.sender).toLowerCase() !== String(event.sender).toLowerCase()) return { ok: false, reason: 'sender_mismatch' };
  if (intent.reference && event.reference !== intent.reference) return { ok: false, reason: 'reference_mismatch' };
  // Broad polling must never guess the owner of a memo-less transfer. An
  // authenticated hash claim is an explicit attribution method allowed by the
  // deposit contract, but transaction facts still come only from the verifier.
  if (config.id !== 'ton' && !authorizedClaim
    && (!intent.sender || !event.sender)) return { ok: false, reason: 'sender_required' };
  return { ok: true, network: config.id, txHash: String(event.txHash), rawAmount: String(event.rawAmount), decimals: config.decimals };
}
