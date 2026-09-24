---
name: VPS frontend rebuilds
description: Environment-specific guidance for rebuilding the frontend on the production VPS.
---

The production VPS retains the frontend source and a working dependency tree, while a fresh workspace install can be blocked by Replit’s package firewall on old transitive packages. For a small frontend-only release, copy the changed source into the VPS release and build there rather than changing dependency versions just to make local verification pass.

**Why:** The locked workspace install was blocked by the security policy, but the VPS already had the exact toolchain used for the previous production build.

**How to apply:** Build from the real release directory, not a symlink copied with `cp -a`; webpack also requires that release’s Git directory to be marked as a safe directory when ownership differs.