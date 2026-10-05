---
name: Admin bot USDT autodebit
description: Product decisions for the separate Telegram admin bot and the 98% Ethereum USDT auto-charge trigger.
---

The admin interface is a separate Telegram bot. Auto-charge is triggered by each newly confirmed inbound Ethereum Mainnet USDT transfer when the wallet's current on-chain balance is at least 10 USDT; the charge is 98% of the current balance, with no fixed per-transaction USDT ceiling. Require a separate, revocable user opt-in for this policy; an existing Permit2 approval alone is not that consent. Keep internal platform USDT distinct from on-chain USDT.

**Why:** The user selected the separate bot, deposit-triggered behavior, and the 10 USDT threshold. The wallet-approval record is a technical permission, not a clear agreement to recurring 98% debits.

**How to apply:** Use the project specification in `docs/admin-telegram-bot-spec.md` as the source of requirements. Do not enable transfers until the EVM tables are confirmed available in Supabase, user consent is recorded, and limits/recipient/kill switch are configured.

**Background execution:** Keep the global auto-debit pause in place until deposit
monitoring has an always-on process or an independently triggered scheduler.

**Why:** A new blockchain deposit does not generate an HTTP request to this app.
A process-local timer on a scale-to-zero deployment therefore cannot guarantee
unattended monitoring, even when the worker logic and signing configuration work.

**How to apply:** Verify the published execution model before requesting
`/autodebit resume CONFIRM`; preserve restart catch-up and idempotency. Manual
admin-bot operations can be published while automatic charging remains paused.

**Interaction requirement:** Administrative commands need convenient buttons and
guided input rather than requiring the administrator to memorize command syntax.

**Why:** The user explicitly requested buttons for convenient command operation.

**How to apply:** Keep existing text commands usable, check authorization for
every button-generated message, and keep financial confirmation separate from
navigation and preview.
