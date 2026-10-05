import crypto from 'node:crypto';

import { normalizeEvmAddress, parseRecipientAllowlist } from './evm.mjs';
import { formatUsdtBaseUnits, parseUsdtAmountToBaseUnits } from './autodebit.mjs';
import { adminMenuKeyboard, createAdminBotMenu } from './admin-telegram-menu.mjs';

const MAX_UPDATE_BYTES = 64 * 1024;
const MAX_TELEGRAM_MESSAGE_LENGTH = 3900;
const CONFIRMATION_TTL_MS = 5 * 60 * 1000;
const WEBHOOK_PATH = '/telegram/admin-webhook';

export function timingSafeSecretEquals(expected, received) {
  if (typeof expected !== 'string' || typeof received !== 'string' || !expected || !received) return false;
  const left = Buffer.from(expected);
  const right = Buffer.from(received);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

export function parseAdminTelegramCommand(text) {
  if (typeof text !== 'string') return undefined;
  const match = text.trim().match(/^\/([a-z][a-z0-9_-]*)(?:@[a-z0-9_]+)?(?:\s+([\s\S]*))?$/i);
  if (!match) return undefined;
  return { command: match[1].toLowerCase(), args: match[2] || '' };
}

function escapeControlCharacters(value, maxLength = 300) {
  return String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, maxLength);
}

function formatDate(value) {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
}

function formatAddress(value) {
  return typeof value === 'string' && value.length > 14
    ? `${value.slice(0, 8)}…${value.slice(-6)}`
    : value || '—';
}

function parsePage(args) {
  if (!args.trim()) return 1;
  if (!/^[1-9][0-9]{0,3}$/.test(args.trim()) || Number(args.trim()) > 1000) {
    throw Object.assign(new Error('Page must be an integer from 1 to 1000'), { status: 400 });
  }
  return Number(args.trim());
}

function parseTelegramId(value) {
  if (typeof value !== 'string' || !/^[0-9]{1,32}$/.test(value)) {
    throw Object.assign(new Error('Telegram ID must contain digits only'), { status: 400 });
  }
  return value;
}

function hashConfirmationCode(code) {
  return crypto.createHash('sha256').update(code.toUpperCase()).digest('hex');
}

async function readJsonBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_UPDATE_BYTES) throw Object.assign(new Error('Telegram update is too large'), { status: 413 });
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw Object.assign(new Error('Invalid Telegram update'), { status: 400 });
  }
}

function sendHttp(res, status, value = '') {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
  res.end(value);
}

export function createAdminTelegramWebhook({
  env = process.env,
  supabase,
  isAdmin,
  readUsdtBalance,
  readPermit2Authorization,
  readEvmAuthorization = (_method, owner) => readPermit2Authorization(owner),
  isOnchainAuthorizationActive,
  previewManualCharge,
  executeManualCharge,
  getAutoDebitReadiness,
  getChainHealth,
  getManualChargeRecipients = () => [...parseRecipientAllowlist()],
  telegramFetch = fetch,
  clock = Date.now,
  log = console,
}) {
  const recentCommands = new Map();
  const menu = createAdminBotMenu({
    parseCommand: parseAdminTelegramCommand,
    listWallets: listUserWallets,
    getRecipients: getManualChargeRecipients,
    now: clock,
  });

  async function telegramSendMessage(chatId, text) {
    if (!env.ADMIN_BOT_TOKEN) throw new Error('Admin bot is not configured');
    const reply = typeof text === 'string' ? { text } : text;
    const response = await telegramFetch(`https://api.telegram.org/bot${env.ADMIN_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: String(reply.text).slice(0, MAX_TELEGRAM_MESSAGE_LENGTH),
        disable_web_page_preview: true,
        ...(reply.reply_markup ? { reply_markup: reply.reply_markup } : {}),
      }),
      signal: AbortSignal.timeout(10_000),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || !result.ok) {
      log.error('[admin-bot] Telegram sendMessage failed', { status: response.status });
      throw new Error('Telegram message delivery failed');
    }
  }

  async function audit(actorTelegramId, action, details = {}, outcome = 'ok') {
    try {
      await supabase('internal_admin_bot_audit_log', {
        method: 'POST',
        body: JSON.stringify({
          actor_telegram_id: actorTelegramId,
          action,
          target_telegram_id: details.targetTelegramId || null,
          owner_address: details.ownerAddress || null,
          charge_id: details.chargeId || null,
          details,
          outcome,
        }),
      });
    } catch (error) {
      log.error('[admin-bot] audit write failed', { status: error?.status || 'unknown' });
    }
  }

  async function listUserWallets(telegramId) {
    return (await supabase(
      `internal_evm_authorizations?telegram_id=eq.${encodeURIComponent(telegramId)}`
        + '&select=id,owner_address,status,verified_at,last_onchain_checked_at,last_onchain_status&order=updated_at.desc&limit=20',
      { headers: { accept: 'application/json' } },
    )) || [];
  }

  async function getUserAutodebitConsents(telegramId) {
    return (await supabase(
      `internal_evm_autodebit_consents?telegram_id=eq.${encodeURIComponent(telegramId)}`
        + '&select=owner_address,recipient_address,policy_version,enabled,accepted_at,revoked_at'
        + '&order=created_at.desc&limit=20',
      { headers: { accept: 'application/json' } },
    )) || [];
  }

  async function handleStats() {
    const rows = await supabase('rpc/internal_admin_bot_get_stats', {
      method: 'POST',
      body: '{}',
    });
    const stats = rows?.[0] || rows || {};
    return [
      'Сводка',
      `Зарегистрировано: ${stats.registered_users ?? '—'}`,
      `С EVM-кошельками: ${stats.users_with_evm_wallet ?? '—'}`,
      `Активные записи разрешений в БД: ${stats.active_db_wallets ?? '—'}`,
      `Активные согласия на автосписание: ${stats.active_autodebit_consents ?? '—'}`,
      `Операций сегодня: ${stats.charges_today ?? '—'} (ручных ${stats.manual_charges_today ?? '—'}, авто ${stats.auto_charges_today ?? '—'})`,
    ].join('\n');
  }

  async function handleUsers(args) {
    const page = parsePage(args);
    const limit = 10;
    const offset = (page - 1) * limit;
    const rows = await supabase(
      `internal_ton_users?select=telegram_id,created_at,last_login_at`
        + `&order=created_at.desc&limit=${limit}&offset=${offset}`,
      { headers: { accept: 'application/json' } },
    );
    if (!rows?.length) return `Страница ${page}: записей нет.`;
    return [`Пользователи · страница ${page}`, ...rows.map((row) => (
      `${row.telegram_id} · регистрация ${formatDate(row.created_at)} · вход ${formatDate(row.last_login_at)}`
    ))].join('\n');
  }

  async function handleUser(telegramId) {
    const id = parseTelegramId(telegramId.trim());
    const [users, wallets, consents, charges] = await Promise.all([
      supabase(`internal_ton_users?telegram_id=eq.${encodeURIComponent(id)}&select=telegram_id,created_at,last_login_at&limit=1`),
      listUserWallets(id),
      getUserAutodebitConsents(id),
      supabase(
        `internal_evm_charges?telegram_id=eq.${encodeURIComponent(id)}`
          + '&select=id,charge_type,amount_base_units,recipient_address,status,tx_hash,reason,requested_by_admin_telegram_id,created_at'
          + '&order=created_at.desc&limit=5',
      ),
    ]);
    if (!users?.[0]) return 'Пользователь не найден.';
    const walletLines = wallets.length
      ? wallets.map((wallet) => (
        `${formatAddress(wallet.owner_address)} · БД: ${wallet.status} · on-chain: ${wallet.last_onchain_status || 'не проверен'}`
      ))
      : ['EVM-кошельков нет'];
    const consentLines = consents.length
      ? consents.map((consent) => (
        `${formatAddress(consent.owner_address)} · автосписание ${consent.enabled ? 'включено' : 'отключено'}`
      ))
      : ['Согласия на автосписание нет'];
    const chargeLines = (charges || []).map((charge) => (
      `${formatUsdtBaseUnits(charge.amount_base_units)} USDT · ${charge.charge_type} · ${charge.status} · ${formatDate(charge.created_at)}`
      + `${charge.reason ? ` · ${escapeControlCharacters(charge.reason, 80)}` : ''}`
      + `${charge.tx_hash ? ` · ${charge.tx_hash}` : ''}`
    ));
    return [
      `Пользователь ${id}`,
      `Регистрация: ${formatDate(users[0].created_at)}`,
      `Последний вход: ${formatDate(users[0].last_login_at)}`,
      'Кошельки:',
      ...walletLines,
      'Согласия:',
      ...consentLines,
      'Последние списания:',
      ...(chargeLines.length ? chargeLines : ['нет']),
    ].join('\n');
  }

  async function handleApproved(args) {
    const page = parsePage(args);
    const limit = 10;
    const rows = await supabase(
      `internal_evm_authorizations?status=eq.active&select=telegram_id,owner_address,authorization_method,status,verified_at,last_onchain_checked_at,last_onchain_status`
        + `&order=updated_at.desc&limit=${limit}&offset=${(page - 1) * limit}`,
      { headers: { accept: 'application/json' } },
    );
    if (!rows?.length) return `Страница ${page}: EVM-разрешений нет.`;
    const lines = await Promise.all(rows.map(async (row) => {
      let currentStatus = 'не удалось проверить';
      try {
        currentStatus = isOnchainAuthorizationActive(
          await readEvmAuthorization(row.authorization_method, row.owner_address),
        )
          ? 'действует сейчас'
          : 'не действует сейчас';
      } catch {
        currentStatus = 'проверка недоступна';
      }
      return `${row.telegram_id} · ${formatAddress(row.owner_address)} · БД: ${row.status} · on-chain: ${currentStatus}`;
    }));
    return [`Кошельки с активной записью · страница ${page}`, ...lines].join('\n');
  }

  async function handleBalance(telegramId) {
    const id = parseTelegramId(telegramId.trim());
    const wallets = await listUserWallets(id);
    if (!wallets.length) return 'У пользователя нет связанных EVM-кошельков.';
    const lines = await Promise.all(wallets.map(async (wallet) => {
      try {
        const balance = await readUsdtBalance(wallet.owner_address);
        return `${formatAddress(wallet.owner_address)} · ${formatUsdtBaseUnits(balance)} on-chain USDT · проверено ${new Date().toISOString()}`;
      } catch {
        return `${formatAddress(wallet.owner_address)} · on-chain проверка недоступна`;
      }
    }));
    const internal = await supabase(
      `internal_usdt_balances?telegram_id=eq.${encodeURIComponent(id)}&currency=eq.USDT&select=amount,updated_at&limit=1`,
    );
    const internalAmount = internal?.[0]?.amount;
    return [
      `Ethereum Mainnet USDT · пользователь ${id}`,
      ...lines,
      `Внутренний USDT-баланс сервиса (отдельно): ${internalAmount ?? 'не найден'}`,
    ].join('\n');
  }

  async function handleCharges(args) {
    const page = parsePage(args);
    const rows = await supabase(
      `internal_evm_charges?select=id,telegram_id,charge_type,amount_base_units,recipient_address,status,tx_hash,reason,requested_by_admin_telegram_id,created_at`
        + `&order=created_at.desc&limit=10&offset=${(page - 1) * 10}`,
      { headers: { accept: 'application/json' } },
    );
    if (!rows?.length) return `Страница ${page}: списаний нет.`;
    return [
      `Списания · страница ${page}`,
      ...rows.map((row) => (
        `${row.telegram_id} · ${formatUsdtBaseUnits(row.amount_base_units)} USDT · ${row.charge_type}`
          + ` · ${row.status} · ${formatAddress(row.recipient_address)} · ${formatDate(row.created_at)}`
          + `${row.requested_by_admin_telegram_id ? ` · админ ${row.requested_by_admin_telegram_id}` : ''}`
          + `${row.reason ? ` · ${escapeControlCharacters(row.reason, 80)}` : ''}`
          + `${row.tx_hash ? ` · ${row.tx_hash}` : ''}`
      )),
    ].join('\n');
  }

  async function handleAutodebit(args, adminTelegramId) {
    const [subject, confirmation] = args.trim().split(/\s+/, 2);
    if (subject?.toLowerCase() === 'pause') {
      await supabase('internal_evm_autodebit_control?id=eq.1', {
        method: 'PATCH',
        headers: { prefer: 'return=minimal' },
        body: JSON.stringify({
          enabled: false,
          paused: true,
          updated_by_telegram_id: adminTelegramId,
          updated_at: new Date().toISOString(),
        }),
      });
      await audit(adminTelegramId, 'autodebit.pause');
      return 'Глобальная остановка включена. Новые автосписания заблокированы; уже отправленные транзакции отменить нельзя.';
    }
    if (subject?.toLowerCase() === 'resume') {
      if (confirmation?.toUpperCase() !== 'CONFIRM') {
        return 'Для снятия глобальной остановки отправьте отдельной командой: /autodebit resume CONFIRM';
      }
      const readiness = await getAutoDebitReadiness();
      if (!readiness?.ready) {
        throw Object.assign(new Error('Automatic-charge configuration is not ready'), { status: 503 });
      }
      await supabase('internal_evm_autodebit_control?id=eq.1', {
        method: 'PATCH',
        headers: { prefer: 'return=minimal' },
        body: JSON.stringify({
          enabled: true,
          paused: false,
          updated_by_telegram_id: adminTelegramId,
          updated_at: new Date().toISOString(),
        }),
      });
      await audit(adminTelegramId, 'autodebit.resume');
      return 'Глобальная остановка снята. Автосписание всё ещё зависит от серверного флага EVM_AUTO_CHARGE_ENABLED.';
    }
    if (!subject) {
      const [control, readiness] = await Promise.all([
        supabase('internal_evm_autodebit_control?id=eq.1&select=enabled,paused,updated_at&limit=1'),
        getAutoDebitReadiness().catch(() => ({ ready: false })),
      ]);
      const state = control?.[0];
      return [
        `Серверная конфигурация: ${readiness.ready ? 'готова' : 'не готова/выключена'}`,
        `Глобальное состояние: ${state?.paused ? 'пауза' : state?.enabled ? 'включено' : 'выключено'}`,
        'Команды: /autodebit pause · /autodebit resume CONFIRM · /autodebit <telegram_id>',
      ].join('\n');
    }
    const telegramId = parseTelegramId(subject);
    const [consents, wallets] = await Promise.all([
      getUserAutodebitConsents(telegramId),
      listUserWallets(telegramId),
    ]);
    if (!consents.length) return `Для пользователя ${telegramId} записей согласия нет.`;
    return [
      `Согласия на автосписание · пользователь ${telegramId}`,
      ...consents.map((consent) => (
        `${formatAddress(consent.owner_address)} · ${consent.enabled ? 'включено' : 'отозвано'}`
          + ` · адрес назначения ${formatAddress(consent.recipient_address)}`
          + ` · политика ${consent.policy_version}`
          + ` · принято ${formatDate(consent.accepted_at)}`
      )),
      `Активных записей разрешения в БД: ${wallets.filter((wallet) => wallet.status === 'active').length}`,
    ].join('\n');
  }

  async function handleChargePreview(args, adminTelegramId) {
    const parts = args.trim().split(/\s+/);
    if (parts.length < 5) {
      return 'Формат: /charge-preview <telegram_id> <кошелёк> <сумма_USDT> <адрес_из_allowlist> <причина>';
    }
    const [telegramIdRaw, ownerAddressRaw, amountRaw, recipientAddressRaw, ...reasonParts] = parts;
    const telegramId = parseTelegramId(telegramIdRaw);
    const ownerAddress = normalizeEvmAddress(ownerAddressRaw, 'ownerAddress');
    const recipientAddress = normalizeEvmAddress(recipientAddressRaw, 'recipientAddress');
    const amountBaseUnits = parseUsdtAmountToBaseUnits(amountRaw).toString();
    const reason = escapeControlCharacters(reasonParts.join(' '), 200);
    if (!reason) return 'Причина списания обязательна.';

    const preview = await previewManualCharge({
      telegramId,
      ownerAddress,
      amountBaseUnits,
      recipientAddress,
      reason,
    });
    const confirmationCode = crypto.randomBytes(8).toString('hex').toUpperCase();
    const idempotencyKey = `admin-bot:${crypto.randomBytes(24).toString('hex')}`;
    await supabase('internal_admin_bot_pending_actions', {
      method: 'POST',
      body: JSON.stringify({
        action_type: 'manual_evm_charge',
        confirmation_hash: hashConfirmationCode(confirmationCode),
        created_by_telegram_id: adminTelegramId,
        expires_at: new Date(clock() + CONFIRMATION_TTL_MS).toISOString(),
        payload: {
          telegramId,
          ownerAddress,
          amountBaseUnits,
          recipientAddress,
          reason,
          idempotencyKey,
        },
      }),
    });
    await audit(adminTelegramId, 'charge.preview', { targetTelegramId: telegramId, ownerAddress });
    return [
      'ПРЕДПРОСМОТР · транзакция ещё не отправлена',
      `Пользователь: ${telegramId}`,
      `Кошелёк: ${ownerAddress}`,
      `Сумма: ${formatUsdtBaseUnits(amountBaseUnits)} USDT`,
      `Баланс сейчас: ${formatUsdtBaseUnits(preview.balanceBaseUnits)} USDT`,
      `Получатель: ${recipientAddress}`,
      `Причина: ${reason}`,
      `Ограничения: разовый максимум ${formatUsdtBaseUnits(preview.maxChargeBaseUnits)} USDT; дневные лимиты проверяются повторно при подтверждении.`,
      `Чтобы выполнить показанную операцию в течение 5 минут, отправьте: /charge-confirm ${confirmationCode}`,
    ].join('\n');
  }

  async function handleChargeConfirm(codeRaw, adminTelegramId) {
    const code = codeRaw.trim().toUpperCase();
    if (!/^[A-F0-9]{16}$/.test(code)) return 'Код подтверждения недействителен или истёк.';
    const result = await supabase('rpc/internal_admin_bot_consume_pending_action', {
      method: 'POST',
      body: JSON.stringify({
        p_confirmation_hash: hashConfirmationCode(code),
        p_actor_telegram_id: adminTelegramId,
      }),
    });
    const action = result?.[0];
    if (action?.result_status !== 'consumed' || action.action_type !== 'manual_evm_charge') {
      return 'Код недействителен, истёк, уже использован или принадлежит другому администратору.';
    }

    const payload = typeof action.payload === 'string' ? JSON.parse(action.payload) : action.payload;
    try {
      const charge = await executeManualCharge({ ...payload, adminTelegramId });
      await audit(adminTelegramId, 'charge.confirm', {
        targetTelegramId: payload.telegramId,
        ownerAddress: payload.ownerAddress,
        chargeId: charge.id,
      });
      return [
        `Результат: ${charge.status}`,
        `Сумма: ${formatUsdtBaseUnits(payload.amountBaseUnits)} USDT`,
        `Кошелёк: ${payload.ownerAddress}`,
        `Получатель: ${payload.recipientAddress}`,
        charge.txHash ? `Tx: ${charge.txHash}` : 'Tx hash пока не получен; проверьте журнал перед повтором.',
      ].join('\n');
    } catch (error) {
      await audit(adminTelegramId, 'charge.confirm', {
        targetTelegramId: payload.telegramId,
        ownerAddress: payload.ownerAddress,
      }, 'error');
      log.error('[admin-bot] charge confirmation failed', { status: error?.status || 'unknown' });
      return 'Подтверждение использовано, но результат операции требует проверки. Сначала проверьте /charges; не повторяйте списание вслепую.';
    }
  }

  async function handleChargeCancel(codeRaw, adminTelegramId) {
    const code = codeRaw.trim().toUpperCase();
    if (!/^[A-F0-9]{16}$/.test(code)) return 'Код отмены недействителен.';
    const result = await supabase('rpc/internal_admin_bot_consume_pending_action', {
      method: 'POST',
      body: JSON.stringify({
        p_confirmation_hash: hashConfirmationCode(code),
        p_actor_telegram_id: adminTelegramId,
      }),
    });
    const action = result?.[0];
    if (action?.result_status !== 'consumed') {
      return 'Код недействителен, истёк, уже использован или принадлежит другому администратору. Отправленную транзакцию отменить нельзя.';
    }
    const payload = typeof action.payload === 'string' ? JSON.parse(action.payload) : action.payload;
    await audit(adminTelegramId, 'charge.cancel', {
      targetTelegramId: payload?.telegramId,
      ownerAddress: payload?.ownerAddress,
    });
    return 'Предпросмотр отменён, одноразовый код закрыт. Транзакция не отправлена.';
  }

  async function handleCommand(command, adminTelegramId) {
    switch (command.command) {
      case 'start':
      case 'help':
        return [
          'Команды администратора:',
          '/stats',
          '/users [страница]',
          '/user <telegram_id>',
          '/approved [страница]',
          '/balance <telegram_id>',
          '/charges [страница]',
          '/autodebit <telegram_id> · /autodebit pause · /autodebit resume CONFIRM',
          '/charge-preview <telegram_id> <кошелёк> <сумма_USDT> <адрес_из_allowlist> <причина>',
          '/charge-confirm <одноразовый_код>',
          '/charge-cancel <одноразовый_код>',
          '/health',
          '/cancel · закрыть пошаговый ввод',
          'Можно пользоваться кнопками меню. Ручное списание сначала показывает предпросмотр и требует отдельного подтверждения.',
        ].join('\n');
      case 'stats':
        await audit(adminTelegramId, 'stats.read');
        return handleStats();
      case 'users':
        await audit(adminTelegramId, 'users.list');
        return handleUsers(command.args);
      case 'user':
        await audit(adminTelegramId, 'user.read', { targetTelegramId: command.args.trim() });
        return handleUser(command.args);
      case 'approved':
        await audit(adminTelegramId, 'approvals.list');
        return handleApproved(command.args);
      case 'balance':
        await audit(adminTelegramId, 'balance.read', { targetTelegramId: command.args.trim() });
        return handleBalance(command.args);
      case 'charges':
        await audit(adminTelegramId, 'charges.list');
        return handleCharges(command.args);
      case 'autodebit':
        return handleAutodebit(command.args, adminTelegramId);
      case 'charge-preview':
        return handleChargePreview(command.args, adminTelegramId);
      case 'charge-confirm':
        return handleChargeConfirm(command.args, adminTelegramId);
      case 'charge-cancel':
        return handleChargeCancel(command.args, adminTelegramId);
      case 'health': {
        const health = await getChainHealth();
        const [control] = await supabase(
          'internal_evm_autodebit_control?id=eq.1&select=enabled,paused,updated_at&limit=1',
        );
        await audit(adminTelegramId, 'health.read');
        return [
          `Ethereum RPC: ${health.rpcReady ? `OK · finalized block ${health.finalizedBlock}` : 'недоступен'}`,
          `Баланс gas оператора: ${health.operatorGasBalance || 'не проверен'}`,
          `Автосписание: ${health.autoReady ? 'конфигурация готова' : 'выключено/не готово'}`,
          `Глобальная остановка: ${control?.paused ? 'активна' : control?.enabled ? 'снята' : 'включена по умолчанию'}`,
        ].join('\n');
      }
      default:
        return 'Неизвестная команда. Отправьте /help.';
    }
  }

  return async function handleAdminTelegramWebhook(req, res) {
    const requestPath = new URL(req.url || '/', 'http://internal.local').pathname;
    const configuredPath = env.ADMIN_BOT_WEBHOOK_PATH || WEBHOOK_PATH;
    if (requestPath !== configuredPath) return false;
    if (!env.ADMIN_BOT_TOKEN || !env.ADMIN_BOT_WEBHOOK_SECRET) {
      sendHttp(res, 404, 'Not found');
      return true;
    }
    if (req.method !== 'POST') {
      sendHttp(res, 405, 'Method not allowed');
      return true;
    }
    const receivedSecret = req.headers['x-telegram-bot-api-secret-token'];
    if (!timingSafeSecretEquals(env.ADMIN_BOT_WEBHOOK_SECRET, receivedSecret)) {
      sendHttp(res, 401, 'Unauthorized');
      return true;
    }

    let update;
    try {
      update = await readJsonBody(req);
    } catch (error) {
      sendHttp(res, error?.status || 400, 'Bad request');
      return true;
    }

    const message = update?.message;
    const senderId = message?.from?.id === undefined ? '' : String(message.from.id);
    const chatId = message?.chat?.id === undefined ? '' : String(message.chat.id);
    if (!message || message.chat?.type !== 'private' || senderId !== chatId) {
      sendHttp(res, 200, 'OK');
      return true;
    }
    if (!isAdmin(senderId)) {
      try {
        await telegramSendMessage(chatId, { text: 'Команда недоступна.', reply_markup: { remove_keyboard: true } });
      } catch {
        // Keep Telegram webhook delivery independent from response delivery.
      }
      sendHttp(res, 200, 'OK');
      return true;
    }

    if (typeof message.text !== 'string') {
      sendHttp(res, 200, 'OK');
      return true;
    }
    const currentTime = clock();
    if (currentTime - (recentCommands.get(senderId) || 0) < 700) {
      try {
        await telegramSendMessage(chatId, 'Слишком частые команды. Подождите секунду.');
      } catch {
        // The rate limit still applies if Telegram cannot deliver this response.
      }
      sendHttp(res, 200, 'OK');
      return true;
    }
    recentCommands.set(senderId, currentTime);
    if (recentCommands.size > 500) {
      const oldest = [...recentCommands.entries()].sort((a, b) => a[1] - b[1]).slice(0, 100);
      oldest.forEach(([id]) => recentCommands.delete(id));
    }

    let command;
    try {
      const selection = await menu.resolve(message.text, senderId);
      command = selection.command;
      const reply = selection.response || menu.decorate(command, await handleCommand(command, senderId));
      await telegramSendMessage(chatId, reply);
    } catch (error) {
      log.error('[admin-bot] command failed', {
        command: command?.command || 'menu',
        status: error?.status || 'unknown',
      });
      try {
        const clientError = error?.status >= 400 && error?.status < 500 && error instanceof Error
          ? error.message.slice(0, 300)
          : 'Операцию выполнить не удалось. Проверьте конфигурацию и журнал.';
        await telegramSendMessage(chatId, { text: clientError, reply_markup: adminMenuKeyboard() });
      } catch {
        // The update is acknowledged to avoid duplicate side effects on Telegram retries.
      }
    }
    sendHttp(res, 200, 'OK');
    return true;
  };
}