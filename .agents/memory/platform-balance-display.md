---
name: Platform balance display
description: How internal database balances are shown alongside real on-chain token data.
---

Internal TON and ETH balances from the platform account should replace the displayed amount in the native asset row and token detail balance, while the underlying UserToken amount remains unchanged for on-chain operations.

**Why:** The overview total can include database balances while the asset list and detail page otherwise show zero from the on-chain wallet, which makes the same account appear inconsistent across screens.

**How to apply:** Use the platform balance only at display boundaries for native TON/ETH tokens; do not mutate global token balances or use internal amounts as send, swap, or transaction inputs.