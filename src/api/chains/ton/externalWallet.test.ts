import { Cell } from '@ton/core';
import type { Wallet } from '@tonconnect/sdk';
import { type ConnectedWallet, TonConnectUI } from '@tonconnect/ui';

jest.mock('@tonconnect/ui', () => ({
  TonConnectUI: jest.fn(),
}));

type ExternalWalletModule = typeof import('./externalWallet');
type StatusListener = (wallet: ConnectedWallet | null) => void;

function createConnectedWallet(
  appName = 'tonkeeper',
  chain: ConnectedWallet['account']['chain'] = '-239',
): ConnectedWallet {
  return {
    appName,
    provider: 'http',
    name: appName,
    imageUrl: 'https://example.test/icon.png',
    aboutUrl: 'https://example.test',
    platforms: ['ios'],
    universalLink: 'https://example.test/connect',
    bridgeUrl: 'https://example.test/bridge',
    device: {
      platform: 'iphone',
      appName,
      appVersion: '1',
      maxProtocolVersion: 2,
      features: [],
    },
    account: {
      address: `0:${'a'.repeat(64)}`,
      chain,
      walletStateInit: 'test-state-init',
    },
  };
}

describe('Standard TON Connect UI completion', () => {
  let api: ExternalWalletModule;
  let statusListener: StatusListener;
  let unsubscribeStatus: jest.Mock;
  let unsubscribeModal: jest.Mock;
  let modalListener: (state: { status: string; closeReason?: string }) => void;
  let ui: {
    connectionRestored: Promise<void>;
    wallet: Wallet | undefined;
    connector: { connect: jest.Mock; unPauseConnection: jest.Mock };
    getWallets: jest.Mock;
    sendTransaction: jest.Mock;
    disconnect: jest.Mock;
    setConnectionNetwork: jest.Mock;
    setConnectRequestParameters: jest.Mock;
    onStatusChange: jest.Mock;
    onModalStateChange: jest.Mock;
    openModal: jest.Mock;
    closeModal: jest.Mock;
  };

  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
    unsubscribeStatus = jest.fn();
    unsubscribeModal = jest.fn();
    const statusListeners = new Set<StatusListener>();
    statusListener = (wallet) => {
      [...statusListeners].forEach((listener) => listener(wallet));
    };
    ui = {
      connectionRestored: Promise.resolve(),
      wallet: undefined,
      connector: {
        connect: jest.fn(),
        unPauseConnection: jest.fn().mockResolvedValue(undefined),
      },
      getWallets: jest.fn().mockResolvedValue([createConnectedWallet()]),
      sendTransaction: jest.fn().mockResolvedValue({ boc: 'signed-boc' }),
      disconnect: jest.fn().mockResolvedValue(undefined),
      setConnectionNetwork: jest.fn(),
      setConnectRequestParameters: jest.fn(),
      onStatusChange: jest.fn((listener: StatusListener) => {
        statusListeners.add(listener);
        return () => {
          statusListeners.delete(listener);
          unsubscribeStatus();
        };
      }),
      onModalStateChange: jest.fn((listener) => {
        modalListener = listener;
        return unsubscribeModal;
      }),
      openModal: jest.fn().mockResolvedValue(undefined),
      closeModal: jest.fn(),
    };
    (TonConnectUI as unknown as jest.Mock).mockImplementation(() => ui);
    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      api = require('./externalWallet') as ExternalWalletModule;
    });
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  it('loads the versioned TON Connect manifest from the current application origin', () => {
    api.getExternalTonConnectUI();

    expect(TonConnectUI).toHaveBeenCalledWith({
      manifestUrl: `${window.location.origin}/tonconnect-manifest.json?v=mygramwallet-ton-name-2026-10-06`,
    });
  });

  it.each(['tonkeeper', 'telegram-wallet', 'gramwallet', 'hot'])(
    'accepts the selected %s mainnet wallet and preserves the SDK account and proof response',
    async (appName) => {
      const wallet = createConnectedWallet(appName);
      ui.openModal.mockImplementation(() => {
        statusListener(wallet);
        return Promise.resolve();
      });

      await expect(api.connectExternalTonWallet('single-use-challenge')).resolves.toBe(wallet);
      expect(ui.setConnectionNetwork).toHaveBeenCalledWith('-239');
      expect(ui.setConnectRequestParameters).toHaveBeenNthCalledWith(1, {
        state: 'ready',
        value: { tonProof: 'single-use-challenge' },
      });
      expect(ui.openModal).toHaveBeenCalledWith();
      expect(ui.setConnectRequestParameters.mock.invocationCallOrder[0])
        .toBeLessThan(ui.openModal.mock.invocationCallOrder[0]);
      expect(ui.setConnectRequestParameters).toHaveBeenLastCalledWith(undefined);
      expect(unsubscribeStatus).toHaveBeenCalledTimes(1);
      expect(unsubscribeModal).toHaveBeenCalledTimes(1);
      expect(jest.getTimerCount()).toBe(0);
    },
  );

  it('rejects a testnet wallet without implicitly disconnecting the session', async () => {
    ui.openModal.mockImplementation(() => {
      statusListener(createConnectedWallet('tonkeeper', '-3'));
      return Promise.resolve();
    });

    await expect(api.connectExternalTonWallet('challenge')).rejects.toThrow('TON Mainnet');
    expect(ui.disconnect).not.toHaveBeenCalled();
  });

  it('sends the exact native TON top-up from the connected wallet to the supplied system address', async () => {
    const wallet = createConnectedWallet();
    ui.wallet = wallet as unknown as Wallet;
    const receiverAddress = `0:${'b'.repeat(64)}`;
    const amountNano = 9_870_057_709n;
    const comment = `d_${'c'.repeat(32)}`;

    await api.sendExternalTonTransaction(receiverAddress, amountNano, comment);

    expect(ui.sendTransaction).toHaveBeenCalledTimes(1);
    const transaction = ui.sendTransaction.mock.calls[0][0];
    expect(transaction).toMatchObject({
      validUntil: expect.any(Number),
      network: '-239',
      from: wallet.account.address,
      messages: [{
        address: receiverAddress,
        amount: amountNano.toString(),
        payload: expect.any(String),
      }],
    });

    const payload = Cell.fromBoc(Buffer.from(transaction.messages[0].payload, 'base64'))[0];
    const payloadSlice = payload.beginParse();
    expect(payloadSlice.loadUint(32)).toBe(0);
    expect(payloadSlice.loadStringTail()).toBe(comment);
  });

  it('surfaces official UI registry failures without implementing another wallet list', async () => {
    ui.openModal.mockRejectedValue(new Error('Wallet registry blocked'));

    await expect(api.connectExternalTonWallet('challenge')).rejects.toThrow('Wallet registry blocked');
    expect(ui.getWallets).not.toHaveBeenCalled();
    expect(ui.setConnectRequestParameters).toHaveBeenLastCalledWith(undefined);
  });

  it('cleans up listeners and proof parameters when the modal fails to open', async () => {
    ui.openModal.mockRejectedValue(new Error('Modal opening failed'));

    await expect(api.connectExternalTonWallet('challenge')).rejects.toThrow('Modal opening failed');
    expect(unsubscribeStatus).toHaveBeenCalledTimes(1);
    expect(unsubscribeModal).toHaveBeenCalledTimes(1);
    expect(ui.setConnectRequestParameters).toHaveBeenLastCalledWith(undefined);
    expect(jest.getTimerCount()).toBe(0);
  });

  describe('standard SDK modal in Telegram', () => {
    const originalTelegram = Object.getOwnPropertyDescriptor(window, 'Telegram');
    let open: jest.SpyInstance;

    async function flushConnectionSetup() {
      for (let i = 0; i < 6; i++) await Promise.resolve();
    }

    function setTelegramPlatform(platform: string) {
      Object.defineProperty(window, 'Telegram', {
        configurable: true,
        value: { WebApp: { platform } },
      });
    }

    beforeEach(() => {
      open = jest.spyOn(window, 'open').mockReturnValue(undefined as unknown as Window);
    });

    afterEach(() => {
      open.mockRestore();
      if (originalTelegram) {
        Object.defineProperty(window, 'Telegram', originalTelegram);
      } else {
        Reflect.deleteProperty(window, 'Telegram');
      }
    });

    it.each(['ios', 'android'])('uses the official picker and return strategy on %s', async (platform) => {
      setTelegramPlatform(platform);
      const wallet = createConnectedWallet('telegram-wallet');
      const connection = api.connectExternalTonWallet('fresh-proof-payload');
      let resolved = false;
      void connection.then(() => {
        resolved = true;
      });
      await flushConnectionSetup();

      expect(TonConnectUI).toHaveBeenCalledWith(expect.objectContaining({
        actionsConfiguration: {
          returnStrategy: 'back',
          twaReturnUrl: expect.stringMatching(/^https:\/\/t\.me\/.+\?startapp$/),
        },
      }));
      expect(ui.openModal).toHaveBeenCalledWith();
      expect(ui.connector.connect).not.toHaveBeenCalled();
      expect(open).not.toHaveBeenCalled();
      expect(resolved).toBe(false);

      statusListener(wallet);
      await expect(connection).resolves.toBe(wallet);
      expect(unsubscribeStatus).toHaveBeenCalledTimes(1);
    });

    it('does not treat closing the picker after wallet selection as completed approval or cancellation', async () => {
      setTelegramPlatform('ios');
      const connection = api.connectExternalTonWallet('challenge');
      await flushConnectionSetup();
      modalListener({ status: 'opened' });
      modalListener({ status: 'closed', closeReason: 'wallet-selected' });
      expect(ui.setConnectRequestParameters).toHaveBeenCalledTimes(1);

      const wallet = createConnectedWallet('telegram-wallet');
      statusListener(wallet);
      await expect(connection).resolves.toBe(wallet);
      expect(open).not.toHaveBeenCalled();
      expect(ui.connector.connect).not.toHaveBeenCalled();
    });

    it('handles user cancellation through the official modal state subscription', async () => {
      const connection = api.connectExternalTonWallet('challenge');
      const rejected = expect(connection).rejects.toThrow('cancelled by user');
      await flushConnectionSetup();
      modalListener({ status: 'opened' });
      modalListener({ status: 'closed', closeReason: 'action-cancelled' });
      await rejected;
      expect(unsubscribeModal).toHaveBeenCalledTimes(1);
      expect(ui.setConnectRequestParameters).toHaveBeenLastCalledWith(undefined);
    });

    it('does not allow another request while wallet approval is pending', async () => {
      setTelegramPlatform('ios');
      const connection = api.connectExternalTonWallet('challenge');
      await flushConnectionSetup();

      await expect(api.connectExternalTonWallet('second-challenge')).rejects.toMatchObject({
        code: 'WALLET_REQUEST_PENDING',
      });
      expect(ui.openModal).toHaveBeenCalledTimes(1);
      statusListener(createConnectedWallet());
      await connection;
    });

    it('closes the official modal when waiting times out and permits a new request', async () => {
      setTelegramPlatform('ios');
      const connection = api.connectExternalTonWallet('challenge');
      const rejected = expect(connection).rejects.toMatchObject({ code: 'WALLET_FLOW_TIMEOUT' });
      await flushConnectionSetup();
      jest.advanceTimersByTime(4 * 60 * 1000);
      await rejected;
      expect(ui.closeModal).toHaveBeenCalledTimes(1);

      const retry = api.connectExternalTonWallet('new-challenge');
      await flushConnectionSetup();
      expect(ui.openModal).toHaveBeenCalledTimes(2);
      statusListener(createConnectedWallet());
      await retry;
    });

    it('stops waiting and closes the SDK modal when disconnect is requested', async () => {
      setTelegramPlatform('ios');
      const connection = api.connectExternalTonWallet('challenge');
      const rejected = expect(connection).rejects.toThrow('cancelled by user');
      await flushConnectionSetup();
      await api.disconnectExternalTonWallet();
      await rejected;
      expect(ui.closeModal).toHaveBeenCalledTimes(1);
      expect(api.getExternalTonWalletState()).toEqual({ address: undefined, isConnected: false });
    });
  });

  it('restores a matching SDK session and clears its visible state after disconnect', async () => {
    const wallet = createConnectedWallet();
    ui.wallet = wallet;
    const onState = jest.fn();
    api.subscribeExternalTonWallet(onState);
    await Promise.resolve();
    expect(onState).toHaveBeenLastCalledWith({ address: wallet.account.address, isConnected: true });

    ui.disconnect.mockImplementation(() => {
      ui.wallet = undefined;
      // The official SDK emits null on disconnect.
      // eslint-disable-next-line no-null/no-null
      statusListener(null);
      return Promise.resolve();
    });
    await api.disconnectExternalTonWallet();
    expect(onState).toHaveBeenLastCalledWith({ address: undefined, isConnected: false });
  });

  it('restores any selected mainnet wallet but does not display a testnet session as connected', () => {
    ui.wallet = createConnectedWallet('other-wallet');
    expect(api.getExternalTonWalletState().isConnected).toBe(true);
    ui.wallet = createConnectedWallet('telegram-wallet', '-3');
    expect(api.getExternalTonWalletState().isConnected).toBe(false);
  });

  it('delivers a restored proof once, including approval arriving after startup restoration', async () => {
    const wallet = createConnectedWallet();
    wallet.connectItems = {
      tonProof: {
        name: 'ton_proof',
        proof: {
          timestamp: 1791201600,
          domain: { lengthBytes: 12, value: 'example.test' },
          signature: 'sdk-signature',
          payload: 'restored-challenge',
        },
      },
    };
    const recovered = jest.fn();
    api.subscribeExternalTonWallet(jest.fn(), undefined, recovered);
    await Promise.resolve();
    expect(recovered).not.toHaveBeenCalled();

    statusListener(wallet);
    statusListener(wallet);
    expect(recovered).toHaveBeenCalledTimes(1);
    expect(recovered).toHaveBeenCalledWith(wallet);
  });

  it('does not submit the normal click flow proof again through the restoration callback', async () => {
    const wallet = createConnectedWallet();
    wallet.connectItems = {
      tonProof: {
        name: 'ton_proof',
        proof: {
          timestamp: 1791201600,
          domain: { lengthBytes: 12, value: 'example.test' },
          signature: 'sdk-signature',
          payload: 'active-click-challenge',
        },
      },
    };
    const recovered = jest.fn();
    api.subscribeExternalTonWallet(jest.fn(), undefined, recovered);
    ui.openModal.mockImplementation(() => {
      statusListener(wallet);
      return Promise.resolve();
    });
    await expect(api.connectExternalTonWallet('active-click-challenge')).resolves.toBe(wallet);
    expect(recovered).not.toHaveBeenCalled();
  });

  it('returns an already connected wallet without disconnect, a picker or a replacement proof request', async () => {
    const wallet = createConnectedWallet();
    ui.wallet = wallet;
    await expect(api.connectExternalTonWallet('unused-new-challenge')).resolves.toBe(wallet);
    expect(ui.disconnect).not.toHaveBeenCalled();
    expect(ui.openModal).not.toHaveBeenCalled();
    expect(ui.setConnectRequestParameters).not.toHaveBeenCalled();
    await expect(api.getConnectedExternalTonWallet()).resolves.toBe(wallet);
  });

  it('preserves a restored SDK wallet before UI wallet metadata is enriched', async () => {
    const fullWallet = createConnectedWallet();
    const sdkWallet: Wallet = {
      account: fullWallet.account,
      device: fullWallet.device,
      provider: fullWallet.provider,
    };
    ui.wallet = sdkWallet;
    await expect(api.connectExternalTonWallet('unused-challenge')).resolves.toBe(sdkWallet);
    await expect(api.getConnectedExternalTonWallet()).resolves.toBe(sdkWallet);
    expect(ui.disconnect).not.toHaveBeenCalled();
    expect(ui.openModal).not.toHaveBeenCalled();
  });

  it('waits for restoration before deciding whether Connect should open a picker', async () => {
    let restore!: () => void;
    ui.connectionRestored = new Promise<void>((resolve) => {
      restore = resolve;
    });
    const state = jest.fn();
    api.subscribeExternalTonWallet(state);
    expect(state).toHaveBeenLastCalledWith({ address: undefined, isConnected: false, isRestoring: true });
    const connection = api.connectExternalTonWallet('unused-challenge');
    expect(ui.openModal).not.toHaveBeenCalled();

    const wallet = createConnectedWallet();
    ui.wallet = wallet;
    restore();
    await expect(connection).resolves.toBe(wallet);
    expect(state).toHaveBeenLastCalledWith({ address: wallet.account.address, isConnected: true });
    expect(ui.disconnect).not.toHaveBeenCalled();
    expect(ui.openModal).not.toHaveBeenCalled();
  });

  it('immediately publishes the SDK snapshot when a connected screen is reopened', () => {
    const wallet = createConnectedWallet();
    ui.wallet = wallet;
    const firstScreen = jest.fn();
    const unsubscribe = api.subscribeExternalTonWallet(firstScreen);
    unsubscribe();
    const reopenedScreen = jest.fn();
    api.subscribeExternalTonWallet(reopenedScreen);
    expect(reopenedScreen).toHaveBeenLastCalledWith({ address: wallet.account.address, isConnected: true });
    expect(ui.disconnect).not.toHaveBeenCalled();
  });

  it('does not publish a late restoration result after a screen unsubscribes', async () => {
    let restore!: () => void;
    ui.connectionRestored = new Promise<void>((resolve) => {
      restore = resolve;
    });
    const state = jest.fn();
    const recovered = jest.fn();
    const unsubscribe = api.subscribeExternalTonWallet(state, undefined, recovered);
    unsubscribe();
    ui.wallet = createConnectedWallet();
    restore();
    await Promise.resolve();
    expect(state).toHaveBeenCalledTimes(1);
    expect(recovered).not.toHaveBeenCalled();
  });

  it('disconnects a session that finishes restoring while explicit Disconnect is pending', async () => {
    let restore!: () => void;
    ui.connectionRestored = new Promise<void>((resolve) => {
      restore = resolve;
    });
    ui.disconnect.mockImplementation(() => {
      ui.wallet = undefined;
      return Promise.resolve();
    });
    const disconnect = api.disconnectExternalTonWallet();
    expect(ui.disconnect).not.toHaveBeenCalled();
    ui.wallet = createConnectedWallet();
    restore();
    await disconnect;
    expect(ui.disconnect).toHaveBeenCalledTimes(1);
    expect(api.getExternalTonWalletState().isConnected).toBe(false);
  });

  it('opens a new connection only after explicit Disconnect', async () => {
    ui.wallet = createConnectedWallet();
    ui.disconnect.mockImplementation(() => {
      ui.wallet = undefined;
      return Promise.resolve();
    });
    await api.disconnectExternalTonWallet();
    const newWallet = createConnectedWallet('telegram-wallet');
    ui.openModal.mockImplementation(() => {
      ui.wallet = newWallet;
      statusListener(newWallet);
      return Promise.resolve();
    });
    await expect(api.connectExternalTonWallet('fresh-challenge-after-disconnect')).resolves.toBe(newWallet);
    expect(ui.disconnect).toHaveBeenCalledTimes(1);
    expect(ui.openModal).toHaveBeenCalledTimes(1);
    expect(api.getExternalTonWalletState()).toEqual({ address: newWallet.account.address, isConnected: true });
  });
});
