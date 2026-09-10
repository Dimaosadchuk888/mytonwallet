import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { verifyTelegramInitData, signSession, verifySession } from './telegram.mjs';

test('Telegram initData accepts a correctly signed fresh payload', () => {
  const token = 'test-token';
  const raw = 'auth_date=1700000000&user=%7B%22id%22%3A42%7D';
  const secret = crypto.createHmac('sha256', 'WebAppData').update(token).digest();
  const hash = crypto.createHmac('sha256', secret).update('auth_date=1700000000\nuser={"id":42}').digest('hex');
  assert.equal(verifyTelegramInitData(`${raw}&hash=${hash}`, token, 1700000000000).user.id, 42);
});

test('sessions reject tampering', () => {
  const session = signSession('42', 'secret', 1000);
  assert.equal(verifySession(session, 'secret', 10000, 2000), '42');
  assert.equal(verifySession(`${session}x`, 'secret', 10000, 2000), undefined);
});