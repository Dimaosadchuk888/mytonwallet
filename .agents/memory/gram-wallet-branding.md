---
name: Gram Wallet brand boundary
description: Distinguishes the public Gram Wallet brand from legacy technical identities.
---

The public product name is exactly `Gram Wallet` in all user-visible copy and every locale. Do not translate the brand name. Customer-facing EVM dApp metadata uses the production Gram Wallet origin and icon. Legacy `MyTonWallet`, `MyWallet`, and related names may remain in API contracts, protocols, storage keys, authentication identities, and external compatibility selectors; do not change them as part of visual rebranding.

**Why:** Display names have historically been reused as technical identifiers. Changing them can alter API metadata, WebAuthn credential derivation, update artifact names, or compatibility with existing wallet integrations. The EVM wallet metadata origin was explicitly moved to the working production brand domain; that does not authorize changing backend API origins.

**How to apply:** Use the production origin only for customer-facing wallet metadata; keep backend API origins and legacy protocol/storage identities separate. Update visible copy, logos, titles, and translations, and split constants when one value serves both display and protocol consumers.