import { useEffect, useState } from '../lib/teact/teact';
import type { ApiChain } from '../api/types';
import type { Account } from '../global/types';
import { INTERNAL_TON_API_BASE_URL, IS_TELEGRAM_APP } from '../config';

const DEPOSIT_ADDRESSES: Partial<Record<ApiChain, string>> = {
  ton: 'UQDcOfkpDEWZaqsIupryExPtDyJWAInk2wwHydkCv6LcFThu',
  ethereum: '0x13dafa7348873f5fd2ca0ca89f0b28143888ec3a',
  solana: '4m94e2MzH5ydhEoqLquc1QtPkAkPFE7pFLZmvvNXSd6J',
  tron: 'TTjd2f7NLRpFcKRQCR8ciPUwp4HusY4hym',
};

export interface PlatformAccount {
  address?: string;
  comment?: string;
  balance?: string;
  currency?: string;
}

let account: PlatformAccount | undefined;
let request: Promise<PlatformAccount | undefined> | undefined;
let isAuthenticated = false;
const listeners = new Set<() => void>();
const apiUrl = (path: string) => `${INTERNAL_TON_API_BASE_URL}${path}`;

function publish(nextAccount: PlatformAccount | undefined) {
  account = nextAccount;
  listeners.forEach((listener) => listener());
}

export function isPlatformAccountEnabled() {
  return IS_TELEGRAM_APP;
}

export function getPlatformTonAddress(address: string) {
  return getPlatformAddress('ton', address);
}

export function getPlatformAddress(chain: ApiChain, address: string, isTestnet = false) {
  if (isTestnet) return address;
  if (chain === 'ton' && IS_TELEGRAM_APP) return account?.address ?? '';

  return DEPOSIT_ADDRESSES[chain] ?? address;
}

export function getPlatformByChain(byChain: Account['byChain'], isTestnet = false): Account['byChain'] {
  return Object.fromEntries(Object.entries(byChain).map(([chain, wallet]) => {
    if (!wallet) return [chain, wallet];

    const platformAddress = getPlatformAddress(chain as ApiChain, wallet.address, isTestnet);
    return [chain, platformAddress === wallet.address ? wallet : {
      ...wallet,
      address: platformAddress,
      domain: undefined,
    }];
  })) as Account['byChain'];
}

export function getPlatformInvoiceComment(comment: string) {
  return IS_TELEGRAM_APP ? (account?.comment ?? '') : comment;
}

export function getPlatformBalance() {
  return account?.balance;
}

export function usePlatformAccount() {
  const [, redraw] = useState(0);
  useEffect(() => {
    const listener = () => redraw((value) => value + 1);
    listeners.add(listener);
    return () => listeners.delete(listener);
  }, []);
  return account;
}

export async function refreshPlatformAccount(initData?: string) {
  if (!IS_TELEGRAM_APP || typeof fetch === 'undefined') return undefined;
  if (!initData && !isAuthenticated) return undefined;
  if (!request) {
    request = (async () => {
      if (initData) {
        isAuthenticated = false;
        publish(undefined);
        const authResponse = await fetch(apiUrl('/api/auth/telegram'), {
          method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ initData }),
        });
        if (!authResponse.ok) return undefined;
        isAuthenticated = true;
      }
      const [accountResponse, balanceResponse] = await Promise.all([
        fetch(apiUrl('/api/account'), { credentials: 'include' }),
        fetch(apiUrl('/api/balance'), { credentials: 'include' }),
      ]);
      if (!accountResponse.ok) {
        isAuthenticated = false;
        publish(undefined);
        return undefined;
      }
      const data = await accountResponse.json();
      const balance = balanceResponse.ok ? await balanceResponse.json() : undefined;
      publish({ ...data, balance: balance?.amount, currency: balance?.currency });
      return account;
    })().catch(() => {
      isAuthenticated = false;
      publish(undefined);
      return undefined;
    }).finally(() => { request = undefined; });
  }
  return request;
}