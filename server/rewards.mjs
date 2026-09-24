import crypto from 'node:crypto';

export function isAdminTelegramId(id, allowlist = process.env.ADMIN_TELEGRAM_IDS) {
  if (!id || !allowlist) return false;
  return allowlist.split(',').map((value) => value.trim()).filter(Boolean).includes(String(id));
}

export function generateRewardCheckCode() {
  return crypto.randomBytes(24).toString('base64url');
}

export function parseRewardAmount(value) {
  if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value)) throw Object.assign(new Error('amountNano must be a positive decimal integer'), { status: 400 });
  const amount = BigInt(value);
  if (amount > 9223372036854775807n) throw Object.assign(new Error('amountNano is too large'), { status: 400 });
  return value;
}

export function parseMaxClaims(value) {
  if (!Number.isInteger(value) || value <= 0 || value > 2147483647) throw Object.assign(new Error('maxClaims must be a positive integer'), { status: 400 });
  return value;
}

export function parseRewardAsset(value) {
  if (value === undefined || value === null || value === '') return 'TON';
  if (value !== 'TON' && value !== 'USDT' && value !== 'ETH') {
    throw Object.assign(new Error('asset must be TON, USDT, or ETH'), { status: 400 });
  }
  return value;
}