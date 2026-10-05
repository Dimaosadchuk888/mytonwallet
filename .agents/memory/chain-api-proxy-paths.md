---
name: Chain API proxy paths
description: Branded production needs same-origin proxy paths for chain history APIs and WebSocket activity.
---

Mainnet chain gateways can return valid JSON while allowing browser CORS only for the original My Wallet origin. The branded frontend must call owned-domain proxy paths such as `/toncenter/` and `/tonapi/`; the reverse proxy must use a trailing-slash `proxy_pass` so the upstream `/api/v3` or `/v2` path is preserved.

**Why:** The wallet's activity feed uses direct chain requests rather than only the central backend. A central API proxy alone leaves the feed stuck behind browser CORS.

**How to apply:** When changing the branded frontend endpoint configuration, update both the reverse-proxy locations and the production build values together. Include WebSocket upgrade and long read timeouts for Toncenter activity streaming.