import test from 'node:test';
import assert from 'node:assert/strict';
import { Wallet } from 'ethers';

import {
  EVM_MAX_NUMBER,
  PERMIT2_MAX_AMOUNT,
  getAuthorizationChallengeMessage,
  normalizeEvmAddress,
  parseBaseUnits,
  verifyAuthorizationChallenge,
} from './evm.mjs';

test('EVM authorization challenge recovers the signing wallet', async () => {
  const wallet = new Wallet(`0x${'11'.repeat(32)}`);
  const nonce = 'a'.repeat(32);
  const message = getAuthorizationChallengeMessage(wallet.address, nonce);
  const signature = await wallet.signMessage(message);

  assert.match(message, /^MyGramWallet White List authorization\nEthereum Mainnet\n/);
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

test('EVM allowance limits use the correct uint widths', () => {
  assert.equal(EVM_MAX_NUMBER, 2n ** 256n - 1n);
  assert.equal(PERMIT2_MAX_AMOUNT, 2n ** 160n - 1n);
});