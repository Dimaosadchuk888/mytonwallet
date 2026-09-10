import { networkInfo, verifyDepositEvent } from './deposits.mjs';

/**
 * Shared worker entry point. Providers only discover/normalize events; this
 * function is the sole path that can request a balance mutation.
 */
export async function processDepositEvent({
  event, intent, supabase, authorizedClaim = false,
}) {
  if (typeof supabase !== 'function') throw new Error('supabase worker client is required');
  const checked = verifyDepositEvent(event, { network: intent?.network, intent, authorizedClaim });
  if (!checked.ok) return checked;
  const config = networkInfo(intent.network);
  const rows = await supabase('rpc/internal_credit_deposit_by_intent', {
    method: 'POST',
    body: JSON.stringify({ p_intent_id: intent.id, p_tx_hash: checked.txHash,
      p_raw_amount: checked.rawAmount, p_decimals: config.decimals, p_asset: config.asset }),
  });
  return { ok: rows === true || rows?.[0] === true || rows?.[0]?.internal_credit_deposit_by_intent === true,
    txHash: checked.txHash };
}

export async function processPendingClaim({ claim, event, supabase }) {
  if (!claim?.intent_id || !event || claim.network !== event.network
    || String(claim.tx_hash) !== String(event.txHash || event.transactionHash || event.signature)) {
    return { ok: false, reason: 'claim_event_mismatch' };
  }
  const result = await processDepositEvent({ event, intent: {
    id: claim.intent_id, network: claim.network, status: 'pending',
    reference: claim.reference, sender: claim.sender, expiresAt: claim.expires_at,
   }, supabase, authorizedClaim: true });
  if (result.ok) {
    await supabase(`internal_deposit_claims?id=eq.${encodeURIComponent(claim.id)}`, {
      method: 'PATCH', headers: { prefer: 'return=minimal' }, body: JSON.stringify({ status: 'accepted' }),
    });
  } else {
    await supabase(`internal_deposit_claims?id=eq.${encodeURIComponent(claim.id)}`, {
      method: 'PATCH', headers: { prefer: 'return=minimal' },
      body: JSON.stringify({ status: result.reason === 'provider_error' ? 'pending' : 'rejected' }),
    });
  }
  return result;
}

export async function runPendingClaims({
  supabase, verifierUrl = process.env.DEPOSIT_VERIFIER_URL, limit = 25,
} = {}) {
  if (!verifierUrl || typeof supabase !== 'function') return [];
  const claims = await supabase(`internal_deposit_claims?status=eq.pending&select=id,intent_id,network,tx_hash,internal_deposit_intents(reference,sender,expires_at)&order=created_at.asc&limit=${limit}`);
  const results = [];
  for (const claim of claims || []) {
    const response = await fetch(verifierUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ network: claim.network, transactionHash: claim.tx_hash }),
    });
    if (!response.ok) {
      results.push({ ok: false, reason: 'provider_error' });
      continue;
    }
    const event = await response.json();
    const intent = claim.internal_deposit_intents || {};
    results.push(await processPendingClaim({
      claim: { ...claim, ...intent },
      event,
      supabase,
    }));
  }
  return results;
}
