---
name: Replit preview WebSockets
description: The dev-server WebSocket behavior required by Replit's HTTPS preview proxy.
---

Replit's proxied preview is HTTPS even when the local webpack dev server runs over HTTP. Webpack dev-server must derive its client WebSocket URL from the preview page (`auto://0.0.0.0:0/ws`) or the browser rejects the default insecure `ws://` connection.

**Why:** The default local socket URL caused an unhandled `Operation is insecure` browser error while the server and bundle were otherwise healthy.

**How to apply:** Keep the automatic WebSocket URL in the main webpack dev-server configuration for Replit preview workflows.