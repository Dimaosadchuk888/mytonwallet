// Set text direction before first paint to avoid an RTL/LTR flash
// CSP forbids inline scripts, so this runs from an external 'self' file loaded in <head>
(function setInitialDirection() {
  var RTL_LANG_CODES = ['ar', 'fa']; // mirrors the `rtl: true` entries of LANG_LIST

  var langCode;
  // The build injects the exact, flavor-specific cache key (Gram/Explorer)
  var exactKey = document.documentElement.getAttribute('data-global-state-key');
  if (exactKey) {
    try {
      var state = JSON.parse(localStorage.getItem(exactKey));
      langCode = state && state.settings && state.settings.langCode;
    } catch (err) {
      // Ignore a corrupted or inaccessible cache and fall back to the UA language
    }
  }

  if (!langCode) {
    langCode = navigator.language || 'en';
  }

  var isRtl = RTL_LANG_CODES.indexOf(langCode.slice(0, 2).toLowerCase()) !== -1;
  var el = document.documentElement;
  el.lang = langCode;
  el.dir = isRtl ? 'rtl' : 'ltr';
})();

// Keep the already-built static bundle aligned with the current support username until the next full build.
(function updateSupportLinks() {
  var oldSupportUrl = 'https://t.me/mysupport';
  var newSupportUrl = 'https://t.me/TonWalletSupport';

  function replaceSupportText(node) {
    node.childNodes.forEach(function(child) {
      if (child.nodeType === Node.TEXT_NODE) {
        child.nodeValue = child.nodeValue.replace(/@mysupport/g, '@TonWalletSupport');
      } else if (child.nodeType === Node.ELEMENT_NODE) {
        replaceSupportText(child);
      }
    });
  }

  function update() {
    document.querySelectorAll('a[href="' + oldSupportUrl + '"]').forEach(function(link) {
      link.setAttribute('href', newSupportUrl);
      replaceSupportText(link);
    });
  }

  update();
  new MutationObserver(update).observe(document.documentElement, { childList: true, subtree: true });
})();

var APP_RENDERED_TIMEOUT = 5000;

function checkAppRendered() {
  if (document.documentElement.className.indexOf('is-rendered') !== -1) return;

  var messageEl = document.createElement('div');
  messageEl.className = 'browser-update-message';

  var text = 'It looks like your browser is outdated. \nTry to update it.';
  if (window.navigator.userAgent.includes('Android')) {
    text = 'It looks like your browser is outdated. \nPlease update Google Chrome and Android WebView apps.';
  }
  messageEl.textContent = text;

  document.body.appendChild(messageEl);
}

window.setTimeout(checkAppRendered, APP_RENDERED_TIMEOUT);
