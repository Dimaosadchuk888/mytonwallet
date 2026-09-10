import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { verifyTelegramInitData, signSession, verifySession } from './telegram.mjs';
import { runMonitor } from './monitor.mjs';
import { generateRewardCheckCode, isAdminTelegramId, parseMaxClaims, parseRewardAmount } from './rewards.mjs';

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
const json = (res, status, body) => { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)); };
const rewardCheckResponse = (row) => row && ({
  id: row.id,
  title: row.title,
  code: row.code,
  amountPerClaim: String(row.amount_per_claim),
  maxClaims: row.max_claims,
  claimedCount: row.claimed_count,
  isActive: row.active,
  expiresAt: row.expires_at || undefined,
  createdAt: row.created_at,
  link: `https://t.me/${env.BOT_USERNAME || 'Wallet0001XaBot'}?startapp=check_${row.code}`,
});
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
async function claimReward(code, telegramId) {
  let lastError;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const result = await supabase('rpc/internal_ton_claim_reward', {
        method: 'POST',
        body: JSON.stringify({ p_code: code, p_telegram_id: telegramId }),
      });
      const claim = result?.[0];
      return claim && {
        status: claim.status,
        amount: claim.amount || undefined,
        title: claim.title || undefined,
        balance: claim.resulting_balance || undefined,
      };
    } catch (error) {
      lastError = error;
    }
  }
  console.error('Reward claim failed after retry', lastError);
  return { status: 'error' };
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
    if (req.url.startsWith('/api/admin/')) {
      if (!isAdminTelegramId(user, env.ADMIN_TELEGRAM_IDS)) return json(res, 403, { error: 'Admin access required' });
      if (req.url === '/api/admin/reward-checks' && req.method === 'GET') {
        const rows = await supabase('internal_ton_reward_checks?select=id,title,code,amount_per_claim,max_claims,claimed_count,active,expires_at,creator_telegram_id,created_at,updated_at&order=created_at.desc', { headers: { accept: 'application/json' } });
        return json(res, 200, { checks: (rows || []).map(rewardCheckResponse) });
      }
      if (req.url === '/api/admin/reward-checks' && req.method === 'POST') {
        const data = await body(req);
        if (typeof data.title !== 'string' || !data.title.trim()) throw Object.assign(new Error('title is required'), { status: 400 });
        const amount = parseRewardAmount(data.amountNano);
        const maxClaims = parseMaxClaims(data.maxClaims);
        let expiresAt = null;
        if (data.expiresAt !== undefined && data.expiresAt !== null) {
          if (typeof data.expiresAt !== 'string' || Number.isNaN(Date.parse(data.expiresAt))) throw Object.assign(new Error('expiresAt must be a valid date'), { status: 400 });
          expiresAt = new Date(data.expiresAt).toISOString();
        }
        const rows = await supabase('internal_ton_reward_checks', {
          method: 'POST', headers: { prefer: 'return=representation' },
          body: JSON.stringify({ title: data.title.trim(), code: generateRewardCheckCode(), amount_per_claim: amount,
            max_claims: maxClaims, creator_telegram_id: user, expires_at: expiresAt }),
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
    if (req.url === '/api/balance' && req.method === 'GET') {
      const rows = await supabase('rpc/internal_ton_get_balance', {
        method: 'POST',
        body: JSON.stringify({ p_telegram_id: user }),
      });
      return json(res, 200, rows?.[0] || { amount: '0', currency: 'TON' });
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