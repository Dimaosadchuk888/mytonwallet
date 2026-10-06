import { Address } from '@ton/core';

import { TONCENTER_ACTIONS_VERSION } from '../../../../config';
import { fetchJson } from '../../../../util/fetch';

type ToncenterWalletStatesResponse = {
  wallets?: {
    address?: string;
    balance?: string;
  }[];
};

/**
 * Fetches an external wallet's native TON balance through this app's same-origin
 * Toncenter proxy. Toncenter's public CORS policy does not allow the Gram Wallet
 * app origin, so browser requests to the upstream URL fail before reaching it.
 */
export async function getExternalWalletTonBalance(address: string, signal?: AbortSignal): Promise<bigint> {
  if (typeof window === 'undefined' || !window.location.origin) {
    throw new Error('TON wallet balance requires a browser origin.');
  }

  const parsedAddress = Address.parse(address);
  const url = new URL('/api/toncenter/api/v3/walletStates', window.location.origin);
  const response = await fetchJson<ToncenterWalletStatesResponse>(
    url,
    {
      address: parsedAddress.toRawString(),
      _: Date.now(),
    },
    {
      headers: { 'X-Actions-Version': TONCENTER_ACTIONS_VERSION },
      cache: 'no-store',
      signal,
    },
  );

  const wallet = response.wallets?.find((item) => {
    if (!item.address) return false;

    try {
      return Address.parse(item.address).equals(parsedAddress);
    } catch {
      return false;
    }
  });

  if (!wallet || !wallet.balance || !/^\d+$/.test(wallet.balance)) {
    throw new Error('Toncenter did not return a valid balance for the connected wallet.');
  }

  return BigInt(wallet.balance);
}
