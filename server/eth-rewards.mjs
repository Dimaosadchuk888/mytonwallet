import { generateRewardCheckCode } from './rewards.mjs';

async function supabase(path, options = {}) {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    throw Object.assign(new Error('Supabase is not configured'), { status: 503 });
  }

  const response = await fetch(`${process.env.SUPABASE_URL}/rest/v1/${path}`, {
    ...options,
    headers: {
      apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
      authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
      'content-type': 'application/json',
      ...(options.headers || {}),
    },
  });

  if (!response.ok) {
    throw Object.assign(new Error(`Supabase request failed (${response.status})`), {
      status: response.status,
    });
  }

  const text = await response.text();
  return text ? JSON.parse(text) : undefined;
}

function mapCheck(row) {
  return {
    id: row.id,
    title: row.title,
    code: row.code,
    asset: 'ETH',
    amount_per_claim: String(row.amount_per_claim),
    max_claims: row.max_claims,
    claimed_count: row.claimed_count,
    active: row.active,
    expires_at: row.expires_at,
    creator_telegram_id: row.creator_telegram_id,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export async function listEthRewardChecks() {
  const rows = await supabase(
    'internal_ton_reward_checks?select=id,title,code,asset,amount_per_claim,max_claims,claimed_count,active,expires_at,creator_telegram_id,created_at,updated_at&asset=eq.ETH&order=created_at.desc',
    { headers: { accept: 'application/json' } },
  );
  return (rows || []).map(mapCheck);
}

export async function createEthRewardCheck({
  title, amountPerClaim, maxClaims, creatorTelegramId, expiresAt,
}) {
  const code = `eth_${generateRewardCheckCode()}`;
  const rows = await supabase('internal_ton_reward_checks', {
    method: 'POST',
    headers: { accept: 'application/json', prefer: 'return=representation' },
    body: JSON.stringify({
      title,
      code,
      asset: 'ETH',
      amount_per_claim: amountPerClaim,
      max_claims: maxClaims,
      creator_telegram_id: creatorTelegramId,
      expires_at: expiresAt,
    }),
  });
  return mapCheck(rows?.[0]);
}

export async function disableEthRewardCheck(id) {
  const rows = await supabase(`internal_ton_reward_checks?id=eq.${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { accept: 'application/json', prefer: 'return=representation' },
    body: JSON.stringify({ active: false, updated_at: new Date().toISOString() }),
  });
  return rows?.[0] ? mapCheck(rows[0]) : undefined;
}

export async function getEthBalance(telegramId) {
  const rows = await supabase('rpc/internal_eth_get_balance', {
    method: 'POST',
    body: JSON.stringify({ p_telegram_id: telegramId }),
  });
  return String(rows?.[0]?.amount ?? '0');
}

export async function claimEthReward(code, telegramId) {
  if (!code.startsWith('eth_')) return undefined;

  const rows = await supabase('rpc/internal_ton_claim_reward_v2', {
    method: 'POST',
    body: JSON.stringify({ p_code: code, p_telegram_id: telegramId }),
  });
  const claim = rows?.[0];
  return claim && {
    status: claim.status,
    amount: claim.amount || undefined,
    title: claim.title || undefined,
    balance: claim.resulting_balance || undefined,
    asset: claim.asset || 'ETH',
  };
}