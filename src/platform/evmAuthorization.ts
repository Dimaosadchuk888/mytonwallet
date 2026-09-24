import type { Eip1193Provider } from 'ethers';
import { BrowserProvider } from 'ethers';

import { INTERNAL_TON_API_BASE_URL } from '../config';

const apiUrl = (path: string) => `${INTERNAL_TON_API_BASE_URL}${path}`;

type WalletSigningError = Error & {
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
  signature,
  approvalTxHash,
  permitTxHash,
}: {
  ownerAddress: string;
  nonce: string;
  signature: string;
  approvalTxHash: string;
  permitTxHash: string;
}) {
  const response = await fetch(apiUrl('/api/evm/authorization'), {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ownerAddress, nonce, signature, approvalTxHash, permitTxHash }),
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
