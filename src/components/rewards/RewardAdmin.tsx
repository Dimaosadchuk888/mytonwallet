import React, { memo, useEffect, useState } from '../../lib/teact/teact';
import { getActions } from '../../global';

import { INTERNAL_TON_API_BASE_URL } from '../../config';
import { getPlatformAuthMetadata, usePlatformAccount } from '../../platform/accountStore';

import Button from '../ui/Button';
import Input from '../ui/Input';

import styles from './RewardAdmin.module.scss';

type RewardCheck = {
  id: string; title: string; code: string; amountPerClaim: string; maxClaims: number;
  asset: RewardAsset; claimedCount: number; isActive: boolean; expiresAt?: string; createdAt: string; link: string;
};

type RewardAsset = 'TON' | 'USDT' | 'ETH';

const apiUrl = (path: string) => `${INTERNAL_TON_API_BASE_URL}${path}`;

function RewardAdmin() {
  usePlatformAccount();
  const [isOpen, setIsOpen] = useState(false);
  const [checks, setChecks] = useState<RewardCheck[]>([]);
  const [title, setTitle] = useState('');
  const [asset, setAsset] = useState<RewardAsset>('TON');
  const [amount, setAmount] = useState('');
  const [maxClaims, setMaxClaims] = useState('');
  const [expiresAt, setExpiresAt] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');
  const metadata = getPlatformAuthMetadata();

  useEffect(() => {
    if (isOpen) void loadChecks();
  }, [isOpen]);

  if (!metadata?.isAdmin || !isAdminStartParam()) return undefined;
  if (!isOpen) {
    return <Button className={styles.trigger} isPrimary isSmall onClick={() => setIsOpen(true)}>Награды</Button>;
  }

  async function loadChecks() {
    setIsLoading(true);
    try {
      const response = await fetch(apiUrl('/api/admin/reward-checks'), { credentials: 'include' });
      if (!response.ok) throw new Error();
      setChecks((await response.json()).checks);
      setError('');
    } catch {
      setError('Не удалось загрузить чеки');
    } finally {
      setIsLoading(false);
    }
  }

  async function createCheck() {
    const amountBaseUnits = parseAmountToBaseUnits(amount, asset);
    const recipients = Number(maxClaims);
    if (!title.trim() || amountBaseUnits === undefined || !Number.isInteger(recipients) || recipients < 1) {
      setError('Проверьте название, сумму и число получателей');
      return;
    }
    setIsLoading(true);
    try {
      const response = await fetch(apiUrl('/api/admin/reward-checks'), {
        method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          title: title.trim(), asset, amountBaseUnits, maxClaims: recipients, ...(expiresAt && { expiresAt }),
        }),
      });
      if (!response.ok) throw new Error();
      const result = await response.json();
      setChecks((current) => [result.check, ...current]);
      setTitle('');
      setAsset('TON');
      setAmount('');
      setMaxClaims('');
      setExpiresAt('');
      setError('');
      getActions().showToast({ message: 'Чек создан' });
    } catch {
      setError('Не удалось создать чек');
    } finally {
      setIsLoading(false);
    }
  }

  async function disableCheck(id: string) {
    if (!window.confirm('Отключить этот чек?')) return;
    const response = await fetch(apiUrl(`/api/admin/reward-checks/${id}/disable`), {
      method: 'POST', credentials: 'include',
    });
    if (response.ok) {
      setChecks((current) => current.map((check) => (
        check.id === id ? { ...check, isActive: false } : check
      )));
    }
  }

  async function copyLink(link: string) {
    await navigator.clipboard.writeText(link);
    getActions().showToast({ message: 'Ссылка скопирована' });
  }

  return (
    <div className={styles.wrapper}>
      <div className={styles.inner}>
        <div className={styles.header}>
          <div>
            <div className={styles.title}>Награды</div>
            <div className={styles.caption}>
              Создавайте ссылки на одноразовые начисления TON, USDT и ETH.
            </div>
          </div>
          <Button isText onClick={() => setIsOpen(false)}>Закрыть</Button>
        </div>
        <div className={styles.card}>
          <div className={styles.cardTitle}>Новый чек</div>
          <Input label="Название" value={title} onInput={setTitle} placeholder="Например, запуск канала" />
          <label className={styles.selectField}>
            <span className={styles.selectLabel}>Валюта</span>
            <select
              className={styles.select}
              value={asset}
              onChange={(event) => setAsset(event.currentTarget.value as RewardAsset)}
            >
              <option value="TON">TON</option>
              <option value="USDT">USDT</option>
              <option value="ETH">ETH (Ethereum)</option>
            </select>
          </label>
          <Input
            label={`Сумма, ${asset}`}
            value={amount}
            onInput={setAmount}
            inputMode="numeric"
            placeholder={asset === 'USDT' ? '1.00' : asset === 'ETH' ? '0.01' : '0.25'}
          />
          <div className={styles.grid}>
            <Input
              label="Получателей"
              value={maxClaims}
              onInput={setMaxClaims}
              inputMode="numeric"
              placeholder="100"
            />
            <Input
              label="Срок действия"
              value={expiresAt}
              onInput={setExpiresAt}
              type="text"
              placeholder="2026-12-31T23:59"
            />
          </div>
          {error && <div className={styles.error}>{error}</div>}
          <Button
            className={styles.button}
            isPrimary
            isLoading={isLoading}
            onClick={createCheck}
          >
            Создать чек
          </Button>
        </div>
        <div className={styles.card}>
          <div className={styles.cardTitle}>Созданные чеки</div>
          {!checks.length && !isLoading && <div className={styles.empty}>Чеков пока нет</div>}
          {checks.map((check) => (
            <div className={styles.check} key={check.id}>
              <div className={styles.checkHeader}>
                <span>{check.title}</span>
                <span>{formatAmount(check.amountPerClaim, check.asset)} {check.asset}</span>
              </div>
              <div className={styles.checkMeta}>
                <span>{check.claimedCount} из {check.maxClaims} получателей</span>
                <span>{check.isActive ? 'Активен' : 'Отключён'}</span>
              </div>
              <div className={styles.actions}>
                <Button isSmall isSecondary onClick={() => void copyLink(check.link)}>Копировать ссылку</Button>
                {check.isActive && (
                  <Button isSmall isDestructive onClick={() => void disableCheck(check.id)}>Отключить</Button>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function parseAmountToBaseUnits(value: string, asset: RewardAsset) {
  const decimals = getAssetDecimals(asset);
  const pattern = new RegExp(`^(?:\\d+)(?:\\.\\d{0,${decimals}})?$`);
  if (!pattern.test(value.trim())) return undefined;
  const [whole, fraction = ''] = value.trim().split('.');
  const normalized = `${whole}${fraction.padEnd(decimals, '0')}`.replace(/^0+(?=\d)/, '') || '0';
  return BigInt(normalized) > 0n ? normalized : undefined;
}

function formatAmount(value: string, asset: RewardAsset) {
  const decimals = getAssetDecimals(asset);
  const normalized = value.padStart(decimals + 1, '0');
  const fraction = normalized.slice(-decimals).replace(/0+$/, '');
  return `${normalized.slice(0, -decimals).replace(/^0+(?=\d)/, '')}${fraction ? `.${fraction}` : ''}`;
}

function getAssetDecimals(asset: RewardAsset) {
  return asset === 'USDT' ? 6 : asset === 'ETH' ? 18 : 9;
}

function isAdminStartParam() {
  return window.Telegram?.WebApp?.initDataUnsafe?.start_param === 'reward_admin';
}

export default memo(RewardAdmin);
