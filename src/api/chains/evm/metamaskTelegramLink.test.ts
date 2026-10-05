import { getTelegramMetaMaskLink } from './metamaskTelegramLink';
import { getMetaMaskRequestFromFragment } from './metamaskTelegramLink';

describe('MetaMask launcher handoff for Telegram', () => {
  const nativeLink = 'metamask://connect/mwp?p=encoded%2Bpayload%2Fwith%3Dpadding&c=1';

  it('uses a same-origin HTTPS launcher and keeps the native SDK request entirely in the fragment', () => {
    const result = getTelegramMetaMaskLink(nativeLink, 'https://wallet.example');
    const url = new URL(result);
    expect(url.origin).toBe('https://wallet.example');
    expect(url.pathname).toBe('/metamask-connect.html');
    expect(url.search).toBe('');
    expect(getMetaMaskRequestFromFragment(url.hash)).toBe(nativeLink);
  });

  it('allows only same-origin HTTP on local development hosts', () => {
    expect(new URL(getTelegramMetaMaskLink(nativeLink, 'http://127.0.0.1:5000')).origin)
      .toBe('http://127.0.0.1:5000');
    expect(() => getTelegramMetaMaskLink(nativeLink, 'http://preview.example'))
      .toThrow('secure application origin');
  });

  it('rejects corrupt, legacy, or unsupported requests before opening the launcher', () => {
    expect(() => getMetaMaskRequestFromFragment('#https%3A%2F%2Fmetamask.app.link%2Fconnect'))
      .toThrow('Invalid MetaMask connection link');
    expect(() => getMetaMaskRequestFromFragment('#%'))
      .toThrow('Invalid MetaMask connection link');
    const duplicateSensitiveParameter = 'metamask://connect/mwp?p=x&c=1&channelId=private';
    expect(() => getMetaMaskRequestFromFragment(`#${encodeURIComponent(duplicateSensitiveParameter)}`))
      .toThrow('Invalid MetaMask connection link');
  });

  it.each([
    'metamask://different-host/mwp?p=test',
    'metamask://connect/mwp?p=test&c=0',
    'metamask://connect/mwp?p=test&c=1&returnTo=wallet',
    'metamask://user:password@connect/mwp?p=test&c=1',
    'javascript:alert(1)',
    'https://metamask.app.link/connect/mwp?p=test&c=1',
  ])('rejects an unsupported SDK handoff: %s', (link) => {
    expect(() => getTelegramMetaMaskLink(link, 'https://wallet.example'))
      .toThrow('Unsupported MetaMask connection link format');
  });
});
