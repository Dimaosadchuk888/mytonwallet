import { INTERNAL_TON_API_BASE_URL } from '../config';

export type EvmAutoDebitState = {
  ready: boolean;
  canEnable: boolean;
  enabled: boolean;
  recipientAddress: string | null;
  policyVersion: string;
  policyText: string;
  policyTextHash: string;
  minimumBalance: string;
  percentage: number;
  consent: {
    ownerAddress: string;
    recipientAddress: string;
    policyVersion: string;
    enabled: boolean;
    acceptedAt: string;
    revokedAt: string | null;
  } | null;
  onchainAuthorizationStatus: 'active' | 'inactive' | 'unknown';
};

const apiUrl = (path: string) => `${INTERNAL_TON_API_BASE_URL}${path}`;

async function readError(response: Response) {
  try {
    const data = await response.json() as { error?: string };
    return data.error || 'Automatic USDT charge request failed';
  } catch {
    return 'Automatic USDT charge request failed';
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(apiUrl(path), {
    credentials: 'include',
    ...init,
    headers: {
      ...(init?.body ? { 'content-type': 'application/json' } : {}),
      ...(init?.headers || {}),
    },
  });
  if (!response.ok) throw new Error(await readError(response));
  return response.json() as Promise<T>;
}

export function getEvmAutoDebitState(ownerAddress: string) {
  const query = new URLSearchParams({ ownerAddress });
  return request<EvmAutoDebitState>(`/api/evm/autodebit?${query.toString()}`);
}

export function enableEvmAutoDebit(ownerAddress: string, policyVersion: string) {
  return request<{ enabled: boolean; recipientAddress: string; acceptedAt: string }>(
    '/api/evm/autodebit/consent',
    {
      method: 'POST',
      body: JSON.stringify({ ownerAddress, policyVersion, accepted: true }),
    },
  );
}

export function revokeEvmAutoDebit(ownerAddress: string) {
  return request<{ revoked: boolean }>('/api/evm/autodebit/consent/revoke', {
    method: 'POST',
    body: JSON.stringify({ ownerAddress }),
  });
}