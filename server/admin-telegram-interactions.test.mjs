import test from 'node:test';
import assert from 'node:assert/strict';
import { createAdminTelegramWebhook } from './admin-telegram.mjs';

const owner = '0x1111111111111111111111111111111111111111';
const recipient = '0x2222222222222222222222222222222222222222';
function fixture() {
  const messages = [];
  const requests = [];
  let pending;
  let executions = 0;
  let clock = 1_000_000;
  const webhook = createAdminTelegramWebhook({
    env: { ADMIN_BOT_TOKEN: 'test-only', ADMIN_BOT_WEBHOOK_SECRET: 'test-secret' },
    clock: () => clock,
    isAdmin: (id) => ['123', '456'].includes(id),
    log: { error() {} },
    telegramFetch: async (url, options) => {
      assert.ok(url.endsWith('/sendMessage'));
      messages.push(JSON.parse(options.body));
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    },
    supabase: async (path, options) => {
      const body = options?.body ? JSON.parse(options.body) : undefined;
      requests.push({ path, body });
      if (path === 'internal_admin_bot_pending_actions') {
        pending = { ...body, used: false };
        return [];
      }
      if (path === 'rpc/internal_admin_bot_consume_pending_action') {
        if (!pending || pending.confirmation_hash !== body.p_confirmation_hash) return [{ result_status: 'not_found' }];
        if (pending.created_by_telegram_id !== body.p_actor_telegram_id) return [{ result_status: 'wrong_actor' }];
        if (pending.used) return [{ result_status: 'already_used' }];
        if (new Date(pending.expires_at).getTime() <= clock) return [{ result_status: 'expired' }];
        pending.used = true;
        return [{ result_status: 'consumed', action_type: pending.action_type, payload: pending.payload }];
      }
      if (path.startsWith('internal_evm_authorizations?telegram_id')) {
        return [{ owner_address: owner, status: 'active' }];
      }
      if (path.startsWith('internal_evm_autodebit_control')) return [{ enabled: false, paused: true }];
      if (path === 'rpc/internal_admin_bot_get_stats') return { registered_users: 5 };
      return [];
    },
    getManualChargeRecipients: () => [recipient],
    previewManualCharge: async () => ({ balanceBaseUnits: '20000000', maxChargeBaseUnits: '100000000' }),
    executeManualCharge: async () => {
      executions += 1;
      return { id: 'test-charge', status: 'submitted', txHash: 'test-hash' };
    },
    getAutoDebitReadiness: async () => ({ ready: true }),
    getChainHealth: async () => ({ rpcReady: true, finalizedBlock: 12345, operatorGasBalance: '0.01 ETH' }),
  });
  async function send(text, sender = 123, type = 'private') {
    clock += 1000;
    const update = { message: { from: { id: sender }, chat: { id: sender, type }, text } };
    const req = {
      url: '/telegram/admin-webhook', method: 'POST',
      headers: { 'x-telegram-bot-api-secret-token': 'test-secret' },
      async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify(update)); },
    };
    const res = { writeHead(status) { this.status = status; }, end() {} };
    await webhook(req, res);
    assert.equal(res.status, 200);
    return messages.at(-1);
  }
  async function preview() {
    for (const text of ['Ручное списание', '789', owner, '10.5', recipient, 'Test reason']) await send(text);
    const result = messages.at(-1);
    assert.match(result.text, /транзакция ещё не отправлена/);
    return result.reply_markup.keyboard[0];
  }
  return { send, preview, requests, messages, executions: () => executions, advance: (ms) => { clock += ms; } };
}
test('authorized start and read-only buttons return the persistent menu', async () => {
  const f = fixture();
  for (const text of ['/start', 'Сводка', 'Пользователи', 'Разрешения кошельков', 'История списаний', 'Состояние системы', 'Автосписание']) {
    const reply = await f.send(text);
    assert.equal(reply.reply_markup.is_persistent, true);
    assert.ok(reply.reply_markup.keyboard.flat().some((button) => button.text === 'Ручное списание'));
  }
  assert.equal(f.executions(), 0);
});
test('non-admin gets no menu/data; group messages are ignored', async () => {
  const f = fixture();
  const denied = await f.send('Сводка', 999);
  assert.equal(denied.text, 'Команда недоступна.');
  assert.deepEqual(denied.reply_markup, { remove_keyboard: true });
  assert.equal(f.requests.length, 0);
  const before = f.messages.length;
  await f.send('/start', 123, 'group');
  assert.equal(f.messages.length, before);
});
test('resume menu button never changes global state, pause button is audited', async () => {
  const f = fixture();
  const reply = await f.send('Снять глобальную паузу');
  assert.match(reply.text, /resume CONFIRM/);
  assert.equal(f.requests.length, 0);
  await f.send('Остановить автосписание');
  assert.ok(f.requests.some((request) => request.path.startsWith('internal_evm_autodebit_control') && request.body.paused === true));
  assert.ok(f.requests.some((request) => request.body?.action === 'autodebit.pause'));
});
test('guided preview does not transfer; confirmation is actor-bound and single-use', async () => {
  const f = fixture();
  const buttons = await f.preview();
  assert.equal(f.executions(), 0);
  const denied = await f.send(buttons[0].text, 456);
  assert.match(denied.text, /другому администратору/);
  assert.equal(f.executions(), 0);
  await f.send(buttons[0].text);
  assert.equal(f.executions(), 1);
  await f.send(buttons[0].text);
  assert.equal(f.executions(), 1);
});
test('cancellation consumes the preview code without sending funds', async () => {
  const f = fixture();
  const buttons = await f.preview();
  const reply = await f.send(buttons[1].text);
  assert.match(reply.text, /Предпросмотр отменён/);
  await f.send(buttons[0].text);
  assert.equal(f.executions(), 0);
  assert.ok(f.requests.some((request) => request.body?.action === 'charge.cancel'));
});
test('expired confirmation and input cancellation cannot execute a charge', async () => {
  const f = fixture();
  const buttons = await f.preview();
  f.advance(300_001);
  await f.send(buttons[0].text);
  assert.equal(f.executions(), 0);
  await f.send('Ручное списание');
  await f.send('Отмена');
  await f.send('789');
  assert.equal(f.executions(), 0);
});
test('out-of-range page is rejected without a user-table query', async () => {
  const f = fixture();
  const reply = await f.send('/users 1001');
  assert.match(reply.text, /from 1 to 1000/);
  assert.ok(!f.requests.some((request) => request.path.startsWith('internal_ton_users?')));
});