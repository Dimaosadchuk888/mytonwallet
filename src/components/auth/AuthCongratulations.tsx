import React, { memo, useEffect } from '../../lib/teact/teact';
import { getActions } from '../../global';

import renderText from '../../global/helpers/renderText';
import buildClassName from '../../util/buildClassName';
import captureKeyboardListeners from '../../util/captureKeyboardListeners';
import { vibrateOnSuccess } from '../../util/haptics';

import useLang from '../../hooks/useLang';
import useLastCallback from '../../hooks/useLastCallback';

import Button from '../ui/Button';

import styles from './Auth.module.scss';

import authSquareLogoPath from '../../assets/MyGramWallet-auth-square.png';

interface OwnProps {
  isActive?: boolean;
  hardwareWalletsAmount?: number;
  isImporting?: boolean;
}

function AuthCongratulations({
  isActive,
  hardwareWalletsAmount,
  isImporting,
}: OwnProps) {
  const { afterCongratulations, requestConfetti } = getActions();

  const lang = useLang();

  useEffect(() => {
    if (isActive) {
      requestConfetti();
      void vibrateOnSuccess();
    }
  }, [isActive]);

  const handleClick = useLastCallback(() => {
    afterCongratulations({ isImporting: isImporting && !hardwareWalletsAmount });
  });

  useEffect(() => {
    return isActive
      ? captureKeyboardListeners({
        onEnter: { handler: handleClick, noStopPropagation: true },
        onSpace: { handler: handleClick, noStopPropagation: true },
      })
      : undefined;
  }, [isActive]);

  function getInfo() {
    if (isImporting) {
      return lang('$wallet_import_done', hardwareWalletsAmount ?? 0, 'i');
    }

    return lang('$wallet_create_done');
  }

  return (
    <div className={buildClassName(styles.container, 'custom-scroll')}>
      <img src={authSquareLogoPath} alt="MyGramWallet" className={styles.authLogo} />
      <div className={styles.title}>{lang('All Set!')}</div>
      <div className={styles.info}>
        <p><b>{getInfo()}</b></p>
        <p>{renderText(lang('$wallet_done_description'))}</p>
      </div>

      <div className={styles.buttons}>
        <Button
          isPrimary
          className={styles.btn}
          onClick={handleClick}
        >
          {lang('Open Wallet')}
        </Button>
      </div>
    </div>
  );
}

export default memo(AuthCongratulations);
