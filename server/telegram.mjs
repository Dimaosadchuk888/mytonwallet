import crypto from 'node:crypto';

const MAX_AUTH_AGE_SECONDS = 24 * 60 * 60;

export function verifyTelegramInitData(initData, botToken, now = Date.now()) {
  if (!initData || !botToken) throw new Error('Telegram authentication is not configured');
  const params = new URLSearchParams(initData);
  const received = params.get('hash');
  const authDate = Number(params.get('auth_date'));
  if (!received || !Number.isFinite(authDate) || Math.floor(now / 1000) - authDate > MAX_AUTH_AGE_SECONDS
    || authDate > Math.floor(now / 1000) + 60) throw new Error('Invalid or expired Telegram initData');
  const dataCheckString = [...params.entries()]
    .filter(([key]) => key !== 'hash')
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  const expected = crypto.createHmac('sha256', secret).update(dataCheckString).digest('hex');
  if (received.length !== expected.length
    || !crypto.timingSafeEqual(Buffer.from(received), Buffer.from(expected))) throw new Error('Invalid Telegram signature');
  const user = params.get('user');
  return { user: user ? JSON.parse(user) : undefined, authDate, startParam: params.get('start_param') || undefined };
}

export function signSession(userId, secret, now = Date.now()) {
  const payload = Buffer.from(JSON.stringify({ sub: userId, iat: now })).toString('base64url');
  const signature = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  return `${payload}.${signature}`;
}

export function verifySession(value, secret, maxAgeMs = 7 * 24 * 60 * 60 * 1000, now = Date.now()) {
  if (!value || !secret) return undefined;
  const [payload, received] = value.split('.');
  if (!payload || !received) return undefined;
  const expected = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  if (received.length !== expected.length
    || !crypto.timingSafeEqual(Buffer.from(received), Buffer.from(expected))) return undefined;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString());
    return data.sub && now - data.iat <= maxAgeMs ? data.sub : undefined;
  } catch { return undefined; }
}