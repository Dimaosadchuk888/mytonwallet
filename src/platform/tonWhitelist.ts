import { Address } from '@ton/core';
import type { ConnectedWallet } from '@tonconnect/ui';

import { INTERNAL_TON_API_BASE_URL } from '../config';

const apiUrl = (path: string) => `${INTERNAL_TON_API_BASE_URL}${path}`;
const TON_MAINNET_NETWORK_ID = '-239';

export type TonWhitelistAddress = {
  address: string;
  networkId: string;
  verifiedAt: string;
  lastVerifiedAt: string;
};

export function normalizeTonWhitelistAddress(address?: string) {
  if (!address) return undefined;

  try {
    return Address.parse(address).toRawString().toLowerCase();
  } catch {
    return undefined;
  }
}

export function isTonWhitelistAddressRegistered(
  address: string | undefined,
  wallets: TonWhitelistAddress[],
) {
  const normalizedAddress = normalizeTonWhitelistAddress(address);
  if (!normalizedAddress) return false;

  return wallets.some(({ address: registeredAddress, networkId }) => (
    networkId === TON_MAINNET_NETWORK_ID
    && normalizeTonWhitelistAddress(registeredAddress) === normalizedAddress
  ));
}

export class TonWhitelistApiError extends Error {
  code: string;

  constructor(code: string) {
    super(code);
    this.code = code;
  }
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(apiUrl(path), {
    ...options,
    credentials: 'include',
    headers: {
      ...(options.headers || {}),
      ...(options.body && { 'content-type': 'application/json' }),
    },
  });

  let data: { code?: string } & Record<string, unknown> = {};
  try {
    const parsed = await response.json();
    if (parsed && typeof parsed === 'object') {
      data = parsed as { code?: string } & Record<string, unknown>;
    }
  } catch {
    // The caller receives a stable error code below when the response is not JSON.
  }

  if (!response.ok) {
    throw new TonWhitelistApiError(data.code || `http_${response.status}`);
  }

  return data as T;
}

export function createTonWhitelistChallenge() {
  return request<{ payload: string; expiresAt: string }>('/api/ton/whitelist/challenge', {
    method: 'POST',
    body: JSON.stringify({}),
  });
}

export async function getTonWhitelistAddresses(address?: string) {
  const addressQuery = address ? `?address=${encodeURIComponent(address)}` : '';
  const response = await request<{ wallets: TonWhitelistAddress[] }>(
    `/api/ton/whitelist${addressQuery}`,
    { cache: 'no-store' },
  );
  return response.wallets;
}

export async function registerTonWalletProof(wallet: Pick<ConnectedWallet, 'account' | 'connectItems'>) {
  const tonProofReply = wallet.connectItems?.tonProof;
  if (!tonProofReply || !('proof' in tonProofReply)) {
    throw new TonWhitelistApiError('invalid_proof');
  }

  const response = await request<{ wallet: TonWhitelistAddress }>('/api/ton/whitelist/verify', {
    method: 'POST',
    body: JSON.stringify({
      account: {
        address: wallet.account.address,
        chain: wallet.account.chain,
        publicKey: wallet.account.publicKey,
        walletStateInit: wallet.account.walletStateInit,
      },
      proof: tonProofReply.proof,
    }),
  });

  return response.wallet;
}

export async function recoverTonWalletRegistration(wallet: Pick<ConnectedWallet, 'account' | 'connectItems'>) {
  // A Telegram return can reload the document after wallet approval. The SDK
  // restores its proof, but a completed registration must not consume it again.
  const addresses = await getTonWhitelistAddresses();
  const existing = addresses.find(({ address }) => address.toLowerCase() === wallet.account.address.toLowerCase());
  if (existing) return existing;
  const reply = wallet.connectItems?.tonProof;
  if (!reply || !('proof' in reply)) return undefined;
  return registerTonWalletProof(wallet);
}

export async function checkTonWhitelistWallet(
  walletApi: Pick<
    typeof import('../api/chains/ton/externalWallet'),
    'getConnectedExternalTonWallet' | 'connectExternalTonWallet'
  >,
) {
  const currentWallet = await walletApi.getConnectedExternalTonWallet();
  if (currentWallet) {
    const registeredWallet = await recoverTonWalletRegistration(currentWallet);
    if (!registeredWallet) throw new TonWhitelistApiError('invalid_proof');
    return registeredWallet;
  }

  const challenge = await createTonWhitelistChallenge();
  const connectedWallet = await walletApi.connectExternalTonWallet(challenge.payload);
  return registerTonWalletProof(connectedWallet);
}
