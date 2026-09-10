import { useEffect, useState } from '../lib/teact/teact';
import { getActions } from '../global';
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

export type PlatformRewardResult = {
  status: 'credited' | 'already_claimed' | 'not_found' | 'inactive' | 'expired' | 'exhausted' | 'error';
  title?: string;
  amount?: string;
  balance?: string;
};

export interface PlatformAuthMetadata {
  isAdmin: boolean;
  reward?: PlatformRewardResult;
}

let account: PlatformAccount | undefined;
let request: Promise<PlatformAccount | undefined> | undefined;
let isAuthenticated = false;
let authMetadata: PlatformAuthMetadata | undefined;
let lastRewardToastKey: string | undefined;
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

export function getPlatformAuthMetadata() {
  return authMetadata;
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
        const authData = await authResponse.json() as { ok?: boolean; isAdmin?: boolean; reward?: PlatformRewardResult };
        authMetadata = { isAdmin: Boolean(authData.isAdmin), reward: authData.reward };
        if (authData.reward && JSON.stringify(authData.reward) !== lastRewardToastKey) {
          lastRewardToastKey = JSON.stringify(authData.reward);
          const reward = authData.reward;
          const message = reward.status === 'credited'
            ? `Начислено ${formatNanoTon(reward.amount)} TON`
            : reward.status === 'already_claimed'
              ? 'Эта награда уже получена'
              : reward.status === 'not_found'
                ? 'Награда не найдена'
                : reward.status === 'inactive'
                  ? 'Эта награда больше недоступна'
                  : reward.status === 'expired'
                    ? 'Срок действия награды истёк'
                    : reward.status === 'exhausted'
                      ? 'Лимит получателей награды исчерпан'
                      : 'Не удалось начислить награду. Откройте ссылку ещё раз';
          getActions().showToast({ message });
        }
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

function formatNanoTon(value?: string) {
  if (!value) return '0';
  const normalized = value.padStart(10, '0');
  const whole = normalized.slice(0, -9).replace(/^0+(?=\d)/, '');
  const fraction = normalized.slice(-9).replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : whole;
}