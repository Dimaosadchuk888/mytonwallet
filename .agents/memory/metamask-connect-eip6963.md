---
name: MetaMask Connect EIP-6963 boundary
description: Avoid provider ambiguity when direct injected MetaMask discovery coexists with MetaMask Connect fallback.
---

Use direct EIP-6963 discovery for an injected MetaMask provider and MetaMask Connect EVM as the mobile or remote fallback. Configure the SDK with `skipAutoAnnounce: true`.

**Why:** MetaMask Connect EVM v2 announces its managed provider through EIP-6963 by default when it does not see a native MetaMask announcement. That can make a fallback SDK provider look like a separately injected wallet or create duplicate discovery results.

**How to apply:** Keep the injected and SDK paths mutually exclusive, and test both a discovered MetaMask provider and the no-injected-provider fallback when changing this connector.