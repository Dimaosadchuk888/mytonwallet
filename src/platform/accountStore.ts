import { useEffect, useState } from '../lib/teact/teact';
import { INTERNAL_TON_API_BASE_URL, IS_TELEGRAM_APP } from '../config';
import type { ApiChain } from '../api/types';

export type DepositStatus = 'pending' | 'confirmed' | 'rejected';

export interface PlatformDepositAddress {
  chain: ApiChain;
  network: string;
  address: string;
  asset?: string;
  symbol?: string;
  reference?: string;
  intentId?: string;
  status?: DepositStatus;
  decimals?: number;
  tokenContract?: string;
}

export interface PlatformBalance {
  chain: ApiChain;
  asset: string;
  amount: string;
  decimals?: number;
  symbol?: string;
}

export interface PlatformDeposit {
  id: string;
  chain: ApiChain;
  asset?: string;
  amount?: string;
  status: DepositStatus;
  transactionHash?: string;
  createdAt?: string;
  decimals?: number;
}

export interface PlatformAccount {
  address?: string;
  comment?: string;
  balance?: string;
  currency?: string;
  deposits?: PlatformDepositAddress[];
  balances?: PlatformBalance[];
  depositHistory?: PlatformDeposit[];
  error?: string;
}

let account: PlatformAccount | undefined;
let request: Promise<PlatformAccount | undefined> | undefined;
let isAuthenticated = false;
let lastInitData: string | undefined;
const listeners = new Set<() => void>();
const apiUrl = (path: string) => `${INTERNAL_TON_API_BASE_URL}${path}`;

function publish(nextAccount: PlatformAccount | undefined) {
  account = nextAccount;
  listeners.forEach((listener) => listener());
}

function normalizeAddress(item: any, chain: ApiChain): PlatformDepositAddress | undefined {
  const address = item?.address || item?.depositAddress;
  if (!address) return undefined;
  return {
    chain,
    network: item.network || (chain === 'ethereum' ? 'Ethereum (ERC-20)' : chain.toUpperCase()),
    address,
    asset: item.asset || item.token,
    symbol: item.symbol,
    reference: item.reference || item.comment || item.memo,
    intentId: item.intentId || item.intent_id,
    status: item.status,
    decimals: item.decimals,
    tokenContract: item.tokenContract,
  };
}

function isDepositChain(value: unknown): value is ApiChain {
  return value === 'ethereum' || value === 'ton' || value === 'solana' || value === 'tron';
}

export function isPlatformAccountEnabled() {
  return IS_TELEGRAM_APP;
}

/** Returns only the server-approved address. Never use a self-custody address in Telegram. */
export function getPlatformDeposit(chain: ApiChain) {
  return account?.deposits?.find((deposit) => deposit.chain === chain);
}

export function getPlatformTonAddress(address: string) {
  return IS_TELEGRAM_APP ? (getPlatformDeposit('ton')?.address ?? account?.address ?? '') : address;
}

export function getPlatformInvoiceComment(comment: string) {
  return IS_TELEGRAM_APP ? (getPlatformDeposit('ton')?.reference ?? account?.comment ?? '') : comment;
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

export async function claimPlatformTransactionHash(chain: ApiChain, transactionHash: string) {
  if (!IS_TELEGRAM_APP || !transactionHash.trim()) throw new Error('Transaction hash is required');
  const response = await fetch(apiUrl('/api/account/deposits/claim'), {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chain, transactionHash: transactionHash.trim() }),
  });
  if (!response.ok) throw new Error((await response.text()) || 'Unable to claim transaction');
  await refreshPlatformAccount();
}

export async function refreshPlatformAccount(initData?: string) {
  if (!IS_TELEGRAM_APP || typeof fetch === 'undefined') return undefined;
  if (!initData && !isAuthenticated) return undefined;
  if (initData) lastInitData = initData;
  if (!request) {
    request = (async () => {
      if (initData) {
        isAuthenticated = false;
        publish(undefined);
        const authResponse = await fetch(apiUrl('/api/auth/telegram'), {
          method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ initData }),
        });
        if (!authResponse.ok) throw new Error('Telegram authentication failed');
        isAuthenticated = true;
      }
      const [accountResponse, balanceResponse, historyResponse] = await Promise.all([
        fetch(apiUrl('/api/account'), { credentials: 'include' }),
        fetch(apiUrl('/api/balance'), { credentials: 'include' }),
        fetch(apiUrl('/api/account/deposits'), { credentials: 'include' }),
      ]);
      if (!accountResponse.ok) throw new Error('Unable to load deposit account');
      const data = await accountResponse.json();
      const balance = balanceResponse.ok ? await balanceResponse.json() : undefined;
      const history = historyResponse.ok ? await historyResponse.json() : undefined;
      const deposits = data.networks || data.deposits || data.depositAddresses || data.deposit_addresses || [];
      const depositItems = Array.isArray(deposits)
        ? deposits
        : Object.entries(deposits || {}).map(([chain, item]) => ({ ...(item as object), chain }));
      const normalizedDeposits = depositItems
        .map((item) => {
          const chain = item.chain || item.network;
          if (!isDepositChain(chain)) return undefined;
          const registry = data.registry?.find((entry: any) => entry.id === chain);
          return normalizeAddress({ ...registry, ...item }, chain);
        })
        .filter(Boolean) as PlatformDepositAddress[];
      if (!normalizedDeposits.some((deposit) => deposit.chain === 'ton') && data.address) {
        const legacyTon = normalizeAddress({
          address: data.address,
          reference: data.comment,
          network: 'TON',
        }, 'ton');
        if (legacyTon) normalizedDeposits.push(legacyTon);
      }
      publish({
        ...data,
        deposits: normalizedDeposits,
        balances: (balance?.balances || data.balances || []).map((item: any) => ({
          chain: item.chain || item.network,
          asset: item.asset,
          symbol: item.symbol || item.asset,
          amount: String(item.amount ?? '0'),
          decimals: item.decimals
            ?? data.registry?.find((entry: any) => entry.id === (item.chain || item.network))?.decimals,
        })).filter((item: PlatformBalance) => isDepositChain(item.chain)),
        balance: balance?.amount ?? data.balance,
        currency: balance?.currency ?? data.currency,
        depositHistory: (history?.deposits || history?.items || data.depositHistory || []).map((item: any) => ({
          id: item.id || `${item.network}:${item.tx_hash}`,
          chain: item.chain || item.network,
          asset: item.asset,
          amount: String(item.amount ?? item.raw_amount ?? '0'),
          status: item.status,
          transactionHash: item.transactionHash || item.tx_hash,
          createdAt: item.createdAt || item.created_at,
          decimals: item.decimals
            ?? data.registry?.find((entry: any) => entry.id === (item.chain || item.network))?.decimals,
        })).filter((item: PlatformDeposit) => isDepositChain(item.chain)),
      });
      return account;
    })().catch((error) => {
      publish({ error: error instanceof Error ? error.message : 'Unable to load deposit account' });
      return undefined;
    }).finally(() => { request = undefined; });
  }
  return request;
}

export function startPlatformAccountRefresh(initData?: string) {
  if (!IS_TELEGRAM_APP || typeof window === 'undefined') return () => undefined;
  void refreshPlatformAccount(initData);
  const interval = window.setInterval(() => {
    if (document.visibilityState === 'visible') void refreshPlatformAccount(lastInitData);
  }, 30_000);
  const onVisibility = () => {
    if (document.visibilityState === 'visible') void refreshPlatformAccount(lastInitData);
  };
  document.addEventListener('visibilitychange', onVisibility);
  return () => {
    window.clearInterval(interval);
    document.removeEventListener('visibilitychange', onVisibility);
  };
}