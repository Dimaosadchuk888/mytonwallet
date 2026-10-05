---
name: EVM authorization registry
description: Security boundary for linking external Ethereum wallets and manually charging USDT.
---

External Ethereum wallet linking requires both fresh on-chain Permit2 state and a one-time wallet signature challenge tied to the Telegram session.

**Why:** On-chain allowance and transaction hashes are public, so state-only registration would let another Telegram user claim someone else's address.

**How to apply:** Keep owner addresses unique across Telegram users, re-check Ethereum Mainnet state before every charge, and keep manual charges disabled unless the operator key, limits, and recipient allowlist are configured.