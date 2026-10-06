import { INTERNAL_TON_API_BASE_URL, IS_TELEGRAM_APP } from '../config';

export type TonDepositIntentStatus = 'pending' | 'expired' | 'credited' | 'rejected';

export interface TonDepositIntent {
  id: string;
  comment: string;
  sourceAddress?: string;
  depositAddress?: string;
  amountNano: string;
  expiresAt: string;
  status?: TonDepositIntentStatus;
}

export class TonDepositApiError extends Error {
  code?: string;
  status: number;

  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = 'TonDepositApiError';
    this.status = status;
    this.code = code;
  }
}

const apiUrl = (path: string) => `${INTERNAL_TON_API_BASE_URL}${path}`;

async function requestTonDeposit<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(apiUrl(path), {
    ...options,
    credentials: 'include',
    headers: {
      ...(options?.body && { 'content-type': 'application/json' }),
      ...(options?.headers || {}),
    },
  });

  const data = await response.json().catch(() => ({})) as {
    code?: string;
    error?: string;
    intent?: T;
  };
  if (!response.ok) {
    throw new TonDepositApiError(data.error || 'TON deposit request failed.', response.status, data.code);
  }
  return data.intent as T;
}

export async function createTonDepositIntent(sourceAddress: string, amountNano: bigint) {
  if (!IS_TELEGRAM_APP) throw new Error('TON deposit intents are available only in the Telegram wallet.');
  return requestTonDeposit<TonDepositIntent>('/api/ton/deposit-intents', {
    method: 'POST',
    body: JSON.stringify({ sourceAddress, amountNano: amountNano.toString() }),
  });
}

export async function getTonDepositIntent(id: string) {
  if (!IS_TELEGRAM_APP) throw new Error('TON deposit intents are available only in the Telegram wallet.');
  return requestTonDeposit<TonDepositIntent>(`/api/ton/deposit-intents/${encodeURIComponent(id)}`);
}

export async function cancelTonDepositIntent(id: string) {
  if (!IS_TELEGRAM_APP) throw new Error('TON deposit intents are available only in the Telegram wallet.');
  return requestTonDeposit<{ ok: boolean }>(`/api/ton/deposit-intents/${encodeURIComponent(id)}/cancel`, {
    method: 'POST',
  });
}
