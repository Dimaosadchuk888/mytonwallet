---
name: Ethereum USDT Permit2 architecture
description: The recurring-deduction path selected for Ethereum mainnet USDT.
---

Use canonical Uniswap Permit2 `AllowanceTransfer` for Ethereum mainnet USDT.
Native EIP-2612 `permit` is unavailable on the selected USDT contract, and a
custom payment contract is out of scope for the current phase. The current
phase intentionally uses maximum protocol permission values and no business
spending caps; limits are a separate follow-up.

**Why:** The existing wallet can sign the initial ERC-20 approval and EIP-712
permission with the current ethers/local-key flow, while Permit2 supports
recurring permissions without deploying a new Solidity contract.

**How to apply:** Require the initial `USDT.approve(Permit2, max)` transaction,
then use Permit2 `AllowanceTransfer` with explicit unlimited-access disclosure.
Keep the operator key out of the client and do not treat Permit2 as a substitute
for recipient routing, identity linking, charge records, or later safety limits.