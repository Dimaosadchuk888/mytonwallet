---
name: TON Connect production manifest host
description: Production manifest hosting and displayed dApp URL are currently different concerns.
---

The TON Connect manifest identity should use the canonical HTTPS app host `https://mytonwallet.replit.app`; keep the served manifest and its declared `url` aligned to avoid Tonkeeper showing a different domain.

**Why:** TON Connect fetches the manifest from the URL passed to the SDK, while Tonkeeper displays the manifest's `url` field as the dApp identity. A stale `url` makes the wallet show the wrong domain even when the connection flow is otherwise current.

**How to apply:** Keep the manifest fetch origin and declared identity explicit, and verify the canonical host serves `/tonconnect-manifest.json` over HTTPS before testing wallet metadata.