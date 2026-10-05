import {
  beginWalletConnectionDiagnostics,
  getSafeWalletErrorCode,
  recordWalletConnectionStage,
  subscribeWalletConnectionDiagnostics,
} from './externalWalletDiagnostics';

let infoLog: jest.SpyInstance;

describe('wallet connection diagnostics privacy', () => {
  beforeEach(() => {
    infoLog = jest.spyOn(console, 'info').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('exposes only allowlisted or numeric codes, never arbitrary provider strings', () => {
    expect(getSafeWalletErrorCode({ message: 'WebAppTgUrlInvalid' })).toBe('WebAppTgUrlInvalid');
    expect(getSafeWalletErrorCode({ info: { error: { code: 4001 } } })).toBe('4001');
    expect(getSafeWalletErrorCode({ code: 'NETWORK_ERROR' })).toBe('NETWORK_ERROR');
    expect(getSafeWalletErrorCode({ code: 'PRIVATE_SESSION_VALUE', name: 'PRIVATE_ACCOUNT_VALUE' }))
      .toBe('UNKNOWN_ERROR');
    expect(getSafeWalletErrorCode(undefined)).toBe('UNKNOWN_ERROR');
  });

  it('retains the original failed stage and excludes all raw error data from UI and logs', () => {
    const onDiagnostics = jest.fn();
    const unsubscribe = subscribeWalletConnectionDiagnostics(onDiagnostics);
    const attemptId = beginWalletConnectionDiagnostics();
    recordWalletConnectionStage(attemptId, 'open_wallet_link', 'failed', {}, {
      code: 'NETWORK_ERROR',
      message: 'PRIVATE_LINK?initData=PRIVATE_AUTH',
      stack: 'PRIVATE_STACK',
      data: { address: 'PRIVATE_ACCOUNT', signature: 'PRIVATE_SIGNATURE' },
    });
    recordWalletConnectionStage(attemptId, 'request_connection', 'failed', {}, { code: 'UNKNOWN_ERROR' });
    recordWalletConnectionStage(attemptId, 'complete', 'succeeded');
    const latest = onDiagnostics.mock.calls[onDiagnostics.mock.calls.length - 1][0];
    expect(latest).toMatchObject({
      attemptId, stage: 'open_wallet_link', status: 'failed', errorCode: 'NETWORK_ERROR',
    });
    expect(JSON.stringify([onDiagnostics.mock.calls, infoLog.mock.calls]))
      .not.toContain('PRIVATE_');
    unsubscribe();
  });

  it('starts a fresh attempt and ignores delayed events from an earlier attempt', () => {
    const onDiagnostics = jest.fn();
    const unsubscribe = subscribeWalletConnectionDiagnostics(onDiagnostics);
    const oldAttempt = beginWalletConnectionDiagnostics();
    recordWalletConnectionStage(oldAttempt, 'initialize_client', 'failed', {}, new Error('private'));
    const nextAttempt = beginWalletConnectionDiagnostics();
    recordWalletConnectionStage(oldAttempt, 'open_wallet_link', 'failed', {}, { code: 'TIMEOUT' });
    recordWalletConnectionStage(nextAttempt, 'complete', 'succeeded');
    expect(onDiagnostics.mock.calls[onDiagnostics.mock.calls.length - 1][0]).toMatchObject({
      attemptId: nextAttempt, stage: 'complete', status: 'succeeded', errorCode: undefined,
    });
    unsubscribe();
  });
});
