import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { isVerifiedTonDepositSource, TON_MAINNET_NETWORK_ID } from './ton-deposit-intents.mjs';

test('TON deposit source verification is scoped to the Telegram user and mainnet wallet', async () => {
  const address = '0:ab cd';
  let request;

  const verified = await isVerifiedTonDepositSource(async (path, options) => {
    request = { path, options };
    return [{ address, network_id: TON_MAINNET_NETWORK_ID, verified_at: '2026-10-06T00:00:00Z' }];
  }, 'telegram-123', address);

  assert.equal(verified, true);
  assert.match(request.path, /telegram_id=eq\.telegram-123/);
  assert.match(request.path, /network_id=eq\.-239/);
  assert.match(request.path, /address=eq\.0%3Aab%20cd/);
  assert.deepEqual(request.options.headers, { accept: 'application/json' });
});

test('TON deposit source verification rejects missing, unverified, or non-mainnet records', async () => {
  const address = '0:abcd';
  for (const row of [
    undefined,
    { address, network_id: TON_MAINNET_NETWORK_ID, verified_at: null },
    { address, network_id: '-3', verified_at: '2026-10-06T00:00:00Z' },
    { address: '0:other', network_id: TON_MAINNET_NETWORK_ID, verified_at: '2026-10-06T00:00:00Z' },
  ]) {
    const verified = await isVerifiedTonDepositSource(async () => (row ? [row] : []), 'telegram-123', address);
    assert.equal(verified, false);
  }
});

test('database intent creation independently enforces the owner-bound TON White List', async () => {
  const migration = await readFile(
    new URL('../supabase/migrations/015_internal_ton_deposit_whitelist_guard.sql', import.meta.url),
    'utf8',
  );

  assert.match(migration, /w\.telegram_id = p_telegram_id/);
  assert.match(migration, /w\.network_id = '-239'/);
  assert.match(migration, /lower\(w\.address\) = lower\(p_source_address\)/);
  assert.match(migration, /w\.verified_at is not null/);
  assert.match(migration, /TON deposit source wallet is not verified/);
});
