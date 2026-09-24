---
name: Ethereum reward balance
description: Scope and accounting boundary for ETH reward checks
---

ETH reward checks credit an internal platform balance with 18-decimal base units. They do not represent native Ethereum funds, an ERC-20 token balance, or an on-chain payout.

**Why:** The first delivery reuses the existing atomic reward ledger and avoids introducing signer custody, gas funding, nonce management, transaction retries, and payout reconciliation.

**How to apply:** Keep ETH reward balances out of the normal asset list, on-chain asset metadata, swaps, and net-worth calculations. A future payout feature must be designed as a separate durable payout system rather than changing the claim RPC to send funds directly.