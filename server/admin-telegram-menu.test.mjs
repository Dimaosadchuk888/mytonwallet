import test from 'node:test';
import assert from 'node:assert/strict';
import { parseAdminTelegramCommand } from './admin-telegram.mjs';
import {
  ADMIN_BOT_COMMANDS, adminMenuKeyboard, createAdminBotMenu, registerAdminBotCommands,
} from './admin-telegram-menu.mjs';

const owner = '0x1111111111111111111111111111111111111111';
const recipient = '0x2222222222222222222222222222222222222222';
function fixture() {
  let time = 1_000_000;
  const menu = createAdminBotMenu({
    parseCommand: parseAdminTelegramCommand,
    listWallets: async () => [{ owner_address: owner, status: 'active' }],
    getRecipients: async () => [recipient],
    now: () => time,
  });
  return { menu, advance: (ms) => { time += ms; } };
}
test('Telegram menu commands use valid underscore names, not legacy hyphens', () => {
  for (const entry of ADMIN_BOT_COMMANDS) {
    assert.match(entry.command, /^[a-z0-9_]{1,32}$/);
    assert.ok(entry.description.length <= 256);
  }
  assert.ok(adminMenuKeyboard().keyboard.flat().some((button) => button.text === 'Ручное списание'));
  assert.ok(!adminMenuKeyboard().keyboard.flat().some((button) => button.text.includes('CONFIRM')));
});
test('command menu registration is private-chat scoped and checks Telegram result', async () => {
  let payload;
  await registerAdminBotCommands({
    token: 'test-only',
    telegramFetch: async (url, options) => {
      assert.ok(url.endsWith('/setMyCommands'));
      payload = JSON.parse(options.body);
      return { ok: true, json: async () => ({ ok: true }) };
    },
  });
  assert.equal(payload.scope.type, 'all_private_chats');
  assert.deepEqual(payload.commands, ADMIN_BOT_COMMANDS);
  await assert.rejects(registerAdminBotCommands({
    token: 'test-only',
    telegramFetch: async () => ({ ok: true, status: 200, json: async () => ({ ok: false }) }),
  }), /registration failed/);
});
test('resume button only requests instructions, never supplies CONFIRM', async () => {
  const { menu } = fixture();
  assert.deepEqual(await menu.resolve('Снять глобальную паузу', '123'), {
    command: { command: 'autodebit', args: 'resume' },
  });
});
test('user input validates IDs, is scoped by administrator, and supports cancellation', async () => {
  const { menu } = fixture();
  assert.ok((await menu.resolve('Найти пользователя', '123')).response);
  await assert.rejects(menu.resolve('bad-id', '123'), /только цифры/);
  assert.ok((await menu.resolve('456', 'other-admin')).response);
  assert.deepEqual(await menu.resolve('456', '123'), { command: { command: 'user', args: '456' } });
  await menu.resolve('Баланс пользователя', '123');
  await menu.resolve('/cancel', '123');
  assert.ok((await menu.resolve('456', '123')).response);
});
test('guided input expires and restarts with a fresh prompt', async () => {
  const { menu, advance } = fixture();
  await menu.resolve('/user', '123');
  advance(300_001);
  assert.match((await menu.resolve('456', '123')).response.text, /истекло/);
  assert.ok((await menu.resolve('/balance', '123')).response);
});
test('manual charge form requires a linked wallet, exact amount, allowed recipient and reason', async () => {
  const { menu } = fixture();
  await menu.resolve('/charge_preview', '123');
  const walletPrompt = await menu.resolve('456', '123');
  assert.equal(walletPrompt.response.reply_markup.keyboard[0][0].text, owner);
  await assert.rejects(menu.resolve(recipient, '123'), /связанный кошелёк/);
  await menu.resolve(owner, '123');
  await assert.rejects(menu.resolve('10.0000001', '123'), /6 decimal/);
  const recipientPrompt = await menu.resolve('10.5', '123');
  assert.equal(recipientPrompt.response.reply_markup.keyboard[0][0].text, recipient);
  await assert.rejects(menu.resolve(owner, '123'), /разрешённом списке/);
  await menu.resolve(recipient, '123');
  await assert.rejects(menu.resolve('', '123'), /причину/);
  assert.deepEqual(await menu.resolve('Test charge', '123'), {
    command: { command: 'charge-preview', args: `456 ${owner} 10.5 ${recipient} Test charge` },
  });
});
test('list navigation, user shortcuts and explicit confirmation/cancellation buttons are generated', async () => {
  const { menu } = fixture();
  const page = menu.decorate({ command: 'users', args: '2' }, 'Users');
  assert.deepEqual(page.reply_markup.keyboard[0], [{ text: '/users 1' }, { text: '/users 3' }]);
  const user = menu.decorate({ command: 'user', args: '456' }, 'User');
  assert.deepEqual(user.reply_markup.keyboard[0], [{ text: '/balance 456' }, { text: '/autodebit 456' }]);
  const code = 'AABBCCDDEEFF0011';
  const preview = menu.decorate({ command: 'charge-preview', args: '' }, `/charge-confirm ${code}`);
  assert.equal(preview.reply_markup.keyboard[0][0].text, `Подтвердить списание ${code}`);
  assert.equal((await menu.resolve(`Подтвердить списание ${code}`, '123')).command.command, 'charge-confirm');
  assert.equal((await menu.resolve(`Отменить списание ${code}`, '123')).command.command, 'charge-cancel');
  assert.equal((await menu.resolve('/charge_confirm '+code, '123')).command.command, 'charge-confirm');
});