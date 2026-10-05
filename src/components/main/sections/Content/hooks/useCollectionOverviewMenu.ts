import { useMemo } from '../../../../../lib/teact/teact';
import { getActions } from '../../../../../global';

import type { ApiNftCollection } from '../../../../../api/types';
import type { OverviewCellSize } from '../../../../../global/types';
import type { DropdownItem } from '../../../../ui/Dropdown';

import buildOverviewCellSizeMenuItems from './buildOverviewCellSizeMenuItems';

import useLastCallback from '../../../../../hooks/useLastCallback';

export type CollectionMenuHandler = OverviewCellSize | 'hide' | 'showAssets' | 'showCollectibles';

export default function useCollectionOverviewMenu({
  overviewCellSize,
  canHide,
  isAssetCellVisible,
  isCollectibleCellVisible,
  hiddenCheckClassName,
}: {
  overviewCellSize?: OverviewCellSize;
  canHide: boolean;
  isAssetCellVisible: boolean;
  isCollectibleCellVisible: boolean;
  hiddenCheckClassName?: string;
}) {
  const {
    setOverviewCellSize, removeCollectionTab, setAreAssetsHidden, setAreCollectiblesHidden,
  } = getActions();

  const menuItems = useMemo<DropdownItem<CollectionMenuHandler>[]>(() => {
    const items: DropdownItem<CollectionMenuHandler>[] = [
      ...buildOverviewCellSizeMenuItems<CollectionMenuHandler>(overviewCellSize, hiddenCheckClassName),
      {
        value: 'hide',
        name: 'Hide Tab',
        fontIcon: 'eye-closed',
        isDisabled: !canHide,
        withDelimiter: true,
      },
    ];

    if (!isAssetCellVisible) {
      items.push({
        value: 'showAssets',
        name: 'Show Assets',
        fontIcon: 'eye',
      });
    }

    if (!isCollectibleCellVisible) {
      items.push({
        value: 'showCollectibles',
        name: 'Show Collectibles',
        fontIcon: 'eye',
      });
    }
    return items;
  }, [overviewCellSize, canHide, isAssetCellVisible, isCollectibleCellVisible, hiddenCheckClassName]);

  const handleMenuItemSelect = useLastCallback((
    value: CollectionMenuHandler,
    collection: ApiNftCollection,
  ) => {
    switch (value) {
      case 'small':
      case 'medium':
      case 'big':
        setOverviewCellSize({ size: value });
        break;
      case 'hide':
        removeCollectionTab({ collection });
        break;
      case 'showAssets':
        setAreAssetsHidden({ isHidden: false });
        break;
      case 'showCollectibles':
        setAreCollectiblesHidden({ isHidden: false });
        break;
    }
  });

  return { menuItems, handleMenuItemSelect };
}
