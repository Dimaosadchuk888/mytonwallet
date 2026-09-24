---
name: Supabase ETH rewards
description: Durable storage and claim boundary for internal ETH reward checks.
---

ETH reward checks are stored in Supabase's existing internal_ton_reward_checks table with asset = 'ETH'. ETH balances are stored in internal_evm_balances, and claims must go through internal_ton_claim_reward_v2 so the claim limit, claim record, and balance credit remain atomic.

**Why:** The application server uses Supabase for the internal ledger, while the old standalone Replit PostgreSQL ETH tables were not visible to the active runtime.

**How to apply:** Apply the Supabase ETH runtime migration before creating or claiming ETH checks. Amounts remain bigint base units with 18 decimals; the normal check code still starts with eth_.