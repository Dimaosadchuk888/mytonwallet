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
  const tx = (overrides = {}) => ({ hash: 'h', lt: '9', mc_block_seqno: 1, description: {
    aborted: false, compute_ph: { success: true }, action: { success: true },
  }, in_msg: {
    source: 'sender', destination: admin, value: '1000', message_content: { body }, ...overrides,
  } });
  assert.deepEqual(extractInboundTonDeposits([tx()], admin), [{
    comment: 'u_opaque-comment', amount: '1000', txHash: 'h', txLt: '9',
  }]);
  assert.deepEqual(extractInboundTonDeposits([tx({ value: '0' }), tx({ bounced: true })], admin), []);
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
  const transactions = Array.from({ length: 120 }, (_, index) => ({
    hash: index === 95 ? 'cursor' : `hash-${index}`,
    lt: String(1000 - index),
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