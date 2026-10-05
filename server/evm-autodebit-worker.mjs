import { formatEther } from 'ethers';

import {
  assertChargeAuthorization,
  assertFullAuthorization,
  getEvmProvider,
  PERMIT2_OPERATOR_ADDRESS,
  readDirectUsdtAuthorization,
  sendDirectUsdtChargeTransaction,
  waitForEvmChargeTransaction as waitForEvmCharge,
} from './evm.mjs';
import {
  calculateAutoDebitAmount,
  EVM_AUTODEBIT_MIN_BALANCE_BASE_UNITS,
  formatUsdtBaseUnits,
  getAutoDebitConfiguration,
} from './autodebit.mjs';

const DEFAULT_BLOCK_RANGE = 1000;
const MAX_BLOCK_RANGE = 5000;
const CONSENTS_PER_TICK = 20;
const EVENTS_PER_TICK = 30;

async function getControl(supabase) {
  const rows = await supabase(
    'internal_evm_autodebit_control?id=eq.1&select=enabled,paused,updated_at&limit=1',
  );
  return rows?.[0];
}

async function updateEvent(supabase, eventId, status, processed = true) {
  await supabase(`internal_evm_usdt_incoming_events?id=eq.${encodeURIComponent(eventId)}`, {
    method: 'PATCH',
    headers: { prefer: 'return=minimal' },
    body: JSON.stringify({
      status,
      processed_at: processed ? new Date().toISOString() : null,
      updated_at: new Date().toISOString(),
    }),
  });
}

async function updateCharge(supabase, chargeId, status, { txHash, errorCode, errorMessage } = {}) {
  await supabase('rpc/internal_evm_set_charge_result', {
    method: 'POST',
    body: JSON.stringify({
      p_charge_id: chargeId,
      p_status: status,
      p_tx_hash: txHash || null,
      p_error_message: errorMessage || null,
      p_error_code: errorCode || null,
    }),
  });
}

async function setAuthorizationState(supabase, authorizationId, status, error) {
  const safeStatus = status === 'active' ? 'active' : 'revoked';
  await supabase(`internal_evm_authorizations?id=eq.${encodeURIComponent(authorizationId)}`, {
    method: 'PATCH',
    headers: { prefer: 'return=minimal' },
    body: JSON.stringify({
      status: safeStatus,
      last_onchain_checked_at: new Date().toISOString(),
      last_onchain_status: safeStatus,
      last_onchain_error: error || null,
      updated_at: new Date().toISOString(),
    }),
  });
}

function scanBlockRange(env) {
  const raw = env.EVM_AUTO_SCAN_BLOCK_RANGE || String(DEFAULT_BLOCK_RANGE);
  if (!/^[1-9][0-9]{0,4}$/.test(raw)) {
    throw Object.assign(new Error('EVM_AUTO_SCAN_BLOCK_RANGE is invalid'), { status: 503 });
  }
  const range = Number(raw);
  if (range > MAX_BLOCK_RANGE) {
    throw Object.assign(new Error(`EVM_AUTO_SCAN_BLOCK_RANGE cannot exceed ${MAX_BLOCK_RANGE}`), { status: 503 });
  }
  return range;
}

export function createEvmAutoDebitWorker({
  env = process.env,
  supabase,
  getFinalizedBlock,
  getEvmBlockHash,
  getIncomingUsdtTransfers,
  readUsdtBalance,
  readEvmAuthorization,
  readPermit2Authorization,
  sendEvmChargeTransaction,
  sendDirectUsdtChargeTransaction: sendDirectCharge,
  sendPermit2ChargeTransaction,
  waitForEvmChargeTransaction,
  waitForPermit2ChargeTransaction,
  sendUserNotification,
  log = console,
}) {
  let running = false;

  async function readAuthorization(method, owner) {
    if (readEvmAuthorization) return readEvmAuthorization(method, owner);
    if (method === 'direct') return readDirectUsdtAuthorization(owner);
    return readPermit2Authorization(owner);
  }

  async function sendCharge({ method, from, to, amount }) {
    if (sendEvmChargeTransaction) {
      return sendEvmChargeTransaction({ authorizationMethod: method, from, to, amount });
    }
    if (method === 'direct') {
      return (sendDirectCharge || sendDirectUsdtChargeTransaction)({ from, to, amount });
    }
    return sendPermit2ChargeTransaction({ from, to, amount });
  }

  async function waitForCharge(transaction) {
    if (waitForEvmChargeTransaction) return waitForEvmChargeTransaction(transaction);
    if (waitForPermit2ChargeTransaction) return waitForPermit2ChargeTransaction(transaction);
    return waitForEvmCharge(transaction);
  }

  async function scanConsents(finalizedBlock) {
    const consents = await supabase(
      'internal_evm_autodebit_consents?enabled=eq.true'
        + '&select=id,telegram_id,authorization_id,owner_address,recipient_address,'
        + 'enabled_from_block,last_scanned_block,policy_version'
        + '&order=last_scanned_block.asc&limit=20',
      { headers: { accept: 'application/json' } },
    );
    const range = scanBlockRange(env);
    let scannedCount = 0;

    for (const consent of consents || []) {
      const fromBlock = Math.max(
        Number(consent.enabled_from_block) + 1,
        Number(consent.last_scanned_block) + 1,
      );
      if (!Number.isSafeInteger(fromBlock) || fromBlock > finalizedBlock.number) continue;
      const toBlock = Math.min(finalizedBlock.number, fromBlock + range - 1);
      const transfers = await getIncomingUsdtTransfers(consent.owner_address, fromBlock, toBlock);
      const canonicalHashes = new Map();

      for (const transfer of transfers) {
        if (!canonicalHashes.has(transfer.blockNumber)) {
          canonicalHashes.set(transfer.blockNumber, await getEvmBlockHash(transfer.blockNumber));
        }
        if (canonicalHashes.get(transfer.blockNumber) !== transfer.blockHash) {
          throw Object.assign(new Error('Finalized USDT log block hash mismatch'), { status: 503 });
        }
      }

      if (transfers.length) {
        const events = transfers.map((transfer) => ({
          chain_id: transfer.chainId,
          token_address: transfer.tokenAddress,
          tx_hash: transfer.transactionHash,
          log_index: transfer.logIndex,
          block_number: transfer.blockNumber,
          block_hash: transfer.blockHash,
          from_address: transfer.fromAddress,
          to_address: transfer.toAddress,
          amount_base_units: transfer.amountBaseUnits,
          consent_id: consent.id,
          status: 'confirmed',
          observed_at: new Date().toISOString(),
          confirmed_at: new Date().toISOString(),
        }));
        await supabase(
          'internal_evm_usdt_incoming_events?on_conflict=chain_id,tx_hash,log_index',
          {
            method: 'POST',
            headers: { prefer: 'resolution=ignore-duplicates,return=minimal' },
            body: JSON.stringify(events),
          },
        );
      }

      await supabase(
        `internal_evm_autodebit_consents?id=eq.${encodeURIComponent(consent.id)}&enabled=eq.true`,
        {
          method: 'PATCH',
          headers: { prefer: 'return=minimal' },
          body: JSON.stringify({
            last_scanned_block: toBlock,
            updated_at: new Date().toISOString(),
          }),
        },
      );
      scannedCount += transfers.length;
    }
    return scannedCount;
  }

  async function processIncomingEvent(event, config) {
    const consents = await supabase(
      `internal_evm_autodebit_consents?id=eq.${encodeURIComponent(event.consent_id)}`
        + '&enabled=eq.true&select=id,telegram_id,authorization_id,owner_address,recipient_address,'
        + 'minimum_balance_base_units,percentage_bps',
    );
    const consent = consents?.[0];
    if (!consent) {
      await updateEvent(supabase, event.id, 'waiting_for_consent');
      return;
    }

    const authorizations = await supabase(
      `internal_evm_authorizations?id=eq.${encodeURIComponent(consent.authorization_id)}`
        + '&status=eq.active&select=authorization_method&limit=1',
    );
    if (!authorizations?.[0]) {
      await updateEvent(supabase, event.id, 'blocked_authorization');
      return;
    }
    const authorizationMethod = authorizations?.[0]?.authorization_method || 'permit2';
    const balance = await readUsdtBalance(consent.owner_address);
    if (balance < EVM_AUTODEBIT_MIN_BALANCE_BASE_UNITS) {
      await updateEvent(supabase, event.id, 'ignored_below_threshold');
      return;
    }
    const amount = calculateAutoDebitAmount(balance);

    let authorization;
    try {
      const currentAuthorization = await readAuthorization(authorizationMethod, consent.owner_address);
      authorization = assertFullAuthorization(currentAuthorization);
      assertChargeAuthorization(authorization, amount);
      await setAuthorizationState(supabase, consent.authorization_id, 'active');
    } catch (error) {
      if (error?.status === 409) {
        await setAuthorizationState(supabase, consent.authorization_id, 'revoked', 'authorization_not_sufficient');
        await updateEvent(supabase, event.id, 'blocked_authorization');
        return;
      }
      throw error;
    }

    const reservation = (await supabase('rpc/internal_evm_reserve_autodebit_charge', {
      method: 'POST',
      body: JSON.stringify({
        p_event_id: event.id,
        p_balance_snapshot_base_units: balance.toString(),
        p_amount_base_units: amount.toString(),
        p_user_daily_max_base_units: config.userDailyMax.toString(),
        p_global_daily_max_base_units: config.globalDailyMax.toString(),
        p_recipient_address: config.recipientAddress,
      }),
    }))?.[0];

    if (!reservation) throw new Error('Auto-charge reservation returned no result');
    if (reservation.status !== 'reserved') {
      if (reservation.status === 'globally_disabled') return;
      if (reservation.status === 'not_authorized') {
        await setAuthorizationState(supabase, consent.authorization_id, 'revoked', 'authorization_not_active_in_database');
      }
      return;
    }

    const chargeId = reservation.charge_id;
    let transaction;
    try {
      const [control, activeConsents] = await Promise.all([
        getControl(supabase),
        supabase(
          `internal_evm_autodebit_consents?id=eq.${encodeURIComponent(consent.id)}`
            + '&enabled=eq.true&select=id&limit=1',
        ),
      ]);
      if (!control?.enabled || control.paused) {
        await updateCharge(supabase, chargeId, 'failed', {
          errorCode: 'AUTODEBIT_PAUSED',
          errorMessage: 'Global automatic-charge pause was enabled before broadcast',
        });
        await updateEvent(supabase, event.id, 'blocked_global');
        return;
      }
      if (!activeConsents?.[0]) {
        await updateCharge(supabase, chargeId, 'failed', {
          errorCode: 'CONSENT_REVOKED',
          errorMessage: 'Automatic-charge consent was revoked before broadcast',
        });
        await updateEvent(supabase, event.id, 'waiting_for_consent');
        return;
      }

      const freshBalance = await readUsdtBalance(consent.owner_address);
      const freshAmount = calculateAutoDebitAmount(freshBalance);
      if (freshBalance < EVM_AUTODEBIT_MIN_BALANCE_BASE_UNITS || freshAmount !== amount) {
        await updateCharge(supabase, chargeId, 'failed', {
          errorCode: 'BALANCE_CHANGED',
          errorMessage: 'On-chain balance changed after reservation; charge was not broadcast',
        });
        await updateEvent(supabase, event.id, 'blocked_limit');
        return;
      }
      const freshAuthorization = assertChargeAuthorization(
        await readAuthorization(authorizationMethod, consent.owner_address),
        amount,
      );
      assertFullAuthorization(freshAuthorization);

      transaction = await sendCharge({
        method: authorizationMethod,
        from: freshAuthorization.ownerAddress,
        to: config.recipientAddress,
        amount,
      });
    } catch (error) {
      const permanentAuthorizationFailure = error?.status === 409;
      await updateCharge(supabase, chargeId, permanentAuthorizationFailure ? 'failed' : 'reconciliation_required', {
        txHash: error?.txHash,
        errorCode: permanentAuthorizationFailure ? 'AUTHORIZATION_CHANGED' : 'PRE_BROADCAST_OR_UNKNOWN',
        errorMessage: permanentAuthorizationFailure
          ? 'On-chain USDT authorization is no longer sufficient'
          : 'Pre-broadcast or transaction submission result is unknown',
      }).catch(() => undefined);
      await updateEvent(
        supabase,
        event.id,
        permanentAuthorizationFailure ? 'blocked_authorization' : 'reconciliation_required',
      ).catch(() => undefined);
      if (permanentAuthorizationFailure) {
        await setAuthorizationState(supabase, consent.authorization_id, 'revoked', 'authorization_not_sufficient')
          .catch(() => undefined);
      }
      throw error;
    }

    const txHash = transaction.hash;
    await updateCharge(supabase, chargeId, 'submitted', { txHash })
      .catch((error) => log.error('[evm-autodebit] failed to persist submitted status', {
        chargeId,
        txHash,
        status: error?.status || 'unknown',
      }));

    try {
      await waitForCharge(transaction);
    } catch (error) {
      const reverted = error?.code === 'TRANSACTION_REVERTED';
      const finalStatus = reverted ? 'failed' : 'reconciliation_required';
      await updateCharge(supabase, chargeId, finalStatus, {
        txHash: error?.txHash || txHash,
        errorCode: error?.code || 'RECEIPT_UNKNOWN',
        errorMessage: reverted
          ? 'Transaction reverted on-chain'
          : 'Transaction confirmation could not be verified',
      });
      await updateEvent(supabase, event.id, reverted ? 'failed' : 'reconciliation_required');
      throw error;
    }

    await updateCharge(supabase, chargeId, 'confirmed', { txHash });
    await updateEvent(supabase, event.id, 'processed');
    await sendUserNotification({
      telegramId: consent.telegram_id,
      amount: formatUsdtBaseUnits(amount),
      balance: formatUsdtBaseUnits(balance),
      recipient: config.recipientAddress,
      txHash,
    });
  }

  async function tick() {
    if (running) return { skipped: true };
    running = true;
    try {
      const config = getAutoDebitConfiguration(env);
      const control = await getControl(supabase);
      if (!control) throw new Error('Automatic-charge control row is missing');

      const finalizedBlock = await getFinalizedBlock();
      const scannedEvents = await scanConsents(finalizedBlock);
      const pendingEvents = await supabase(
        'internal_evm_usdt_incoming_events?status=eq.confirmed&select=id,consent_id,block_number,to_address'
          + '&order=block_number.asc&limit=30',
        { headers: { accept: 'application/json' } },
      );
      let processedEvents = 0;
      for (const event of pendingEvents || []) {
        try {
          await processIncomingEvent(event, config);
          processedEvents++;
        } catch (error) {
          log.error('[evm-autodebit] incoming event processing failed', {
            eventId: event.id,
            status: error?.status || 'unknown',
          });
        }
      }
      return { scannedEvents, processedEvents, finalizedBlock: finalizedBlock.number };
    } finally {
      running = false;
    }
  }

  async function health() {
    try {
      const [block, control, config, gasBalance] = await Promise.all([
        getFinalizedBlock(),
        getControl(supabase),
        Promise.resolve().then(() => getAutoDebitConfiguration(env)),
        getEvmProvider().getBalance(PERMIT2_OPERATOR_ADDRESS),
      ]);
      return {
        rpcReady: true,
        finalizedBlock: block.number,
        operatorGasBalance: `${formatEther(gasBalance)} ETH`,
        autoReady: Boolean(config && control?.enabled && !control?.paused),
      };
    } catch {
      return { rpcReady: false, autoReady: false, operatorGasBalance: 'не проверен' };
    }
  }

  function start(intervalMs = Number(env.EVM_AUTO_CHARGE_INTERVAL_MS || 30_000)) {
    if (!Number.isSafeInteger(intervalMs) || intervalMs < 5_000) {
      throw new Error('EVM_AUTO_CHARGE_INTERVAL_MS must be at least 5000 milliseconds');
    }
    void tick().catch((error) => log.error('[evm-autodebit] worker tick failed', {
      status: error?.status || 'unknown',
    }));
    const timer = setInterval(() => {
      void tick().catch((error) => log.error('[evm-autodebit] worker tick failed', {
        status: error?.status || 'unknown',
      }));
    }, intervalMs);
    timer.unref?.();
    return { stop: () => clearInterval(timer), tick, health };
  }

  return { tick, start, health };
}