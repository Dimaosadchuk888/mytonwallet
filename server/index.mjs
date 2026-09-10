import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { verifyTelegramInitData, signSession, verifySession } from './telegram.mjs';
import { runMonitor } from './monitor.mjs';
import { DEPOSIT_NETWORKS, validateDepositRegistry } from './deposits.mjs';
import { runPendingClaims } from './deposit-worker.mjs';

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const dist = join(root, 'dist');
const env = process.env;
const requiredSettings = [
  'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'TELEGRAM_BOT_TOKEN',
  'SESSION_SECRET',
];
if (env.TON_MONITOR_ENABLED === '1') requiredSettings.push('TONCENTER_API_KEY');
if (['ETHEREUM', 'SOLANA', 'TRON'].some((network) => env[`${network}_MONITOR_ENABLED`] === '1')) {
  requiredSettings.push('DEPOSIT_VERIFIER_URL');
}
const missingSettings = requiredSettings.filter((key) => !env[key]);
if (missingSettings.length) throw new Error(`Missing required server settings: ${missingSettings.join(', ')}`);
validateDepositRegistry();
const claimAttempts = new Map();

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
const json = (res, status, body) => { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)); };
async function body(req) {
  let out = '';
  for await (const chunk of req) { out += chunk; if (out.length > 64 * 1024) throw Object.assign(new Error('Request body too large'), { status: 413 }); }
  try { return JSON.parse(out || '{}'); } catch { throw Object.assign(new Error('Invalid JSON'), { status: 400 }); }
}
async function supabase(path, options = {}) {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) throw new Error('Supabase is not configured');
  const response = await fetch(`${env.SUPABASE_URL}/rest/v1/${path}`, {
    ...options, headers: { apikey: env.SUPABASE_SERVICE_ROLE_KEY, authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      'content-type': 'application/json', ...(options.headers || {}) },
  });
  if (!response.ok) throw new Error(`Supabase request failed (${response.status})`);
  const text = await response.text();
  return text ? JSON.parse(text) : undefined;
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
    if (req.url === '/api/auth/telegram' && req.method === 'POST') {
      const data = await body(req);
      const verified = verifyTelegramInitData(data.initData, env.TELEGRAM_BOT_TOKEN);
      if (!verified.user?.id) {
        expireSession(res);
        return json(res, 400, { error: 'Telegram user is required' });
      }
      const id = String(verified.user.id);
      let tonReference;
      await supabase('internal_ton_users?on_conflict=telegram_id', { method: 'POST', headers: { prefer: 'resolution=merge-duplicates' },
        body: JSON.stringify({ telegram_id: id, username: verified.user.username || null,
          first_name: verified.user.first_name || null, last_name: verified.user.last_name || null,
          language_code: verified.user.language_code || null, last_login_at: new Date().toISOString() }) });
      const users = await supabase(`internal_ton_users?telegram_id=eq.${encodeURIComponent(id)}&select=id`, { headers: { accept: 'application/json' } });
      if (users?.[0]) {
        const legacyAccounts = await supabase(`internal_ton_deposit_accounts?telegram_id=eq.${encodeURIComponent(id)}&select=comment&limit=1`, { headers: { accept: 'application/json' } });
        const comment = legacyAccounts?.[0]?.comment || `u_${crypto.randomBytes(12).toString('base64url')}`;
        tonReference = comment;
        await supabase('internal_ton_deposit_accounts?on_conflict=telegram_id', { method: 'POST',
          headers: { prefer: 'resolution=merge-duplicates' },
          body: JSON.stringify({ user_id: users[0].id, telegram_id: id, address: DEPOSIT_NETWORKS.ton.address, comment }) });
        await supabase('internal_ton_balances?on_conflict=telegram_id', { method: 'POST',
          headers: { prefer: 'resolution=ignore-duplicates' },
          body: JSON.stringify({ user_id: users[0].id, telegram_id: id, amount: 0, currency: 'TON' }) });
      }
      if (users?.[0]) {
        for (const network of Object.values(DEPOSIT_NETWORKS)) {
          const reference = network.id === 'ton' ? tonReference : null;
          await supabase('internal_deposit_intents?on_conflict=user_id,network', { method: 'POST',
            headers: { prefer: 'resolution=merge-duplicates' },
            body: JSON.stringify({ user_id: users[0].id, telegram_id: id, network: network.id,
              address: network.address, reference, status: 'pending',
              expires_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString() }) });
        }
      }
      const token = signSession(id, env.SESSION_SECRET);
      res.setHeader('set-cookie', `mtw_session=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=604800${env.NODE_ENV === 'production' ? '; Secure' : ''}`);
      return json(res, 200, { ok: true });
    }
    if (!req.url.startsWith('/api/')) return false;
    const user = session(req);
    if (!user) return json(res, 401, { error: 'Authentication required' });
    const account = await supabase(`internal_deposit_intents?telegram_id=eq.${encodeURIComponent(user)}&select=id,network,address,reference,status,expires_at`, { headers: { accept: 'application/json' } });
    if (req.url === '/api/account' && req.method === 'GET') {
      return json(res, 200, { networks: account || [], registry: Object.values(DEPOSIT_NETWORKS).map(({ id, name, asset, tokenStandard, tokenContract, decimals, confirmations }) => ({ id, name, asset, tokenStandard, tokenContract, decimals, confirmations })) });
    }
    if (req.url === '/api/balance' && req.method === 'GET') {
      const rows = await supabase(`internal_balances?telegram_id=eq.${encodeURIComponent(user)}&select=network,asset,amount`, { headers: { accept: 'application/json' } });
      return json(res, 200, { balances: rows || [] });
    }
    if ((req.url === '/api/account/deposits' || req.url === '/api/deposits') && req.method === 'GET') {
      const rows = await supabase(`internal_deposits?telegram_id=eq.${encodeURIComponent(user)}&select=network,tx_hash,raw_amount,decimals,asset,status,created_at&order=created_at.desc`, { headers: { accept: 'application/json' } });
      return json(res, 200, { deposits: rows || [] });
    }
    if ((req.url === '/api/account/deposits/claim' || req.url === '/api/deposits/claim') && req.method === 'POST') {
      const data = await body(req);
      const network = String(data.network || data.chain || '').toLowerCase();
      const txHash = String(data.txHash || data.transactionHash || '');
      if (!DEPOSIT_NETWORKS[network] || !/^[\x21-\x7e]{8,256}$/.test(txHash)) return json(res, 400, { error: 'Network and transaction hash are required' });
      const key = `${user}:${network}`;
      const now = Date.now();
      const attempts = (claimAttempts.get(key) || []).filter((time) => now - time < 60 * 60 * 1000);
      if (attempts.length >= 10) return json(res, 429, { error: 'Too many claim attempts' });
      const recentClaims = await supabase(`internal_deposit_claims?telegram_id=eq.${encodeURIComponent(user)}&created_at=gte.${encodeURIComponent(new Date(now - 60 * 60 * 1000).toISOString())}&select=id`, { headers: { accept: 'application/json' } });
      if ((recentClaims || []).length >= 10) return json(res, 429, { error: 'Too many claim attempts' });
      attempts.push(now); claimAttempts.set(key, attempts);
      const intent = account?.find((item) => item.network === network);
      if (!intent) return json(res, 409, { error: 'Deposit intent is not available' });
      const duplicate = await supabase(`internal_deposit_claims?intent_id=eq.${encodeURIComponent(intent.id)}&network=eq.${encodeURIComponent(network)}&tx_hash=eq.${encodeURIComponent(txHash)}&select=status&limit=1`, { headers: { accept: 'application/json' } });
      if (duplicate?.[0]) return json(res, 202, { status: duplicate[0].status, network, txHash });
      await supabase('internal_deposit_claims?on_conflict=intent_id,network,tx_hash', { method: 'POST',
        headers: { prefer: 'resolution=ignore-duplicates,return=minimal' },
        body: JSON.stringify({ intent_id: intent.id, telegram_id: user, network, tx_hash: txHash, status: 'pending' }) });
      return json(res, 202, { status: 'pending', network, txHash });
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
  if (req.url?.startsWith('/api/')) return api(req, res);
  const requested = req.url === '/' ? 'index.html' : req.url.split('?')[0].replace(/^\/+/, '');
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
   const monitorSupabase = (fn, params) => supabase(`rpc/${fn === 'credit_deposit' ? 'internal_credit_deposit' : `internal_ton_${fn}`}`, { method: 'POST', body: JSON.stringify(params) });
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
if (env.DEPOSIT_VERIFIER_URL) {
  let claimWorkerRunning = false;
  const tickClaims = async () => {
    if (claimWorkerRunning) return;
    claimWorkerRunning = true;
    try {
      await runPendingClaims({ supabase });
    } catch (error) {
      console.error('[deposit-claim-worker]', error.message);
    } finally {
      claimWorkerRunning = false;
    }
  };
  void tickClaims();
  setInterval(tickClaims, Number(env.DEPOSIT_CLAIM_INTERVAL_MS || 30000));
}