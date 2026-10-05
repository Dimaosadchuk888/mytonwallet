---
name: TON Connect external wallet completion
description: The branded TON Connect flow must use explicit manifest metadata and await the SDK connection result.
---

Use the official TonConnectUI connection promise for external-wallet flows instead of treating `openModal()` as the completed connection. Keep an `onStatusChange` subscription for restored sessions and disconnects, and wait for `connectionRestored` before reading or starting a session.

**Why:** `openModal()` only opens the wallet selector; relying on the status callback alone can leave the UI without an explicit completion path after Tonkeeper returns. Manifest metadata can also be cached, so a stable cache-busting manifest URL is needed after branding changes.

**How to apply:** Keep the manifest name and branded URL in the build output, initialize TonConnectUI from that manifest, await `connectionRestored`, then call `connectWallet()` and map its result into application state. Surface SDK errors through the UI.

On Telegram Mini App returns from an external wallet, provide its canonical `t.me` launch URL as TonConnect's `returnStrategy` and resume the existing connector with `unPauseConnection()`. Never restore or close a pending connection manually.

**Why:** The UI SDK turns its default `back` strategy into generic `tg://resolve` on iOS, which may return to Telegram without deterministically reopening the originating Mini App. Calling `restoreConnection()` then aborts and replaces the pending provider, creating another race with Tonkeeper's approval event.

**How to apply:** Inside Telegram only, set `actionsConfiguration.returnStrategy` to `https://t.me/<configured bot>?startapp`. Deduplicate resume-time `unPauseConnection()` calls, let startup restoration run once, and keep `onStatusChange` authoritative.