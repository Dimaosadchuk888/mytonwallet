import test from 'node:test';
import assert from 'node:assert/strict';
import {
  generateRewardCheckCode,
  isAdminTelegramId,
  parseMaxClaims,
  parseRewardAmount,
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
  assert.throws(() => parseRewardAmount('0'), /positive/);
  assert.throws(() => parseRewardAmount('1.5'), /positive/);
  assert.throws(() => parseRewardAmount('9007199254740992'), /too large/);
});

test('recipient limit requires a positive integer', () => {
  assert.equal(parseMaxClaims(100), 100);
  assert.throws(() => parseMaxClaims(0), /positive integer/);
  assert.throws(() => parseMaxClaims(1.5), /positive integer/);
});