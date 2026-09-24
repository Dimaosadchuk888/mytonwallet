import React, { memo } from '../../lib/teact/teact';

import type { Theme } from '../../global/types';

import buildClassName from '../../util/buildClassName';
import { SECOND } from '../../util/dateFormat';

import useAppTheme from '../../hooks/useAppTheme';
import useFlag from '../../hooks/useFlag';
import useLang from '../../hooks/useLang';
import useMediaTransition from '../../hooks/useMediaTransition';
import useTimeout from '../../hooks/useTimeout';

import styles from './Auth.module.scss';

import authWordmarkPath from '../../assets/MyGramWallet-auth-wordmark.png';
import authWordmarkLightPath from '../../assets/MyGramWallet-auth-wordmark-light.png';

interface OwnProps {
  isActive?: boolean;
  theme: Theme;
}

const START_DELAY = 700;
const INTERVAL = SECOND;

const AuthCreatingWallet = ({ isActive, theme }: OwnProps) => {
  const lang = useLang();
  const appTheme = useAppTheme(theme);
  const [one, markOne] = useFlag();
  const [two, markTwo] = useFlag();
  const [three, markThree] = useFlag();

  useTimeout(markOne, isActive ? START_DELAY : undefined);
  useTimeout(markTwo, isActive ? START_DELAY + INTERVAL : undefined);
  useTimeout(markThree, isActive ? START_DELAY + INTERVAL * 2 : undefined);

  const oneRef = useMediaTransition<HTMLElement>(one);
  const twoRef = useMediaTransition<HTMLElement>(two);
  const threeRef = useMediaTransition<HTMLElement>(three);

  return (
    <div className={buildClassName(styles.container, 'custom-scroll')}>
      <img
        src={appTheme === 'dark' ? authWordmarkLightPath : authWordmarkPath}
        alt="MyGramWallet"
        className={styles.authLogo}
      />
      <div className={styles.title}>{lang('Creating Wallet...')}</div>

      <div className={styles.counter}>
        <p className={styles.counterTitle}>{lang('On the count of three...')}</p>
        <b ref={oneRef} className={buildClassName(styles.counterDigit, 'rounded-font')}>1</b>
        <b ref={twoRef} className={buildClassName(styles.counterDigit, 'rounded-font')}>2</b>
        <b ref={threeRef} className={buildClassName(styles.counterDigit, 'rounded-font')}>3</b>
      </div>
    </div>
  );
};

export default memo(AuthCreatingWallet);
