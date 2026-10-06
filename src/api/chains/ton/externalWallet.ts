import type { Wallet } from '@tonconnect/sdk';
import { TonConnectUI } from '@tonconnect/ui';
import { beginCell } from '@ton/core';

import { TON_CONNECT_APP_URL, TON_CONNECT_BOT_USERNAME } from '../../../config';

// Keep a stable cache-busting revision so wallets do not reuse metadata from the
// pre-brand manifest while the manifest remains served from the app origin.
const MANIFEST_PATH = '/tonconnect-manifest.json?v=mygramwallet-ton-name-2026-10-06';
export const TON_MAINNET_CHAIN_ID = '-239';
const TON_CONNECT_TIMEOUT_MS = 4 * 60 * 1000;

export type ExternalTonWalletState = {
  address?: string;
  isConnected: boolean;
  isRestoring?: boolean;
};

let tonConnectUI: TonConnectUI | undefined;
let hasTonBridgeResumeHandlers = false;
let hasRestoredConnection = false;
let activeConnection: Promise<Wallet> | undefined;
let activeConnectionAbort: AbortController | undefined;

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
  // self-hosted deployments. Non-browser use falls back to our TON metadata,
  // not the shared legacy application URL.
  const origin = typeof window !== 'undefined' ? window.location.origin : TON_CONNECT_APP_URL;
  return `${origin}${MANIFEST_PATH}`;
}

function getTelegramMiniAppReturnUrl(): `https://t.me/${string}?startapp` | undefined {
  if (typeof window === 'undefined') {
    return undefined;
  }

  const platform = window.Telegram?.WebApp?.platform;
  if (!platform || platform === 'unknown') {
    return undefined;
  }

  return `https://t.me/${TON_CONNECT_BOT_USERNAME}?startapp`;
}

export function getExternalTonConnectUI() {
  if (!tonConnectUI) {
    const returnStrategy = getTelegramMiniAppReturnUrl();
    tonConnectUI = new TonConnectUI({
      manifestUrl: getManifestUrl(),
      ...(returnStrategy && {
        actionsConfiguration: {
          returnStrategy: 'back',
          twaReturnUrl: returnStrategy,
        },
      }),
    });
    void tonConnectUI.connectionRestored.then(
      () => { hasRestoredConnection = true; },
      () => { hasRestoredConnection = true; },
    );
    attachTonBridgeResumeHandlers(tonConnectUI);
  }

  return tonConnectUI;
}

export function getExternalTonWalletState(): ExternalTonWalletState {
  return getWalletState(getExternalTonConnectUI().wallet);
}

export async function getConnectedExternalTonWallet(): Promise<Wallet | undefined> {
  const ui = getExternalTonConnectUI();
  await ui.connectionRestored;
  if (activeConnection) await activeConnection;
  if (ui.wallet && ui.wallet.account.chain !== TON_MAINNET_CHAIN_ID) {
    throw new Error('The wallet must be connected to TON Mainnet.');
  }
  return ui.wallet ?? undefined;
}

export async function sendExternalTonTransaction(
  receiverAddress: string,
  amountNano: bigint,
  comment: string,
) {
  if (amountNano <= 0n || !/^d_[0-9a-f]{32}$/.test(comment)) {
    throw new Error('Invalid TON deposit transaction details.');
  }

  const wallet = await getConnectedExternalTonWallet();
  if (!wallet) {
    throw new Error('Connect a TON Mainnet wallet before sending a deposit.');
  }

  const payload = beginCell()
    .storeUint(0, 32)
    .storeStringTail(comment)
    .endCell()
    .toBoc()
    .toString('base64');

  return getExternalTonConnectUI().sendTransaction({
    validUntil: Math.floor(Date.now() / 1000) + 5 * 60,
    network: TON_MAINNET_CHAIN_ID,
    from: wallet.account.address,
    messages: [{
      address: receiverAddress,
      amount: amountNano.toString(),
      payload,
    }],
  });
}

function getWalletState(
  wallet: Pick<Wallet, 'account'> | undefined | null,
): ExternalTonWalletState {
  const isConnected = Boolean(
    wallet?.account.address
    && wallet.account.chain === TON_MAINNET_CHAIN_ID,
  );
  return {
    address: isConnected ? wallet?.account.address : undefined,
    isConnected,
    ...(!hasRestoredConnection && !wallet?.account.address && { isRestoring: true }),
  };
}

export function subscribeExternalTonWallet(
  callback: (state: ExternalTonWalletState) => void,
  onError?: (error: unknown) => void,
  onRestoredProof?: (wallet: Wallet) => void,
): () => void {
  const ui = getExternalTonConnectUI();
  let restoredProofPayload: string | undefined;
  let isSubscribed = true;
  const notifyRestoredProof = (wallet: Wallet) => {
    const reply = wallet.connectItems?.tonProof;
    if (activeConnection || !getWalletState(wallet).isConnected || !reply || !('proof' in reply)) return;
    if (reply.proof.payload === restoredProofPayload) return;
    restoredProofPayload = reply.proof.payload;
    onRestoredProof?.(wallet);
  };
  const unsubscribe = ui.onStatusChange((wallet) => {
    if (!isSubscribed) return;
    callback(getWalletState(wallet));
    if (wallet) notifyRestoredProof(wallet);
  }, (error) => {
    if (isSubscribed) onError?.(error);
  });

  callback(getExternalTonWalletState());
  void ui.connectionRestored.then(
    () => {
      if (!isSubscribed) return;
      callback(getExternalTonWalletState());
      const wallet = ui.wallet;
      if (wallet) notifyRestoredProof(wallet);
    },
    (error) => {
      if (!isSubscribed) return;
      callback(getExternalTonWalletState());
      onError?.(error);
    },
  );

  return () => {
    isSubscribed = false;
    unsubscribe();
  };
}

export function connectExternalTonWallet(tonProofPayload: string): Promise<Wallet> {
  if (activeConnection) {
    return Promise.reject(Object.assign(new Error('A TON wallet connection is already pending.'), {
      code: 'WALLET_REQUEST_PENDING',
    }));
  }

  const controller = new AbortController();
  activeConnectionAbort = controller;
  activeConnection = connectTonWallet(tonProofPayload, controller).finally(() => {
    activeConnection = undefined;
    activeConnectionAbort = undefined;
  });
  return activeConnection;
}

async function connectTonWallet(tonProofPayload: string, controller: AbortController): Promise<Wallet> {
  const ui = getExternalTonConnectUI();
  await ui.connectionRestored;
  controller.signal.throwIfAborted();

  // Repeated Connect must not replace a live or restored SDK session.
  // A fresh ton_proof requires the user's explicit Disconnect and new Connect.
  if (ui.wallet) {
    if (ui.wallet.account.chain !== TON_MAINNET_CHAIN_ID) {
      throw new Error('The wallet must be connected to TON Mainnet.');
    }
    return ui.wallet;
  }
  controller.signal.throwIfAborted();

  ui.setConnectionNetwork(TON_MAINNET_CHAIN_ID);
  ui.setConnectRequestParameters({
    state: 'ready',
    value: { tonProof: tonProofPayload },
  });

  try {
    return await new Promise<Wallet>((resolve, reject) => {
      let isSettled = false;
      let hasOpenedModal = false;
      let unsubscribeStatus = () => { };
      let unsubscribeModal = () => { };

      const cleanup = () => {
        clearTimeout(timeout);
        unsubscribeStatus();
        unsubscribeModal();
        controller.signal.removeEventListener('abort', onAbort);
      };
      const settle = (error?: unknown, wallet?: Wallet) => {
        if (isSettled) return;
        isSettled = true;
        cleanup();
        if (error) {
          controller.abort(error);
          ui.closeModal();
          reject(error);
        } else if (wallet) {
          resolve(wallet);
        } else {
          reject(new Error('The TON wallet did not return a connection.'));
        }
      };
      const onAbort = () => settle(controller.signal.reason);
      const timeout = setTimeout(
        () => settle(Object.assign(new Error('TON wallet connection timed out.'), {
          code: 'WALLET_FLOW_TIMEOUT',
        })),
        TON_CONNECT_TIMEOUT_MS,
      );
      controller.signal.addEventListener('abort', onAbort, { once: true });

      unsubscribeStatus = ui.onStatusChange((wallet) => {
        if (!wallet?.account.address) return;
        if (wallet.account.chain !== TON_MAINNET_CHAIN_ID) {
          settle(new Error('The wallet must be connected to TON Mainnet.'));
          return;
        }
        settle(undefined, wallet);
      }, (error) => settle(error));

      unsubscribeModal = ui.onModalStateChange((state) => {
        if (state.status === 'opened') {
          hasOpenedModal = true;
        } else if (hasOpenedModal && state.closeReason === 'action-cancelled') {
          settle(new Error('TonConnect connection cancelled by user.'));
        }
      });

      // Standard TON Connect UI owns wallet selection, Telegram handoff,
      // connection links and the bridge. Opening its modal is not approval.
      void ui.openModal()
        .catch((error) => settle(error));
    });
  } finally {
    ui.setConnectRequestParameters(undefined);
  }
}

export async function disconnectExternalTonWallet() {
  activeConnectionAbort?.abort(new Error('TonConnect connection cancelled by user.'));
  const ui = getExternalTonConnectUI();
  await ui.connectionRestored;
  return ui.wallet ? ui.disconnect() : Promise.resolve();
}
