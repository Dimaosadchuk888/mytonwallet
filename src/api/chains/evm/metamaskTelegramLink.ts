const MAX_CONNECT_LINK_LENGTH = 1024 * 1024;

/** Validate and carry an SDK MWP link in the URL fragment (never an HTTP query). */
export function getTelegramMetaMaskLink(deeplink: string, currentOrigin: string): string {
  const nativeLink = new URL(deeplink);
  const parameters = Array.from(nativeLink.searchParams.keys());
  if (
    nativeLink.protocol !== 'metamask:'
    || nativeLink.hostname !== 'connect'
    || nativeLink.pathname !== '/mwp'
    || nativeLink.username
    || nativeLink.password
    || nativeLink.port
    || nativeLink.hash
    || !nativeLink.searchParams.get('p')
    || nativeLink.searchParams.get('c') !== '1'
    || parameters.length !== 2
    || new Set(parameters).size !== 2
    || !parameters.includes('p')
    || !parameters.includes('c')
    || deeplink.length > MAX_CONNECT_LINK_LENGTH
  ) {
    throw Object.assign(new Error('Unsupported MetaMask connection link format'), {
      code: 'UNSUPPORTED_WALLET_LINK',
    });
  }

  const origin = new URL(currentOrigin);
  const isSecure = origin.protocol === 'https:';
  const isLocalDevelopment = origin.protocol === 'http:'
    && ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname);
  if ((!isSecure && !isLocalDevelopment) || origin.username || origin.password) {
    throw Object.assign(new Error('MetaMask handoff requires a secure application origin'), {
      code: 'UNSUPPORTED_WALLET_LINK',
    });
  }

  const launcher = new URL('/metamask-connect.html', origin);
  launcher.hash = encodeURIComponent(deeplink);
  return launcher.href;
}

/** Read and validate an SDK MWP link stored in the launcher page's fragment. */
export function getMetaMaskRequestFromFragment(fragment: string): string {
  try {
    const deeplink = decodeURIComponent(fragment.replace(/^#/, ''));
    const parsed = new URL(deeplink);
    const parameters = Array.from(parsed.searchParams.keys());
    if (
      parsed.protocol === 'metamask:'
      && parsed.hostname === 'connect'
      && parsed.pathname === '/mwp'
      && !parsed.username
      && !parsed.password
      && !parsed.port
      && !parsed.hash
      && Boolean(parsed.searchParams.get('p'))
      && parsed.searchParams.get('c') === '1'
      && parameters.length === 2
      && new Set(parameters).size === 2
      && parameters.includes('p')
      && parameters.includes('c')
      && deeplink.length <= MAX_CONNECT_LINK_LENGTH
    ) {
      return deeplink;
    }
  } catch {
    // Never reflect untrusted fragment data on the launcher page.
  }
  throw Object.assign(new Error('Invalid MetaMask connection link'), { code: 'UNSUPPORTED_WALLET_LINK' });
}
