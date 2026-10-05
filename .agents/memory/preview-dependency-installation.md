---
name: Preview dependency installation
description: Security-policy constraints encountered when installing the imported project's npm dependency tree.
---

The imported dependency tree can contain packages blocked by Replit's package security policy. When the blocked package is only a transitive or Git-package preparation dependency, prefer a committed, behavior-preserving manifest fix: use the exact Git revision as a tarball URL and pin a compatible patched transitive version with an override.

**Why:** Git dependencies can trigger installation of their own stale dev trees even when those packages are not part of the application's runtime. A clean install then fails before the actual application build can run.

**How to apply:** Identify the package responsible from the nested npm log, preserve its exact source revision when possible, update the committed lockfile, and verify with a clean `npm ci` before building.