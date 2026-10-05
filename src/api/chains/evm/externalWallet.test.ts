import type { Eip1193Provider } from 'ethers';

import { getTelegramMetaMaskLink } from './metamaskTelegramLink';

jest.mock('@metamask/connect-evm', () => ({
  createEVMClient: jest.fn(),
}));

jest.mock('../../../util/telegram', () => ({
  getTelegramApp: jest.fn(),
}));

const TEST_ADDRESS = '0x11a43b91414b2c7083888d8f4e963988ddee12a3';

type TestWalletProvider = {
  request: jest.Mock;
  on: jest.Mock;
  removeListener: jest.Mock;
};

function createTestProvider(initialAccounts: string[] = [TEST_ADDRESS]) {
  let accounts = initialAccounts;
  const request = jest.fn(({ method }: { method: string }): Promise<unknown> => {
    switch (method) {
      case 'eth_requestAccounts':
        accounts = [TEST_ADDRESS];
        return Promise.resolve(accounts);
      case 'eth_accounts':
        return Promise.resolve(accounts);
      case 'eth_chainId':
        return Promise.resolve('0x1');
      default:
        return Promise.resolve(undefined);
    }
  });

  const provider = {
    request,
    on: jest.fn(),
    removeListener: jest.fn(),
  } satisfies TestWalletProvider;

  return {
    provider: provider as unknown as Eip1193Provider,
    request,
    setAccounts: (nextAccounts: string[]) => {
      accounts = nextAccounts;
    },
  };
}

function announceInjectedProvider(provider: Eip1193Provider) {
  const dispatchEvent = window.dispatchEvent.bind(window);
  jest.spyOn(window, 'dispatchEvent').mockImplementation((event) => {
    const dispatched = dispatchEvent(event);
    if (event.type === 'eip6963:requestProvider') {
      dispatchEvent(new CustomEvent('eip6963:announceProvider', {
        detail: {
          info: { rdns: 'io.metamask' },
          provider,
        },
      }));
    }
    return dispatched;
  });
}

function mockMetaMaskClient(provider: Eip1193Provider) {
  const client = {
    connect: jest.fn().mockResolvedValue({ accounts: [TEST_ADDRESS], chainId: '0x1' }),
    disconnect: jest.fn().mockResolvedValue(undefined),
    getAccount: jest.fn(() => TEST_ADDRESS),
    getProvider: jest.fn(() => provider),
    switchChain: jest.fn().mockResolvedValue(undefined),
  };
  const createEVMClient = jest.requireMock('@metamask/connect-evm').createEVMClient as jest.Mock;
  createEVMClient.mockResolvedValue(client);
  return { client, createEVMClient };
}

let externalWallet: typeof import('./externalWallet');
let diagnostics: typeof import('./externalWalletDiagnostics');
let infoLog: jest.SpyInstance;

beforeEach(async () => {
  jest.resetModules();
  infoLog = jest.spyOn(console, 'info').mockImplementation(() => undefined);
  externalWallet = await import('./externalWallet');
  diagnostics = await import('./externalWalletDiagnostics');
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('external EVM wallet connector', () => {
  it('uses the discovered MetaMask provider for connect, network switching, and disconnect', async () => {
    const { provider, request } = createTestProvider([]);
    announceInjectedProvider(provider);

    await externalWallet.connectExternalEvmWallet();

    expect(request).toHaveBeenCalledWith({ method: 'eth_requestAccounts' });
    expect(externalWallet.getExternalEvmWalletState()).toMatchObject({
      address: TEST_ADDRESS,
      chainId: 1,
      isConnected: true,
      provider,
    });

    await externalWallet.switchExternalEvmWalletToMainnet();
    expect(request).toHaveBeenCalledWith({
      method: 'wallet_switchEthereumChain',
      params: [{ chainId: '0x1' }],
    });

    await externalWallet.disconnectExternalEvmWallet();
    expect(request).toHaveBeenCalledWith({
      method: 'wallet_revokePermissions',
      params: [{ eth_accounts: {} }],
    });
    expect(externalWallet.getExternalEvmWalletState()).toEqual({ isConnected: false });
  });

  it('uses MetaMask Connect when no injected MetaMask provider is announced', async () => {
    const { provider } = createTestProvider();
    const { client, createEVMClient } = mockMetaMaskClient(provider);
    const getTelegramApp = jest.requireMock('../../../util/telegram').getTelegramApp as jest.Mock;
    const telegramApp = {
      openLink: jest.fn((link: string) => {
        // Telegram's actual SDK performs this protocol check before opening a link.
        if (!['http:', 'https:'].includes(new URL(link).protocol)) throw new Error('WebAppTgUrlInvalid');
      }),
    };
    getTelegramApp.mockReturnValue(telegramApp);
    client.connect.mockImplementation(() => Promise.resolve().then(() => {
      const { mobile } = createEVMClient.mock.calls[0][0];
      mobile.preferredOpenLink('metamask://connect/mwp?p=test%2Brequest%2Fpayload%3D&c=1');
      return { accounts: [TEST_ADDRESS], chainId: '0x1' };
    }));
    const onDiagnostics = jest.fn();
    const unsubscribe = diagnostics.subscribeWalletConnectionDiagnostics(onDiagnostics);

    await externalWallet.connectExternalEvmWallet();

    expect(createEVMClient).toHaveBeenCalledWith(expect.objectContaining({
      analytics: { enabled: false },
      mobile: { preferredOpenLink: expect.any(Function) },
      skipAutoAnnounce: true,
    }));
    expect(telegramApp.openLink)
      .toHaveBeenCalledWith(getTelegramMetaMaskLink(
        'metamask://connect/mwp?p=test%2Brequest%2Fpayload%3D&c=1',
        'http://localhost',
      ));
    expect(onDiagnostics.mock.calls.some(([entry]) => entry.stage === 'await_wallet_response')).toBe(true);
    expect(onDiagnostics.mock.calls[onDiagnostics.mock.calls.length - 1][0])
      .toMatchObject({ stage: 'complete', status: 'succeeded', providerKind: 'metamask-connect' });
    expect(client.connect).toHaveBeenCalledWith({ chainIds: ['0x1'] });
    expect(externalWallet.getExternalEvmWalletState()).toMatchObject({
      address: TEST_ADDRESS,
      chainId: 1,
      isConnected: true,
      provider,
    });

    await externalWallet.switchExternalEvmWalletToMainnet();
    expect(client.switchChain).toHaveBeenCalledWith({ chainId: '0x1' });

    await externalWallet.disconnectExternalEvmWallet();
    expect(client.disconnect).toHaveBeenCalled();
    expect(externalWallet.getExternalEvmWalletState()).toEqual({ isConnected: false });
    unsubscribe();
  });

  it('reports client initialization failure without publishing provider error payloads', async () => {
    const createEVMClient = jest.requireMock('@metamask/connect-evm').createEVMClient as jest.Mock;
    createEVMClient.mockRejectedValue({
      code: 'NETWORK_ERROR', message: `PRIVATE_AUTH ${TEST_ADDRESS}`, data: 'PRIVATE_SIGNATURE',
    });
    const onDiagnostics = jest.fn();
    const unsubscribe = diagnostics.subscribeWalletConnectionDiagnostics(onDiagnostics);
    await expect(externalWallet.connectExternalEvmWallet()).rejects.toMatchObject({ code: 'NETWORK_ERROR' });
    expect(onDiagnostics.mock.calls[onDiagnostics.mock.calls.length - 1][0])
      .toMatchObject({ stage: 'initialize_client', status: 'failed', errorCode: 'NETWORK_ERROR' });
    const output = JSON.stringify([onDiagnostics.mock.calls, infoLog.mock.calls]);
    expect(output).not.toContain(TEST_ADDRESS);
    expect(output).not.toContain('PRIVATE_');
    unsubscribe();
  });

  it('retains the link-opening failure instead of overwriting it with the outer connect stage', async () => {
    const { provider } = createTestProvider();
    const { client, createEVMClient } = mockMetaMaskClient(provider);
    const getTelegramApp = jest.requireMock('../../../util/telegram').getTelegramApp as jest.Mock;
    getTelegramApp.mockReturnValue({
      openLink: () => {
        throw new Error('WebAppTgUrlInvalid');
      },
    });
    client.connect.mockImplementation(() => Promise.resolve().then(() => {
      createEVMClient.mock.calls[0][0].mobile.preferredOpenLink('metamask://connect/mwp?p=test&c=1');
    }));
    const onDiagnostics = jest.fn();
    const unsubscribe = diagnostics.subscribeWalletConnectionDiagnostics(onDiagnostics);
    await expect(externalWallet.connectExternalEvmWallet()).rejects.toThrow('WebAppTgUrlInvalid');
    expect(onDiagnostics.mock.calls[onDiagnostics.mock.calls.length - 1][0])
      .toMatchObject({ stage: 'open_wallet_link', status: 'failed', errorCode: 'WebAppTgUrlInvalid' });
    unsubscribe();
  });

  it('distinguishes an SDK connection rejection from initialization and link-opening failures', async () => {
    const { provider } = createTestProvider();
    const { client } = mockMetaMaskClient(provider);
    client.connect.mockRejectedValue({ code: 4001, message: 'PRIVATE_MESSAGE' });
    const onDiagnostics = jest.fn();
    const unsubscribe = diagnostics.subscribeWalletConnectionDiagnostics(onDiagnostics);
    await expect(externalWallet.connectExternalEvmWallet()).rejects.toMatchObject({ code: 4001 });
    expect(onDiagnostics.mock.calls[onDiagnostics.mock.calls.length - 1][0])
      .toMatchObject({ stage: 'request_connection', status: 'failed', errorCode: '4001' });
    unsubscribe();
  });

  it('allows an immediate retry after the wallet rejects a connection request', async () => {
    const { provider } = createTestProvider();
    const { client } = mockMetaMaskClient(provider);
    client.connect
      .mockRejectedValueOnce({ code: 4001, message: 'User rejected the request' })
      .mockResolvedValueOnce({ accounts: [TEST_ADDRESS], chainId: '0x1' });

    await expect(externalWallet.connectExternalEvmWallet()).rejects.toMatchObject({ code: 4001 });
    await expect(externalWallet.connectExternalEvmWallet()).resolves.toBeUndefined();

    expect(client.connect).toHaveBeenCalledTimes(2);
    expect(externalWallet.getExternalEvmWalletState()).toMatchObject({
      address: TEST_ADDRESS,
      chainId: 1,
      isConnected: true,
      provider,
    });
  });

  it('preserves a confirmed connection when a post-connect refresh fails', async () => {
    const { provider, request } = createTestProvider();
    request.mockImplementation(({ method }: { method: string }) => {
      if (method === 'eth_accounts') return Promise.reject({ code: -32603, message: 'PRIVATE_RPC_URL' });
      return Promise.resolve('0x1');
    });
    mockMetaMaskClient(provider);
    const onDiagnostics = jest.fn();
    const unsubscribe = diagnostics.subscribeWalletConnectionDiagnostics(onDiagnostics);
    await externalWallet.connectExternalEvmWallet();
    expect(externalWallet.getExternalEvmWalletState()).toMatchObject({
      address: TEST_ADDRESS,
      isConnected: true,
      provider,
    });
    expect(onDiagnostics.mock.calls[onDiagnostics.mock.calls.length - 1][0])
      .toMatchObject({ stage: 'refresh_wallet_state', status: 'failed', errorCode: '-32603' });
    unsubscribe();
  });

  it('refreshes the wallet session when the app becomes visible after a MetaMask handoff', async () => {
    const { provider, setAccounts } = createTestProvider([]);
    const { client } = mockMetaMaskClient(provider);
    let resolveConnect: ((value: { accounts: string[]; chainId: string }) => void) | undefined;
    let signalConnectStarted: (() => void) | undefined;
    const connectStarted = new Promise<void>((resolve) => {
      signalConnectStarted = resolve;
    });
    client.connect.mockImplementation(() => new Promise((resolve) => {
      resolveConnect = resolve;
      signalConnectStarted?.();
    }));

    const visibilityDescriptor = Object.getOwnPropertyDescriptor(document, 'visibilityState');
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: 'hidden',
    });
    const unsubscribe = externalWallet.subscribeExternalEvmWallet(jest.fn());

    try {
      const pendingConnection = externalWallet.connectExternalEvmWallet();
      await connectStarted;

      setAccounts([TEST_ADDRESS]);
      Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        value: 'visible',
      });
      document.dispatchEvent(new Event('visibilitychange'));
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(externalWallet.getExternalEvmWalletState()).toMatchObject({
        address: TEST_ADDRESS,
        isConnected: true,
        provider,
      });

      resolveConnect?.({ accounts: [TEST_ADDRESS], chainId: '0x1' });
      await pendingConnection;
    } finally {
      unsubscribe();
      if (visibilityDescriptor) {
        Object.defineProperty(document, 'visibilityState', visibilityDescriptor);
      } else {
        Reflect.deleteProperty(document, 'visibilityState');
      }
    }
  });

  it('reuses the same pending connection rather than mixing overlapping attempts', async () => {
    const { provider } = createTestProvider();
    const { client } = mockMetaMaskClient(provider);
    const first = externalWallet.connectExternalEvmWallet();
    const second = externalWallet.connectExternalEvmWallet();
    expect(second).toBe(first);
    await first;
    expect(client.connect).toHaveBeenCalledTimes(1);
  });
});
