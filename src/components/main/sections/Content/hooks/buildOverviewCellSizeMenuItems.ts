import type { OverviewCellSize } from '../../../../../global/types';
import type { DropdownItem } from '../../../../ui/Dropdown';

const SIZE_VALUES: OverviewCellSize[] = ['small', 'medium', 'big'];
const SIZE_LANG_KEY: Record<OverviewCellSize, string> = {
  small: '$overview_cell_size_small',
  medium: '$overview_cell_size_medium',
  big: '$overview_cell_size_big',
};

export default function buildOverviewCellSizeMenuItems<T extends string>(
  currentSize: OverviewCellSize | undefined,
  hiddenCheckClassName?: string,
): DropdownItem<T>[] {
  return SIZE_VALUES.map((size) => ({
    value: size as T,
    name: SIZE_LANG_KEY[size],
    fontIcon: 'check',
    fontIconClassName: currentSize === size ? undefined : hiddenCheckClassName,
  }));
}
