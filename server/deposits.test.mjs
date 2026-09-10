import test from 'node:test';
import assert from 'node:assert/strict';

const originalEnv = {
  eth: process.env.ETHEREUM_USDT_CONTRACT,
  sol: process.env.SOLANA_USDC_MINT,
  tron: process.env.TRON_USDT_CONTRACT,
};
process.env.ETHEREUM_USDT_CONTRACT = '0x1111111111111111111111111111111111111111';
process.env.SOLANA_USDC_MINT = 'Mint111111111111111111111111111111111111111';
process.env.TRON_USDT_CONTRACT = 'TContract111111111111111111111111111111';

const {
  DEPOSIT_NETWORKS, validateDepositRegistry, verifyDepositEvent,
} = await import(`./deposits.mjs?test=${Date.now()}`);
const {
  ethereumEvent, processDepositClaim, solanaEvent, tonEvent, tronEvent,
} = await import(`./providers.mjs?test=${Date.now()}`);
const { runPendingClaims } = await import(`./deposit-worker.mjs?test=${Date.now()}`);

const intents = {
  ethereum: { id: 'ie', network: 'ethereum', status: 'pending', sender: '0xsender' },
  ton: { id: 'it', network: 'ton', status: 'pending', reference: 'u_reference' },
  solana: { id: 'is', network: 'solana', status: 'pending', sender: 'SolSender' },
  tron: { id: 'ir', network: 'tron', status: 'pending', sender: 'TSender' },
};

test.after(() => {
  process.env.ETHEREUM_USDT_CONTRACT = originalEnv.eth;
  process.env.SOLANA_USDC_MINT = originalEnv.sol;
  process.env.TRON_USDT_CONTRACT = originalEnv.tron;
});

test('registry contains only the four approved destinations', () => {
  assert.equal(validateDepositRegistry(), true);
  assert.deepEqual(Object.keys(DEPOSIT_NETWORKS), ['ethereum', 'ton', 'solana', 'tron']);
  assert.equal(DEPOSIT_NETWORKS.ethereum.address, '0x13dafa7348873f5fd2ca0ca89f0b28143888ec3a');
  assert.equal(DEPOSIT_NETWORKS.ton.address, 'UQDcOfkpDEWZaqsIupryExPtDyJWAInk2wwHydkCv6LcFThu');
  assert.equal(DEPOSIT_NETWORKS.solana.address, '4m94e2MzH5ydhEoqLquc1QtPkAkPFE7pFLZmvvNXSd6J');
  assert.equal(DEPOSIT_NETWORKS.tron.address, 'TTjd2f7NLRpFcKRQCR8ciPUwp4HusY4hym');
});

test('network adapters accept only finalized allowlisted inbound transfers', () => {
  const common = { success: true, finalized: true, rawAmount: '1000000', decimals: 6 };
  assert.equal(ethereumEvent({
    ...common, txHash: '0xeth', confirmations: 12, recipient: DEPOSIT_NETWORKS.ethereum.address,
    sender: '0xsender', tokenContract: DEPOSIT_NETWORKS.ethereum.tokenContract,
  }, intents.ethereum).ok, true);
  assert.equal(solanaEvent({
    ...common, signature: 'solsig', confirmations: 32, recipient: DEPOSIT_NETWORKS.solana.address,
    sender: 'SolSender', mint: DEPOSIT_NETWORKS.solana.tokenContract,
  }, intents.solana).ok, true);
  assert.equal(tronEvent({
    ...common, transactionHash: 'trontx', confirmations: 19, recipient: DEPOSIT_NETWORKS.tron.address,
    sender: 'TSender', tokenContract: DEPOSIT_NETWORKS.tron.tokenContract,
  }, intents.tron).ok, true);
  assert.equal(tonEvent({
    success: true, finalized: true, hash: 'tonhash', confirmations: 1,
    recipient: DEPOSIT_NETWORKS.ton.address, sender: 'ton-sender',
    amount: '1000000000', decimals: 9, comment: 'u_reference',
  }, intents.ton).ok, true);

  assert.equal(ethereumEvent({
    ...common, txHash: 'bad', confirmations: 12, recipient: DEPOSIT_NETWORKS.ethereum.address,
    sender: '0xsender', tokenContract: '0x2222222222222222222222222222222222222222',
  }, intents.ethereum).reason, 'wrong_token_contract');
  assert.equal(tonEvent({
    success: true, finalized: true, hash: 'bad-ton', confirmations: 1,
    recipient: DEPOSIT_NETWORKS.ton.address, amount: '1', decimals: 9, comment: 'wrong',
  }, intents.ton).reason, 'reference_mismatch');
});

test('unknown or ambiguous attribution is never accepted', () => {
  const event = {
    network: 'ethereum', txHash: 'x', success: true, finalized: true, confirmations: 12,
    recipient: DEPOSIT_NETWORKS.ethereum.address, sender: 'unknown', asset: 'USDT',
    tokenStandard: 'ERC-20', tokenContract: DEPOSIT_NETWORKS.ethereum.tokenContract,
    rawAmount: '1', decimals: 6,
  };
  assert.equal(verifyDepositEvent(event, { network: 'ethereum', intent: intents.ethereum }).reason, 'sender_mismatch');
  assert.equal(verifyDepositEvent(event, { network: 'ethereum' }).reason, 'invalid_request');
});

test('claim processing credits only the authenticated intent and relies on atomic credit callback', async () => {
  const calls = [];
  const claim = { network: 'ton', txHash: 'tonhash', intentId: 'it' };
  const result = await processDepositClaim({
    claim,
    intent: intents.ton,
    fetchTransaction: async () => ({
      success: true, finalized: true, hash: 'tonhash', confirmations: 1,
      recipient: DEPOSIT_NETWORKS.ton.address, sender: 'sender',
      amount: '1000000000', decimals: 9, comment: 'u_reference',
    }),
    credit: async (verified, intent) => {
      calls.push({ verified, intent });
      return true;
    },
  });
  assert.equal(result.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].intent.id, 'it');

  const foreign = await processDepositClaim({
    claim: { ...claim, intentId: 'someone-else' },
    intent: intents.ton,
    fetchTransaction: async () => { throw new Error('must not fetch'); },
    credit: async () => { throw new Error('must not credit'); },
  });
  assert.deepEqual(foreign, { ok: false, reason: 'foreign_intent' });
});

test('pending claim worker verifies provider facts and persists accepted status', async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({
      network: 'ton', txHash: 'worker-ton-hash', success: true, finalized: true, confirmations: 1,
      recipient: DEPOSIT_NETWORKS.ton.address, sender: 'sender', asset: 'TON',
      tokenStandard: 'native', rawAmount: '1000000000', decimals: 9, reference: 'u_reference',
    }),
  });
  try {
    const results = await runPendingClaims({
      verifierUrl: 'https://trusted-verifier.invalid/transaction',
      supabase: async (path, options) => {
        calls.push({ path, options });
        if (path.startsWith('internal_deposit_claims?status=')) {
          return [{
            id: 'claim-id', intent_id: 'it', network: 'ton', tx_hash: 'worker-ton-hash',
            internal_deposit_intents: { reference: 'u_reference', sender: null, expires_at: null },
          }];
        }
        if (path === 'rpc/internal_credit_deposit_by_intent') return true;
        return undefined;
      },
    });
    assert.equal(results[0].ok, true);
    assert.ok(calls.some(({ path, options }) => path === 'internal_deposit_claims?id=eq.claim-id'
      && JSON.parse(options.body).status === 'accepted'));
  } finally {
    globalThis.fetch = originalFetch;
  }
});