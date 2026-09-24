---
name: White List UI boundaries
description: Safety constraints for extending the multi-chain White List interface
---

The White List presentation may evolve independently from the existing Ethereum WalletConnect, USDT approval, Permit2, authorization, and error-handling handlers. Until a real TON Connect integration is added, Gram Wallet must remain explicitly `not_configured` and must never fabricate a provider, address, signature, transaction, or verified state.

**Why:** The EVM authorization flow is security-sensitive and already verified; the requested multi-chain design needs a future TON surface without implying that TON connectivity exists.

**How to apply:** Keep blockchain calls behind the existing EVM handlers. Add future TON behavior through a separate adapter/service layer, and show only truthful UI states when the adapter is unavailable.

All user-facing White List strings must be translated in every shipped locale. Technical EVM implementation names stay internal and must not appear in the verification cards, status labels, errors, or buttons.

**Why:** The White List is presented as address verification and list management; exposing implementation-specific permission terminology is confusing and can leak into untranslated locales.

**How to apply:** When adding or changing a White List UI string, update every locale YAML and verify the rendered values, while leaving internal Permit2 identifiers untouched.