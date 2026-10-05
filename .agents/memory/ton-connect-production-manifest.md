---
name: TON Connect production manifest host
description: Production manifest hosting and displayed dApp URL are currently different concerns.
---

As of 2026-10-02, the verified Replit production primary URL is `https://mytonwallet-Kazercx.replit.app`, and `/tonconnect-manifest.json` is served there. Keep the manifest's `url` aligned with the active deployment; its `name` is the separate display label.

The TON Connect UI uses the public wallet registry by default. It currently distinguishes Gram Wallet (`app_name: gramwallet`, universal URL `https://connect.gramwallet.io`) from legacy My Wallet (`app_name: mytonwallet`, universal URL `https://connect.mytonwallet.org`). The app's Telegram `returnStrategy` is separate and is built from `BOT_USERNAME`.

**Why:** The previous host note was stale. A wallet-specific link comes from the selected registry entry, while a failed return to Telegram comes from the dApp's bot return URL; confusing them leads to changing the wrong setting.

**How to apply:** Verify the current deployment URL and manifest over HTTPS before editing identity metadata. Do not replace registry URLs globally; require the active Telegram bot username before changing the return target, and only force one wallet if that product restriction is intended.