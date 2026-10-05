---
name: EVM USDT authorization methods
description: Project policy for new direct USDT authorizations and legacy Permit2 authorizations.
---

New external-wallet links use direct ERC-20 USDT authorization. Existing Permit2 links remain valid and must continue to use the Permit2 charging path. Persist and honor the authorization method; do not infer it from the age or shape of a row.

**Why:** The user requested direct USDT `transferFrom` charging for new authorizations while preserving existing Permit2 authorizations and code.

**How to apply:** Keep the method consistent across wallet linking, database records, on-chain allowance checks, manual charges, and automatic charges. Do not silently switch or remove a legacy Permit2 authorization.