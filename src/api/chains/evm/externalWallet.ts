import { type AppKit, createAppKit } from '@reown/appkit';
import { mainnet } from '@reown/appkit/networks';
import { EthersAdapter } from '@reown/appkit-adapter-ethers';
import { OptionsController } from '@reown/appkit-controllers';
import type { Eip1193Provider } from 'ethers';

import {
  EXTERNAL_EVM_WALLET_METADATA_ICON_URL,
  EXTERNAL_EVM_WALLET_METADATA_NAME,
  EXTERNAL_EVM_WALLET_METADATA_URL,
  WALLET_CONNECT_PROJECT_ID,
} from '../../../config';
import { getTranslation } from '../../../util/langProvider';

export { mainnet as EXTERNAL_EVM_MAINNET };

const METAMASK_WALLET_ID = 'c57ca95b47569778a828d19178114f4db188b89b763c899ba0be274e97267d96';

export type ExternalEvmWalletState = {
  address?: string;
  chainId?: number;
  isConnected: boolean;
  provider?: Eip1193Provider;
};

let appKit: AppKit | undefined;

export function getExternalEvmAppKit() {
  if (!appKit) {
    if (!WALLET_CONNECT_PROJECT_ID) {
      throw new Error('Reown WalletConnect project ID is not configured');
    }

    appKit = createAppKit({
      adapters: [new EthersAdapter()],
      networks: [mainnet],
      defaultNetwork: mainnet,
      projectId: WALLET_CONNECT_PROJECT_ID,
      metadata: {
        name: EXTERNAL_EVM_WALLET_METADATA_NAME,
        description: getTranslation('Connect an external Ethereum wallet'),
        url: EXTERNAL_EVM_WALLET_METADATA_URL,
        icons: [EXTERNAL_EVM_WALLET_METADATA_ICON_URL],
      },
      features: {
        email: false,
        socials: false,
        reownAuthentication: false,
      },
      featuredWalletIds: [METAMASK_WALLET_ID],
      allWallets: 'SHOW',
      enableEIP6963: true,
      themeMode: 'light',
    });

    // The project-level remote feature flag can enable Reown Authentication
    // even when this dapp does not configure SIWX. This EVM connection is
    // intentionally transport-only; authorization happens in the whitelist
    // flow after the connection is established.
    void appKit.ready().then(() => {
      OptionsController.setSIWX(undefined);
    });
  }

  return appKit;
}

export function getExternalEvmWalletState(): ExternalEvmWalletState {
  const kit = getExternalEvmAppKit();
  const account = kit.getAccount('eip155');
  const chainId = kit.getChainId();

  return {
    address: account?.address,
    chainId: chainId === undefined ? undefined : Number(chainId),
    isConnected: Boolean(account?.isConnected && account.address),
    provider: kit.getWalletProvider() as Eip1193Provider | undefined,
  };
}

export function subscribeExternalEvmWallet(
  callback: (state: ExternalEvmWalletState) => void,
): () => void {
  const kit = getExternalEvmAppKit();
  const update = () => callback(getExternalEvmWalletState());

  const unsubscribeAccount = kit.subscribeAccount(update, 'eip155');
  const unsubscribeNetwork = kit.subscribeNetwork(update);
  const unsubscribeProvider = kit.subscribeProviders(update);

  update();

  return () => {
    unsubscribeAccount();
    unsubscribeNetwork();
    unsubscribeProvider();
  };
}
