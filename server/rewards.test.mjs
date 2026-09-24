import test from 'node:test';
import assert from 'node:assert/strict';
import {
  generateRewardCheckCode,
  isAdminTelegramId,
  parseMaxClaims,
  parseRewardAmount,
  parseRewardAsset,
} from './rewards.mjs';

test('admin allowlist matches complete Telegram IDs only', () => {
  assert.equal(isAdminTelegramId('42', '7, 42,100'), true);
  assert.equal(isAdminTelegramId('4', '7, 42,100'), false);
  assert.equal(isAdminTelegramId('42', ''), false);
});

test('reward codes are opaque URL-safe values', () => {
  const first = generateRewardCheckCode();
  const second = generateRewardCheckCode();
  assert.match(first, /^[A-Za-z0-9_-]{32}$/);
  assert.notEqual(first, second);
});

test('reward amounts accept positive bigint strings only', () => {
  assert.equal(parseRewardAmount('1000000000'), '1000000000');
  assert.equal(parseRewardAmount('10000000000000000'), '10000000000000000');
  assert.throws(() => parseRewardAmount('0'), /positive/);
  assert.throws(() => parseRewardAmount('1.5'), /positive/);
  assert.throws(() => parseRewardAmount('9223372036854775808'), /too large/);
});

test('recipient limit requires a positive integer', () => {
  assert.equal(parseMaxClaims(100), 100);
  assert.throws(() => parseMaxClaims(0), /positive integer/);
  assert.throws(() => parseMaxClaims(1.5), /positive integer/);
});

test('reward assets are limited to supported internal currencies', () => {
  assert.equal(parseRewardAsset(undefined), 'TON');
  assert.equal(parseRewardAsset('TON'), 'TON');
  assert.equal(parseRewardAsset('USDT'), 'USDT');
  assert.equal(parseRewardAsset('ETH'), 'ETH');
  assert.throws(() => parseRewardAsset('TRX'), /TON, USDT, or ETH/);
});