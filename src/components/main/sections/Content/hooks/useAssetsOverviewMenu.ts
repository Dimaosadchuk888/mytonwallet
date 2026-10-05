import { useMemo } from '../../../../../lib/teact/teact';
import { getActions } from '../../../../../global';

import type { OverviewCellSize } from '../../../../../global/types';
import type { DropdownItem } from '../../../../ui/Dropdown';
import { SettingsState } from '../../../../../global/types';

import buildOverviewCellSizeMenuItems from './buildOverviewCellSizeMenuItems';

import useLastCallback from '../../../../../hooks/useLastCallback';

export type AssetsMenuHandler =
  | OverviewCellSize
  | 'addToken'
  | 'manageAssets'
  | 'showCollectibles'
  | 'hide';

export default function useAssetsOverviewMenu({
  overviewCellSize,
  isCollectibleCellVisible,
  canHide,
  hiddenCheckClassName,
}: {
  overviewCellSize?: OverviewCellSize;
  isCollectibleCellVisible: boolean;
  canHide: boolean;
  hiddenCheckClassName?: string;
}) {
  const {
    setOverviewCellSize, openSettingsWithState, setAreCollectiblesHidden, setAreAssetsHidden,
  } = getActions();

  const menuItems = useMemo<DropdownItem<AssetsMenuHandler>[]>(() => {
    const items: DropdownItem<AssetsMenuHandler>[] = [
      ...buildOverviewCellSizeMenuItems<AssetsMenuHandler>(overviewCellSize, hiddenCheckClassName),
      {
        value: 'addToken',
        name: 'Add Token',
        fontIcon: 'menu-plus',
        withDelimiter: true,
      },
      {
        value: 'manageAssets',
        name: 'Manage Assets',
        fontIcon: 'menu-params',
      },
    ];

    if (!isCollectibleCellVisible) {
      items.push({
        value: 'showCollectibles',
        name: 'Show Collectibles',
        fontIcon: 'eye',
        withDelimiter: true,
      });
    }

    if (canHide) {
      items.push({
        value: 'hide',
        name: 'Hide Tab',
        fontIcon: 'eye-closed',
        withDelimiter: isCollectibleCellVisible,
      });
    }

    return items;
  }, [overviewCellSize, isCollectibleCellVisible, canHide, hiddenCheckClassName]);

  const handleMenuItemSelect = useLastCallback((value: AssetsMenuHandler) => {
    switch (value) {
      case 'small':
      case 'medium':
      case 'big':
        setOverviewCellSize({ size: value });
        break;
      case 'addToken':
        openSettingsWithState({ state: SettingsState.SelectTokenList });
        break;
      case 'manageAssets':
        openSettingsWithState({ state: SettingsState.Assets });
        break;
      case 'showCollectibles':
        setAreCollectiblesHidden({ isHidden: false });
        break;
      case 'hide':
        setAreAssetsHidden({ isHidden: true });
        break;
    }
  });

  return { menuItems, handleMenuItemSelect };
}
