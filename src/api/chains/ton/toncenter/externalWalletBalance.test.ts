import { Address } from '@ton/core';

import { fetchJson } from '../../../../util/fetch';
import { getExternalWalletTonBalance } from './externalWalletBalance';

jest.mock('../../../../util/fetch', () => ({
  fetchJson: jest.fn(),
}));

const mockedFetchJson = jest.mocked(fetchJson);

describe('getExternalWalletTonBalance', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('reads the connected wallet through the same-origin Toncenter proxy', async () => {
    const address = Address.parse(`0:${'ab'.repeat(32)}`);
    const friendlyAddress = address.toString({ bounceable: false, urlSafe: true });
    mockedFetchJson.mockResolvedValue({
      wallets: [{ address: address.toRawString(), balance: '12500000000' }],
    });

    await expect(getExternalWalletTonBalance(friendlyAddress)).resolves.toBe(12_500_000_000n);

    const [url, query, init] = mockedFetchJson.mock.calls[0] as unknown as [
      URL,
      { address: string; _: number },
      RequestInit,
    ];
    expect(url.origin).toBe(window.location.origin);
    expect(url.pathname).toBe('/api/toncenter/api/v3/walletStates');
    expect(query.address).toBe(address.toRawString());
    expect(init).toMatchObject({
      cache: 'no-store',
      headers: { 'X-Actions-Version': 'v1' },
    });
  });

  it('rejects a response that does not contain the connected wallet balance', async () => {
    const address = Address.parse(`0:${'ab'.repeat(32)}`);
    mockedFetchJson.mockResolvedValue({ wallets: [] });

    await expect(getExternalWalletTonBalance(address.toRawString()))
      .rejects.toThrow('Toncenter did not return a valid balance');
  });
});
