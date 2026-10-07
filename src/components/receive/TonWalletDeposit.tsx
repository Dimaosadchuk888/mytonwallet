import { Address } from '@ton/core';
import React, { memo, useEffect, useRef, useState } from '../../lib/teact/teact';

import type { ExternalTonWalletState } from '../../api/chains/ton/externalWallet';

import { toDecimal } from '../../util/decimals';
import {
  getConnectedExternalTonWallet, getExternalTonConnectUI, sendExternalTonTransaction,
  subscribeExternalTonWallet, TON_MAINNET_CHAIN_ID,
} from '../../api/chains/ton/externalWallet';
import { getExternalWalletTonBalance } from '../../api/chains/ton/toncenter/externalWalletBalance';
import { refreshPlatformAccount } from '../../platform/accountStore';
import {
  cancelTonDepositIntent, createTonDepositIntent, getTonDepositIntent, TonDepositApiError,
} from '../../platform/tonDeposit';
import { getTonWhitelistAddresses, isTonWhitelistAddressRegistered } from '../../platform/tonWhitelist';

import useLang from '../../hooks/useLang';
import useLastCallback from '../../hooks/useLastCallback';

import Button from '../ui/Button';

import styles from './TonWalletDeposit.module.scss';

const TON_NETWORK_FEE_RESERVE = 100_000_000n;
const STATUS_POLL_INTERVAL_MS = 3_000;
const STATUS_POLL_TIMEOUT_MS = 120_000;

type DepositUiStatus = 'idle' | 'sending' | 'waiting' | 'pending' | 'expired' | 'credited' | 'cancelled' | 'rejected';
type WalletVerificationStatus = 'idle' | 'checking' | 'verified' | 'unverified' | 'error';

interface OwnProps {
  isActive: boolean;
  forceAutoFillAmount?: boolean;
  hideActions?: boolean;
  hideDestination?: boolean;
  amountNano: bigint;
  amountValue?: string;
  isAmountFromWallet: boolean;
  receiverAddress: string;
  onAutoFillAmount: (value: string | undefined) => void;
  onClearAmount: () => void;
  onControlsChange?: (controls?: TonWalletDepositControls) => void;
}

export interface TonWalletDepositControls {
  send: () => Promise<void>;
  isSendDisabled: boolean;
  isSending: boolean;
  isBalanceLoading: boolean;
  maxAmount?: bigint;
}

function toFriendlyAddress(value?: string) {
  if (!value) return undefined;
  try {
    return Address.parse(value).toString({ bounceable: false, urlSafe: true });
  } catch {
    return undefined;
  }
}

function isUserCancellation(error: unknown) {
  const code = (error as { code?: unknown } | undefined)?.code;
  return code === 300 || code === 'USER_REJECTS_ERROR';
}

function TonWalletDeposit({
  isActive,
  forceAutoFillAmount = false,
  hideActions = false,
  hideDestination = false,
  amountNano,
  amountValue,
  isAmountFromWallet,
  receiverAddress,
  onAutoFillAmount,
  onClearAmount,
  onControlsChange,
}: OwnProps) {
  const lang = useLang();
  const [walletState, setWalletState] = useState<ExternalTonWalletState>({
    isConnected: false,
    isRestoring: true,
  });
  const [walletBalance, setWalletBalance] = useState<bigint>();
  const [walletVerification, setWalletVerification] = useState<WalletVerificationStatus>('idle');
  const [isBalanceLoading, setIsBalanceLoading] = useState(false);
  const [uiStatus, setUiStatus] = useState<DepositUiStatus>('idle');
  const [errorKey, setErrorKey] = useState<string>();
  const [intentId, setIntentId] = useState<string>();
  const balanceRequestId = useRef(0);
  const whitelistRequestId = useRef(0);
  const currentAddress = useRef<string>();
  const amountValueRef = useRef(amountValue);
  const isAmountFromWalletRef = useRef(isAmountFromWallet);
  const forceAutoFillAmountRef = useRef(forceAutoFillAmount);
  const wasActiveRef = useRef(isActive);

  amountValueRef.current = amountValue;
  isAmountFromWalletRef.current = isAmountFromWallet;

  const refreshBalance = useLastCallback(async (
    address: string,
    forceAutoFill = false,
    allowAutoFill = true,
  ) => {
    const requestId = ++balanceRequestId.current;
    setIsBalanceLoading(true);
    setErrorKey(undefined);
    try {
      const balance = await getExternalWalletTonBalance(address);
      if (requestId !== balanceRequestId.current) return undefined;

      setWalletBalance(balance);
      if (allowAutoFill && (forceAutoFill || !amountValueRef.current || isAmountFromWalletRef.current)) {
        const maxAmount = balance > TON_NETWORK_FEE_RESERVE ? balance - TON_NETWORK_FEE_RESERVE : 0n;
        onAutoFillAmount(maxAmount > 0n ? toDecimal(maxAmount, 9) : undefined);
      }
      return balance;
    } catch {
      if (requestId === balanceRequestId.current) {
        setWalletBalance(undefined);
        setErrorKey('$ton_deposit_balance_unavailable');
      }
      return undefined;
    } finally {
      if (requestId === balanceRequestId.current) setIsBalanceLoading(false);
    }
  });

  const verifyWallet = useLastCallback(async (address: string) => {
    const requestId = ++whitelistRequestId.current;
    setWalletVerification('checking');
    try {
      const wallets = await getTonWhitelistAddresses(address);
      if (requestId !== whitelistRequestId.current) return;
      setWalletVerification(isTonWhitelistAddressRegistered(address, wallets) ? 'verified' : 'unverified');
    } catch {
      if (requestId === whitelistRequestId.current) setWalletVerification('error');
    }
  });

  const handleWalletState = useLastCallback((next: ExternalTonWalletState) => {
    setWalletState(next);
    if (next.address === currentAddress.current) return;

    const isWalletSwitch = currentAddress.current !== undefined;
    currentAddress.current = next.address;
    balanceRequestId.current += 1;
    setWalletBalance(undefined);
    setErrorKey(undefined);
    setWalletVerification(next.address ? 'checking' : 'idle');
    if (!next.address) {
      whitelistRequestId.current += 1;
      setIsBalanceLoading(false);
    }

    if (isWalletSwitch) onClearAmount();
    if (next.address) {
      void refreshBalance(
        next.address,
        forceAutoFillAmount || isWalletSwitch || !amountValueRef.current,
      );
      void verifyWallet(next.address);
    }
  });

  useEffect(() => {
    if (!isActive) return undefined;

    return subscribeExternalTonWallet(
      handleWalletState,
      () => setErrorKey('$ton_deposit_balance_unavailable'),
    );
  }, [handleWalletState, isActive]);

  useEffect(() => {
    const shouldForceRefresh = forceAutoFillAmount
      && (!forceAutoFillAmountRef.current || !wasActiveRef.current)
      && isActive;
    forceAutoFillAmountRef.current = forceAutoFillAmount;
    wasActiveRef.current = isActive;
    if (isActive && shouldForceRefresh && walletState.address) {
      void refreshBalance(walletState.address, true);
    }
  }, [forceAutoFillAmount, isActive, refreshBalance, walletState.address]);

  useEffect(() => {
    const address = walletState.address;
    if (!isActive || !address) return undefined;

    const refreshOnReturn = () => {
      if (document.visibilityState !== 'hidden') void refreshBalance(address);
    };
    window.addEventListener('focus', refreshOnReturn);
    window.addEventListener('pageshow', refreshOnReturn);
    document.addEventListener('visibilitychange', refreshOnReturn);

    return () => {
      window.removeEventListener('focus', refreshOnReturn);
      window.removeEventListener('pageshow', refreshOnReturn);
      document.removeEventListener('visibilitychange', refreshOnReturn);
    };
  }, [isActive, refreshBalance, walletState.address]);

  useEffect(() => {
    if (!isActive || !intentId || uiStatus !== 'waiting') return undefined;

    let isCancelled = false;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const deadline = Date.now() + STATUS_POLL_TIMEOUT_MS;

    const poll = async () => {
      while (!isCancelled && Date.now() < deadline) {
        try {
          const intent = await getTonDepositIntent(intentId);
          if (intent.status === 'credited') {
            setErrorKey(undefined);
            setUiStatus('credited');
            await refreshPlatformAccount();
            return;
          }
          if (intent.status === 'rejected') {
            setErrorKey(undefined);
            setUiStatus('rejected');
            return;
          }
          if (intent.status === 'expired') {
            setErrorKey(undefined);
            setUiStatus('expired');
            return;
          }
        } catch {
          // A temporary status API error does not change whether the chain transaction exists.
        }

        await new Promise<void>((resolve) => {
          timeoutId = setTimeout(resolve, STATUS_POLL_INTERVAL_MS);
        });
      }

      if (!isCancelled) setUiStatus('pending');
    };

    void poll();
    return () => {
      isCancelled = true;
      if (timeoutId) clearTimeout(timeoutId);
    };
  }, [intentId, isActive, uiStatus]);

  const handleOpenWallet = useLastCallback(async () => {
    try {
      const ui = getExternalTonConnectUI();
      ui.setConnectionNetwork(TON_MAINNET_CHAIN_ID);
      await ui.openModal();
    } catch {
      setErrorKey('$ton_deposit_failed');
    }
  });

  const handleRefreshBalance = useLastCallback(() => {
    if (walletState.address) {
      void refreshBalance(walletState.address, true);
      void verifyWallet(walletState.address);
    }
  });

  const handleSend = useLastCallback(async () => {
    if (!walletState.address || !receiverAddress || amountNano <= 0n || uiStatus === 'sending') return;

    let createdIntentId: string | undefined;
    setUiStatus('sending');
    setErrorKey(undefined);
    try {
      const wallet = await getConnectedExternalTonWallet();
      if (!wallet) throw new Error('No TON wallet is connected.');

      const connectedAddress = Address.parse(wallet.account.address).toRawString();
      const selectedAddress = Address.parse(walletState.address).toRawString();
      const destinationAddress = Address.parse(receiverAddress).toRawString();
      if (connectedAddress !== selectedAddress || connectedAddress === destinationAddress) {
        throw new Error('The connected TON wallet changed. Reconnect and try again.');
      }

      const verifiedWallets = await getTonWhitelistAddresses(connectedAddress);
      if (!isTonWhitelistAddressRegistered(connectedAddress, verifiedWallets)) {
        setWalletVerification('unverified');
        setUiStatus('idle');
        return;
      }
      setWalletVerification('verified');

      const currentBalance = await refreshBalance(wallet.account.address, false, false);
      if (currentBalance === undefined) {
        setUiStatus('idle');
        setErrorKey('$ton_deposit_balance_unavailable');
        return;
      }
      if (amountNano + TON_NETWORK_FEE_RESERVE > currentBalance) {
        setUiStatus('idle');
        setErrorKey('$ton_deposit_insufficient');
        return;
      }

      const intent = await createTonDepositIntent(wallet.account.address, amountNano);
      if (!intent.sourceAddress || !intent.depositAddress
        || Address.parse(intent.sourceAddress).toRawString() !== connectedAddress
        || Address.parse(intent.depositAddress).toRawString() !== destinationAddress
        || intent.amountNano !== amountNano.toString()) {
        setUiStatus('idle');
        setErrorKey('$ton_deposit_unavailable');
        return;
      }

      const walletBeforeSend = await getConnectedExternalTonWallet();
      if (!walletBeforeSend
        || Address.parse(walletBeforeSend.account.address).toRawString() !== connectedAddress) {
        await cancelTonDepositIntent(intent.id).catch(() => undefined);
        setUiStatus('idle');
        setErrorKey('$ton_deposit_failed');
        return;
      }

      setIntentId(intent.id);
      createdIntentId = intent.id;
      await sendExternalTonTransaction(intent.depositAddress, amountNano, intent.comment);
      await refreshBalance(wallet.account.address, false, false);
      setErrorKey(undefined);
      setUiStatus('waiting');
    } catch (error) {
      const wasCancelled = isUserCancellation(error);
      if (wasCancelled && createdIntentId) {
        setUiStatus('cancelled');
        await cancelTonDepositIntent(createdIntentId).catch(() => undefined);
      } else if (createdIntentId) {
        setUiStatus('waiting');
        setIntentId(createdIntentId);
        setErrorKey('$ton_deposit_uncertain');
      } else {
        setUiStatus('idle');
      }
      if (error instanceof TonDepositApiError && error.code === 'TON_DEPOSIT_PENDING') {
        setErrorKey('$ton_deposit_pending');
      } else if (error instanceof TonDepositApiError && error.code === 'TON_DEPOSIT_UNAVAILABLE') {
        setErrorKey('$ton_deposit_unavailable');
      } else if (error instanceof TonDepositApiError && error.code === 'TON_WALLET_NOT_VERIFIED') {
        setWalletVerification('unverified');
        setErrorKey(undefined);
      } else if (!isUserCancellation(error)) {
        setErrorKey('$ton_deposit_failed');
      }
    }
  });

  const handleCheckStatus = useLastCallback(() => {
    if (intentId) setUiStatus('waiting');
  });

  const displayBalance = walletBalance === undefined ? undefined : toDecimal(walletBalance, 9);
  const displayAddress = toFriendlyAddress(walletState.address);
  const displayReceiver = toFriendlyAddress(receiverAddress);
  const isSendDisabled = !walletState.isConnected
    || !receiverAddress
    || amountNano <= 0n
    || walletBalance === undefined
    || walletVerification !== 'verified'
    || isBalanceLoading
    || uiStatus === 'sending'
    || uiStatus === 'waiting'
    || uiStatus === 'pending';
  const maxAmount = walletBalance === undefined
    ? undefined
    : walletBalance > TON_NETWORK_FEE_RESERVE
      ? walletBalance - TON_NETWORK_FEE_RESERVE
      : 0n;

  useEffect(() => {
    if (!onControlsChange) return;

    onControlsChange({
      send: handleSend,
      isSendDisabled,
      isSending: uiStatus === 'sending',
      isBalanceLoading,
      maxAmount,
    });
  }, [handleSend, isBalanceLoading, isSendDisabled, maxAmount, onControlsChange, uiStatus]);

  useEffect(() => {
    return () => onControlsChange?.(undefined);
  }, [onControlsChange]);

  let statusText: string | undefined;
  if (uiStatus === 'waiting' || uiStatus === 'pending') statusText = lang('$ton_deposit_waiting');
  if (uiStatus === 'expired') statusText = lang('$ton_deposit_expired');
  if (uiStatus === 'credited') statusText = lang('$ton_deposit_credited');
  if (uiStatus === 'cancelled') statusText = lang('$ton_deposit_cancelled');
  if (uiStatus === 'rejected') statusText = lang('$ton_deposit_failed');
  if (walletVerification === 'unverified') statusText = lang('Address must be added to the White List');
  if (walletVerification === 'error') statusText = lang('TON wallet verification failed. Please try again.');
  if (errorKey) statusText = lang(errorKey);

  return (
    <section className={styles.tonDeposit} aria-label={lang('$ton_deposit_send')}>
      {walletState.isConnected && displayAddress ? (
        <div className={styles.detailRow}>
          <span className={styles.label}>{lang('$ton_deposit_connected_wallet')}</span>
          <span className={styles.value}>{displayAddress}</span>
        </div>
      ) : walletState.isRestoring ? (
        <p className={styles.status} aria-live="polite">
          {lang('$ton_deposit_restoring_wallet')}
        </p>
      ) : (
        <Button className={styles.button} isPrimary onClick={handleOpenWallet}>
          {lang('Connect Wallet')}
        </Button>
      )}

      {walletState.isConnected && isBalanceLoading && walletBalance === undefined && (
        <p className={styles.status} aria-live="polite">
          {lang('$ton_deposit_loading_balance')}
        </p>
      )}

      {displayBalance !== undefined && (
        <div className={styles.detailRow}>
          <span className={styles.label}>{lang('$ton_deposit_available_balance')}</span>
          <span className={styles.value}>{displayBalance} GRAM</span>
        </div>
      )}

      {!hideDestination && displayReceiver && (
        <div className={styles.detailRow}>
          <span className={styles.label}>{lang('$ton_deposit_destination')}</span>
          <span className={styles.value}>{displayReceiver}</span>
        </div>
      )}

      {walletState.isConnected && (
        <p className={styles.feeNote}>{lang('$ton_deposit_fee_reserve')}</p>
      )}

      {!hideActions && walletState.isConnected && (
        <div className={styles.actions}>
          <Button
            className={styles.button}
            isSmall
            isDisabled={isBalanceLoading}
            onClick={handleRefreshBalance}
          >
            {lang('$ton_deposit_refresh_balance')}
          </Button>
          <Button
            className={styles.button}
            isPrimary
            isDisabled={isSendDisabled}
            isLoading={uiStatus === 'sending'}
            onClick={handleSend}
          >
            {lang('$ton_deposit_send')}
          </Button>
        </div>
      )}

      {(uiStatus === 'pending' || uiStatus === 'expired') && intentId && (
        <Button className={styles.button} isSmall onClick={handleCheckStatus}>
          {lang('$ton_deposit_check_status')}
        </Button>
      )}

      {statusText && (
        <p className={styles.status} aria-live="polite">
          {statusText}
        </p>
      )}
    </section>
  );
}

export default memo(TonWalletDeposit);
