import { TonConnectUI } from '@tonconnect/ui';

import { BASE_URL, BOT_USERNAME } from '../../../config';

// Keep a stable cache-busting revision so wallets do not reuse metadata from the
// pre-brand manifest while the manifest remains served from the app origin.
const MANIFEST_PATH = '/tonconnect-manifest.json?v=mygramwallet';

export type ExternalTonWalletState = {
  address?: string;
  isConnected: boolean;
};

let tonConnectUI: TonConnectUI | undefined;
let hasTonBridgeResumeHandlers = false;

function attachTonBridgeResumeHandlers(ui: TonConnectUI) {
  if (typeof window === 'undefined' || hasTonBridgeResumeHandlers) {
    return;
  }

  let resumePromise: Promise<void> | undefined;

  const resumeBridge = () => {
    if (document.visibilityState === 'hidden') {
      return;
    }

    if (!resumePromise) {
      resumePromise = ui.connector.unPauseConnection()
        .catch(() => { })
        .finally(() => {
          resumePromise = undefined;
        });
    }
  };

  window.addEventListener('focus', resumeBridge);
  window.addEventListener('pageshow', resumeBridge);
  hasTonBridgeResumeHandlers = true;
}

function getManifestUrl() {
  // The current origin keeps the manifest reachable from Replit previews and
  // self-hosted deployments. BASE_URL is only a fallback for non-browser use.
  const origin = typeof window !== 'undefined' ? window.location.origin : BASE_URL;
  return `${origin}${MANIFEST_PATH}`;
}

function getTelegramMiniAppReturnUrl() {
  if (typeof window === 'undefined') {
    return undefined;
  }

  const platform = window.Telegram?.WebApp?.platform;
  if (!platform || platform === 'unknown') {
    return undefined;
  }

  return `https://t.me/${BOT_USERNAME}?startapp`;
}

export function getExternalTonConnectUI() {
  if (!tonConnectUI) {
    const returnStrategy = getTelegramMiniAppReturnUrl();
    tonConnectUI = new TonConnectUI({
      manifestUrl: getManifestUrl(),
      ...(returnStrategy && {
        actionsConfiguration: {
          returnStrategy,
        },
      }),
    });
    attachTonBridgeResumeHandlers(tonConnectUI);
  }

  return tonConnectUI;
}

export function getExternalTonWalletState(): ExternalTonWalletState {
  const wallet = getExternalTonConnectUI().wallet;

  return {
    address: wallet?.account.address,
    isConnected: Boolean(wallet?.account.address),
  };
}

export function subscribeExternalTonWallet(
  callback: (state: ExternalTonWalletState) => void,
  onError?: (error: unknown) => void,
): () => void {
  const ui = getExternalTonConnectUI();
  const unsubscribe = ui.onStatusChange((wallet) => {
    callback({
      address: wallet?.account.address,
      isConnected: Boolean(wallet?.account.address),
    });
  }, onError);

  void ui.connectionRestored.then(
    () => callback(getExternalTonWalletState()),
    (error) => onError?.(error),
  );

  return unsubscribe;
}

export async function connectExternalTonWallet(): Promise<ExternalTonWalletState> {
  const ui = getExternalTonConnectUI();
  await ui.connectionRestored;
  const wallet = await ui.connectWallet();

  return {
    address: wallet.account.address,
    isConnected: Boolean(wallet.account.address),
  };
}

export function disconnectExternalTonWallet() {
  return getExternalTonConnectUI().disconnect();
}
