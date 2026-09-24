import React, { memo } from '../../../lib/teact/teact';
import { getActions } from '../../../global';

import type { ApiChain } from '../../../api/types';

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
  onClose?: NoneToVoidFunction;
}

function Address({
  chain,
  isActive,
  isLedger,
  isViewMode,
  address,
  comment,
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
        {renderText(lang('$receive_description'))}
      </div>

      <div className={styles.qrCode} ref={qrCodeRef} />

      <InteractiveTextField
        chain={chain}
        address={address}
        copyText={copyText}
        className={styles.addressWrapper}
        copyNotification={lang('%chain% Address Copied', { chain: getChainTitle(chain) }) as string}
        noSavedAddress
        noDimming
      />

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

      {!isViewMode && <Actions chain={chain} isLedger={isLedger} onClose={onClose} />}
    </div>
  );
}

export default memo(Address);
