---
name: External wallet session boundary
description: The security distinction between an EVM wallet transport session and the stored Permit2 authorization.
---

Treat an AppKit/MetaMask connection as a temporary transport only. Disconnecting it does not revoke the USDT approval or Permit2 allowance; backend charging must rely on fresh on-chain checks and an explicit authorization record.

**Why:** The wallet connection can disappear while the blockchain permissions remain active, so session presence is not evidence that an authorization was revoked or that a new connected address is authorized.

**How to apply:** Compare the live connected address with the stored authorization address in UI and action guards; provide a separate revoke path that invalidates both the server record and the on-chain allowance.