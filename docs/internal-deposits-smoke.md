# Internal deposits smoke test

1. Apply the Supabase migrations and configure the server-only Telegram,
   session, Supabase, and provider variables in `.env`.
2. Enable a monitor only after setting its provider URL and token/mint
   contract allowlist. Start the server and authenticate through Telegram.
3. `GET /api/account` must return exactly four network intents and the
   configured public destination/asset metadata.
4. Send a test asset to the displayed destination (including the TON
   reference where applicable), then wait for finality. `GET
   /api/account/deposits` must show one confirmed row and `/api/balance` must
   increase by its raw amount.
5. Re-run the monitor and submit the same hash through
   `POST /api/account/deposits/claim` with `{ "chain": "...",
   "transactionHash": "..." }`. It must not increase the balance twice.
6. Submit a hash from another intent and failed, pending, wrong-token, wrong
   recipient, or insufficient-finality fixtures; each remains rejected or
   pending and never changes a balance. Claims are throttled persistently in
   `internal_deposit_claims` (ten attempts per user per hour).
