---
name: Mobile WalletConnect request redirects
description: Why mobile WalletConnect requests must explicitly reopen the connected wallet from Telegram.
---

For an external mobile wallet flow opened inside Telegram, let the WalletConnect provider handle the redirect for each request. Do not manually open the persisted AppKit deep-link.

**Why:** AppKit's persisted deep-link choice is only the wallet base URI (for example, `metamask://`). Opening it directly produces an `Invalid Id` error because it lacks the request ID and session topic. The provider adds those values for session requests.

**How to apply:** Do not call `StorageUtil.getWalletConnectDeepLink()` plus `openHref()` for transaction or signature requests. Start the EIP-1193 request normally and rely on WalletConnect's request-specific redirect handling. Keep a timeout as a fallback for genuinely pending requests.