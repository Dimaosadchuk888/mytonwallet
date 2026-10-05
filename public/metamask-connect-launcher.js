(() => {
  const maximumLinkLength = 1024 * 1024;
  const openButton = document.getElementById('open-metamask');
  const errorMessage = document.getElementById('invalid-link');

  function getConnectionRequest(fragment) {
    const value = decodeURIComponent(fragment.replace(/^#/, ''));
    const link = new URL(value);
    const params = Array.from(link.searchParams.keys());

    if (
      link.protocol !== 'metamask:'
      || link.hostname !== 'connect'
      || link.pathname !== '/mwp'
      || link.username
      || link.password
      || link.port
      || link.hash
      || !link.searchParams.get('p')
      || link.searchParams.get('c') !== '1'
      || params.length !== 2
      || new Set(params).size !== 2
      || !params.includes('p')
      || !params.includes('c')
      || value.length > maximumLinkLength
    ) {
      throw new Error('Invalid MetaMask connection link');
    }

    return value;
  }

  let connectionRequest;
  try {
    if (!window.isSecureContext) throw new Error('A secure connection is required');
    connectionRequest = getConnectionRequest(window.location.hash);
  } catch {
    window.history.replaceState(window.history.state, '', `${window.location.pathname}${window.location.search}`);
    errorMessage.hidden = false;
  }

  if (!connectionRequest) return;

  // Remove the connection payload from the address bar and browser history; keep it only in memory.
  window.history.replaceState(window.history.state, '', `${window.location.pathname}${window.location.search}`);
  openButton.hidden = false;
  openButton.addEventListener('click', () => {
    openButton.disabled = true;
    window.location.href = connectionRequest;
  }, { once: true });
})();