import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createAdminTelegramWebhook,
  parseAdminTelegramCommand,
  timingSafeSecretEquals,
} from './admin-telegram.mjs';

test('admin Telegram command parser accepts names, arguments, and bot mentions', () => {
  assert.deepEqual(parseAdminTelegramCommand('/stats'), { command: 'stats', args: '' });
  assert.deepEqual(parseAdminTelegramCommand('/charge-preview@private_bot 123'), {
    command: 'charge-preview',
    args: '123',
  });
  assert.deepEqual(parseAdminTelegramCommand('/charge-confirm A1B2C3D4'), {
    command: 'charge-confirm',
    args: 'A1B2C3D4',
  });
  assert.deepEqual(parseAdminTelegramCommand('/users 2'), { command: 'users', args: '2' });
});

test('admin Telegram command parser rejects ordinary text and malformed commands', () => {
  assert.equal(parseAdminTelegramCommand('stats'), undefined);
  assert.equal(parseAdminTelegramCommand('/ bad'), undefined);
  assert.equal(parseAdminTelegramCommand(undefined), undefined);
});

test('Telegram webhook secret comparison requires exact, non-empty, constant-time-sized values', () => {
  assert.equal(timingSafeSecretEquals('webhook-secret', 'webhook-secret'), true);
  assert.equal(timingSafeSecretEquals('webhook-secret', 'wrong-secret'), false);
  assert.equal(timingSafeSecretEquals('webhook-secret', 'short'), false);
  assert.equal(timingSafeSecretEquals('', ''), false);
});

test('admin Telegram webhook rejects requests with no Telegram secret before reading the body', async () => {
  const webhook = createAdminTelegramWebhook({
    env: {
      ADMIN_BOT_TOKEN: 'not-used',
      ADMIN_BOT_WEBHOOK_SECRET: 'expected-secret',
    },
    supabase: async () => [],
    isAdmin: () => true,
  });
  const response = {
    status: undefined,
    writeHead(status) {
      this.status = status;
    },
    end() {},
  };
  const request = {
    url: '/telegram/admin-webhook',
    method: 'POST',
    headers: {},
    async *[Symbol.asyncIterator]() {
      throw new Error('The request body must not be read');
    },
  };

  assert.equal(await webhook(request, response), true);
  assert.equal(response.status, 401);
});