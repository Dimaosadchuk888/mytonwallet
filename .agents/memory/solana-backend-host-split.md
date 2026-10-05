---
name: Solana backend host split
description: The Solana API DNS endpoint and the server currently reachable by SSH are different infrastructure.
---

`solanaapi.mytonwallet.org` currently resolves to `5.39.219.76`, while the SSH-accessible server `213.210.20.97` is a separate host with unrelated Nginx services. Do not change the latter expecting to modify the live Solana proxy.

**Why:** A public-key login succeeded on `213.210.20.97`, but its Nginx configuration did not contain the Solana/MyTonWallet proxy; the live endpoint on `5.39.219.76` continued serving the old CORS origin.

**How to apply:** For Solana backend changes, obtain access to `5.39.219.76` or deliberately deploy a replacement proxy and update DNS/configuration as a separate migration.