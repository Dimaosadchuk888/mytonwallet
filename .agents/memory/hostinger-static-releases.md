---
name: Hostinger static releases
description: Reliable fallback for publishing the production TMA bundle to Hostinger.
---

The live `mytonwallet.shop` frontend is served by Nginx from a versioned release behind the VPS `current` symlink. Build in a physical release directory with the retained dependency tree, verify `dist`, then switch the symlink atomically and reload Nginx.

**Why:** Hostinger shared-hosting API deployment can accept an archive successfully without changing the live domain because DNS points at the VPS. The VPS retains the compatible dependency tree when clean installation is blocked.

**How to apply:** Create a new VPS release, build from that real directory, confirm the expected hashed bundle and feature marker, switch `current`, run `nginx -t`, reload Nginx, and verify the live hash plus backend CORS. Keep the prior release for rollback.