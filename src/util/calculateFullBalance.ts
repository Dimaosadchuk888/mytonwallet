import type { ApiChain, ApiStakingState } from '../api/types';
import type { UserToken } from '../global/types';

import { STAKED_TOKEN_SLUGS } from '../config';
import { Big } from '../lib/big.js';
import { calcBigChangeValue } from './calcChangeValue';
import { toBig } from './decimals';
import { formatNumber } from './formatNumber';
import { buildArrayCollectionByKey } from './iteratees';
import { round } from './math';
import { getFullStakingBalance } from './staking';

type ChangePrefix = 'up' | 'down' | undefined;
export type PlatformBalances = Partial<Record<'TON' | 'USDT' | 'ETH', string>>;

export function calculateFullBalance(
  tokens?: UserToken[],
  stakingStates?: ApiStakingState[],
  baseCurrencyRate: string = '1',
  platformBalances?: PlatformBalances,
) {
  const stakingStateBySlug = buildArrayCollectionByKey(stakingStates ?? [], 'tokenSlug');

  const primaryValueUsd = (tokens ?? []).reduce((acc, token) => {
    if (STAKED_TOKEN_SLUGS.has(token.slug)) {
      // Cost of staked tokens is already taken into account
      return acc;
    }

    const stakingStates = stakingStateBySlug[token.slug] ?? [];

    for (const stakingState of stakingStates) {
      const stakingAmount = toBig(getFullStakingBalance(stakingState), token.decimals);
      acc = acc.plus(stakingAmount.mul(token.priceUsd));
    }

    return acc.plus(toBig(token.amount, token.decimals).mul(token.priceUsd));
  }, Big(0));
  const platformValueUsd = Object.entries(platformBalances ?? {}).reduce((acc, [asset, amount]) => {
    if (!amount) return acc;

    const decimals = asset === 'USDT' ? 6 : asset === 'ETH' ? 18 : 9;
    const priceUsd = asset === 'USDT'
      ? 1
      : tokens?.find((token) => (
        asset === 'TON'
          ? token.slug === 'toncoin'
          : token.chain === 'ethereum' && !token.tokenAddress
      ))?.priceUsd;

    if (priceUsd === undefined) return acc;

    try {
      return acc.plus(toBig(BigInt(amount), decimals).mul(priceUsd));
    } catch {
      return acc;
    }
  }, Big(0));
  const totalValueUsd = primaryValueUsd.plus(platformValueUsd);
  const primaryValue = totalValueUsd.mul(baseCurrencyRate);

  const [primaryWholePart, primaryFractionPart] = formatNumber(primaryValue).split('.');
  const changeValue = (tokens ?? []).reduce((acc, token) => {
    return acc.plus(calcBigChangeValue(token.totalValue, token.change24h));
  }, Big(0)).round(4).toNumber();

  const changePercent = round(primaryValue ? (changeValue / (primaryValue.toNumber() - changeValue)) * 100 : 0, 2);
  const changePrefix: ChangePrefix = changeValue > 0 ? 'up' : changeValue < 0 ? 'down' : undefined;

  return {
    primaryValue: primaryValue.toString(),
    primaryValueUsd: totalValueUsd.toString(),
    primaryWholePart,
    primaryFractionPart,
    changePrefix,
    changePercent,
    changeValue,
  };
}

/** Sorts chains by their full USD balance (staking included) descending, keeping the default order for ties */
export function sortChainsByBalance(chains: ApiChain[], tokens?: UserToken[], stakingStates?: ApiStakingState[]) {
  if (chains.length <= 1 || !tokens?.length) {
    return chains;
  }

  const balanceByChain: Partial<Record<ApiChain, Big>> = {};
  for (const chain of chains) {
    const chainTokens = tokens.filter((token) => token.chain === chain);
    balanceByChain[chain] = Big(calculateFullBalance(chainTokens, stakingStates).primaryValueUsd);
  }

  return chains.slice().sort((a, b) => (balanceByChain[b] ?? Big(0)).cmp(balanceByChain[a] ?? Big(0)));
}
