---
name: Reown relay project validity
description: How to distinguish an invalid Reown project from mobile deep-link or session-settlement failures.
---

Treat WalletConnect relay JSON-RPC error code `3000` with message `Project not found` as a project identity or lifecycle failure that occurs before pairing. Do not debug mobile redirects, wallet return, or account subscriptions until the relay accepts the project.

**Why:** AppKit configuration, limits, and origin endpoints can still return successful responses for a project that the relay rejects. In that state, the mobile wallet screen may render, but no usable pairing URI, proposal, session settlement, address, or chain ID can exist.

**How to apply:** Capture the first relay frame without logging the authenticated WebSocket URL. Replace the deployed project ID with an active Reown project, configure every initiating origin, rebuild, then gate further debugging on pairing URI creation and a successful controlled WalletKit approval.