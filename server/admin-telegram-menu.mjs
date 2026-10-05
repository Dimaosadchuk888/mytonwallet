import { normalizeEvmAddress } from './evm.mjs';
import { parseUsdtAmountToBaseUnits } from './autodebit.mjs';

export const ADMIN_BOT_COMMANDS = [
  { command: 'start', description: 'Открыть меню администратора' },
  { command: 'stats', description: 'Общая сводка' },
  { command: 'users', description: 'Список пользователей' },
  { command: 'user', description: 'Карточка пользователя по Telegram ID' },
  { command: 'approved', description: 'Разрешения кошельков и проверка on-chain' },
  { command: 'balance', description: 'Баланс пользователя по Telegram ID' },
  { command: 'charges', description: 'Журнал списаний' },
  { command: 'autodebit', description: 'Согласия и глобальное состояние автосписания' },
  { command: 'charge_preview', description: 'Предпросмотр ручного списания' },
  { command: 'charge_confirm', description: 'Подтвердить операцию одноразовым кодом' },
  { command: 'charge_cancel', description: 'Отменить предпросмотр одноразовым кодом' },
  { command: 'health', description: 'Проверить RPC, gas и глобальную паузу' },
  { command: 'cancel', description: 'Закрыть пошаговый ввод' },
  { command: 'help', description: 'Справка по командам' },
];

export async function registerAdminBotCommands({ token, telegramFetch = fetch }) {
  const response = await telegramFetch(`https://api.telegram.org/bot${token}/setMyCommands`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ commands: ADMIN_BOT_COMMANDS, scope: { type: 'all_private_chats' } }),
    signal: AbortSignal.timeout(10_000),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || !result.ok) {
    throw Object.assign(new Error('Admin bot command menu registration failed'), { status: response.status });
  }
}

const ROWS = [
  ['Сводка', 'Пользователи'],
  ['Разрешения кошельков', 'История списаний'],
  ['Найти пользователя', 'Баланс пользователя'],
  ['Согласия пользователя', 'Автосписание'],
  ['Ручное списание', 'Состояние системы'],
  ['Остановить автосписание', 'Снять глобальную паузу'],
  ['Помощь', 'Отмена'],
];
const BUTTON_COMMANDS = {
  'Сводка': { command: 'stats', args: '' },
  'Пользователи': { command: 'users', args: '' },
  'Разрешения кошельков': { command: 'approved', args: '' },
  'История списаний': { command: 'charges', args: '' },
  'Автосписание': { command: 'autodebit', args: '' },
  'Состояние системы': { command: 'health', args: '' },
  'Остановить автосписание': { command: 'autodebit', args: 'pause' },
  // Opening this action only displays instructions. It never resumes charging.
  'Снять глобальную паузу': { command: 'autodebit', args: 'resume' },
  'Помощь': { command: 'help', args: '' },
};
const FORMS = {
  'Найти пользователя': 'user',
  'Баланс пользователя': 'balance',
  'Согласия пользователя': 'autodebit',
  'Ручное списание': 'charge-preview',
};
const ALIASES = {
  charge_preview: 'charge-preview',
  charge_confirm: 'charge-confirm',
  charge_cancel: 'charge-cancel',
};
const TTL = 5 * 60 * 1000;

export function adminMenuKeyboard(extraRows = []) {
  return {
    keyboard: [...extraRows, ...ROWS].map((row) => row.map((text) => ({ text }))),
    resize_keyboard: true,
    is_persistent: true,
    input_field_placeholder: 'Выберите действие или введите команду',
  };
}

function inputError(message) {
  return Object.assign(new Error(message), { status: 400 });
}

export function createAdminBotMenu({ parseCommand, listWallets, getRecipients, now = Date.now }) {
  const sessions = new Map();
  function startForm(id, command) {
    for (const [key, session] of sessions) {
      if (session.expiresAt <= now()) sessions.delete(key);
    }
    if (sessions.size >= 500) sessions.delete(sessions.keys().next().value);
    sessions.set(id, { command, values: [], expiresAt: now() + TTL, options: [] });
    return prompt(sessions.get(id));
  }
  function prompt(session) {
    const steps = [
      'Введите Telegram ID пользователя (только цифры).',
      'Выберите Ethereum-кошелёк с активной записью в базе. On-chain разрешение будет проверено перед предпросмотром.',
      'Введите сумму USDT, например 10.5 (не больше 6 знаков после точки).',
      'Выберите получателя из разрешённого списка.',
      'Введите причину списания (до 200 символов).',
    ];
    return {
      response: {
        text: steps[session.values.length] + '\nДля выхода нажмите «Отмена» или отправьте /cancel.',
        reply_markup: {
          keyboard: [...session.options.map((text) => [{ text }]), [{ text: 'Отмена' }]],
          resize_keyboard: true,
          input_field_placeholder: 'Ответьте на текущий вопрос',
        },
      },
    };
  }
  async function resolve(text, id) {
    const value = text.trim();
    const explicit = parseCommand(value);
    if (value === 'Отмена' || explicit?.command === 'cancel') {
      sessions.delete(id);
      return { response: { text: 'Пошаговый ввод закрыт. Для отмены предпросмотра используйте его отдельную кнопку отмены.', reply_markup: adminMenuKeyboard() } };
    }
    if (explicit) {
      const command = { ...explicit, command: ALIASES[explicit.command] || explicit.command };
      sessions.delete(id);
      if (['user', 'balance', 'charge-preview'].includes(command.command) && !command.args.trim()) {
        return startForm(id, command.command);
      }
      return { command };
    }
    if (BUTTON_COMMANDS[value]) {
      sessions.delete(id);
      return { command: BUTTON_COMMANDS[value] };
    }
    const confirmation = value.match(/^(Подтвердить|Отменить) списание ([A-F0-9]{16})$/);
    if (confirmation) {
      sessions.delete(id);
      return { command: { command: confirmation[1] === 'Подтвердить' ? 'charge-confirm' : 'charge-cancel', args: confirmation[2] } };
    }
    if (FORMS[value]) return startForm(id, FORMS[value]);
    const session = sessions.get(id);
    if (!session) return { response: { text: 'Выберите действие в меню или отправьте /help.', reply_markup: adminMenuKeyboard() } };
    if (session.expiresAt <= now()) {
      sessions.delete(id);
      return { response: { text: 'Время пошагового ввода истекло. Начните заново через меню.', reply_markup: adminMenuKeyboard() } };
    }
    const step = session.values.length;
    let normalized = value;
    if (step === 0 && !/^[0-9]{1,32}$/.test(value)) throw inputError('Telegram ID должен содержать только цифры.');
    if (session.command !== 'charge-preview') {
      sessions.delete(id);
      return { command: { command: session.command, args: value } };
    }
    if (step === 1 || step === 3) {
      normalized = normalizeEvmAddress(value, step === 1 ? 'wallet' : 'recipient');
      if (!session.options.some((address) => address.toLowerCase() === normalized)) {
        throw inputError(step === 1 ? 'Выберите активный связанный кошелёк этого пользователя.' : 'Получатель отсутствует в разрешённом списке.');
      }
    }
    if (step === 2) parseUsdtAmountToBaseUnits(value);
    if (step === 4 && (!value || value.length > 200)) throw inputError('Введите причину длиной от 1 до 200 символов.');
    // Fetch before committing the step so transient failures are safely retryable.
    let nextOptions = [];
    if (step === 0) {
      nextOptions = (await listWallets(value))
        .filter((wallet) => wallet.status === 'active')
        .map((wallet) => wallet.owner_address);
      if (!nextOptions.length) {
        sessions.delete(id);
        return { response: { text: 'У пользователя нет активных связанных EVM-кошельков. Списание не подготовлено.', reply_markup: adminMenuKeyboard() } };
      }
    }
    if (step === 2) nextOptions = await getRecipients();
    session.values.push(normalized);
    session.options = nextOptions;
    session.expiresAt = now() + TTL;
    if (step === 4) {
      sessions.delete(id);
      return { command: { command: 'charge-preview', args: session.values.join(' ') } };
    }
    return prompt(session);
  }
  function decorate(command, text) {
    const rows = [];
    if (['users', 'approved', 'charges'].includes(command.command)) {
      const page = Number(command.args.trim() || 1);
      const navigation = [];
      if (page > 1) navigation.push(`/${command.command} ${page - 1}`);
      if (page < 1000) navigation.push(`/${command.command} ${page + 1}`);
      if (navigation.length) rows.push(navigation);
    }
    if (command.command === 'user' && /^[0-9]{1,32}$/.test(command.args.trim())) {
      rows.push([`/balance ${command.args.trim()}`, `/autodebit ${command.args.trim()}`]);
    }
    if (command.command === 'charge-preview') {
      const code = text.match(/\/charge-confirm ([A-F0-9]{16})/)?.[1];
      if (code) rows.push([`Подтвердить списание ${code}`, `Отменить списание ${code}`]);
    }
    return { text, reply_markup: adminMenuKeyboard(rows) };
  }
  return { resolve, decorate };
}