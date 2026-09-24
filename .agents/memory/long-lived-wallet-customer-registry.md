---
name: Long-lived wallet customer registry
description: Product decision for retaining customer wallet relationships beyond individual provider sessions.
---

The customer registry and wallet authorization history should be long-lived. Do not delete a customer relationship merely because a MetaMask or WalletConnect transport session expires; keep the record and mark the transport as stale or reconnect-required.

**Why:** The product needs an ongoing customer base, while provider sessions are temporary and controlled by WalletConnect, MetaMask, browser storage, and the user.

**How to apply:** Remove application-level cleanup TTLs for relationship metadata where policy permits, but keep protocol expiry, explicit user disconnect, on-chain revoke/expiration, request expiry, and user confirmation requirements intact.