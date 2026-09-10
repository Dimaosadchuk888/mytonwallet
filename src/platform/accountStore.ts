import { useEffect, useState } from '../lib/teact/teact';
import { IS_TELEGRAM_APP } from '../config';

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

function publish(nextAccount: PlatformAccount | undefined) {
  account = nextAccount;
  listeners.forEach((listener) => listener());
}

export function isPlatformAccountEnabled() {
  return IS_TELEGRAM_APP;
}

export function getPlatformTonAddress(address: string) {
  return IS_TELEGRAM_APP ? (account?.address ?? '') : address;
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
        const authResponse = await fetch('/api/auth/telegram', {
          method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ initData }),
        });
        if (!authResponse.ok) return undefined;
        isAuthenticated = true;
      }
      const [accountResponse, balanceResponse] = await Promise.all([
        fetch('/api/account', { credentials: 'include' }),
        fetch('/api/balance', { credentials: 'include' }),
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