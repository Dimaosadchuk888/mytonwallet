---
name: Telegram preview authentication
description: Telegram-mode builds can render in Replit Preview, but Preview does not provide real Telegram initData for platform-account authentication.
---

Telegram-mode builds require an actual Telegram Mini App launch to receive `initData` and load internal balances. Replit Preview can verify the build and UI shell, but it cannot prove the authenticated platform-balance flow without a Telegram session.

**Why:** Enabling `IS_TELEGRAM_APP=1` changes the frontend build mode but does not manufacture Telegram identity data.

**How to apply:** Use the Preview for build/boot checks; verify internal balances by opening the deployed Telegram Mini App through the configured bot.