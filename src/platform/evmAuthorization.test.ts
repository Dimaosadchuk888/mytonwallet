import {
  loadPendingEvmOwnershipChallenge,
  removePendingEvmOwnershipChallenge,
  savePendingEvmOwnershipChallenge,
  verifyPendingEvmOwnershipChallenge,
} from './evmAuthorization';

const TEST_ADDRESS = '0x11a43b91414b2c7083888d8f4e963988ddee12a3';
let originalFetch: typeof fetch | undefined;

function createChallenge(expiresAt = new Date(Date.now() + 60_000).toISOString()) {
  return {
    ownerAddress: TEST_ADDRESS,
    nonce: 'test-nonce',
    challengeSignature: 'test-signature',
    expiresAt,
  };
}

function mockFetchResponse(status: number, body: Record<string, unknown>) {
  const fetchMock = jest.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  } as Response);
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

describe('pending EVM ownership challenge persistence', () => {
  beforeEach(() => {
    window.localStorage.clear();
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    if (originalFetch) {
      globalThis.fetch = originalFetch;
    } else {
      Reflect.deleteProperty(globalThis, 'fetch');
    }
    jest.restoreAllMocks();
  });

  it('restores a saved unexpired challenge case-insensitively by wallet address', () => {
    const challenge = createChallenge();

    expect(savePendingEvmOwnershipChallenge(challenge)).toBe(true);
    expect(loadPendingEvmOwnershipChallenge(TEST_ADDRESS.toUpperCase())).toEqual(challenge);

    removePendingEvmOwnershipChallenge(TEST_ADDRESS);
    expect(loadPendingEvmOwnershipChallenge(TEST_ADDRESS)).toBeUndefined();
  });

  it('removes expired saved challenges instead of restoring them', () => {
    savePendingEvmOwnershipChallenge(createChallenge(new Date(Date.now() - 1_000).toISOString()));

    expect(loadPendingEvmOwnershipChallenge(TEST_ADDRESS)).toBeUndefined();
    expect(window.localStorage.length).toBe(0);
  });

  it('asks the authenticated server to verify a saved challenge before restoring it', async () => {
    const challenge = createChallenge();
    const fetchSpy = mockFetchResponse(200, { verified: true, expiresAt: challenge.expiresAt });

    await expect(verifyPendingEvmOwnershipChallenge(challenge)).resolves.toBe(true);
    expect(fetchSpy).toHaveBeenCalledWith(
      expect.stringContaining('/api/evm/authorization/challenge/verify'),
      expect.objectContaining({
        method: 'POST',
        credentials: 'include',
        body: JSON.stringify({
          ownerAddress: challenge.ownerAddress,
          nonce: challenge.nonce,
          challengeSignature: challenge.challengeSignature,
        }),
      }),
    );
  });

  it('rejects a challenge the server reports as expired or already used', async () => {
    mockFetchResponse(409, { error: 'Authorization challenge is expired or unavailable' });

    await expect(verifyPendingEvmOwnershipChallenge(createChallenge())).resolves.toBe(false);
  });

  it('does not treat a failed verification service as a valid challenge', async () => {
    mockFetchResponse(503, { error: 'Verification service unavailable' });

    await expect(verifyPendingEvmOwnershipChallenge(createChallenge()))
      .rejects.toThrow('Verification service unavailable');
  });
});
