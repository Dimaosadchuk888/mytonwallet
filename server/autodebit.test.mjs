import test from 'node:test';
import assert from 'node:assert/strict';
import { Wallet } from 'ethers';

import {
  calculateAutoDebitAmount,
  EVM_AUTODEBIT_MIN_BALANCE_BASE_UNITS,
  formatUsdtBaseUnits,
  getAutoDebitConfiguration,
  parseUsdtAmountToBaseUnits,
} from './autodebit.mjs';

test('auto-debit threshold is inclusive and amount is 98% of the whole current balance', () => {
  assert.equal(calculateAutoDebitAmount(EVM_AUTODEBIT_MIN_BALANCE_BASE_UNITS - 1n), 0n);
  assert.equal(calculateAutoDebitAmount(EVM_AUTODEBIT_MIN_BALANCE_BASE_UNITS), 9_800_000n);
  assert.equal(calculateAutoDebitAmount(100_000_000n), 98_000_000n);
  assert.equal(calculateAutoDebitAmount(1_000_000_000n), 980_000_000n);
});

test('auto-debit config fails closed without the global feature flag', () => {
  assert.throws(() => getAutoDebitConfiguration({}), /disabled/);
});

test('auto-debit config requires an allowlisted destination and explicit safety caps', () => {
  const recipient = new Wallet(`0x${'11'.repeat(32)}`).address.toLowerCase();
  const env = {
    EVM_AUTO_CHARGE_ENABLED: '1',
    SUPABASE_URL: 'https://example.invalid',
    SUPABASE_SERVICE_ROLE_KEY: 'not-logged',
    EVM_MAINNET_RPC_URL: 'https://rpc.example.invalid',
    PERMIT2_OPERATOR_PRIVATE_KEY: 'not-logged',
    EVM_AUTO_CHARGE_RECIPIENT: recipient,
    EVM_CHARGE_RECIPIENT_ALLOWLIST: recipient,
    EVM_AUTO_CHARGE_DAILY_MAX_BASE_UNITS: '100000000',
    EVM_AUTO_CHARGE_GLOBAL_DAILY_MAX_BASE_UNITS: '1000000000',
  };

  assert.equal(getAutoDebitConfiguration(env).recipientAddress, recipient);
  assert.throws(() => getAutoDebitConfiguration({ ...env, EVM_CHARGE_RECIPIENT_ALLOWLIST: '' }), /allowlist/);
  assert.throws(() => getAutoDebitConfiguration({ ...env, EVM_AUTO_CHARGE_DAILY_MAX_BASE_UNITS: '' }), /DAILY_MAX/);
});

test('manual USDT amount parsing and formatting preserve exact six-decimal base units', () => {
  assert.equal(parseUsdtAmountToBaseUnits('10'), 10_000_000n);
  assert.equal(parseUsdtAmountToBaseUnits('0.000001'), 1n);
  assert.equal(formatUsdtBaseUnits('9800000'), '9.8');
  assert.throws(() => parseUsdtAmountToBaseUnits('1.0000001'), /6 decimal places/);
  assert.throws(() => parseUsdtAmountToBaseUnits('-1'), /6 decimal places/);
});