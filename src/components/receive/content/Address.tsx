import React, { memo } from '../../../lib/teact/teact';
import { getActions } from '../../../global';

import type { ApiChain } from '../../../api/types';
import type { PlatformDeposit } from '../../../platform/accountStore';

import renderText from '../../../global/helpers/renderText';
import buildClassName from '../../../util/buildClassName';
import { getChainConfig, getChainTitle } from '../../../util/chain';

import useLang from '../../../hooks/useLang';
import useQrCode from '../../../hooks/useQrCode';

import InteractiveTextField from '../../ui/InteractiveTextField';
import WarningMessage from '../../ui/WarningMessage';
import Actions from './Actions';

import styles from '../ReceiveModal.module.scss';

interface OwnProps {
  chain: ApiChain;
  isActive?: boolean;
  isLedger?: boolean;
  isViewMode?: boolean;
  address: string;
  comment?: string;
  network?: string;
  asset?: string;
  reference?: string;
  platformLoading?: boolean;
  depositHistory?: PlatformDeposit[];
  onClose?: NoneToVoidFunction;
}

function Address({
  chain,
  isActive,
  isLedger,
  isViewMode,
  address,
  comment,
  network,
  asset,
  reference,
  platformLoading,
  depositHistory,
  onClose,
}: OwnProps) {
  const { verifyHardwareAddress } = getActions();

  const lang = useLang();
  const copyText = address && comment
    ? getChainConfig(chain).formatTransferUrl?.(address, undefined, comment)
    : undefined;
  const { qrCodeRef } = useQrCode({
    address,
    chain,
    isActive,
    preferUrl: true,
    comment,
  });

  const handleVerify = (e: React.MouseEvent<HTMLAnchorElement>) => {
    e.preventDefault();
    e.stopPropagation();

    verifyHardwareAddress({ chain });
  };

  return (
    <div>
      <div className={buildClassName(styles.contentTitle, styles.contentTitleQr)}>
        {network ? `${network}${asset ? ` · ${asset}` : ''}` : renderText(lang('$receive_description'))}
      </div>

      {platformLoading && <div className={styles.platformNotice}>Loading approved deposit details…</div>}
      {!platformLoading && !address && (
        <div className={styles.platformNotice}>Deposit details are temporarily unavailable. Please try again.</div>
      )}
      {address && <div className={styles.qrCode} ref={qrCodeRef} />}

      {address && <InteractiveTextField
        chain={chain}
        address={address}
        copyText={copyText}
        className={styles.addressWrapper}
        copyNotification={lang('%chain% Address Copied', { chain: getChainTitle(chain) }) as string}
        noSavedAddress
        noDimming
      />}
      {reference && (
        <div className={styles.platformNotice}>
          Required reference: <strong>{reference}</strong>
        </div>
      )}
      {depositHistory?.length ? (
        <div className={styles.platformNotice}>
          <strong>Deposit Transactions</strong>
          {depositHistory.slice(0, 3).map((deposit) => (
            <div key={deposit.id}>
              {deposit.status}
              {' · '}
              {deposit.asset}
              {deposit.transactionHash ? ` · ${deposit.transactionHash.slice(0, 10)}…` : ''}
            </div>
          ))}
        </div>
      ) : undefined}

      {isViewMode && (
        <WarningMessage className={styles.viewModeWarning}>
          {renderText(lang('$view_only_wallet_receive_warning'))}
        </WarningMessage>
      )}

      {isLedger && (
        <div className={buildClassName(styles.contentTitle, styles.contentTitleLedger)}>
          {renderText(lang('$ledger_verify_address'))}
          {' '}
          <a href="#" onClick={handleVerify} className={styles.dottedLink}>
            {lang('Verify now')}
          </a>
        </div>
      )}

      {!isViewMode && address && <Actions chain={chain} isLedger={isLedger} onClose={onClose} />}
    </div>
  );
}

export default memo(Address);
