import { getTronClient } from './util/tronweb';
import { getWalletFromPrivateKey } from './auth';

describe('getWalletFromPrivateKey', () => {
  it('produces the generated account address and public key', () => {
    const generatedAccount = getTronClient('mainnet').utils.accounts.generateAccount();

    expect(getWalletFromPrivateKey('mainnet', generatedAccount.privateKey)).toMatchObject({
      address: generatedAccount.address.base58,
      publicKey: generatedAccount.publicKey.toLowerCase(),
    });
  });
});
