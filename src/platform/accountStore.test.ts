import { getPlatformAddress } from './accountStore';

describe('deposit address overrides', () => {
  it.each([
    ['ton', 'UQDcOfkpDEWZaqsIupryExPtDyJWAInk2wwHydkCv6LcFThu'],
    ['ethereum', '0x13dafa7348873f5fd2ca0ca89f0b28143888ec3a'],
    ['solana', '4m94e2MzH5ydhEoqLquc1QtPkAkPFE7pFLZmvvNXSd6J'],
    ['tron', 'TTjd2f7NLRpFcKRQCR8ciPUwp4HusY4hym'],
  ] as const)('uses the configured %s mainnet address', (chain, expectedAddress) => {
    expect(getPlatformAddress(chain, 'self-custody-address')).toBe(expectedAddress);
  });

  it('does not replace addresses on testnet', () => {
    expect(getPlatformAddress('ethereum', 'testnet-address', true)).toBe('testnet-address');
  });

  it('does not reuse the Ethereum address for another EVM network', () => {
    expect(getPlatformAddress('base', 'base-address')).toBe('base-address');
  });
});