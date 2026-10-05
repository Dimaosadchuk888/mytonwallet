import test from 'node:test';
import assert from 'node:assert/strict';

import { createEvmAutoDebitWorker } from './evm-autodebit-worker.mjs';

const recipient = '0x0000000000000000000000000000000000000001';
const owner = '0x0000000000000000000000000000000000000002';
const event = { id: 'event-1', consent_id: 'consent-1', block_number: 100, to_address: owner };
const consent = {
  id: 'consent-1',
  telegram_id: '123',
  authorization_id: 'authorization-1',
  owner_address: owner,
  recipient_address: recipient,
  minimum_balance_base_units: '10000000',
  percentage_bps: 9800,
};

function makeWorker({
  balance,
  authorization,
  control = { enabled: true, paused: false },
  reservationStatus = 'reserved',
  pendingEvents = [event],
  eventConsent = consent,
  authorizationMethod = 'permit2',
}) {
  const updatedEvents = [];
  const updatedAuthorizations = [];
  const chargeMethods = [];
  let reservationCalls = 0;
  let transactionCalls = 0;
  const env = {
    EVM_AUTO_CHARGE_ENABLED: '1',
    EVM_AUTO_CHARGE_RECIPIENT: recipient,
    EVM_CHARGE_RECIPIENT_ALLOWLIST: recipient,
    EVM_AUTO_CHARGE_DAILY_MAX_BASE_UNITS: '1000000000',
    EVM_AUTO_CHARGE_GLOBAL_DAILY_MAX_BASE_UNITS: '10000000000',
    SUPABASE_URL: 'https://example.invalid',
    SUPABASE_SERVICE_ROLE_KEY: 'test-only',
    EVM_MAINNET_RPC_URL: 'https://rpc.example.invalid',
    PERMIT2_OPERATOR_PRIVATE_KEY: 'test-only',
  };
  const supabase = async (path, options = {}) => {
    if (path.startsWith('internal_evm_autodebit_control?')) return [control];
    if (path.startsWith('internal_evm_autodebit_consents?enabled=eq.true')) return [];
    if (path.startsWith('internal_evm_usdt_incoming_events?status=eq.confirmed')) return pendingEvents;
    if (path.startsWith('internal_evm_autodebit_consents?id=eq.consent-1')) return [eventConsent];
    if (path.startsWith('internal_evm_authorizations?id=eq.authorization-1')) {
      if (path.includes('select=authorization_method')) {
        return [{ authorization_method: authorizationMethod }];
      }
      updatedAuthorizations.push(JSON.parse(options.body));
      return [];
    }
    if (path.startsWith('internal_evm_usdt_incoming_events?id=eq.event-1')) {
      updatedEvents.push(JSON.parse(options.body));
      return [];
    }
    if (path === 'rpc/internal_evm_reserve_autodebit_charge') {
      reservationCalls++;
      return [{
        status: reservationStatus,
        charge_id: 'charge-1',
        telegram_id: '123',
        owner_address: owner,
        recipient_address: recipient,
        amount_base_units: '9800000',
      }];
    }
    return [];
  };
  const worker = createEvmAutoDebitWorker({
    env,
    supabase,
    getFinalizedBlock: async () => ({ number: 100, hash: `0x${'a'.repeat(64)}` }),
    getEvmBlockHash: async () => `0x${'a'.repeat(64)}`,
    getIncomingUsdtTransfers: async () => [],
    readUsdtBalance: async () => balance,
    readPermit2Authorization: async () => authorization,
    readEvmAuthorization: async (method) => {
      assert.equal(method, authorizationMethod);
      return authorization;
    },
    sendEvmChargeTransaction: async ({ authorizationMethod: method }) => {
      chargeMethods.push(method);
      transactionCalls++;
      return { hash: `0x${'b'.repeat(64)}` };
    },
    waitForEvmChargeTransaction: async () => `0x${'b'.repeat(64)}`,
    sendPermit2ChargeTransaction: async () => {
      transactionCalls++;
      return { hash: `0x${'b'.repeat(64)}` };
    },
    waitForPermit2ChargeTransaction: async () => `0x${'b'.repeat(64)}`,
    sendUserNotification: async () => undefined,
    log: { error() {} },
  });
  return {
    worker,
    updatedEvents,
    updatedAuthorizations,
    chargeMethods,
    get reservationCalls() { return reservationCalls; },
    get transactionCalls() { return transactionCalls; },
  };
}

test('a balance below 10 USDT is ignored without reserving or sending a charge', async () => {
  const testWorker = makeWorker({
    balance: 9_999_999n,
    authorization: {},
  });

  await testWorker.worker.tick();

  assert.equal(testWorker.reservationCalls, 0);
  assert.equal(testWorker.transactionCalls, 0);
  assert.equal(testWorker.updatedEvents[0].status, 'ignored_below_threshold');
});

test('an inactive on-chain Permit2 authorization blocks the event before reservation', async () => {
  const testWorker = makeWorker({
    balance: 20_000_000n,
    authorization: {
      ownerAddress: owner,
      tokenAllowance: 0n,
      permit2AllowanceAmount: 0n,
      permit2Expiration: 0n,
      permit2Nonce: 0n,
    },
  });

  await testWorker.worker.tick();

  assert.equal(testWorker.reservationCalls, 0);
  assert.equal(testWorker.transactionCalls, 0);
  assert.equal(testWorker.updatedEvents[0].status, 'blocked_authorization');
  assert.equal(testWorker.updatedAuthorizations[0].status, 'revoked');
});

test('a globally paused database control prevents a new charge reservation', async () => {
  const validAuthorization = {
    ownerAddress: owner,
    tokenAllowance: (2n ** 256n) - 1n,
    permit2AllowanceAmount: (2n ** 160n) - 1n,
    permit2Expiration: BigInt(Math.floor(Date.now() / 1000) + 3600),
    permit2Nonce: 0n,
  };
  const testWorker = makeWorker({
    balance: 20_000_000n,
    authorization: validAuthorization,
    control: { enabled: false, paused: true },
    reservationStatus: 'globally_disabled',
  });

  const result = await testWorker.worker.tick();
  assert.equal(testWorker.reservationCalls, 1);
  assert.equal(testWorker.transactionCalls, 0);
  assert.equal(result.processedEvents, 1);
});

test('direct USDT authorizations are checked and routed to the generic charge sender', async () => {
  const testWorker = makeWorker({
    balance: 20_000_000n,
    authorizationMethod: 'direct',
    authorization: {
      authorizationMethod: 'direct',
      ownerAddress: owner,
      tokenAllowance: (2n ** 256n) - 1n,
    },
  });

  const result = await testWorker.worker.tick();

  assert.equal(result.processedEvents, 1);
  assert.equal(testWorker.reservationCalls, 1);
  assert.equal(testWorker.transactionCalls, 1);
  assert.deepEqual(testWorker.chargeMethods, ['direct']);
  assert.equal(testWorker.updatedEvents[0].status, 'processed');
});