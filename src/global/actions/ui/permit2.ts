import { addActionHandler } from '../../index';
import { updateCurrentAccountState } from '../../reducers';

addActionHandler('setEvmWhitelist', (global, actions, { authorization }) => {
  return updateCurrentAccountState(global, { evmWhitelist: authorization });
});
