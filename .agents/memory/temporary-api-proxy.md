---
name: Temporary API proxy
description: The current production test path fronts original My Wallet central services through the branded API hostname.
---

The branded API hostname is currently a compatibility proxy, not an independent wallet backend. It preserves the existing frontend contracts while routing central and portfolio API calls to the original My Wallet services; the static hostname also falls back to the original asset CDN. The Telegram internal-account API is same-origin on the published app, so a production frontend must not assume an unimplemented `/internal-ton` mount.

**Why:** This lets the finished frontend be tested in production without rewriting wallet mechanics, while keeping the browser-facing origin under the MyTonWallet domain.

**How to apply:** Keep browser calls to central, portfolio, chain data, and the internal Telegram account API on owned same-origin proxy paths. Treat this as a temporary migration mode. Do not describe the project as fully self-hosted until these services are replaced or explicitly retired.