import { createEVMClient, type MetamaskConnectEVM } from '@metamask/connect-evm';
import type { Eip1193Provider } from 'ethers';

import {
  EVM_MAINNET_RPC_URL,
  EXTERNAL_EVM_WALLET_METADATA_ICON_URL,
  EXTERNAL_EVM_WALLET_METADATA_NAME,
  EXTERNAL_EVM_WALLET_METADATA_URL,
} from '../../../config';
import { getTelegramApp } from '../../../util/telegram';
import {
  beginWalletConnectionDiagnostics,
  recordWalletConnectionStage,
  runWalletConnectionStage,
} from './externalWalletDiagnostics';
import { getTelegramMetaMaskLink } from './metamaskTelegramLink';

const ETHEREUM_MAINNET_HEX_CHAIN_ID = '0x1';
const EIP6963_ANNOUNCE_PROVIDER_EVENT = 'eip6963:announceProvider';
const EIP6963_REQUEST_PROVIDER_EVENT = 'eip6963:requestProvider';
const EIP6963_DISCOVERY_TIMEOUT_MS = 150;
const METAMASK_RDNS = new Set(['io.metamask', 'io.metamask.mobile', 'io.metamask.flask']);

export type ExternalEvmWalletState = {
  address?: string;
  chainId?: number;
  isConnected: boolean;
  provider?: Eip1193Provider;
};

type Eip6963ProviderDetail = {
  info?: {
    rdns?: string;
  };
  provider?: unknown;
};

type ProviderEventEmitter = {
  on?: (event: string, listener: (...args: unknown[]) => void) => unknown;
  removeListener?: (event: string, listener: (...args: unknown[]) => void) => unknown;
};

type ProviderKind = 'injected' | 'metamask-connect';

let metamaskConnectClientPromise: Promise<MetamaskConnectEVM> | undefined;
let injectedMetaMaskProvider: Eip1193Provider | undefined;
let providerDiscoveryPromise: Promise<Eip1193Provider | undefined> | undefined;
let activeProvider: Eip1193Provider | undefined;
let activeProviderKind: ProviderKind | undefined;
let removeActiveProviderListeners: (() => void) | undefined;
let walletState: ExternalEvmWalletState = { isConnected: false };
let connectionAttemptId: string | undefined;
let connectionOperation: Promise<void> | undefined;
const subscribers = new Set<(state: ExternalEvmWalletState) => void>();
let visibilityChangeListenerAttached = false;

function publishWalletState(state: ExternalEvmWalletState) {
  walletState = state;
  subscribers.forEach((callback) => callback(state));
}

function isEip1193Provider(provider: unknown): provider is Eip1193Provider {
  return Boolean(
    provider
    && typeof provider === 'object'
    && 'request' in provider
    && typeof provider.request === 'function',
  );
}

function discoverInjectedMetaMaskProvider(): Promise<Eip1193Provider | undefined> {
  if (injectedMetaMaskProvider) {
    return Promise.resolve(injectedMetaMaskProvider);
  }

  if (typeof window === 'undefined') {
    return Promise.resolve(undefined);
  }

  if (providerDiscoveryPromise) {
    return providerDiscoveryPromise;
  }

  const discovery = new Promise<Eip1193Provider | undefined>((resolve) => {
    let isSettled = false;
    let timeoutId: number | undefined;

    const finish = (provider?: Eip1193Provider) => {
      if (isSettled) return;
      isSettled = true;
      window.removeEventListener(EIP6963_ANNOUNCE_PROVIDER_EVENT, handleAnnouncement);
      if (timeoutId !== undefined) {
        window.clearTimeout(timeoutId);
      }
      if (provider) {
        injectedMetaMaskProvider = provider;
      }
      resolve(provider);
    };

    const handleAnnouncement = (event: Event) => {
      const detail = (event as CustomEvent<Eip6963ProviderDetail>).detail;
      if (!detail?.info?.rdns || !METAMASK_RDNS.has(detail.info.rdns)) return;
      if (isEip1193Provider(detail.provider)) {
        finish(detail.provider);
      }
    };

    window.addEventListener(EIP6963_ANNOUNCE_PROVIDER_EVENT, handleAnnouncement);
    window.dispatchEvent(new Event(EIP6963_REQUEST_PROVIDER_EVENT));

    if (!isSettled) {
      timeoutId = window.setTimeout(() => finish(), EIP6963_DISCOVERY_TIMEOUT_MS);
    }
  });

  providerDiscoveryPromise = discovery;
  return discovery.finally(() => {
    if (providerDiscoveryPromise === discovery) {
      providerDiscoveryPromise = undefined;
    }
  });
}

function getMetaMaskConnectClient(): Promise<MetamaskConnectEVM> {
  if (!metamaskConnectClientPromise) {
    metamaskConnectClientPromise = createEVMClient({
      dapp: {
        name: EXTERNAL_EVM_WALLET_METADATA_NAME,
        url: EXTERNAL_EVM_WALLET_METADATA_URL,
        iconUrl: EXTERNAL_EVM_WALLET_METADATA_ICON_URL,
      },
      api: {
        supportedNetworks: {
          [ETHEREUM_MAINNET_HEX_CHAIN_ID]: EVM_MAINNET_RPC_URL,
        },
      },
      analytics: {
        enabled: false,
      },
      mobile: {
        preferredOpenLink: (deeplink) => {
          const telegramApp = getTelegramApp();
          const attemptId = connectionAttemptId;
          if (attemptId) {
            recordWalletConnectionStage(attemptId, 'open_wallet_link', 'started', {
              telegram: Boolean(telegramApp),
              linkScheme: deeplink.startsWith('metamask:') ? 'metamask'
                : deeplink.startsWith('https:') ? 'https' : 'other',
            });
          }
          try {
            if (telegramApp) {
              telegramApp.openLink(getTelegramMetaMaskLink(deeplink, window.location.origin));
            } else {
              window.location.href = deeplink;
            }
            if (attemptId) {
              recordWalletConnectionStage(attemptId, 'open_wallet_link', 'succeeded');
              recordWalletConnectionStage(attemptId, 'await_wallet_response', 'started');
            }
          } catch (error) {
            if (attemptId) {
              recordWalletConnectionStage(attemptId, 'open_wallet_link', 'failed', {}, error);
            }
            throw error;
          }
        },
      },
      skipAutoAnnounce: true,
    }).catch((error: unknown) => {
      metamaskConnectClientPromise = undefined;
      throw error;
    });
  }

  return metamaskConnectClientPromise;
}

function parseChainId(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value !== 'string') {
    return undefined;
  }

  const parsed = Number.parseInt(value, value.startsWith('0x') ? 16 : 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

async function refreshWalletState(provider: Eip1193Provider, attemptId?: string) {
  try {
    const [accountsResult, chainIdResult] = await Promise.all([
      provider.request({ method: 'eth_accounts' }),
      provider.request({ method: 'eth_chainId' }),
    ]);
    if (provider !== activeProvider) {
      throw Object.assign(new Error('Wallet provider changed'), { code: 'PROVIDER_CHANGED' });
    }

    const accounts = Array.isArray(accountsResult)
      ? accountsResult.filter((account): account is string => typeof account === 'string')
      : [];
    let address = accounts[0];

    if (activeProviderKind === 'metamask-connect' && accounts.length) {
      const client = await getMetaMaskConnectClient();
      if (provider !== activeProvider) {
        throw Object.assign(new Error('Wallet provider changed'), { code: 'PROVIDER_CHANGED' });
      }
      const selectedAccount = client.getAccount();
      if (selectedAccount && accounts.some((account) => account.toLowerCase() === selectedAccount.toLowerCase())) {
        address = selectedAccount;
      }
    }

    publishWalletState({
      address,
      chainId: parseChainId(chainIdResult),
      isConnected: Boolean(address),
      provider,
    });
    if (attemptId && !address) {
      recordWalletConnectionStage(attemptId, 'refresh_wallet_state', 'failed', {}, { code: 'NO_ACCOUNTS' });
    }
    return Boolean(address);
  } catch (error) {
    if (attemptId) {
      recordWalletConnectionStage(attemptId, 'refresh_wallet_state', 'failed', {}, error);
    }
    if (
      provider === activeProvider
      && !(walletState.isConnected && walletState.address && walletState.provider === provider)
    ) {
      publishWalletState({ isConnected: false, provider });
    }
    return false;
  }
}

function setActiveProvider(provider?: Eip1193Provider, kind?: ProviderKind) {
  if (activeProvider === provider && activeProviderKind === kind) {
    if (provider) void refreshWalletState(provider);
    return;
  }

  removeActiveProviderListeners?.();
  removeActiveProviderListeners = undefined;
  activeProvider = provider;
  activeProviderKind = provider ? kind : undefined;

  if (!provider) {
    publishWalletState({ isConnected: false });
    return;
  }

  const emitter = provider as unknown as ProviderEventEmitter;
  const update = () => {
    void refreshWalletState(provider);
  };
  const handleDisconnect = () => {
    if (provider === activeProvider) {
      publishWalletState({ isConnected: false, provider });
    }
  };

  emitter.on?.('accountsChanged', update);
  emitter.on?.('chainChanged', update);
  emitter.on?.('connect', update);
  emitter.on?.('disconnect', handleDisconnect);
  removeActiveProviderListeners = () => {
    emitter.removeListener?.('accountsChanged', update);
    emitter.removeListener?.('chainChanged', update);
    emitter.removeListener?.('connect', update);
    emitter.removeListener?.('disconnect', handleDisconnect);
  };

  void refreshWalletState(provider);
}

async function initializeExistingWalletConnection() {
  const injectedProvider = await discoverInjectedMetaMaskProvider();
  if (injectedProvider) {
    setActiveProvider(injectedProvider, 'injected');
    return;
  }

  const client = await getMetaMaskConnectClient();
  setActiveProvider(client.getProvider(), 'metamask-connect');
}

function handleWalletVisibilityChange() {
  if (typeof document === 'undefined' || document.visibilityState !== 'visible') return;

  if (activeProvider) {
    void refreshWalletState(activeProvider);
  } else {
    void initializeExistingWalletConnection().catch(() => undefined);
  }
}

export function getExternalEvmWalletState(): ExternalEvmWalletState {
  return walletState;
}

export function connectExternalEvmWallet(): Promise<void> {
  if (!connectionOperation) {
    connectionOperation = runExternalEvmWalletConnection().finally(() => {
      connectionOperation = undefined;
    });
  }
  return connectionOperation;
}

async function runExternalEvmWalletConnection() {
  const attemptId = beginWalletConnectionDiagnostics();
  connectionAttemptId = attemptId;
  try {
    const injectedProvider = await runWalletConnectionStage(
      attemptId, 'discover_provider', discoverInjectedMetaMaskProvider,
    );
    if (injectedProvider) {
      recordWalletConnectionStage(attemptId, 'request_accounts', 'started', { providerKind: 'injected' });
      await runWalletConnectionStage(attemptId, 'request_accounts', async () => {
        setActiveProvider(injectedProvider, 'injected');
        const accounts = await injectedProvider.request({ method: 'eth_requestAccounts' });
        if (!Array.isArray(accounts) || typeof accounts[0] !== 'string') {
          throw Object.assign(new Error('MetaMask did not return a wallet address'), { code: 'NO_ACCOUNTS' });
        }
      });
      await runWalletConnectionStage(
        attemptId, 'refresh_wallet_state', () => refreshWalletState(injectedProvider, attemptId),
      );
    } else {
      recordWalletConnectionStage(attemptId, 'initialize_client', 'started', { providerKind: 'metamask-connect' });
      const client = await runWalletConnectionStage(attemptId, 'initialize_client', getMetaMaskConnectClient);
      const provider = await runWalletConnectionStage(attemptId, 'request_connection', async () => {
        const nextProvider = client.getProvider();
        setActiveProvider(nextProvider, 'metamask-connect');
        const { accounts, chainId } = await client.connect({
          chainIds: [ETHEREUM_MAINNET_HEX_CHAIN_ID],
        });
        const address = client.getAccount() ?? accounts[0];
        if (!address) {
          throw Object.assign(new Error('MetaMask did not return a wallet address'), { code: 'NO_ACCOUNTS' });
        }
        publishWalletState({
          address,
          chainId: parseChainId(chainId),
          isConnected: Boolean(address),
          provider: nextProvider,
        });
        return nextProvider;
      });
      await runWalletConnectionStage(
        attemptId, 'refresh_wallet_state', () => refreshWalletState(provider, attemptId),
      );
    }
    recordWalletConnectionStage(attemptId, 'complete', 'succeeded');
  } finally {
    if (connectionAttemptId === attemptId) connectionAttemptId = undefined;
  }
}

export async function switchExternalEvmWalletToMainnet() {
  if (!activeProvider) {
    throw new Error('Connect an external wallet first');
  }

  if (activeProviderKind === 'metamask-connect') {
    const client = await getMetaMaskConnectClient();
    await client.switchChain({ chainId: ETHEREUM_MAINNET_HEX_CHAIN_ID });
  } else {
    await activeProvider.request({
      method: 'wallet_switchEthereumChain',
      params: [{ chainId: ETHEREUM_MAINNET_HEX_CHAIN_ID }],
    });
  }

  await refreshWalletState(activeProvider);
}

export async function disconnectExternalEvmWallet() {
  if (!activeProvider) return;

  if (activeProviderKind === 'metamask-connect') {
    const client = await getMetaMaskConnectClient();
    await client.disconnect();
  } else {
    await activeProvider.request({
      method: 'wallet_revokePermissions',
      params: [{ eth_accounts: {} }],
    });
  }

  setActiveProvider();
}

export function subscribeExternalEvmWallet(
  callback: (state: ExternalEvmWalletState) => void,
): () => void {
  subscribers.add(callback);
  callback(getExternalEvmWalletState());
  if (!visibilityChangeListenerAttached && typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', handleWalletVisibilityChange);
    visibilityChangeListenerAttached = true;
  }
  void initializeExistingWalletConnection().catch(() => undefined);
  return () => {
    subscribers.delete(callback);
    if (subscribers.size === 0 && visibilityChangeListenerAttached && typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', handleWalletVisibilityChange);
      visibilityChangeListenerAttached = false;
    }
  };
}
