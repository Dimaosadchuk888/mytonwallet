---
name: Preview browser fallback
description: Running isolated Playwright previews when the project-local browser bundle is unavailable.
---

When Playwright cannot find its downloaded browser, run the isolated preview with the managed Chromium executable at `/repl/tools/bin/chromium` and `--no-sandbox`.

**Why:** The project can have the Playwright package installed while its browser cache is absent, so a normal `chromium.launch()` fails before the preview starts.

**How to apply:** Keep the browser override local to the preview script; do not add browser binaries or change the application's runtime configuration just to capture a screenshot.