---
name: Internal TON database namespace
description: Why internal deposit database objects use a dedicated prefix.
---

Keep every table, index, and RPC for internal TON deposits under the `internal_ton_` prefix.

**Why:** The connected Supabase project already contained generic application objects such as `public.users`; generic migration names could collide with unrelated production data.

**How to apply:** Extend the existing prefixed schema for future internal-balance work. Do not introduce generic table or RPC names in this shared Supabase project.

USDT reward balances remain in a separate `internal_usdt_balances` table rather than adding a currency dimension to the existing TON balance row.

**Why:** The existing TON balance has a unique Telegram-user contract and is consumed as the legacy TON `balance` field; a separate table adds USDT without changing that contract or mixing currencies.

**How to apply:** Add future sponsored reward currencies through their own prefixed balance/RPC path unless the public account API is deliberately versioned.