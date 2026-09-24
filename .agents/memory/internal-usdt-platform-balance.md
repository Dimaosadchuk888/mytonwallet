---
name: Internal USDT platform balance
description: Reward USDT is a shared Telegram platform balance, not a blockchain token.
---

Internal USDT must be rendered from the authenticated platform account as a separate balance. It must not be inserted into on-chain token metadata, account balance slugs, swap assets, or net-worth calculations.

**Why:** The reward balance has no blockchain, contract address, transaction history, or network-specific wallet ownership. Treating it as a token would make transfers and portfolio totals incorrect and would duplicate one shared balance across wallets.

**How to apply:** Fetch it through the platform account balance endpoint, show it in platform UI with sensitive-data masking, and keep it independent from blockchain asset selectors and account switching.