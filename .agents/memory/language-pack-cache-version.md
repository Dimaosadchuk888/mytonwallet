---
name: Language-pack cache version
description: Prevent stale locale caches from falling back to default English after translation updates.
---

When shipped locale YAML files change, increment `LANG_CACHE_NAME` so existing clients fetch a fresh language pack.

**Why:** the language provider caches whole packs by version and silently uses English for missing keys in an outdated pack, making correct YAML translations appear ineffective.

**How to apply:** include a cache-version bump with locale updates and verify the generated locale JSON files in the build.