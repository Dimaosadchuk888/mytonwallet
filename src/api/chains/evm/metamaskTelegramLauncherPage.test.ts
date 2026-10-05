import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const launcherScript = readFileSync('public/metamask-connect-launcher.js', 'utf8');

function runLauncher(fragment: string, isSecureContext = true) {
  const openButton = {
    hidden: true,
    disabled: false,
    click: undefined as (() => void) | undefined,
    addEventListener: jest.fn((_event, callback: () => void) => {
      openButton.click = callback;
    }),
  };
  const invalidMessage = { hidden: true };
  let cleanedLocation: string | undefined;
  const location = {
    hash: fragment,
    pathname: '/metamask-connect.html',
    search: '',
    href: `https://wallet.example/metamask-connect.html${fragment}`,
  };
  const context = {
    window: {
      isSecureContext,
      location,
      history: {
        state: undefined,
        replaceState: jest.fn((_state, _title, value: string) => {
          cleanedLocation = value;
          location.hash = '';
        }),
      },
    },
    document: {
      getElementById(id: string) {
        return id === 'open-metamask' ? openButton : invalidMessage;
      },
    },
    URL,
  };

  runInNewContext(launcherScript, context);
  return { context, invalidMessage, openButton, cleanedLocation: () => cleanedLocation };
}

describe('standalone MetaMask connection launcher page', () => {
  const nativeRequest = 'metamask://connect/mwp?p=encoded%2Bpayload%2Fwith%3Dpadding&c=1';

  it('hides the fragment from page history and opens only the validated SDK request after a user tap', () => {
    const encodedRequest = encodeURIComponent(nativeRequest);
    const { context, invalidMessage, openButton, cleanedLocation } = runLauncher(`#${encodedRequest}`);

    expect(invalidMessage.hidden).toBe(true);
    expect(openButton.hidden).toBe(false);
    expect(cleanedLocation()).toBe('/metamask-connect.html');
    openButton.click!();
    expect(openButton.disabled).toBe(true);
    expect(context.window.location.href).toBe(nativeRequest);
  });

  it.each(['#https%3A%2F%2Fmetamask.app.link%2Fconnect', '#%'])(
    'does not show the wallet launch button for malformed or legacy links: %s',
    (fragment) => {
      const { invalidMessage, openButton } = runLauncher(fragment);

      expect(invalidMessage.hidden).toBe(false);
      expect(openButton.hidden).toBe(true);
    },
  );

  it('refuses to dispatch a MetaMask deeplink from a non-secure context', () => {
    const { invalidMessage, openButton } = runLauncher(`#${encodeURIComponent(nativeRequest)}`, false);

    expect(invalidMessage.hidden).toBe(false);
    expect(openButton.hidden).toBe(true);
  });
});
