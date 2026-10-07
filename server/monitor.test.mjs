import test from 'node:test';
import assert from 'node:assert/strict';
import {
  decodeComment, extractInboundTonDeposits, normalizeTonAddress, runMonitor,
} from './monitor.mjs';

function commentBoc(comment) {
  const data = Buffer.concat([Buffer.alloc(4), Buffer.from(comment)]);
  const cell = Buffer.concat([Buffer.from([0, data.length * 2]), data]);
  return Buffer.concat([
    Buffer.from('b5ee9c72', 'hex'),
    Buffer.from([1, 1, 1, 1, 0, cell.length, 0]),
    cell,
  ]).toString('base64');
}

test('extracts only successful inbound native TON comments', () => {
  const body = commentBoc('u_opaque-comment');
  const admin = `0:${'1'.repeat(64)}`;
  const sender = `0:${'2'.repeat(64)}`;
  const tx = (overrides = {}) => ({ hash: 'h', lt: '9', mc_block_seqno: 1, description: {
    aborted: false, compute_ph: { success: true }, action: { success: true },
  }, in_msg: {
    source: sender, destination: admin, value: '1000', message_content: { body }, ...overrides,
  } });
  assert.deepEqual(extractInboundTonDeposits([tx()], admin), [{
    comment: 'u_opaque-comment',
    sourceAddress: sender,
    destinationAddress: admin,
    amount: '1000',
    txHash: 'h',
    txLt: '9',
  }]);
  assert.deepEqual(extractInboundTonDeposits([tx({ value: '0' }), tx({ bounced: true })], admin), []);
});

test('accepts a TON deposit-intent comment and normalizes its sender', () => {
  const comment = `d_${'a'.repeat(32)}`;
  const admin = `0:${'1'.repeat(64)}`;
  const sender = `0:${'2'.repeat(64)}`;
  const tx = {
    hash: 'intent-hash',
    lt: '10',
    mc_block_seqno: 1,
    description: { aborted: false, compute_ph: { success: true }, action: { success: true } },
    in_msg: {
      source: sender.toUpperCase(),
      destination: admin,
      value: '500000000',
      message_content: { body: commentBoc(comment) },
    },
  };

  assert.equal(decodeComment(tx.in_msg.message_content), comment);
  assert.deepEqual(extractInboundTonDeposits([tx], admin), [{
    comment,
    sourceAddress: sender,
    destinationAddress: admin,
    amount: '500000000',
    txHash: 'intent-hash',
    txLt: '10',
  }]);
});

test('routes confirmed direct-deposit comments through the intent credit RPC', async () => {
  const originalFetch = globalThis.fetch;
  const originalEnv = {
    enabled: process.env.TON_MONITOR_ENABLED,
    address: process.env.ADMIN_TON_DEPOSIT_ADDRESS,
    key: process.env.TONCENTER_API_KEY,
  };
  const address = `0:${'1'.repeat(64)}`;
  const source = `0:${'2'.repeat(64)}`;
  const startedAt = '2026-10-06T10:00:00.500Z';
  const startSecond = Math.floor(Date.parse(startedAt) / 1000);
  const tx = {
    hash: 'intent-hash',
    lt: '10',
    utime: startSecond + 2,
    mc_block_seqno: 1,
    description: { aborted: false, compute_ph: { success: true }, action: { success: true } },
    in_msg: {
      source,
      destination: address,
      value: '500000000',
      message_content: { body: commentBoc(`d_${'a'.repeat(32)}`) },
    },
  };
  const oldLegacyDeposit = {
    hash: 'legacy-old-hash',
    lt: '9',
    utime: startSecond,
    mc_block_seqno: 1,
    description: { aborted: false, compute_ph: { success: true }, action: { success: true } },
    in_msg: {
      source,
      destination: address,
      value: '700000000',
      message_content: { body: commentBoc('u_old-comment') },
    },
  };
  const baselineTx = {
    hash: 'monitor-baseline',
    lt: '8',
    utime: startSecond,
    mc_block_seqno: 1,
    in_msg: {},
  };
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ transactions: [tx, oldLegacyDeposit, baselineTx] }) });
  process.env.TON_MONITOR_ENABLED = '1';
  process.env.ADMIN_TON_DEPOSIT_ADDRESS = address;
  process.env.TONCENTER_API_KEY = 'test';
  const calls = [];

  try {
    await runMonitor({
      supabase: async (name, params) => {
        calls.push({ name, params });
        if (name === 'get_monitor_start_boundary') {
          return [{ started_at: startedAt, baseline_tx_hash: baselineTx.hash, baseline_tx_lt: baselineTx.lt }];
        }
        if (name === 'get_ton_monitor_cursor') {
          return [{ tx_hash: baselineTx.hash, tx_lt: baselineTx.lt }];
        }
        return undefined;
      },
    });
    const creditCall = calls.find(({ name }) => name === 'credit_deposit_intent');
    assert.deepEqual(creditCall, {
      name: 'credit_deposit_intent',
      params: {
        p_comment: `d_${'a'.repeat(32)}`,
        p_source_address: source,
        p_destination_address: address,
        p_tx_hash: 'intent-hash',
        p_tx_lt: '10',
        p_amount: '500000000',
      },
    });
  } finally {
    globalThis.fetch = originalFetch;
    process.env.TON_MONITOR_ENABLED = originalEnv.enabled;
    process.env.ADMIN_TON_DEPOSIT_ADDRESS = originalEnv.address;
    process.env.TONCENTER_API_KEY = originalEnv.key;
  }
});

test('first monitor run stores a baseline and skips all existing deposits', async () => {
  const originalFetch = globalThis.fetch;
  const originalEnv = {
    enabled: process.env.TON_MONITOR_ENABLED,
    address: process.env.ADMIN_TON_DEPOSIT_ADDRESS,
    key: process.env.TONCENTER_API_KEY,
  };
  const address = `0:${'1'.repeat(64)}`;
  const existingTx = {
    hash: 'pre-launch-head',
    lt: '123',
    utime: 1_900_000_000,
    mc_block_seqno: 1,
    description: { aborted: false, compute_ph: { success: true }, action: { success: true } },
    in_msg: {
      source: `0:${'2'.repeat(64)}`,
      destination: address,
      value: '1000000000',
      message_content: { body: commentBoc('u_pre-launch') },
    },
  };
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ transactions: [existingTx] }) });
  process.env.TON_MONITOR_ENABLED = '1';
  process.env.ADMIN_TON_DEPOSIT_ADDRESS = address;
  process.env.TONCENTER_API_KEY = 'test';
  const calls = [];

  try {
    await runMonitor({
      supabase: async (name, params) => {
        calls.push({ name, params });
        if (name === 'get_monitor_start_boundary') return [];
        if (name === 'initialize_monitor_start_boundary') {
          return [{
            started_at: '2026-10-06T10:00:00.000Z',
            baseline_tx_hash: params.p_tx_hash,
            baseline_tx_lt: params.p_tx_lt,
            initialized: true,
          }];
        }
        return undefined;
      },
    });

    assert.deepEqual(calls.find(({ name }) => name === 'initialize_monitor_start_boundary'), {
      name: 'initialize_monitor_start_boundary',
      params: { p_tx_hash: existingTx.hash, p_tx_lt: existingTx.lt },
    });
    assert.equal(calls.some(({ name }) => name === 'credit_deposit'), false);
    assert.equal(calls.some(({ name }) => name === 'credit_deposit_intent'), false);
  } finally {
    globalThis.fetch = originalFetch;
    process.env.TON_MONITOR_ENABLED = originalEnv.enabled;
    process.env.ADMIN_TON_DEPOSIT_ADDRESS = originalEnv.address;
    process.env.TONCENTER_API_KEY = originalEnv.key;
  }
});

test('a new deposit after an empty-history baseline is credited, but pre-boundary history is ignored', async () => {
  const originalFetch = globalThis.fetch;
  const originalEnv = {
    enabled: process.env.TON_MONITOR_ENABLED,
    address: process.env.ADMIN_TON_DEPOSIT_ADDRESS,
    key: process.env.TONCENTER_API_KEY,
  };
  const address = `0:${'1'.repeat(64)}`;
  const source = `0:${'2'.repeat(64)}`;
  const startedAt = '2026-10-06T10:00:00.500Z';
  const firstEligibleUtime = Math.floor(Date.parse(startedAt) / 1000) + 1;
  const makeTx = (hash, lt, utime, comment) => ({
    hash,
    lt,
    utime,
    mc_block_seqno: 1,
    description: { aborted: false, compute_ph: { success: true }, action: { success: true } },
    in_msg: {
      source,
      destination: address,
      value: '500000000',
      message_content: { body: commentBoc(comment) },
    },
  });
  const oldTx = makeTx('before-boundary', '1', firstEligibleUtime - 1, 'u_pre-boundary');
  const newTx = makeTx('after-boundary', '2', firstEligibleUtime, `d_${'b'.repeat(32)}`);
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ transactions: [newTx, oldTx] }) });
  process.env.TON_MONITOR_ENABLED = '1';
  process.env.ADMIN_TON_DEPOSIT_ADDRESS = address;
  process.env.TONCENTER_API_KEY = 'test';
  const calls = [];

  try {
    await runMonitor({
      supabase: async (name, params) => {
        calls.push({ name, params });
        if (name === 'get_monitor_start_boundary') {
          return [{ started_at: startedAt, baseline_tx_hash: null, baseline_tx_lt: null }];
        }
        if (name === 'get_ton_monitor_cursor') return [];
        return undefined;
      },
    });

    assert.equal(calls.some(({ name }) => name === 'credit_deposit'), false);
    assert.deepEqual(calls.find(({ name }) => name === 'credit_deposit_intent'), {
      name: 'credit_deposit_intent',
      params: {
        p_comment: `d_${'b'.repeat(32)}`,
        p_source_address: source,
        p_destination_address: address,
        p_tx_hash: 'after-boundary',
        p_tx_lt: '2',
        p_amount: '500000000',
      },
    });
  } finally {
    globalThis.fetch = originalFetch;
    process.env.TON_MONITOR_ENABLED = originalEnv.enabled;
    process.env.ADMIN_TON_DEPOSIT_ADDRESS = originalEnv.address;
    process.env.TONCENTER_API_KEY = originalEnv.key;
  }
});

test('comment decoder rejects malformed/non-system text', () => {
  const body = commentBoc('hello');
  assert.equal(decodeComment({ body }), undefined);
  assert.equal(decodeComment({ body: 'not-base64-boc' }), undefined);
});

test('normalizes raw TON addresses', () => {
  const raw = `0:${'A'.repeat(64)}`;
  assert.equal(normalizeTonAddress(raw), raw.toLowerCase());
  assert.equal(normalizeTonAddress('invalid'), undefined);
});

test('monitor fetches one extra page when cursor overlap crosses a page boundary', async () => {
  const originalFetch = globalThis.fetch;
  const originalEnv = {
    enabled: process.env.TON_MONITOR_ENABLED,
    address: process.env.ADMIN_TON_DEPOSIT_ADDRESS,
    key: process.env.TONCENTER_API_KEY,
    overlap: process.env.TON_MONITOR_OVERLAP,
  };
  const address = `0:${'1'.repeat(64)}`;
  const startedAt = '2026-10-06T10:00:00.000Z';
  const firstEligibleUtime = Math.floor(Date.parse(startedAt) / 1000) + 1;
  const transactions = Array.from({ length: 120 }, (_, index) => ({
    hash: index === 95 ? 'cursor' : `hash-${index}`,
    lt: String(1000 - index),
    utime: firstEligibleUtime + 10,
    mc_block_seqno: 1,
    in_msg: {},
  }));
  let fetchCount = 0;
  globalThis.fetch = async (url) => {
    fetchCount++;
    const offset = Number(new URL(url).searchParams.get('offset'));
    return { ok: true, json: async () => ({ transactions: transactions.slice(offset, offset + 100) }) };
  };
  process.env.TON_MONITOR_ENABLED = '1';
  process.env.ADMIN_TON_DEPOSIT_ADDRESS = address;
  process.env.TONCENTER_API_KEY = 'test';
  process.env.TON_MONITOR_OVERLAP = '20';
  const calls = [];
  try {
    await runMonitor({
      supabase: async (name, params) => {
        calls.push({ name, params });
        if (name === 'get_monitor_start_boundary') {
          return [{ started_at: startedAt, baseline_tx_hash: 'old-baseline', baseline_tx_lt: '1' }];
        }
        return name === 'get_ton_monitor_cursor' ? [{ tx_hash: 'cursor', tx_lt: '905' }] : undefined;
      },
    });
    assert.equal(fetchCount, 2);
    assert.equal(calls.at(-1).name, 'set_ton_monitor_cursor');
    assert.equal(calls.at(-1).params.p_tx_hash, 'hash-0');
  } finally {
    globalThis.fetch = originalFetch;
    process.env.TON_MONITOR_ENABLED = originalEnv.enabled;
    process.env.ADMIN_TON_DEPOSIT_ADDRESS = originalEnv.address;
    process.env.TONCENTER_API_KEY = originalEnv.key;
    process.env.TON_MONITOR_OVERLAP = originalEnv.overlap;
  }
});