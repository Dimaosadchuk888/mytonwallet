import React, { memo, useRef } from '../../lib/teact/teact';

import {
  APP_ENV_MARKER,
  APP_NAME,
  APP_VERSION,
  IS_GRAM_WALLET,
} from '../../config';
import buildClassName from '../../util/buildClassName';
import { handleUrlClick } from '../../util/openUrl';
import { getBlogUrl } from '../../util/url';

import { useDeviceScreen } from '../../hooks/useDeviceScreen';
import useHistoryBack from '../../hooks/useHistoryBack';
import useLang from '../../hooks/useLang';

import Header from '../auth/Header';
import SettingsHeader from './SettingsHeader';

import styles from './Settings.module.scss';

import logoWebpPath from '../../assets/logo.webp';
import gramWalletLogoPath from '../../assets/logoGramWallet.svg';
import hotImg from '../../assets/settings/settings_hot.svg';

const LOGO_PATH = IS_GRAM_WALLET ? gramWalletLogoPath : logoWebpPath;

interface OwnProps {
  isActive?: boolean;
  slideClassName?: string;
  onBackClick: NoneToVoidFunction;
}

function SettingsAbout({
  isActive, slideClassName, onBackClick,
}: OwnProps) {
  const lang = useLang();

  const { isPortrait } = useDeviceScreen();
  const headerRef = useRef<HTMLHeadingElement>();

  useHistoryBack({
    isActive,
    onBack: onBackClick,
  });

  return (
    <div className={buildClassName(styles.slide, slideClassName)}>
      {isPortrait ? (
        <Header
          isActive={isActive}
          title={`${APP_NAME} ${APP_VERSION} ${APP_ENV_MARKER || ''}`}
          topTargetRef={headerRef}
          onBackClick={onBackClick}
        />
      ) : (
        <SettingsHeader onBackClick={onBackClick} />
      )}

      <div
        className={buildClassName(styles.content, styles.noTitle, 'custom-scroll')}
      >
        <img src={LOGO_PATH} alt={lang('Logo')} className={styles.logo} />
        <h2 ref={headerRef} className={styles.title}>
          {APP_NAME} {APP_VERSION} {APP_ENV_MARKER}
        </h2>
        <div className={buildClassName(styles.settingsBlock, styles.settingsBlock_text)}>
          <p className={styles.text}>
            {renderText(lang('$about_description1'))}
          </p>
          <p className={styles.text}>
            {renderText(lang('$about_description2'))}
          </p>
        </div>

        <p className={styles.blockTitle}>{lang('%app_name% Resources', { app_name: APP_NAME })}</p>
        <div className={styles.settingsBlock}>
          <a
            href={getBlogUrl(lang.code!)}
            target="_blank"
            rel="noreferrer"
            className={styles.item}
            onClick={handleUrlClick}
          >
            <img className={styles.menuIcon} src={hotImg} alt={lang('Enjoy Monthly Updates in Blog')} />
            <span className={styles.itemTitle}>{lang('Enjoy Monthly Updates in Blog')}</span>

            <i className={buildClassName(styles.iconChevronRight, 'icon-chevron-right')} aria-hidden />
          </a>
        </div>
      </div>
    </div>
  );
}

export default memo(SettingsAbout);
