import { Address } from '@ton/core';
import type { TeactNode } from '../../lib/teact/teact';
import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from '../../lib/teact/teact';
import { getActions, withGlobal } from '../../global';

import type { ApiBaseCurrency, ApiFetchEstimateDieselResult, ApiNft } from '../../api/types';
import type { SavedAddress, UserToken } from '../../global/types';
import type { LangFn } from '../../hooks/useLang';
import type { ExplainedTransferFee } from '../../util/fee/transferFee';
import type { FeePrecision, FeeTerms } from '../../util/fee/types';
import type { TonWalletDepositControls } from '../receive/TonWalletDeposit';
import { ScamWarningType, SettingsState, TransferState } from '../../global/types';

import {
  DEFAULT_PRICE_CURRENCY, IS_TELEGRAM_APP, TONCOIN, UNKNOWN_TOKEN,
} from '../../config';
import { getHelpCenterUrl } from '../../global/helpers/getHelpCenterUrl';
import {
  selectCurrentAccount,
  selectCurrentAccountId,
  selectCurrentAccountState,
  selectCurrentAccountTokenBalance,
  selectCurrentAccountTokens,
  selectCurrentNetwork,
  selectHasMultipleAccounts,
  selectIsAllowSuspiciousActions,
  selectIsHardwareAccount,
  selectIsMultisigWallet,
} from '../../global/selectors';
import buildClassName from '../../util/buildClassName';
import { getChainConfig } from '../../util/chain';
import { SECOND } from '../../util/dateFormat';
import { fromDecimal, toDecimal } from '../../util/decimals';
import { stopEvent } from '../../util/domEvents';
import { getMaxTransferAmount, isBalanceSufficientForTransfer } from '../../util/fee/transferFee';
import { vibrate } from '../../util/haptics';
import { isValidAddressOrDomain } from '../../util/isValidAddress';
import { debounce } from '../../util/schedulers';
import { trimStringByMaxBytes } from '../../util/text';
import { getChainBySlug, getIsNativeToken, getIsServiceToken, getNativeToken } from '../../util/tokens';
import { isPlatformAccountEnabled, usePlatformAccount } from '../../platform/accountStore';
import {
  getTonWhitelistAddresses, isTonWhitelistAddressRegistered, normalizeTonWhitelistAddress,
} from '../../platform/tonWhitelist';

import useCurrentOrPrev from '../../hooks/useCurrentOrPrev';
import useFlag from '../../hooks/useFlag';
import useInterval from '../../hooks/useInterval';
import useLang from '../../hooks/useLang';
import useLastCallback from '../../hooks/useLastCallback';
import { useTransitionActiveKey } from '../../hooks/useTransitionActiveKey';
import { useAmountInputState } from '../ui/hooks/useAmountInputState';

import AccountSwitcherPill from '../common/AccountSwitcherPill';
import FeeDetailsModal from '../common/FeeDetailsModal';
import TonWalletDeposit from '../receive/TonWalletDeposit';
import AddressInput from '../ui/AddressInput';
import AmountInput from '../ui/AmountInput';
import Button from '../ui/Button';
import FeeLine from '../ui/FeeLine';
import Modal from '../ui/Modal';
import Transition from '../ui/Transition';
import CommentSection from './CommentSection';
import NftChips from './NftChips';
import NftInfo from './NftInfo';
import SentTabs from './SentTabs';

import modalStyles from '../ui/Modal.module.scss';
import styles from './Transfer.module.scss';

interface StateProps {
  toAddress?: string;
  resolvedAddress?: string;
  toAddressName?: string;
  amount?: bigint;
  comment?: string;
  shouldEncrypt?: boolean;
  isActive: boolean;
  isLoading?: boolean;
  isComplete?: boolean;
  tokenSlug: string;
  tokens?: UserToken[];
  savedAddresses?: SavedAddress[];
  nativeTokenBalance: bigint;
  isEncryptedCommentSupported: boolean;
  isMemoRequired?: boolean;
  baseCurrency: ApiBaseCurrency;
  nfts?: ApiNft[];
  binPayload?: string;
  stateInit?: string;
  diesel?: ApiFetchEstimateDieselResult;
  isDieselAuthorizationStarted?: boolean;
  isMultisig: boolean;
  isSensitiveDataHidden?: true;
  scamWarningType?: ScamWarningType;
  isAllowSuspiciousActions: boolean;
  isTransferReadonly?: boolean;
  explainedFee?: ExplainedTransferFee;
  accountId?: string;
  accountTitle?: string;
  hasMultipleAccounts?: boolean;
  isMainnet: boolean;
}

const COMMENT_MAX_SIZE_BYTES = 5000;
const ACTIVE_STATES = new Set([TransferState.Initial, TransferState.None]);
const AUTHORIZE_DIESEL_INTERVAL_MS = SECOND;

const runDebounce = debounce((cb) => cb(), 500, false);

function toFriendlyTonAddress(value: string) {
  try {
    return Address.parse(value).toString({ bounceable: false, urlSafe: true });
  } catch {
    return value;
  }
}

function TransferInitial({
  tokenSlug,
  toAddress = '',
  resolvedAddress,
  toAddressName = '',
  amount,
  comment = '',
  shouldEncrypt,
  tokens,
  savedAddresses,
  nativeTokenBalance,
  isEncryptedCommentSupported,
  isMemoRequired,
  isActive,
  isLoading,
  isComplete,
  baseCurrency,
  nfts,
  binPayload,
  stateInit,
  diesel,
  isDieselAuthorizationStarted,
  isMultisig,
  isSensitiveDataHidden,
  scamWarningType,
  isAllowSuspiciousActions,
  isTransferReadonly,
  explainedFee,
  accountId,
  accountTitle,
  hasMultipleAccounts,
  isMainnet,
}: StateProps) {
  const {
    submitTransferInitial,
    fetchTransferFee,
    fetchNftFee,
    changeTransferToken,
    setTransferAmount,
    setTransferToAddress,
    setTransferComment,
    setTransferShouldEncrypt,
    cancelTransfer,
    showDialog,
    authorizeDiesel,
    fetchTransferDieselState,
    checkTransferAddress,
    dismissTransferScamWarning,
    openSettingsWithState,
    setTransferScreen,
  } = getActions();

  const isNftTransfer = Boolean(nfts?.length);
  if (isNftTransfer) {
    const nftChain = nfts[0].chain;
    // Token and amount can't be selected in the NFT transfer form, so they are overwritten once for convenience
    tokenSlug = getChainConfig(nftChain).nativeToken.slug;
    amount = undefined;
  }

  const lang = useLang();
  const [isWhitelistDialogOpen, openWhitelistDialog, closeWhitelistDialog] = useFlag();
  const platformAccount = usePlatformAccount();
  const [tonDepositControls, setTonDepositControls] = useState<TonWalletDepositControls>();
  const [isTonTopUpAmountReady, setIsTonTopUpAmountReady] = useState(false);
  const hasShownWhitelistDialog = useRef(false);
  const hasShownTonWhitelistDialog = useRef(false);
  const lastTonWhitelistRecipientRef = useRef<string>();
  const wasTonTopUpRef = useRef(false);
  const handleTonDepositControlsChange = useLastCallback((controls?: TonWalletDepositControls) => {
    setTonDepositControls(controls);
  });
  const handleTonAutoFillAmount = useLastCallback((value?: string) => {
    setTransferAmount({ amount: value === undefined ? 0n : fromDecimal(value, TONCOIN.decimals) });
    setIsTonTopUpAmountReady(true);
  });
  const handleTonClearAmount = useLastCallback(() => {
    setTransferAmount({ amount: undefined });
    setIsTonTopUpAmountReady(false);
  });

  const transferToken = useMemo(() => tokens?.find((token) => token.slug === tokenSlug), [tokenSlug, tokens]);
  const { amount: balance, symbol, chain } = transferToken || {};
  const isTonTopUp = IS_TELEGRAM_APP
    && isPlatformAccountEnabled()
    && isMainnet
    && !isNftTransfer
    && chain === 'ton'
    && tokenSlug === TONCOIN.slug;
  const systemTonAddress = isTonTopUp ? (platformAccount?.address ?? '') : '';
  const recipientAddress = isTonTopUp ? toFriendlyTonAddress(systemTonAddress) : toAddress;
  const addressForValidation = isTonTopUp ? systemTonAddress : toAddress;
  const isWhitelistNativeTransfer = !isTonTopUp && Boolean(
    chain
    && (chain === 'ton' || chain === 'ethereum')
    && tokenSlug === getNativeToken(chain).slug,
  );
  const hasWhitelistTransferDetails = isActive
    && !isNftTransfer
    && isWhitelistNativeTransfer
    && Boolean(toAddress.trim())
    && amount !== undefined;

  const renderedScamWarningType = useCurrentOrPrev(scamWarningType, true);
  const amountInputRef = useRef<HTMLInputElement>();
  const isDisabledDebounce = useRef<boolean>(false);
  const isAddressValid = chain ? isValidAddressOrDomain(addressForValidation, chain) : undefined;
  const doesSupportComment = !isTonTopUp && chain && getChainConfig(chain).isTransferPayloadSupported;
  const doesSupportCommentEncryption = !!chain
    && getChainConfig(chain).isEncryptedCommentSupported
    && isEncryptedCommentSupported;
  const transitionKey = useTransitionActiveKey(nfts?.length ? nfts : [tokenSlug]);

  const handleAddressInput = useLastCallback((newToAddress?: string, isValueReplaced?: boolean) => {
    // If value is replaced, callbacks must be executed immediately, without debounce
    if (isValueReplaced) {
      isDisabledDebounce.current = true;
    }

    setTransferToAddress({ toAddress: newToAddress });
  });

  const handleAddressPaste = useLastCallback(() => {
    requestAnimationFrame(() => {
      amountInputRef.current?.focus();
    });
  });

  const shouldDisableClearButton = isTonTopUp || (
    !toAddress && !(comment || binPayload) && !shouldEncrypt && (isNftTransfer || amount === undefined)
  );

  const safeExplainedFee = useMemo(() => {
    return explainedFee ?? {
      isGasless: false,
      canTransferFullBalance: false,
    };
  }, [explainedFee]);

  // Note: this constant has 3 distinct meaningful values
  const isEnoughBalance = isTonTopUp ? true : isBalanceSufficientForTransfer({
    tokenBalance: balance,
    nativeTokenBalance,
    transferAmount: isNftTransfer ? 0n : amount,
    fullFee: safeExplainedFee.fullFee?.terms,
    canTransferFullBalance: safeExplainedFee.canTransferFullBalance,
  });

  const isAmountMissing = !isNftTransfer && !amount;

  useEffect(() => {
    if (wasTonTopUpRef.current === isTonTopUp) return;

    wasTonTopUpRef.current = isTonTopUp;
    setTransferAmount({ amount: undefined });
    setTonDepositControls(undefined);
    setIsTonTopUpAmountReady(false);
  }, [isTonTopUp]);

  useEffect(() => {
    if (!hasWhitelistTransferDetails) {
      hasShownWhitelistDialog.current = false;
      hasShownTonWhitelistDialog.current = false;
      lastTonWhitelistRecipientRef.current = undefined;
      closeWhitelistDialog();
      return;
    }

    if (chain !== 'ton') {
      lastTonWhitelistRecipientRef.current = undefined;
      hasShownTonWhitelistDialog.current = false;

      if (!hasShownWhitelistDialog.current) {
        hasShownWhitelistDialog.current = true;
        openWhitelistDialog();
      }
      return;
    }

    const recipient = resolvedAddress || toAddress;
    const normalizedRecipient = normalizeTonWhitelistAddress(recipient);
    const recipientKey = normalizedRecipient || recipient.trim().toLowerCase();

    if (lastTonWhitelistRecipientRef.current !== recipientKey) {
      lastTonWhitelistRecipientRef.current = recipientKey;
      hasShownTonWhitelistDialog.current = false;
      closeWhitelistDialog();
    }

    if (!normalizedRecipient) {
      return;
    }

    let isCurrentRequest = true;
    void getTonWhitelistAddresses(normalizedRecipient)
      .then((wallets) => {
        if (!isCurrentRequest) return;

        if (isTonWhitelistAddressRegistered(normalizedRecipient, wallets)) {
          hasShownTonWhitelistDialog.current = false;
          closeWhitelistDialog();
          return;
        }

        if (!hasShownTonWhitelistDialog.current) {
          hasShownTonWhitelistDialog.current = true;
          openWhitelistDialog();
        }
      })
      .catch(() => {
        if (!isCurrentRequest) return;
        showDialog({ message: lang('TON wallet verification failed. Please try again.') });
      });

    return () => {
      isCurrentRequest = false;
    };
  }, [
    chain, closeWhitelistDialog, hasWhitelistTransferDetails, lang, openWhitelistDialog,
    resolvedAddress, showDialog, toAddress,
  ]);

  const maxAmount = isTonTopUp
    ? tonDepositControls?.maxAmount
    : getMaxTransferAmount({
      tokenBalance: balance,
      tokenSlug,
      fullFee: safeExplainedFee.fullFee?.terms,
      canTransferFullBalance: safeExplainedFee.canTransferFullBalance,
    });

  const isDieselNotAuthorized = diesel?.status === 'not-authorized';
  const authorizeDieselInterval = isDieselNotAuthorized && isDieselAuthorizationStarted
    ? AUTHORIZE_DIESEL_INTERVAL_MS
    : undefined;

  const updateDieselState = useLastCallback(() => {
    fetchTransferDieselState({ tokenSlug });
  });

  useInterval(updateDieselState, authorizeDieselInterval);

  const fullFee = useMemo(() => {
    return getFullFee(safeExplainedFee.fullFee?.terms, tokenSlug);
  }, [safeExplainedFee.fullFee, tokenSlug]);

  useEffect(() => {
    if (isTonTopUp) return;
    if (
      balance && amount && fullFee !== undefined
      && amount <= balance
      && fullFee < balance
      && amount + fullFee >= balance
    ) {
      setTransferAmount({ amount: balance - fullFee });
    }
  }, [amount, balance, fullFee, isTonTopUp]);

  // Note: this effect doesn't watch amount changes mainly because it's tricky to program a fee recalculation avoidance
  // when the amount changes due to a fee change. And it's not needed because the fee doesn't depend on the amount.
  useEffect(() => {
    if (isTonTopUp) return;
    if (isAmountMissing || !isAddressValid) {
      return;
    }

    const runFunction = () => {
      if (isNftTransfer) {
        fetchNftFee({
          toAddress,
          comment,
          nfts: nfts ?? [],
        });
      } else {
        fetchTransferFee({
          tokenSlug,
          toAddress,
          amount,
          comment,
          shouldEncrypt,
          binPayload,
          stateInit,
        });
      }
    };

    if (!isDisabledDebounce.current) {
      runDebounce(runFunction);
    } else {
      isDisabledDebounce.current = false;
      runFunction();
    }
  }, [
    isAmountMissing, binPayload, comment, shouldEncrypt, isAddressValid, isNftTransfer, nfts, stateInit, toAddress,
    tokenSlug, amount, isTonTopUp,
  ]);

  useEffect(() => {
    if (getIsServiceToken(transferToken)) {
      showDialog({
        title: lang('Warning!'),
        message: lang('$service_token_transfer_warning'),
        noBackdropClose: true,
      });
    }
  }, [lang, transferToken]);

  useEffect(() => {
    if (isComplete) clearForm();
  }, [isComplete]);

  const handleTokenChange = useLastCallback((slug: string) => {
    const selectingTonTopUp = IS_TELEGRAM_APP
      && isPlatformAccountEnabled()
      && isMainnet
      && slug === TONCOIN.slug;
    if (isTonTopUp || selectingTonTopUp) {
      setTransferAmount({ amount: undefined });
      setTonDepositControls(undefined);
      setIsTonTopUpAmountReady(false);
    }
    changeTransferToken({ tokenSlug: slug });
  });

  function clearForm() {
    handleAddressInput('');
    checkTransferAddress({});
    setTransferAmount({ amount: undefined });
    setTransferComment({ comment: undefined });
    setTransferShouldEncrypt({ shouldEncrypt: false });
  }

  const handleClear = useLastCallback(() => {
    clearForm();
  });

  const handleCloseClick = useLastCallback(() => {
    cancelTransfer({ shouldReset: true });
  });

  const handleOpenAccountSelector = useLastCallback(() => {
    setTransferScreen({ state: TransferState.SelectAccount });
  });

  const handleScamWarningModalClose = useLastCallback(() => {
    dismissTransferScamWarning();
    cancelTransfer({ shouldReset: true });
  });

  const handleWhitelistAddAddress = useLastCallback(() => {
    closeWhitelistDialog();
    cancelTransfer();
    openSettingsWithState({ state: SettingsState.ExternalEvmWhitelist });
  });

  const handleAmountChange = (amount?: bigint, isValueReplaced?: boolean) => {
    // The amount input may change the amount when it's in the base currency mode and the token price changes.
    // Meanwhile, the amount in the global state must not change after the transfer form is submitted.
    if (!isActive) {
      return;
    }

    if (amount !== undefined && amount < 0) {
      return;
    }

    // If the value is replaced, callbacks must be executed immediately, without debounce
    if (isValueReplaced) {
      isDisabledDebounce.current = true;
    }

    setTransferAmount({ amount });
  };

  const handlePaste = useLastCallback(() => {
    isDisabledDebounce.current = true;
  });

  const handleCommentChange = useLastCallback((value) => {
    setTransferComment({ comment: trimStringByMaxBytes(value, COMMENT_MAX_SIZE_BYTES) });
  });

  const isAmountGreaterThanBalance = !isTonTopUp && !isNftTransfer && balance !== undefined && amount !== undefined
    && amount > balance;
  const hasInsufficientFeeError = !isTonTopUp && isEnoughBalance === false && !isAmountGreaterThanBalance
    && diesel?.status !== 'not-authorized' && diesel?.status !== 'pending-previous';
  const hasAmountError = !isTonTopUp && !isNftTransfer && amount !== undefined && (
    (maxAmount !== undefined && amount > maxAmount)
    || hasInsufficientFeeError // Ideally, the insufficient fee error message should be displayed somewhere else
  );
  const isCommentRequired = !isTonTopUp && Boolean(toAddress) && isMemoRequired;
  const hasCommentError = isCommentRequired && !comment;

  const canSubmit = isTonTopUp
    ? Boolean(systemTonAddress && isAddressValid && amount && !isAmountMissing
      && isTonTopUpAmountReady && tonDepositControls && !tonDepositControls.isSendDisabled)
    : isDieselNotAuthorized || Boolean(
      isAddressValid
      && !isAmountMissing && !hasAmountError
      && isEnoughBalance
      && !hasCommentError
      && !isMultisig
      && (!safeExplainedFee.isGasless || diesel?.status === 'available' || diesel?.status === 'stars-fee')
      && !(isNftTransfer && !nfts?.length),
    );

  const handleSubmit = useLastCallback((e?: React.FormEvent | React.UIEvent) => {
    if (e) stopEvent(e);

    if (isTonTopUp) {
      if (!canSubmit || !tonDepositControls) return;
      vibrate();
      void tonDepositControls.send();
      return;
    }

    if (scamWarningType) return;

    if (isDieselNotAuthorized) {
      authorizeDiesel();
      return;
    }

    if (!canSubmit) {
      return;
    }

    vibrate();

    submitTransferInitial({
      tokenSlug,
      amount: amount ?? 0n,
      toAddress,
      comment,
      binPayload,
      shouldEncrypt,
      nfts,
      isGasless: safeExplainedFee.isGasless,
      isGaslessWithStars: diesel?.status === 'stars-fee',
      stateInit,
    });
  });

  const [isFeeModalOpen, openFeeModal, closeFeeModal] = useFeeModal(safeExplainedFee);

  const tokensToSelect = useMemo(
    () => (tokens ?? []).filter((token) => isSelectableToken(token, tokenSlug)),
    [tokens, tokenSlug],
  );

  const amountInputProps = useAmountInputState({
    amount,
    token: transferToken,
    baseCurrency,
    isAmountReadonly: isTransferReadonly || isTonTopUp,
    onAmountChange: handleAmountChange,
    onTokenChange: handleTokenChange,
  });

  // It is necessary to use useCallback instead of useLastCallback here
  const renderBottomRight = useCallback((className?: string) => {
    let transitionKey = 0;
    let content: TeactNode = ' ';

    if (isMultisig && !isTonTopUp) {
      transitionKey = 1;
      content = <span className={styles.balanceError}>{lang('Multisig sending disabled')}</span>;
    } else if (amount) {
      if (isAmountGreaterThanBalance) {
        transitionKey = 2;
        content = <span className={styles.balanceError}>{lang('Insufficient balance')}</span>;
      } else if (hasInsufficientFeeError) {
        transitionKey = 3;
        content = <span className={styles.balanceError}>{lang('Insufficient fee')}</span>;
      }
    }

    return (
      <Transition
        className={className}
        name="fade"
        activeKey={transitionKey}
      >
        {content}
      </Transition>
    );
  }, [amount, hasInsufficientFeeError, isAmountGreaterThanBalance, isMultisig, isTonTopUp, lang]);

  function renderButtonText() {
    if (!isTonTopUp && diesel?.status === 'not-authorized') {
      return lang('$authorize_token_fee_capitalized', { token: symbol! });
    }
    if (!isTonTopUp && diesel?.status === 'pending-previous') {
      return lang('Awaiting Previous Fee');
    }
    return lang('$send_token_symbol', isNftTransfer ? 'NFT' : symbol || UNKNOWN_TOKEN.symbol);
  }

  function renderFee() {
    let terms: FeeTerms | undefined;
    let precision: FeePrecision = 'exact';

    if (!isAmountMissing) {
      const actualFee = hasInsufficientFeeError ? safeExplainedFee.fullFee : safeExplainedFee.realFee;
      if (actualFee) {
        ({ terms, precision } = actualFee);
      }
    }

    return (
      <FeeLine
        terms={terms}
        token={transferToken}
        precision={precision}
        onDetailsClick={openFeeModal}
      />
    );
  }

  return (
    <>
      <form
        className={modalStyles.transitionContent}
        onSubmit={handleSubmit}
        onPaste={handlePaste}
      >
        <Transition
          activeKey={transitionKey}
          name="semiFade"
          shouldCleanup
          slideClassName={styles.formSlide}
        >
          {hasMultipleAccounts && !isNftTransfer && accountId && (
            <AccountSwitcherPill
              accountId={accountId}
              title={accountTitle}
              className={styles.accountPill}
              onClick={handleOpenAccountSelector}
            />
          )}

          <Button
            isRound
            className={buildClassName(modalStyles.closeButton, styles.closeButton)}
            ariaLabel={lang('Close')}
            onClick={handleCloseClick}
          >
            <i className={buildClassName(modalStyles.closeIcon, 'icon-close')} aria-hidden />
          </Button>

          {isNftTransfer ? (
            <div className={styles.transferTitle}>
              {lang(nfts.length > 1 ? 'Send Collectibles' : 'Send Collectible')}
            </div>
          ) : (
            <SentTabs className={buildClassName(hasMultipleAccounts && styles.sentTabsWithSwitcher)} />
          )}

          {nfts?.length === 1 && <NftInfo nft={nfts[0]} withMediaViewer />}
          {Boolean(nfts?.length) && nfts.length > 1 && <NftChips nfts={nfts} />}

          <AddressInput
            label={lang('Recipient Address')}
            value={recipientAddress}
            chain={chain}
            // NFT transfers are available only on the TON blockchain on this moment
            addressBookChain={chain}
            savedAddresses={savedAddresses}
            validateAddress={isTonTopUp ? undefined : checkTransferAddress}
            isReadonly={isTransferReadonly || isTonTopUp}
            withQrScan={!isTonTopUp}
            address={isTonTopUp ? systemTonAddress : resolvedAddress || toAddress}
            addressName={isTonTopUp ? lang('$ton_deposit_destination') : toAddressName}
            onInput={isTonTopUp ? undefined : handleAddressInput}
            onPaste={handleAddressPaste}
            onClose={cancelTransfer}
          />

          {isTonTopUp && (
            <TonWalletDeposit
              isActive={isActive}
              forceAutoFillAmount
              hideActions
              hideDestination
              amountNano={isTonTopUpAmountReady ? amount ?? 0n : 0n}
              amountValue={!isTonTopUpAmountReady || amount === undefined
                ? undefined
                : toDecimal(amount, TONCOIN.decimals)}
              isAmountFromWallet
              receiverAddress={systemTonAddress}
              onAutoFillAmount={handleTonAutoFillAmount}
              onClearAmount={handleTonClearAmount}
              onControlsChange={handleTonDepositControlsChange}
            />
          )}

          {!isNftTransfer && (
            <AmountInput
              {...amountInputProps}
              amount={isTonTopUp && !isTonTopUpAmountReady ? undefined : amount}
              ref={amountInputRef}
              maxAmount={maxAmount}
              token={transferToken}
              allTokens={tokensToSelect}
              hasError={hasAmountError}
              withChainIcon
              isMaxAmountLoading={isTonTopUp
                ? !tonDepositControls || tonDepositControls.isBalanceLoading || maxAmount === undefined
                : maxAmount === undefined}
              isSensitiveDataHidden={isSensitiveDataHidden}
              renderBottomRight={renderBottomRight}
              onPressEnter={handleSubmit}
            />
          )}

          {doesSupportComment && (
            <CommentSection
              comment={comment}
              shouldEncrypt={shouldEncrypt}
              binPayload={binPayload}
              stateInit={stateInit}
              chain={chain}
              isReadonly={isTransferReadonly}
              isCommentRequired={isCommentRequired}
              isEncryptedCommentSupported={doesSupportCommentEncryption}
              onCommentChange={handleCommentChange}
            />
          )}

          <div className={styles.footer}>
            {!isTonTopUp && renderFee()}

            <div className={styles.buttons}>
              <Button
                isDisabled={shouldDisableClearButton || isLoading}
                className={styles.button}
                onClick={handleClear}
              >
                {lang('Clear')}
              </Button>
              <Button
                isPrimary
                isSubmit={!isTonTopUp}
                isDisabled={!canSubmit}
                isLoading={isLoading || Boolean(isTonTopUp && tonDepositControls?.isSending)}
                className={styles.button}
                onClick={isTonTopUp ? handleSubmit : undefined}
              >
                {renderButtonText()}
              </Button>
            </div>
          </div>
        </Transition>
      </form>
      <FeeDetailsModal
        isOpen={isFeeModalOpen}
        onClose={closeFeeModal}
        fullFee={safeExplainedFee.fullFee?.terms}
        realFee={safeExplainedFee.realFee?.terms}
        realFeePrecision={safeExplainedFee.realFee?.precision}
        excessFee={safeExplainedFee.excessFee}
        excessFeePrecision="approximate"
        token={transferToken}
      />
      <Modal
        isOpen={Boolean(scamWarningType)}
        isCompact
        title={lang('Warning!')}
        noBackdropClose
        onClose={handleScamWarningModalClose}
      >
        <div>
          {getScamWarning(lang, renderedScamWarningType)}
        </div>
        <div className={modalStyles.footerButtons}>
          {isAllowSuspiciousActions ? (
            <>
              <Button
                className={modalStyles.button}
                onClick={handleScamWarningModalClose}
              >
                {lang('Close')}
              </Button>
              <Button
                isPrimary
                isDestructive
                className={modalStyles.button}
                onClick={dismissTransferScamWarning}
              >
                {lang('Continue')}
              </Button>
            </>
          ) : (
            <Button onClick={handleScamWarningModalClose}>{lang('Close')}</Button>
          )}
        </div>
      </Modal>
      <Modal
        isOpen={isWhitelistDialogOpen}
        isCompact
        title={lang('Address must be added to the White List')}
        titleClassName={modalStyles.titleMultiline}
        onClose={closeWhitelistDialog}
      >
        <div>
          {lang('For security, add the wallet address to the White List before your first withdrawal.')}
        </div>
        <div className={modalStyles.footerButtons}>
          <Button onClick={closeWhitelistDialog}>{lang('Close')}</Button>
          <Button isPrimary onClick={handleWhitelistAddAddress}>
            {lang('Add to White List')}
          </Button>
        </div>
      </Modal>
    </>
  );
}

export default memo(
  withGlobal(
    (global): StateProps => {
      const {
        toAddress,
        resolvedAddress,
        toAddressName,
        amount,
        comment,
        shouldEncrypt,
        tokenSlug,
        isLoading,
        state,
        nfts,
        binPayload,
        isMemoRequired,
        diesel,
        stateInit,
        scamWarningType,
        isTransferReadonly,
        explainedFee,
      } = global.currentTransfer;

      const isLedger = selectIsHardwareAccount(global);
      const currentAccountId = selectCurrentAccountId(global)!;
      const currentAccount = selectCurrentAccount(global);
      const accountState = selectCurrentAccountState(global);
      const { baseCurrency = DEFAULT_PRICE_CURRENCY, isSensitiveDataHidden } = global.settings;
      const isActive = ACTIVE_STATES.has(state);

      const chain = getChainBySlug(tokenSlug);
      return {
        toAddress,
        resolvedAddress,
        toAddressName,
        amount,
        comment,
        shouldEncrypt,
        nfts,
        tokenSlug,
        binPayload,
        stateInit,
        tokens: selectCurrentAccountTokens(global),
        savedAddresses: accountState?.savedAddresses,
        isEncryptedCommentSupported: !isLedger && !nfts?.length && !isMemoRequired,
        isMemoRequired,
        isActive,
        isLoading: isLoading && isActive,
        isComplete: state === TransferState.Complete,
        baseCurrency,
        nativeTokenBalance: selectCurrentAccountTokenBalance(global, getNativeToken(chain).slug),
        diesel,
        isDieselAuthorizationStarted: accountState?.isDieselAuthorizationStarted,
        isMultisig: selectIsMultisigWallet(global, currentAccountId, chain),
        isSensitiveDataHidden,
        scamWarningType,
        isAllowSuspiciousActions: selectIsAllowSuspiciousActions(global, currentAccountId),
        isTransferReadonly,
        explainedFee,
        accountId: currentAccountId,
        accountTitle: currentAccount?.title,
        hasMultipleAccounts: selectHasMultipleAccounts(global),
        isMainnet: selectCurrentNetwork(global) === 'mainnet',
      };
    },
    (global, _, stickToFirst) => stickToFirst(selectCurrentAccountId(global)),
  )(TransferInitial),
);

function useFeeModal(explainedFee: ExplainedTransferFee) {
  const isAvailable = explainedFee.realFee?.precision !== 'exact';
  const [isOpen, open, close] = useFlag(false);
  const openIfAvailable = isAvailable ? open : undefined;
  return [isOpen, openIfAvailable, close] as const;
}

function isSelectableToken(token: UserToken, selectedTokenSlug: string) {
  return token.type !== 'lp_token'
    || (token.amount > 0 && !token.isDisabled)
    || token.slug === selectedTokenSlug;
}

function getScamWarning(lang: LangFn, scamWarning: ScamWarningType | undefined) {
  if (!scamWarning) return undefined;

  return lang(scamWarning === ScamWarningType.DomainLike
    ? '$domain_like_scam_warning'
    : '$seed_phrase_scam_warning', {
    help_center_link: (
      <a
        href={getHelpCenterUrl(lang.code, scamWarning === ScamWarningType.DomainLike ? 'domainScam' : 'seedScam')}
        target="_blank"
        rel="noreferrer"
      >
        <b>{lang('$help_center_prepositional')}</b>
      </a>
    ),
  });
}

// Calculates fee in the token currency to keep abstraction from SDK native fee values
function getFullFee(terms: FeeTerms<bigint> | undefined, tokenSlug: string): bigint | undefined {
  if (!terms) return undefined;
  const tokenPart = terms.token ?? 0n;
  const nativePart = getIsNativeToken(tokenSlug) ? (terms.native ?? 0n) : 0n;
  return tokenPart + nativePart;
}
