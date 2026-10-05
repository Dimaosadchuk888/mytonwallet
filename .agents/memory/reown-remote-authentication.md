---
name: Reown remote authentication
description: AppKit project-level remote feature flags can enable connection-time SIWX/Auth unexpectedly.
---

Reown AppKit can enable Reown Authentication from project-level remote features. This can cause a WalletConnect connection to request `personal_sign` even when the dapp passes no `siwx` or `siweConfig`.

**Why:** The project-level feature flag is checked alongside local options, so a transport-only external-wallet connector may unexpectedly show MetaMask's “needs to connect to your wallet” signing screen.

**How to apply:** For connectors that must establish a transport-only session, clear `OptionsController.setSIWX(undefined)` after `appKit.ready()` and keep authorization signatures in the explicit application flow.