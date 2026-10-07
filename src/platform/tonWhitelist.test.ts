import { Address } from '@ton/core';
import type { ConnectedWallet } from '@tonconnect/ui';

import {
  checkTonWhitelistWallet, createTonWhitelistChallenge, getTonWhitelistAddresses,
  isTonWhitelistAddressRegistered, normalizeTonWhitelistAddress, recoverTonWalletRegistration,
  registerTonWalletProof,
} from './tonWhitelist';

describe('TON whitelist API lifecycle', () => {
  const originalFetch = globalThis.fetch;
  let fetchMock: jest.Mock;
  const registeredWallet = {
    address: `0:${'a'.repeat(64)}`,
    networkId: '-239',
    verifiedAt: '2026-10-05T12:00:00.000Z',
    lastVerifiedAt: '2026-10-05T12:00:00.000Z',
  };
  const wallet: Partial<ConnectedWallet> = {
    account: {
      address: registeredWallet.address,
      chain: '-239',
      publicKey: 'b'.repeat(64),
      walletStateInit: 'sdk-wallet-state-init',
    },
    connectItems: {
      tonProof: {
        name: 'ton_proof',
        proof: {
          timestamp: 1791201600,
          domain: { lengthBytes: 25, value: 'my-gramwallet.replit.app' },
          signature: 'sdk-proof-signature',
          payload: 'user-bound-single-use-challenge',
        },
      },
    },
  };

  beforeEach(() => {
    fetchMock = jest.fn();
    globalThis.fetch = fetchMock;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function respond(data: object, ok = true) {
    fetchMock.mockResolvedValue({ ok, status: ok ? 201 : 409, json: () => Promise.resolve(data) });
  }

  it('requests a user-bound challenge using the existing authenticated TON endpoint', async () => {
    respond({ payload: 'single-use-challenge', expiresAt: '2026-10-05T12:05:00.000Z' });
    await expect(createTonWhitelistChallenge()).resolves.toHaveProperty('payload', 'single-use-challenge');
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('/api/ton/whitelist/challenge'), {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
  });

  it('submits the SDK account and proof and returns only the server-confirmed registration', async () => {
    respond({ wallet: registeredWallet });
    await expect(registerTonWalletProof(wallet as ConnectedWallet)).resolves.toEqual(registeredWallet);
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toContain('/api/ton/whitelist/verify');
    expect(options.credentials).toBe('include');
    expect(options.method).toBe('POST');
    expect(JSON.parse(options.body)).toEqual({
      account: wallet.account,
      proof: wallet.connectItems?.tonProof && 'proof' in wallet.connectItems.tonProof
        ? wallet.connectItems.tonProof.proof
        : undefined,
    });
  });

  it('retrieves persisted registrations when the Mini App is reopened', async () => {
    respond({ wallets: [registeredWallet] });
    await expect(getTonWhitelistAddresses()).resolves.toEqual([registeredWallet]);
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('/api/ton/whitelist'), {
      credentials: 'include',
      headers: {},
      cache: 'no-store',
    });
  });

  it('can refresh one address from the authenticated whitelist endpoint', async () => {
    respond({ wallets: [registeredWallet] });
    await expect(getTonWhitelistAddresses(registeredWallet.address)).resolves.toEqual([registeredWallet]);
    expect(fetchMock.mock.calls[0][0]).toContain(
      `/api/ton/whitelist?address=${encodeURIComponent(registeredWallet.address)}`,
    );
    expect(fetchMock.mock.calls[0][1].credentials).toBe('include');
    expect(fetchMock.mock.calls[0][1].cache).toBe('no-store');
  });

  it('normalizes raw and user-friendly TON addresses before comparing whitelist records', () => {
    const friendlyAddress = Address.parse(registeredWallet.address)
      .toString({ urlSafe: true, bounceable: false });

    expect(normalizeTonWhitelistAddress(registeredWallet.address)).toBe(registeredWallet.address);
    expect(normalizeTonWhitelistAddress(friendlyAddress)).toBe(registeredWallet.address);
    expect(isTonWhitelistAddressRegistered(friendlyAddress, [registeredWallet])).toBe(true);
    expect(isTonWhitelistAddressRegistered(registeredWallet.address, [{
      ...registeredWallet,
      networkId: '-3',
    }])).toBe(false);
    expect(normalizeTonWhitelistAddress('not a TON address')).toBeUndefined();
  });

  it('does not register a transport connection without a TON Proof', async () => {
    await expect(registerTonWalletProof({ ...wallet, connectItems: undefined } as ConnectedWallet))
      .rejects.toMatchObject({ code: 'invalid_proof' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not treat a server registration failure as a successfully saved wallet', async () => {
    respond({ code: 'address_in_use' }, false);
    await expect(registerTonWalletProof(wallet as ConnectedWallet))
      .rejects.toMatchObject({ code: 'address_in_use' });
  });

  it('recovers a proof after reload without re-registering an already saved address', async () => {
    respond({ wallets: [registeredWallet] });
    await expect(recoverTonWalletRegistration(wallet as ConnectedWallet)).resolves.toEqual(registeredWallet);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][1].method).toBeUndefined();
  });

  it('finishes a registration interrupted by a document reload', async () => {
    fetchMock
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ wallets: [] }) })
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ wallet: registeredWallet }) });
    await expect(recoverTonWalletRegistration(wallet as ConnectedWallet)).resolves.toEqual(registeredWallet);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1][0]).toContain('/api/ton/whitelist/verify');
  });

  it('never creates a database registration from a restored address alone', async () => {
    respond({ wallets: [] });
    await expect(recoverTonWalletRegistration({ ...wallet, connectItems: undefined } as ConnectedWallet))
      .resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][1].method).toBeUndefined();
  });

  it('Check Wallet recognizes a saved connected address even when no proof is restored', async () => {
    respond({ wallets: [registeredWallet] });
    const walletApi = {
      getConnectedExternalTonWallet: jest.fn().mockResolvedValue({ ...wallet, connectItems: undefined }),
      connectExternalTonWallet: jest.fn(),
    };
    await expect(checkTonWhitelistWallet(walletApi)).resolves.toEqual(registeredWallet);
    expect(walletApi.connectExternalTonWallet).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toContain('/api/ton/whitelist');
    expect(fetchMock.mock.calls[0][1].method).toBeUndefined();
  });

  it('Check Wallet verifies the existing proof without issuing a replacement challenge or Connect', async () => {
    fetchMock
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ wallets: [] }) })
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ wallet: registeredWallet }) });
    const walletApi = {
      getConnectedExternalTonWallet: jest.fn().mockResolvedValue(wallet),
      connectExternalTonWallet: jest.fn(),
    };
    await expect(checkTonWhitelistWallet(walletApi)).resolves.toEqual(registeredWallet);
    expect(walletApi.connectExternalTonWallet).not.toHaveBeenCalled();
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      expect.stringMatching(/\/api\/ton\/whitelist$/),
      expect.stringMatching(/\/api\/ton\/whitelist\/verify$/),
    ]);
  });

  it('a new connection still obtains a challenge, waits for the wallet and verifies the returned proof', async () => {
    fetchMock
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ payload: 'new-challenge' }) })
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ wallet: registeredWallet }) });
    const walletApi = {
      getConnectedExternalTonWallet: jest.fn().mockResolvedValue(undefined),
      connectExternalTonWallet: jest.fn().mockResolvedValue(wallet),
    };
    await expect(checkTonWhitelistWallet(walletApi)).resolves.toEqual(registeredWallet);
    expect(walletApi.connectExternalTonWallet).toHaveBeenCalledWith('new-challenge');
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      expect.stringMatching(/\/api\/ton\/whitelist\/challenge$/),
      expect.stringMatching(/\/api\/ton\/whitelist\/verify$/),
    ]);
  });

  it('an expired existing proof fails verification without trying to reconnect or create a new nonce', async () => {
    fetchMock
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ wallets: [] }) })
      .mockResolvedValueOnce({ ok: false, json: () => Promise.resolve({ code: 'challenge_expired' }) });
    const walletApi = {
      getConnectedExternalTonWallet: jest.fn().mockResolvedValue(wallet),
      connectExternalTonWallet: jest.fn(),
    };
    await expect(checkTonWhitelistWallet(walletApi)).rejects.toMatchObject({ code: 'challenge_expired' });
    expect(walletApi.connectExternalTonWallet).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.some(([url]) => url.endsWith('/challenge'))).toBe(false);
  });
});
