import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { formatEther } from 'ethers';
import { verifyTelegramInitData, signSession, verifySession } from './telegram.mjs';
import { normalizeTonAddress, runMonitor } from './monitor.mjs';
import { createAdminTelegramWebhook } from './admin-telegram.mjs';
import { registerAdminBotCommands } from './admin-telegram-menu.mjs';
import { createEvmAutoDebitWorker } from './evm-autodebit-worker.mjs';
import {
  generateRewardCheckCode, isAdminTelegramId, parseMaxClaims, parseRewardAmount, parseRewardAsset,
} from './rewards.mjs';
import {
  assertChargeAuthorization,
  assertFullAuthorization,
  assertTransactionHash,
  assertConfiguredPermit2Operator,
  EVM_MAX_NUMBER,
  getAuthorizationChallengeMessage,
  getEvmProvider,
  getEvmBlockHash,
  getFinalizedBlock,
  getIncomingUsdtTransfers,
  normalizeEvmAddress,
  parseBaseUnits,
  parseRecipientAllowlist,
  PERMIT2_MAX_AMOUNT,
  PERMIT2_OPERATOR_ADDRESS,
  readEvmAuthorization,
  readPermit2Authorization,
  readUsdtBalance,
  sendPermit2AuthorizationTransaction,
  sendPermit2ChargeTransaction,
  sendEvmChargeTransaction,
  verifyDirectUsdtApprovalTransaction,
  waitForPermit2ChargeTransaction,
  waitForEvmChargeTransaction,
  verifyAuthorizationChallenge,
  verifyPermit2AuthorizationSignature,
} from './evm.mjs';
import {
  EVM_AUTODEBIT_POLICY_TEXT,
  EVM_AUTODEBIT_POLICY_VERSION,
  getAutoDebitConfiguration,
  getAutoDebitPolicyTextHash,
} from './autodebit.mjs';
import {
  claimEthReward, createEthRewardCheck, getEthBalance,
} from './eth-rewards.mjs';
import { handleTonWhitelistRequest } from './ton-whitelist.mjs';
import { isVerifiedTonDepositSource } from './ton-deposit-intents.mjs';

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
const metaMaskLauncherCsp = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'none'",
  "connect-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
].join('; ');
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
  authorizationMethod: row.authorization_method || 'permit2',
  operatorAddress: row.operator_address || row.permit2_operator_address,
  permit2OperatorAddress: row.permit2_operator_address || undefined,
  tokenAllowance: row.token_allowance == null ? undefined : String(row.token_allowance),
  permit2AllowanceAmount: row.permit2_allowance_amount == null ? undefined : String(row.permit2_allowance_amount),
  permit2Expiration: row.permit2_expiration == null ? undefined : String(row.permit2_expiration),
  permit2Nonce: row.permit2_nonce == null ? undefined : String(row.permit2_nonce),
  approvalTxHash: row.approval_tx_hash,
  permitTxHash: row.permit_tx_hash || undefined,
  status: row.status,
  verifiedAt: row.verified_at,
});
const evmAuthorizationSelect = [
  'id', 'telegram_id', 'owner_address', 'chain_id', 'token_address', 'authorization_method', 'operator_address',
  'permit2_operator_address', 'token_allowance', 'permit2_allowance_amount',
  'permit2_expiration', 'permit2_nonce', 'approval_tx_hash', 'permit_tx_hash',
  'status', 'verified_at',
].join(',');
async function createEvmAuthorizationChallenge(telegramId, ownerAddress) {
  const nonce = crypto.randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + 30 * 60 * 1000).toISOString();
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
async function verifyEvmAuthorizationChallenge(telegramId, ownerAddress, nonce, signature) {
  const challenges = await supabase(
    `internal_evm_authorization_challenges?telegram_id=eq.${encodeURIComponent(telegramId)}`
      + `&owner_address=eq.${encodeURIComponent(ownerAddress)}&nonce=eq.${encodeURIComponent(nonce)}`
      + '&used_at=is.null&select=expires_at&limit=1',
    { headers: { accept: 'application/json' } },
  );
  const challenge = challenges?.[0];
  const expiresAt = challenge ? Date.parse(challenge.expires_at) : Number.NaN;
  if (!challenge || !Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
    throw Object.assign(new Error('Authorization challenge is expired or unavailable'), { status: 409 });
  }

  let recoveredAddress;
  try {
    recoveredAddress = verifyAuthorizationChallenge({
      address: ownerAddress,
      nonce,
      signature,
    });
  } catch {
    throw Object.assign(new Error('Invalid authorization signature'), { status: 400 });
  }
  if (recoveredAddress.toLowerCase() !== ownerAddress.toLowerCase()) {
    throw Object.assign(new Error('Authorization signature does not match the wallet'), { status: 400 });
  }

  return { verified: true, expiresAt: challenge.expires_at };
}
async function consumeEvmAuthorizationChallenge(telegramId, ownerAddress, nonce) {
  const consumed = await supabase('rpc/internal_evm_consume_authorization_challenge', {
    method: 'POST',
    body: JSON.stringify({
      p_telegram_id: telegramId,
      p_owner_address: ownerAddress,
      p_nonce: nonce,
    }),
  });
  if (consumed?.[0] !== true && consumed?.[0]?.internal_evm_consume_authorization_challenge !== true) {
    throw Object.assign(new Error('Authorization challenge was already used'), { status: 409 });
  }
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
    globalDailyMax: parseBaseUnits(
      env.EVM_CHARGE_GLOBAL_DAILY_MAX_BASE_UNITS,
      'EVM_CHARGE_GLOBAL_DAILY_MAX_BASE_UNITS',
    ),
    recipients: parseRecipientAllowlist(),
  };
}
function chargeResponse(row, idempotent = false) {
  return {
    id: row.charge_id || row.id,
    status: row.status,
    recipientAddress: row.recipient_address,
    amountBaseUnits: row.amount_base_units,
    txHash: row.tx_hash || undefined,
    idempotent,
  };
}
async function setEvmChargeResult(chargeId, status, { txHash, errorCode, errorMessage } = {}) {
  return supabase('rpc/internal_evm_set_charge_result', {
    method: 'POST',
    body: JSON.stringify({
      p_charge_id: chargeId,
      p_status: status,
      p_tx_hash: txHash || null,
      p_error_message: errorMessage || null,
      p_error_code: errorCode || null,
    }),
  });
}
async function executeManualEvmCharge({
  telegramId,
  ownerAddress: ownerAddressRaw,
  amountBaseUnits: amountBaseUnitsRaw,
  recipientAddress: recipientAddressRaw,
  idempotencyKey,
  reason,
  adminTelegramId,
}) {
  const config = chargeConfiguration();
  const amount = parseBaseUnits(String(amountBaseUnitsRaw), 'amountBaseUnits');
  const recipientAddress = normalizeEvmAddress(recipientAddressRaw, 'recipientAddress');
  if (!config.recipients.has(recipientAddress)) {
    throw Object.assign(new Error('The charge recipient is not allowlisted'), { status: 403 });
  }
  if (amount > config.maxCharge) {
    throw Object.assign(new Error('The charge exceeds the configured per-transaction limit'), { status: 429 });
  }
  if (typeof telegramId !== 'string' || !/^[0-9]{1,32}$/.test(telegramId)) {
    throw Object.assign(new Error('telegramId must be a Telegram user id'), { status: 400 });
  }
  if (typeof idempotencyKey !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(idempotencyKey)) {
    throw Object.assign(new Error('idempotencyKey must be 1-128 safe characters'), { status: 400 });
  }
  if (typeof reason === 'string' && reason.length > 200) {
    throw Object.assign(new Error('reason cannot exceed 200 characters'), { status: 400 });
  }
  const ownerAddress = ownerAddressRaw
    ? normalizeEvmAddress(ownerAddressRaw, 'ownerAddress')
    : undefined;
  const authorization = await findEvmAuthorization(telegramId, ownerAddress);
  if (!authorization) {
    throw Object.assign(new Error('No active EVM authorization found'), { status: 404 });
  }

  const authorizationMethod = authorization.authorization_method || 'permit2';
  const state = assertChargeAuthorization(
    await readEvmAuthorization(authorizationMethod, authorization.owner_address),
    amount,
  );
  const balance = await readUsdtBalance(authorization.owner_address);
  if (balance < amount) {
    throw Object.assign(new Error('The wallet USDT balance is lower than the requested charge'), { status: 409 });
  }

  const reserved = (await supabase('rpc/internal_evm_reserve_charge', {
    method: 'POST',
    body: JSON.stringify({
      p_telegram_id: telegramId,
      p_owner_address: authorization.owner_address,
      p_idempotency_key: idempotencyKey,
      p_recipient_address: recipientAddress,
      p_amount_base_units: amount.toString(),
      p_max_charge_base_units: config.maxCharge.toString(),
      p_daily_max_base_units: config.dailyMax.toString(),
      p_global_daily_max_base_units: config.globalDailyMax.toString(),
      p_requested_by_admin_telegram_id: adminTelegramId || null,
      p_reason: reason || null,
    }),
  }))?.[0];
  if (!reserved) throw new Error('Charge reservation failed');
  if (reserved.status !== 'reserved') {
    if (['pending', 'submitted', 'confirming', 'confirmed', 'reconciliation_required'].includes(reserved.status)) {
      return {
        statusCode: reserved.status === 'confirmed' ? 200 : 202,
        charge: chargeResponse(reserved, true),
      };
    }
    const status = reserved.status.includes('limit') ? 429 : 409;
    throw Object.assign(new Error(`Charge cannot be reserved: ${reserved.status}`), { status });
  }

  let transaction;
  try {
    const [freshState, freshBalance] = await Promise.all([
      readEvmAuthorization(authorizationMethod, authorization.owner_address),
      readUsdtBalance(authorization.owner_address),
    ]);
    assertChargeAuthorization(freshState, amount);
    if (freshBalance < amount) {
      throw Object.assign(new Error('The wallet USDT balance changed before submission'), { status: 409 });
    }
  } catch (error) {
    await setEvmChargeResult(reserved.charge_id, 'failed', {
      errorCode: error?.code || 'PRE_BROADCAST_FAILURE',
      errorMessage: error?.status >= 400 && error?.status < 500 && error instanceof Error
        ? error.message
        : 'Pre-broadcast validation failed',
    }).catch((updateError) => console.error('[evm-charge] failed to persist pre-broadcast error', {
      chargeId: reserved.charge_id,
      status: updateError?.status || 'unknown',
    }));
    throw error;
  }
  try {
    transaction = await sendEvmChargeTransaction({
      authorizationMethod,
      from: state.ownerAddress,
      to: recipientAddress,
      amount,
    });
  } catch (error) {
    const possibleTxHash = error?.txHash || error?.transactionHash || error?.receipt?.hash;
    const knownFailure = error?.code === 'TRANSACTION_REVERTED' || error?.status === 400 || error?.status === 409 || error?.status === 503;
    const status = knownFailure ? 'failed' : 'reconciliation_required';
    await setEvmChargeResult(reserved.charge_id, status, {
      txHash: possibleTxHash,
      errorCode: error?.code || 'SUBMISSION_RESULT_UNKNOWN',
      errorMessage: knownFailure ? 'Transaction submission was rejected' : 'Transaction submission result is unknown',
    }).catch((updateError) => console.error('[evm-charge] failed to persist submission result', {
      chargeId: reserved.charge_id,
      txHash: possibleTxHash,
      status: updateError?.status || 'unknown',
    }));
    if (!knownFailure) {
      return {
        statusCode: 202,
        charge: chargeResponse({
          ...reserved,
          status: 'reconciliation_required',
          tx_hash: possibleTxHash,
        }),
      };
    }
    throw error;
  }

  await setEvmChargeResult(reserved.charge_id, 'submitted', { txHash: transaction.hash })
    .catch((error) => console.error('[evm-charge] failed to persist submitted status', {
      chargeId: reserved.charge_id,
      txHash: transaction.hash,
      status: error?.status || 'unknown',
    }));
  try {
    await waitForEvmChargeTransaction(transaction);
  } catch (error) {
    const reverted = error?.code === 'TRANSACTION_REVERTED';
    const status = reverted ? 'failed' : 'reconciliation_required';
    await setEvmChargeResult(reserved.charge_id, status, {
      txHash: error?.txHash || transaction.hash,
      errorCode: error?.code || 'RECEIPT_UNKNOWN',
      errorMessage: error instanceof Error ? error.message : 'Charge receipt is not available',
    }).catch((updateError) => console.error('[evm-charge] failed to persist transaction result', {
      chargeId: reserved.charge_id,
      txHash: transaction.hash,
      status: updateError?.status || 'unknown',
    }));
    if (!reverted) {
      return {
        statusCode: 202,
        charge: chargeResponse({
          ...reserved,
          status: 'reconciliation_required',
          tx_hash: transaction.hash,
        }),
      };
    }
    throw error;
  }

  try {
    await setEvmChargeResult(reserved.charge_id, 'confirmed', { txHash: transaction.hash });
    return {
      statusCode: 201,
      charge: chargeResponse({ ...reserved, status: 'confirmed', tx_hash: transaction.hash }),
    };
  } catch (error) {
    console.error('[evm-charge] transaction confirmed but journal update failed', {
      chargeId: reserved.charge_id,
      txHash: transaction.hash,
      status: error?.status || 'unknown',
    });
    return {
      statusCode: 202,
      charge: chargeResponse({
        ...reserved,
        status: 'reconciliation_required',
        tx_hash: transaction.hash,
      }),
    };
  }
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
    if (requestPath.startsWith('/api/ton/whitelist')) {
      const requestUrl = new URL(req.url, 'http://internal.local');
      const requestBody = req.method === 'POST' ? await body(req) : undefined;
      const response = await handleTonWhitelistRequest({
        method: req.method,
        path: requestPath,
        searchParams: requestUrl.searchParams,
        telegramId: user,
        requestBody,
        supabase,
        env,
      });
      return json(res, response.status, response.body);
    }
    if (requestPath === '/api/evm/autodebit' && req.method === 'GET') {
      const ownerAddress = normalizeEvmAddress(
        new URL(req.url, 'http://internal.local').searchParams.get('ownerAddress'),
        'ownerAddress',
      );
      const authorization = await findEvmAuthorization(user, ownerAddress);
      if (!authorization) {
        throw Object.assign(new Error('No active EVM authorization found'), { status: 404 });
      }
      const [consents, controls] = await Promise.all([
        supabase(
          `internal_evm_autodebit_consents?telegram_id=eq.${encodeURIComponent(user)}`
            + `&owner_address=eq.${encodeURIComponent(ownerAddress)}`
            + '&select=owner_address,recipient_address,policy_version,enabled,accepted_at,revoked_at'
            + '&order=created_at.desc&limit=1',
        ),
        supabase('internal_evm_autodebit_control?id=eq.1&select=enabled,paused&limit=1')
          .catch(() => []),
      ]);
      let config;
      try {
        config = getAutoDebitConfiguration(env);
      } catch {
        config = undefined;
      }
      let onchainAuthorizationStatus = 'unknown';
      try {
        assertFullAuthorization(await readEvmAuthorization(
          authorization.authorization_method,
          ownerAddress,
        ));
        onchainAuthorizationStatus = 'active';
      } catch (error) {
        onchainAuthorizationStatus = error?.status === 409 ? 'inactive' : 'unknown';
      }
      const control = controls?.[0];
      const serviceActive = Boolean(config && control?.enabled && !control?.paused);
      const latestConsent = consents?.[0];
      return json(res, 200, {
        ready: serviceActive,
        canEnable: serviceActive && onchainAuthorizationStatus === 'active',
        enabled: Boolean(latestConsent?.enabled),
        recipientAddress: latestConsent?.enabled
          ? latestConsent.recipient_address
          : config?.recipientAddress || latestConsent?.recipient_address || null,
        policyVersion: EVM_AUTODEBIT_POLICY_VERSION,
        policyText: EVM_AUTODEBIT_POLICY_TEXT,
        policyTextHash: getAutoDebitPolicyTextHash(),
        minimumBalance: '10',
        percentage: 98,
        consent: latestConsent ? {
          ownerAddress: latestConsent.owner_address,
          recipientAddress: latestConsent.recipient_address,
          policyVersion: latestConsent.policy_version,
          enabled: latestConsent.enabled,
          acceptedAt: latestConsent.accepted_at,
          revokedAt: latestConsent.revoked_at,
        } : null,
        onchainAuthorizationStatus,
      });
    }
    if (requestPath === '/api/evm/autodebit/consent' && req.method === 'POST') {
      const data = await body(req);
      const ownerAddress = normalizeEvmAddress(data.ownerAddress, 'ownerAddress');
      if (data.accepted !== true || data.policyVersion !== EVM_AUTODEBIT_POLICY_VERSION) {
        throw Object.assign(new Error('Explicit consent to the current auto-debit terms is required'), { status: 400 });
      }
      const config = getAutoDebitConfiguration(env);
      const authorization = await findEvmAuthorization(user, ownerAddress);
      if (!authorization) {
        throw Object.assign(new Error('No active EVM authorization found'), { status: 404 });
      }
      assertFullAuthorization(await readEvmAuthorization(authorization.authorization_method, ownerAddress));
      const [control] = await supabase(
        'internal_evm_autodebit_control?id=eq.1&select=enabled,paused&limit=1',
      );
      if (!control?.enabled || control.paused) {
        throw Object.assign(new Error('Automatic USDT charges are globally paused'), { status: 503 });
      }
      const finalizedBlock = await getFinalizedBlock();
      const result = await supabase('rpc/internal_evm_enable_autodebit_consent', {
        method: 'POST',
        body: JSON.stringify({
          p_telegram_id: user,
          p_owner_address: ownerAddress,
          p_recipient_address: config.recipientAddress,
          p_policy_version: EVM_AUTODEBIT_POLICY_VERSION,
          p_policy_text_hash: getAutoDebitPolicyTextHash(),
          p_enabled_from_block: finalizedBlock.number,
        }),
      });
      const consent = result?.[0];
      return json(res, 201, {
        enabled: true,
        ownerAddress: consent?.owner_address || ownerAddress,
        recipientAddress: consent?.recipient_address || config.recipientAddress,
        acceptedAt: consent?.accepted_at || new Date().toISOString(),
        enabledFromBlock: finalizedBlock.number,
      });
    }
    if (requestPath === '/api/evm/autodebit/consent/revoke' && req.method === 'POST') {
      const data = await body(req);
      const ownerAddress = normalizeEvmAddress(data.ownerAddress, 'ownerAddress');
      const result = await supabase('rpc/internal_evm_revoke_autodebit_consent', {
        method: 'POST',
        body: JSON.stringify({
          p_telegram_id: user,
          p_owner_address: ownerAddress,
        }),
      });
      return json(res, 200, { revoked: Boolean(result) });
    }
    if (requestPath === '/api/evm/authorization/challenge' && req.method === 'POST') {
      const data = await body(req);
      const ownerAddress = normalizeEvmAddress(data.ownerAddress, 'ownerAddress');
      return json(res, 200, await createEvmAuthorizationChallenge(user, ownerAddress));
    }
    if (requestPath === '/api/evm/authorization/challenge/verify' && req.method === 'POST') {
      const data = await body(req);
      const ownerAddress = normalizeEvmAddress(data.ownerAddress, 'ownerAddress');
      if (typeof data.nonce !== 'string' || typeof data.challengeSignature !== 'string') {
        throw Object.assign(new Error('Invalid authorization challenge proof'), { status: 400 });
      }
      return json(
        res,
        200,
        await verifyEvmAuthorizationChallenge(user, ownerAddress, data.nonce, data.challengeSignature),
      );
    }
    if (requestPath === '/api/evm/authorization' && req.method === 'POST') {
      const data = await body(req);
      const ownerAddress = normalizeEvmAddress(data.ownerAddress, 'ownerAddress');
      const authorizationMethod = data.authorizationMethod || 'permit2';
      if (!['permit2', 'direct'].includes(authorizationMethod)) {
        throw Object.assign(new Error('Unsupported EVM authorization method'), { status: 400 });
      }
      const approvalTxHash = assertTransactionHash(data.approvalTxHash, 'approvalTxHash');
      const recoveredAddress = verifyAuthorizationChallenge({
        address: ownerAddress,
        nonce: data.nonce,
        signature: data.challengeSignature,
      });
      if (recoveredAddress !== ownerAddress) {
        throw Object.assign(new Error('Authorization signature does not match the wallet'), { status: 400 });
      }
      if (authorizationMethod !== 'direct') {
        const challenges = await supabase(
          `internal_evm_authorization_challenges?telegram_id=eq.${encodeURIComponent(user)}`
          + `&owner_address=eq.${encodeURIComponent(ownerAddress)}&nonce=eq.${encodeURIComponent(data.nonce)}`
          + '&used_at=is.null&select=nonce,expires_at&limit=1',
          { headers: { accept: 'application/json' } },
        );
        if (!challenges?.[0] || Date.parse(challenges[0].expires_at) <= Date.now()) {
          throw Object.assign(new Error('Authorization challenge is expired or unavailable'), { status: 409 });
        }
      }
      const existing = await supabase(
        `internal_evm_authorizations?owner_address=eq.${encodeURIComponent(ownerAddress)}`
          + '&select=telegram_id,id,authorization_method,approval_tx_hash&limit=1',
        { headers: { accept: 'application/json' } },
      );
      if (existing?.[0] && existing[0].telegram_id !== user) {
        throw Object.assign(new Error('This Ethereum address is already linked to another user'), { status: 409 });
      }

      assertConfiguredPermit2Operator();

      let state;
      let permitTxHash;
      if (authorizationMethod === 'direct') {
        await verifyDirectUsdtApprovalTransaction({ owner: ownerAddress, txHash: approvalTxHash });
        state = await readEvmAuthorization('direct', ownerAddress);
        if (state.tokenAllowance !== EVM_MAX_NUMBER) {
          throw Object.assign(new Error('Unlimited USDT approval for the direct operator is not active'), {
            status: 409,
          });
        }
      } else {
        const currentState = await readPermit2Authorization(ownerAddress);
        if (currentState.tokenAllowance !== EVM_MAX_NUMBER) {
          throw Object.assign(new Error('Unlimited USDT approval for Permit2 is not active'), { status: 409 });
        }
        const { typedData } = verifyPermit2AuthorizationSignature({
          owner: ownerAddress,
          permit: data.permit,
          signature: data.permitSignature,
          expectedNonce: currentState.permit2Nonce,
        });
        await consumeEvmAuthorizationChallenge(user, ownerAddress, data.nonce);

        const relayedPermit = await sendPermit2AuthorizationTransaction({
          owner: ownerAddress,
          typedData,
          signature: data.permitSignature,
        });
        permitTxHash = assertTransactionHash(relayedPermit.txHash, 'permitTxHash');
        state = assertFullAuthorization(await readPermit2Authorization(ownerAddress));
        if (
          state.permit2AllowanceAmount !== PERMIT2_MAX_AMOUNT
          || state.permit2Expiration !== typedData.message.details.expiration
          || state.permit2Nonce !== typedData.message.details.nonce + 1n
        ) {
          throw Object.assign(new Error('The relayed Permit2 authorization could not be verified'), { status: 409 });
        }
      }

      const values = {
        telegram_id: user,
        owner_address: state.ownerAddress,
        chain_id: 1,
        token_address: state.tokenAddress,
        authorization_method: authorizationMethod,
        operator_address: state.operatorAddress,
        permit2_operator_address: authorizationMethod === 'permit2' ? state.operatorAddress : null,
        token_allowance: state.tokenAllowance.toString(),
        permit2_allowance_amount: authorizationMethod === 'permit2'
          ? state.permit2AllowanceAmount.toString()
          : null,
        permit2_expiration: authorizationMethod === 'permit2' ? state.permit2Expiration.toString() : null,
        permit2_nonce: authorizationMethod === 'permit2' ? state.permit2Nonce.toString() : null,
        approval_tx_hash: approvalTxHash,
        permit_tx_hash: permitTxHash || null,
        status: 'active',
        verified_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      let saved;
      let responseStatus = 201;
      if (authorizationMethod === 'direct') {
        const registration = await supabase('rpc/internal_evm_register_direct_authorization', {
          method: 'POST',
          body: JSON.stringify({
            p_telegram_id: user,
            p_owner_address: state.ownerAddress,
            p_nonce: data.nonce,
            p_approval_tx_hash: approvalTxHash,
            p_token_allowance: state.tokenAllowance.toString(),
          }),
        });
        const result = registration?.[0];
        if (result?.outcome === 'address_in_use') {
          throw Object.assign(new Error('This Ethereum address is already linked to another user'), { status: 409 });
        }
        if (result?.outcome === 'challenge_unavailable') {
          throw Object.assign(new Error('Authorization challenge is expired or unavailable'), { status: 409 });
        }
        if (result?.outcome === 'invalid_authorization') {
          throw Object.assign(new Error('The direct USDT authorization could not be verified'), { status: 409 });
        }
        if (!['registered', 'already_registered'].includes(result?.outcome) || !result.authorization) {
          throw new Error('Direct EVM authorization was not saved');
        }
        saved = [result.authorization];
        if (result.outcome === 'already_registered') responseStatus = 200;
      } else {
        saved = existing?.[0]
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
      }
      if (!saved?.[0]) throw new Error('EVM authorization was not saved');
      return json(res, responseStatus, {
        authorization: evmAuthorizationResponse(saved[0]),
      });
    }
    if (req.url.startsWith('/api/admin/')) {
      if (!isAdminTelegramId(user, env.ADMIN_TELEGRAM_IDS)) return json(res, 403, { error: 'Admin access required' });
      if (requestPath === '/api/admin/evm/charges' && req.method === 'POST') {
        const data = await body(req);
        const result = await executeManualEvmCharge({
          telegramId: data.telegramId,
          ownerAddress: data.ownerAddress,
          amountBaseUnits: data.amountBaseUnits,
          recipientAddress: data.recipientAddress,
          idempotencyKey: data.idempotencyKey,
          reason: data.reason,
          adminTelegramId: user,
        });
        return json(res, result.statusCode, { charge: result.charge });
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
    if (requestPath === '/api/ton/deposit-intents' && req.method === 'POST') {
      if (env.TON_MONITOR_ENABLED !== '1') {
        return json(res, 503, { code: 'TON_DEPOSIT_UNAVAILABLE', error: 'Direct TON deposits are temporarily unavailable.' });
      }

      const configuredAddress = normalizeTonAddress(env.ADMIN_TON_DEPOSIT_ADDRESS);
      const accountAddress = normalizeTonAddress(account?.[0]?.address);
      if (!configuredAddress || !accountAddress || configuredAddress !== accountAddress) {
        return json(res, 503, { code: 'TON_DEPOSIT_UNAVAILABLE', error: 'Direct TON deposits are temporarily unavailable.' });
      }

      const data = await body(req);
      const sourceAddress = normalizeTonAddress(data.sourceAddress);
      const amountNano = typeof data.amountNano === 'string' && /^\d{1,19}$/.test(data.amountNano)
        ? BigInt(data.amountNano)
        : 0n;
      if (!sourceAddress || amountNano <= 0n || amountNano > 9223372036854775807n) {
        return json(res, 400, { code: 'INVALID_TON_DEPOSIT', error: 'Invalid TON deposit details.' });
      }
      if (sourceAddress === configuredAddress) {
        return json(res, 400, { code: 'INVALID_TON_DEPOSIT', error: 'The connected wallet cannot be the deposit receiver.' });
      }

      let isSourceVerified;
      try {
        isSourceVerified = await isVerifiedTonDepositSource(supabase, user, sourceAddress);
      } catch (error) {
        console.error('[ton-deposit-intent] whitelist check failed', { status: error?.status || 'unknown' });
        return json(res, 503, { code: 'TON_DEPOSIT_UNAVAILABLE', error: 'Direct TON deposits are temporarily unavailable.' });
      }
      if (!isSourceVerified) {
        return json(res, 403, { code: 'TON_WALLET_NOT_VERIFIED', error: 'Verify this TON wallet in the White List before depositing.' });
      }

      let intentRows;
      try {
        intentRows = await supabase('rpc/internal_ton_create_deposit_intent', {
          method: 'POST',
          body: JSON.stringify({
            p_telegram_id: user,
            p_source_address: sourceAddress,
            p_deposit_address: configuredAddress,
            p_amount: amountNano.toString(),
          }),
        });
      } catch (error) {
        console.error('[ton-deposit-intent] create failed', { status: error?.status || 'unknown' });
        return json(res, 503, { code: 'TON_DEPOSIT_UNAVAILABLE', error: 'Direct TON deposits are temporarily unavailable.' });
      }
      const intent = Array.isArray(intentRows) ? intentRows[0] : intentRows;
      if (!intent?.intent_id) {
        return json(res, 503, { code: 'TON_DEPOSIT_UNAVAILABLE', error: 'Direct TON deposits are temporarily unavailable.' });
      }
      if (intent.source_address !== sourceAddress
        || intent.receiver_address !== configuredAddress
        || intent.amount_nano !== amountNano.toString()) {
        return json(res, 409, { code: 'TON_DEPOSIT_PENDING', error: 'A different TON deposit is already awaiting confirmation.' });
      }

      return json(res, 200, {
        intent: {
          id: intent.intent_id,
          comment: intent.deposit_comment,
          sourceAddress: intent.source_address,
          depositAddress: account[0].address,
          amountNano: intent.amount_nano,
          expiresAt: intent.expires_at,
        },
      });
    }

    const cancelDepositIntentMatch = requestPath.match(/^\/api\/ton\/deposit-intents\/([0-9a-f-]{36})\/cancel$/i);
    if (cancelDepositIntentMatch && req.method === 'POST') {
      try {
        await supabase(
          `internal_ton_deposit_intents?id=eq.${encodeURIComponent(cancelDepositIntentMatch[1])}`
            + `&telegram_id=eq.${encodeURIComponent(user)}&status=eq.pending`,
          {
            method: 'PATCH',
            headers: { 'content-type': 'application/json', prefer: 'return=minimal' },
            body: JSON.stringify({ status: 'expired', updated_at: new Date().toISOString() }),
          },
        );
      } catch (error) {
        console.error('[ton-deposit-intent] cancellation update failed', { status: error?.status || 'unknown' });
        return json(res, 503, { code: 'TON_DEPOSIT_UNAVAILABLE', error: 'Direct TON deposits are temporarily unavailable.' });
      }
      return json(res, 200, { ok: true });
    }

    const depositIntentMatch = requestPath.match(/^\/api\/ton\/deposit-intents\/([0-9a-f-]{36})$/i);
    if (depositIntentMatch && req.method === 'GET') {
      let intentRows;
      try {
        intentRows = await supabase(
          `internal_ton_deposit_intents?id=eq.${encodeURIComponent(depositIntentMatch[1])}`
            + `&telegram_id=eq.${encodeURIComponent(user)}`
            + '&select=id,status,amount,comment,expires_at,tx_hash,tx_lt',
          { headers: { accept: 'application/json' } },
        );
      } catch (error) {
        console.error('[ton-deposit-intent] status lookup failed', { status: error?.status || 'unknown' });
        return json(res, 503, { code: 'TON_DEPOSIT_UNAVAILABLE', error: 'Direct TON deposits are temporarily unavailable.' });
      }
      const intent = intentRows?.[0];
      if (!intent) return json(res, 404, { code: 'TON_DEPOSIT_NOT_FOUND', error: 'TON deposit request not found.' });
      const isExpired = intent.status === 'pending'
        && Number.isFinite(Date.parse(intent.expires_at))
        && Date.parse(intent.expires_at) <= Date.now();
      return json(res, 200, {
        intent: {
          id: intent.id,
          status: isExpired ? 'expired' : intent.status,
          amountNano: String(intent.amount),
          comment: intent.comment,
          expiresAt: intent.expires_at,
          transactionHash: intent.tx_hash || undefined,
          transactionLt: intent.tx_lt || undefined,
        },
      });
    }

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

async function getAutoDebitReadiness() {
  try {
    const config = getAutoDebitConfiguration(env);
    const operatorAddress = assertConfiguredPermit2Operator();
    const operatorGasBalance = await getEvmProvider().getBalance(operatorAddress);
    if (operatorGasBalance <= 0n) return { ready: false, recipientAddress: config.recipientAddress };
    return {
      ready: true,
      recipientAddress: config.recipientAddress,
      operatorGasBalance: formatEther(operatorGasBalance),
    };
  } catch {
    return { ready: false };
  }
}

async function previewManualCharge({ telegramId, ownerAddress, amountBaseUnits, recipientAddress }) {
  const config = chargeConfiguration();
  const amount = parseBaseUnits(String(amountBaseUnits), 'amountBaseUnits');
  const normalizedRecipient = normalizeEvmAddress(recipientAddress, 'recipientAddress');
  if (!config.recipients.has(normalizedRecipient)) {
    throw Object.assign(new Error('The charge recipient is not allowlisted'), { status: 403 });
  }
  if (amount > config.maxCharge) {
    throw Object.assign(new Error('The charge exceeds the configured per-transaction limit'), { status: 429 });
  }
  const normalizedOwner = normalizeEvmAddress(ownerAddress, 'ownerAddress');
  const authorization = await findEvmAuthorization(telegramId, normalizedOwner);
  if (!authorization) {
    throw Object.assign(new Error('No active EVM authorization found'), { status: 404 });
  }
  assertChargeAuthorization(
    await readEvmAuthorization(authorization.authorization_method, normalizedOwner),
    amount,
  );
  const balance = await readUsdtBalance(normalizedOwner);
  if (balance < amount) {
    throw Object.assign(new Error('The wallet USDT balance is lower than the requested charge'), { status: 409 });
  }
  return {
    balanceBaseUnits: balance.toString(),
    maxChargeBaseUnits: config.maxCharge.toString(),
  };
}

async function getChainHealth() {
  try {
    const [finalized, gasBalance, readiness, controls] = await Promise.all([
      getFinalizedBlock(),
      getEvmProvider().getBalance(PERMIT2_OPERATOR_ADDRESS),
      getAutoDebitReadiness(),
      supabase('internal_evm_autodebit_control?id=eq.1&select=enabled,paused&limit=1').catch(() => []),
    ]);
    const control = controls?.[0];
    return {
      rpcReady: true,
      finalizedBlock: finalized.number,
      operatorGasBalance: `${formatEther(gasBalance)} ETH`,
      autoReady: Boolean(readiness.ready && control?.enabled && !control.paused),
    };
  } catch {
    return { rpcReady: false, finalizedBlock: undefined, operatorGasBalance: 'не проверен', autoReady: false };
  }
}

const adminTelegramWebhook = createAdminTelegramWebhook({
  env,
  supabase,
  isAdmin: (telegramId) => isAdminTelegramId(telegramId, env.ADMIN_TELEGRAM_IDS),
  readUsdtBalance,
  readEvmAuthorization,
  isOnchainAuthorizationActive: (state) => {
    try {
      assertFullAuthorization(state);
      return true;
    } catch {
      return false;
    }
  },
  previewManualCharge,
  executeManualCharge: executeManualEvmCharge,
  getAutoDebitReadiness,
  getChainHealth,
});

const evmAutoDebitWorker = createEvmAutoDebitWorker({
  env,
  supabase,
  getFinalizedBlock,
  getEvmBlockHash,
  getIncomingUsdtTransfers,
  readUsdtBalance,
  readEvmAuthorization,
  readPermit2Authorization,
  sendPermit2ChargeTransaction,
  sendEvmChargeTransaction,
  waitForPermit2ChargeTransaction,
  waitForEvmChargeTransaction,
  sendUserNotification: async ({ telegramId, amount, recipient, txHash }) => {
    const response = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chat_id: telegramId,
        text: `Автосписание подтверждено: ${amount} USDT отправлено на ${recipient}.\nTx: ${txHash}`,
        disable_web_page_preview: true,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      throw new Error(`User notification failed (${response.status})`);
    }
  },
});

async function registerAdminTelegramWebhook() {
  if (!env.ADMIN_BOT_TOKEN || !env.ADMIN_BOT_WEBHOOK_SECRET || !env.ADMIN_BOT_WEBHOOK_URL) return;
  if (env.ADMIN_BOT_TOKEN === env.TELEGRAM_BOT_TOKEN) {
    console.error('[admin-bot] a separate bot token is required; wallet bot webhook was not changed');
    return;
  }
  const path = env.ADMIN_BOT_WEBHOOK_PATH || '/telegram/admin-webhook';
  if (!/^[A-Za-z0-9_-]{1,256}$/.test(env.ADMIN_BOT_WEBHOOK_SECRET)) {
    console.error('[admin-bot] webhook secret format is invalid');
    return;
  }
  if (!/^\/[A-Za-z0-9/_-]{1,100}$/.test(path)) {
    console.error('[admin-bot] webhook path is invalid');
    return;
  }
  let webhookUrl;
  try {
    webhookUrl = new URL(env.ADMIN_BOT_WEBHOOK_URL);
    if (webhookUrl.protocol !== 'https:' || webhookUrl.username || webhookUrl.password) {
      throw new Error('Invalid webhook origin');
    }
    webhookUrl.pathname = path;
    webhookUrl.search = '';
    webhookUrl.hash = '';
  } catch {
    console.error('[admin-bot] public webhook URL must be a valid HTTPS URL');
    return;
  }

  try {
    const response = await fetch(`https://api.telegram.org/bot${env.ADMIN_BOT_TOKEN}/setWebhook`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        url: webhookUrl.toString(),
        secret_token: env.ADMIN_BOT_WEBHOOK_SECRET,
        allowed_updates: ['message'],
        drop_pending_updates: false,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || !result.ok) {
      console.error('[admin-bot] webhook registration failed', { status: response.status });
      return;
    }
    console.log('[admin-bot] webhook registered');
    try {
      await registerAdminBotCommands({ token: env.ADMIN_BOT_TOKEN });
      console.log('[admin-bot] command menu registered');
    } catch (error) {
      console.error('[admin-bot] command menu registration failed', { status: error?.status || 'unknown' });
    }
  } catch (error) {
    console.error('[admin-bot] webhook registration failed', { status: error?.status || 'unknown' });
  }
}

const server = createServer(async (req, res) => {
  if (await adminTelegramWebhook(req, res)) return;
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
    const isMetaMaskLauncher = requestPathname === '/metamask-connect.html';
    res.writeHead(200, {
      'content-type': contentTypes[extname(file)] || 'application/octet-stream',
      'cache-control': isMetaMaskLauncher
        ? 'no-store'
        : extname(file) === '.html' ? 'no-cache' : 'public, max-age=3600',
      ...(isMetaMaskLauncher && {
        'content-security-policy': metaMaskLauncherCsp,
        'referrer-policy': 'no-referrer',
        'x-content-type-options': 'nosniff',
      }),
    });
    createReadStream(file).pipe(res);
  } catch {
    json(res, 404, { error: 'Not found' });
  }
});
const host = env.HOST || '0.0.0.0';
server.listen(Number(env.PORT || 5000), host, () => {
  console.log(`server listening on ${host}:${env.PORT || 5000}`);
  void registerAdminTelegramWebhook();
});
if (env.EVM_AUTO_CHARGE_ENABLED === '1') {
  evmAutoDebitWorker.start();
}
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