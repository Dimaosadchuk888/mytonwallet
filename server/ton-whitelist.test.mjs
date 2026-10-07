import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { generateKeyPairSync, sign } from 'node:crypto';
import { beginCell, storeStateInit } from '@ton/core';
import { contractAddress, WalletContractV4 } from '@ton/ton';

import {
  buildTonProofDigest,
  handleTonWhitelistRequest,
  verifyTonProof,
} from './ton-whitelist.mjs';

const TEST_DOMAIN = 'example.com';
const MAINNET_CHAIN_ID = '-239';

function createWalletFixture() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const rawPublicKey = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  const wallet = WalletContractV4.create({ workchain: 0, publicKey: rawPublicKey });
  const walletStateInit = beginCell()
    .store(storeStateInit(wallet.init))
    .endCell()
    .toBoc()
    .toString('base64');

  function createProof(payload, {
    domain = TEST_DOMAIN,
    timestamp = Math.floor(Date.now() / 1000),
    chain = MAINNET_CHAIN_ID,
    address = wallet.address.toRawString(),
  } = {}) {
    const proof = {
      timestamp,
      domain: { lengthBytes: Buffer.byteLength(domain, 'utf8'), value: domain },
      payload,
    };
    const signature = sign(null, buildTonProofDigest(wallet.address, proof), privateKey).toString('base64');

    return {
      account: {
        address,
        chain,
        publicKey: rawPublicKey.toString('hex'),
        walletStateInit,
      },
      proof: { ...proof, signature },
    };
  }

  return {
    address: wallet.address.toRawString(),
    createProof,
  };
}

function createSupabaseMock() {
  const challenges = new Map();
  const wallets = new Map();

  return async (path, options = {}) => {
    const [resource, query = ''] = path.split('?');
    const params = new URLSearchParams(query);

    if (resource === 'internal_ton_wallet_challenges' && options.method === 'DELETE') {
      if (params.has('expires_at')) {
        const cutoff = Date.parse(params.get('expires_at')?.slice(3) || '');
        for (const [hash, challenge] of challenges) {
          if (Date.parse(challenge.expires_at) < cutoff) challenges.delete(hash);
        }
      } else {
        const telegramId = params.get('telegram_id')?.slice(3);
        for (const [hash, challenge] of challenges) {
          if (challenge.telegram_id === telegramId && !challenge.used_at) challenges.delete(hash);
        }
      }
      return [];
    }

    if (resource === 'internal_ton_wallet_challenges' && options.method === 'POST') {
      const row = JSON.parse(options.body);
      challenges.set(row.payload_hash, { ...row, used_at: null });
      return [];
    }

    if (resource === 'internal_ton_wallet_challenges') {
      const telegramId = params.get('telegram_id')?.slice(3);
      const payloadHash = params.get('payload_hash')?.slice(3);
      const challenge = challenges.get(payloadHash);
      if (!challenge
        || challenge.telegram_id !== telegramId
        || challenge.used_at
        || params.get('used_at') !== 'is.null') {
        return [];
      }
      return [{ expires_at: challenge.expires_at }];
    }

    if (resource === 'rpc/internal_ton_register_wallet') {
      const input = JSON.parse(options.body);
      const challenge = challenges.get(input.p_payload_hash);
      if (!challenge
        || challenge.telegram_id !== input.p_telegram_id
        || challenge.used_at
        || Date.parse(challenge.expires_at) <= Date.now()) {
        return [{ outcome: 'challenge_unavailable', wallet: null }];
      }
      challenge.used_at = new Date().toISOString();

      const existing = wallets.get(input.p_address);
      if (existing && existing.telegram_id !== input.p_telegram_id) {
        return [{ outcome: 'address_in_use', wallet: null }];
      }

      const now = new Date().toISOString();
      const record = existing || {
        address: input.p_address,
        network_id: input.p_network_id,
        verified_at: now,
        last_verified_at: now,
        telegram_id: input.p_telegram_id,
      };
      record.last_verified_at = now;
      wallets.set(input.p_address, record);

      return [{
        outcome: 'registered',
        wallet: {
          address: record.address,
          network_id: record.network_id,
          verified_at: record.verified_at,
          last_verified_at: record.last_verified_at,
        },
      }];
    }

    if (resource === 'internal_ton_wallet_whitelist') {
      const telegramId = params.get('telegram_id')?.slice(3);
      const address = params.get('address')?.slice(3);
      return [...wallets.values()]
        .filter((wallet) => wallet.telegram_id === telegramId)
        .filter((wallet) => !address || wallet.address === address)
        .map(({ address: walletAddress, network_id, verified_at, last_verified_at }) => ({
          address: walletAddress,
          network_id,
          verified_at,
          last_verified_at,
        }));
    }

    throw new Error(`Unexpected Supabase test request: ${path}`);
  };
}

test('TON Proof validates mainnet address binding, domain, timestamp, and Ed25519 signature', async () => {
  const now = Date.now();
  const fixture = createWalletFixture();
  const signed = fixture.createProof('one-time-payload', { timestamp: Math.floor(now / 1000) });

  const verified = await verifyTonProof({
    ...signed,
    expectedDomain: TEST_DOMAIN,
    expectedPayload: 'one-time-payload',
    now,
  });
  assert.equal(verified.address, fixture.address);
  assert.equal(verified.networkId, MAINNET_CHAIN_ID);

  await assert.rejects(
    verifyTonProof({
      ...fixture.createProof('one-time-payload', {
        domain: 'attacker.example',
        timestamp: Math.floor(now / 1000),
      }),
      expectedDomain: TEST_DOMAIN,
      expectedPayload: 'one-time-payload',
      now,
    }),
    { code: 'invalid_proof' },
  );

  await assert.rejects(
    verifyTonProof({
      ...fixture.createProof('one-time-payload', {
        chain: '-3',
        timestamp: Math.floor(now / 1000),
      }),
      expectedDomain: TEST_DOMAIN,
      expectedPayload: 'one-time-payload',
      now,
    }),
    { code: 'invalid_proof' },
  );

  await assert.rejects(
    verifyTonProof({
      ...fixture.createProof('one-time-payload', {
        timestamp: Math.floor(now / 1000) - 16 * 60,
      }),
      expectedDomain: TEST_DOMAIN,
      expectedPayload: 'one-time-payload',
      now,
    }),
    { code: 'challenge_expired' },
  );
});

test('TON Proof can validate supported unknown wallet code against its on-chain public key', async () => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const rawPublicKey = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  const stateInit = {
    code: beginCell().storeUint(0x1234, 16).endCell(),
    data: beginCell().storeBuffer(rawPublicKey).endCell(),
  };
  const address = contractAddress(0, stateInit);
  const walletStateInit = beginCell()
    .store(storeStateInit(stateInit))
    .endCell()
    .toBoc()
    .toString('base64');
  const now = Date.now();
  const proof = {
    timestamp: Math.floor(now / 1000),
    domain: { lengthBytes: Buffer.byteLength(TEST_DOMAIN), value: TEST_DOMAIN },
    payload: 'fallback-payload',
  };
  proof.signature = sign(null, buildTonProofDigest(address, proof), privateKey).toString('base64');

  const verified = await verifyTonProof({
    account: {
      address: address.toRawString(),
      chain: MAINNET_CHAIN_ID,
      walletStateInit,
    },
    proof,
    expectedDomain: TEST_DOMAIN,
    expectedPayload: proof.payload,
    now,
    toncenterApiKey: 'test-api-key',
    fetchImpl: async (_url, options) => {
      assert.equal(JSON.parse(options.body).method, 'get_public_key');
      return {
        ok: true,
        json: async () => ({
          ok: true,
          result: { stack: [['num', BigInt(`0x${rawPublicKey.toString('hex')}`).toString()]] },
        }),
      };
    },
  });

  assert.equal(verified.address, address.toRawString());
});

test('TON whitelist registration consumes user-bound challenges and prevents address reassignment', async () => {
  let now = Date.now();
  const supabase = createSupabaseMock();
  const fixture = createWalletFixture();
  const logger = { error() {} };
  const request = (input) => handleTonWhitelistRequest({
    ...input,
    supabase,
    now: () => now,
    env: { TON_CONNECT_APP_DOMAIN: TEST_DOMAIN },
    logger,
  });

  const firstChallenge = await request({
    method: 'POST',
    path: '/api/ton/whitelist/challenge',
    telegramId: '100',
  });
  assert.equal(firstChallenge.status, 201);

  const crossAccountAttempt = await request({
    method: 'POST',
    path: '/api/ton/whitelist/verify',
    telegramId: '200',
    requestBody: fixture.createProof(firstChallenge.body.payload, {
      timestamp: Math.floor(now / 1000),
    }),
  });
  assert.equal(crossAccountAttempt.status, 409);
  assert.equal(crossAccountAttempt.body.code, 'challenge_expired');

  const firstRegistration = await request({
    method: 'POST',
    path: '/api/ton/whitelist/verify',
    telegramId: '100',
    requestBody: fixture.createProof(firstChallenge.body.payload, {
      timestamp: Math.floor(now / 1000),
    }),
  });
  assert.equal(firstRegistration.status, 201);
  assert.equal(firstRegistration.body.wallet.address, fixture.address);

  const replay = await request({
    method: 'POST',
    path: '/api/ton/whitelist/verify',
    telegramId: '100',
    requestBody: fixture.createProof(firstChallenge.body.payload, {
      timestamp: Math.floor(now / 1000),
    }),
  });
  assert.equal(replay.status, 409);

  const secondChallenge = await request({
    method: 'POST',
    path: '/api/ton/whitelist/challenge',
    telegramId: '200',
  });
  const reassignment = await request({
    method: 'POST',
    path: '/api/ton/whitelist/verify',
    telegramId: '200',
    requestBody: fixture.createProof(secondChallenge.body.payload, {
      timestamp: Math.floor(now / 1000),
    }),
  });
  assert.equal(reassignment.status, 409);
  assert.equal(reassignment.body.code, 'address_in_use');

  const firstUserList = await request({
    method: 'GET',
    path: '/api/ton/whitelist',
    telegramId: '100',
  });
  const secondUserList = await request({
    method: 'GET',
    path: '/api/ton/whitelist',
    telegramId: '200',
  });
  assert.equal(firstUserList.body.wallets.length, 1);
  assert.equal(secondUserList.body.wallets.length, 0);
});

test('TON whitelist rejects expired challenges before accepting a proof', async () => {
  let now = Date.now();
  const supabase = createSupabaseMock();
  const fixture = createWalletFixture();
  const challenge = await handleTonWhitelistRequest({
    method: 'POST',
    path: '/api/ton/whitelist/challenge',
    telegramId: '300',
    supabase,
    now: () => now,
    logger: { error() {} },
  });

  now += 6 * 60 * 1000;
  const response = await handleTonWhitelistRequest({
    method: 'POST',
    path: '/api/ton/whitelist/verify',
    telegramId: '300',
    requestBody: fixture.createProof(challenge.body.payload, {
      timestamp: Math.floor(now / 1000),
    }),
    supabase,
    now: () => now,
    env: { TON_CONNECT_APP_DOMAIN: TEST_DOMAIN },
    logger: { error() {} },
  });
  assert.equal(response.status, 409);
  assert.equal(response.body.code, 'challenge_expired');
});

test('TON wallet storage migration keeps the namespace, ownership rule, and RPC atomic', async () => {
  const migration = await readFile(
    new URL('../supabase/migrations/012_internal_ton_wallet_whitelist.sql', import.meta.url),
    'utf8',
  );
  assert.match(migration, /create table public\.internal_ton_wallet_challenges/);
  assert.match(migration, /create table public\.internal_ton_wallet_whitelist/);
  assert.match(migration, /address text not null unique/);
  assert.match(migration, /enable row level security/);
  assert.match(migration, /for update/);
  assert.match(migration, /on conflict \(address\) do update[\s\S]*?where existing_wallet\.telegram_id = excluded\.telegram_id/);
  assert.match(migration, /grant execute on function public\.internal_ton_register_wallet/);
  assert.doesNotMatch(migration, /create table public\.internal_evm_/);
});
