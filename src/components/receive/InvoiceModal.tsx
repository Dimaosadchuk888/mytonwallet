import React, {
  memo, useEffect, useMemo, useState,
} from '../../lib/teact/teact';
import { getActions, withGlobal } from '../../global';

import type { ApiTokenWithPrice } from '../../api/types';
import type { Account, UserSwapToken, UserToken } from '../../global/types';

import { DEFAULT_CHAIN } from '../../config';
import renderText from '../../global/helpers/renderText';
import {
  selectCurrentAccount,
  selectCurrentAccountId,
  selectCurrentAccountState,
  selectHasMultipleAccounts,
} from '../../global/selectors';
import buildClassName from '../../util/buildClassName';
import { getChainConfig, getOrderedAccountChains } from '../../util/chain';
import { fromDecimal } from '../../util/decimals';
import {
  claimPlatformTransactionHash, getPlatformDeposit, isPlatformAccountEnabled,
  usePlatformAccount,
} from '../../platform/accountStore';
import resolveSlideTransitionName from '../../util/resolveSlideTransitionName';
import { getChainBySlug } from '../../util/tokens';

import useFlag from '../../hooks/useFlag';
import useLang from '../../hooks/useLang';
import useLastCallback from '../../hooks/useLastCallback';

import AccountSwitcherPill from '../common/AccountSwitcherPill';
import AccountSwitcherSlide from '../common/AccountSwitcherSlide';
import SelectTokenButton from '../common/SelectTokenButton';
import TokenSelector from '../common/TokenSelector';
import Input from '../ui/Input';
import InteractiveTextField from '../ui/InteractiveTextField';
import Modal from '../ui/Modal';
import ModalHeader from '../ui/ModalHeader';
import RichNumberInput from '../ui/RichNumberInput';
import Transition from '../ui/Transition';

import modalStyles from '../ui/Modal.module.scss';
import styles from './ReceiveModal.module.scss';

interface StateProps {
  isOpen?: boolean;
  tokenSlug?: string;
  tokensBySlug?: Record<string, ApiTokenWithPrice>;
  byChain?: Account['byChain'];
  currentAccountId?: string;
  accountTitle?: string;
  hasMultipleAccounts?: boolean;
}

const enum SLIDES {
  Initial,
  TokenSelector,
  AccountSelector,
}

function InvoiceModal({
  byChain,
  tokenSlug,
  tokensBySlug,
  isOpen,
  currentAccountId,
  accountTitle,
  hasMultipleAccounts,
}: StateProps) {
  const platformAccount = usePlatformAccount();
  const { changeInvoiceToken, closeInvoiceModal, switchAccount } = getActions();

  const selectedChain = tokenSlug ? getChainBySlug(tokenSlug) : DEFAULT_CHAIN;
  const { isTransferPayloadSupported, nativeToken, formatTransferUrl } = getChainConfig(selectedChain);
  const isPlatformDeposit = isPlatformAccountEnabled();
  const platformDeposit = isPlatformDeposit ? getPlatformDeposit(selectedChain) : undefined;
  const selectedToken = isPlatformDeposit
    ? { ...nativeToken, symbol: platformDeposit?.asset || nativeToken.symbol, decimals: platformDeposit?.decimals ?? nativeToken.decimals }
    : ((tokenSlug && tokensBySlug?.[tokenSlug]) || nativeToken);
  const address = isPlatformDeposit ? platformDeposit?.address : byChain?.[selectedChain]?.address;

  const lang = useLang();
  const [isTokenSelectorOpen, openTokenSelector, closeTokenSelector] = useFlag(false);
  const [isAccountSelectorOpen, openAccountSelector, closeAccountSelector] = useFlag(false);
  const [amountValue, setAmountValue] = useState<string | undefined>(undefined);
  const [comment, setComment] = useState<string>('');
  const [claimHash, setClaimHash] = useState('');
  const [claimError, setClaimError] = useState<string>();
  const hasSystemComment = isPlatformDeposit;
  const invoiceComment = isPlatformDeposit ? (platformDeposit?.reference || '') : comment;
  const handleCommentInput = useLastCallback((value: string) => {
    if (!hasSystemComment) setComment(value);
  });
  const handleOpenTokenSelector = useLastCallback(() => {
    if (!isPlatformDeposit) openTokenSelector();
  });

  useEffect(() => {
    if (!isOpen) closeAccountSelector();
  }, [isOpen, closeAccountSelector]);

  // Leave the selector only after the account actually changes and the main slide remounts with it
  useEffect(closeAccountSelector, [closeAccountSelector, currentAccountId]);

  const avalableChains = useMemo(
    () => byChain
      ? getOrderedAccountChains(byChain).filter((chain) => getChainConfig(chain).formatTransferUrl)
      : [],
    [byChain],
  );

  const amount = amountValue ? fromDecimal(amountValue, selectedToken.decimals) : 0n;
  const tokenAddress = isPlatformDeposit
    ? platformDeposit?.tokenContract
    : ('tokenAddress' in selectedToken ? selectedToken?.tokenAddress : undefined);
  const invoiceUrl = address && formatTransferUrl && (!isPlatformDeposit || selectedChain === 'ton')
    ? formatTransferUrl(address, amount, invoiceComment, tokenAddress)
    : '';

  const handleTokenSelect = useLastCallback((token: UserToken | UserSwapToken) => {
    if (isPlatformDeposit) return;
    changeInvoiceToken({ tokenSlug: token.slug });
  });

  const handleClaim = useLastCallback(async () => {
    try {
      setClaimError(undefined);
      await claimPlatformTransactionHash(selectedChain, claimHash);
      setClaimHash('');
    } catch (error) {
      setClaimError(error instanceof Error ? error.message : 'Unable to claim transaction');
    }
  });

  const handleSelectAccount = useLastCallback((accountId: string) => {
    switchAccount({ accountId });
  });

  const activeKey = isAccountSelectorOpen
    ? SLIDES.AccountSelector
    : (isTokenSelectorOpen ? SLIDES.TokenSelector : SLIDES.Initial);
  const nextKey = activeKey === SLIDES.Initial ? SLIDES.TokenSelector : SLIDES.Initial;

  function renderContent(isActive: boolean, isFrom: boolean, currentKey: SLIDES) {
    switch (currentKey) {
      case SLIDES.Initial:
        return (
          <>
            <div className={styles.headerWithSwitcher}>
              <ModalHeader
                title={lang('Deposit Link')}
                onClose={closeInvoiceModal}
              />
              {hasMultipleAccounts && currentAccountId && (
                <AccountSwitcherPill
                  accountId={currentAccountId}
                  title={accountTitle}
                  className={styles.accountPill}
                  onClick={openAccountSelector}
                />
              )}
            </div>
            <div className={styles.content}>
              <div className={styles.contentTitle}>
                {renderText(lang('$receive_invoice_description'))}
              </div>
              <RichNumberInput
                key="amount"
                id="amount"
                value={amountValue}
                labelText={lang('Amount')}
                onChange={setAmountValue}
              >
                <SelectTokenButton
                  noChainIcon={avalableChains.length <= 1}
                  token={selectedToken}
                  onClick={handleOpenTokenSelector}
                />
              </RichNumberInput>
                {isTransferPayloadSupported && !isPlatformDeposit && (
                <Input
                  value={invoiceComment}
                  label={lang('Comment')}
                  placeholder={lang('Optional')}
                  wrapperClassName={styles.invoiceComment}
                  onInput={handleCommentInput}
                />
              )}

              <p className={styles.labelForInvoice}>
                {lang('Share this URL to receive %token%', { token: selectedToken?.symbol })}
              </p>
              <InteractiveTextField
                text={invoiceUrl}
                noExplorer
                copyNotification={lang('Invoice Link Copied')}
                className={styles.invoiceLinkField}
              />
              {isPlatformDeposit && selectedChain !== 'ton' && !invoiceUrl && (
                <div className={styles.platformNotice}>
                  Copy the approved address above. A token payment link is unavailable for this network.
                </div>
              )}
                {isPlatformDeposit && (
                  <>
                    <div className={styles.platformNotice}>
                      {platformDeposit?.network || selectedChain.toUpperCase()} · send only the approved asset
                      {platformDeposit?.reference ? ` and include reference ${platformDeposit.reference}` : ''}.
                      For networks without a reference, claim your transaction hash after sending.
                    </div>
                    <Input
                      value={claimHash}
                      label="Transaction hash claim"
                      placeholder="Paste transaction hash"
                      onInput={setClaimHash}
                    />
                    <button type="button" disabled={!platformAccount || !claimHash.trim()} onClick={handleClaim}>
                      Claim transaction
                    </button>
                    {claimError && <div className={styles.platformNotice}>{claimError}</div>}
                  </>
                )}
            </div>
          </>
        );

      case SLIDES.TokenSelector:
        return (
          <TokenSelector
            isActive={isActive}
            shouldHideNotSupportedTokens
            selectedChain={avalableChains}
            onTokenSelect={handleTokenSelect}
            onBack={closeTokenSelector}
            onClose={closeInvoiceModal}
          />
        );

      case SLIDES.AccountSelector:
        return (
          <AccountSwitcherSlide
            isActive={isActive}
            onAccountSelect={handleSelectAccount}
            onBack={closeAccountSelector}
            onClose={closeInvoiceModal}
          />
        );
    }
  }

  return (
    <Modal
      isOpen={isOpen}
      dialogClassName={styles.modalDialog}
      onClose={closeInvoiceModal}
      onCloseAnimationEnd={closeTokenSelector}
    >
      <Transition
        name={resolveSlideTransitionName()}
        className={buildClassName(modalStyles.transition, 'custom-scroll')}
        slideClassName={modalStyles.transitionSlide}
        activeKey={activeKey}
        nextKey={nextKey}
      >
        {renderContent}
      </Transition>
    </Modal>
  );
}

export default memo(
  withGlobal((global): StateProps => {
    const account = selectCurrentAccount(global);
    const { invoiceTokenSlug } = selectCurrentAccountState(global) || {};

    return {
      isOpen: global.isInvoiceModalOpen,
      tokenSlug: invoiceTokenSlug,
      tokensBySlug: global.tokenInfo?.bySlug,
      byChain: account?.byChain,
      currentAccountId: selectCurrentAccountId(global),
      accountTitle: account?.title,
      hasMultipleAccounts: selectHasMultipleAccounts(global),
    };
  })(InvoiceModal),
);
