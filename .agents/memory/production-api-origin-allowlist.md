---
name: Production API origin allowlist
description: Browser communication requires matching backend CORS and frontend CSP origin allowlists.
---

Browser API access requires both directions of the origin policy to agree: the backend must allow the branded frontend through CORS, and the frontend's `connect-src` CSP must allow the production API origin. Either omission blocks the request before application logic can complete.

**Why:** A static frontend cannot override the browser `Origin` header, and CSP can block `fetch` before it reaches Nginx. Successful direct `curl` checks do not prove browser access. This previously left Telegram registration tables empty even though the backend and Supabase were healthy.

**How to apply:** For every production API origin used by browser code, include its origin in the generated CSP and allow the frontend origin in backend CORS/credentials settings. For Replit Preview, use a fixed-host same-origin proxy rather than weakening the production allowlist. Verify the generated live HTML CSP, the actual browser request, and the backend access log. Never solve this by exposing provider credentials in the browser.