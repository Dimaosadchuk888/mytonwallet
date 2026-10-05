export type WalletConnectionStage =
  | 'connector_load'
  | 'discover_provider'
  | 'initialize_client'
  | 'request_accounts'
  | 'request_connection'
  | 'open_wallet_link'
  | 'await_wallet_response'
  | 'refresh_wallet_state'
  | 'complete';

type StageStatus = 'started' | 'succeeded' | 'failed';
type ConnectionContext = {
  providerKind?: 'injected' | 'metamask-connect';
  telegram?: boolean;
  linkScheme?: 'metamask' | 'https' | 'http' | 'other';
};

export type WalletConnectionDiagnostics = ConnectionContext & {
  attemptId: string;
  stage: WalletConnectionStage;
  status: 'running' | 'succeeded' | 'failed';
  elapsedMs: number;
  errorCode?: string;
};

const SAFE_ERROR_CODES = new Set([
  'ACTION_REJECTED', 'NETWORK_ERROR', 'TIMEOUT', 'UNKNOWN_ERROR', 'INVALID_ARGUMENT',
  'UNSUPPORTED_OPERATION', 'UNSUPPORTED_WALLET_LINK', 'NO_ACCOUNTS', 'PROVIDER_CHANGED',
  'CALL_EXCEPTION', 'BAD_DATA', 'SERVER_ERROR', 'OFFCHAIN_FAULT',
]);
const SAFE_ERROR_NAMES = new Set(['TypeError', 'SecurityError', 'QuotaExceededError', 'AbortError']);
const subscribers = new Set<(diagnostics: WalletConnectionDiagnostics) => void>();
let current: WalletConnectionDiagnostics | undefined;
let startedAt = 0;
let attemptSequence = 0;

/** Never copy arbitrary provider messages, data, stack traces, or nested payloads. */
export function getSafeWalletErrorCode(error: unknown): string {
  if (!error || typeof error !== 'object') return 'UNKNOWN_ERROR';
  const value = error as { code?: unknown; name?: unknown; message?: unknown; info?: { error?: { code?: unknown } } };
  if (value.message === 'WebAppTgUrlInvalid') return 'WebAppTgUrlInvalid';
  const code = value.info?.error?.code ?? value.code;
  if (typeof code === 'number' && Number.isSafeInteger(code)) return String(code);
  if (typeof code === 'string' && SAFE_ERROR_CODES.has(code)) return code;
  if (typeof value.name === 'string' && SAFE_ERROR_NAMES.has(value.name)) return value.name;
  return 'UNKNOWN_ERROR';
}

function publish(diagnostics: WalletConnectionDiagnostics) {
  current = diagnostics;
  subscribers.forEach((callback) => callback(diagnostics));
}

export function beginWalletConnectionDiagnostics() {
  startedAt = Date.now();
  attemptSequence += 1;
  const attemptId = `${startedAt.toString(36)}-${attemptSequence}`;
  publish({ attemptId, stage: 'discover_provider', status: 'running', elapsedMs: 0 });
  return attemptId;
}

export function recordWalletConnectionStage(
  attemptId: string,
  stage: WalletConnectionStage,
  stageStatus: StageStatus,
  context: ConnectionContext = {},
  error?: unknown,
) {
  if (!current || current.attemptId !== attemptId || current.status !== 'running') return;
  const diagnostics: WalletConnectionDiagnostics = {
    ...current,
    ...context,
    stage,
    status: stageStatus === 'failed' ? 'failed' : stage === 'complete' ? 'succeeded' : 'running',
    elapsedMs: Math.max(0, Date.now() - startedAt),
    errorCode: stageStatus === 'failed' ? getSafeWalletErrorCode(error) : undefined,
  };
  // Only the explicitly constructed, allowlisted fields above are logged.
  // eslint-disable-next-line no-console
  console.info('[External EVM connection]', { ...diagnostics, stageStatus });
  publish(diagnostics);
}

export async function runWalletConnectionStage<T>(
  attemptId: string,
  stage: WalletConnectionStage,
  operation: () => Promise<T>,
): Promise<T> {
  recordWalletConnectionStage(attemptId, stage, 'started');
  try {
    const result = await operation();
    recordWalletConnectionStage(attemptId, stage, 'succeeded');
    return result;
  } catch (error) {
    recordWalletConnectionStage(attemptId, stage, 'failed', {}, error);
    throw error;
  }
}

export function subscribeWalletConnectionDiagnostics(
  callback: (diagnostics: WalletConnectionDiagnostics) => void,
) {
  subscribers.add(callback);
  if (current) callback(current);
  return () => {
    subscribers.delete(callback);
  };
}
