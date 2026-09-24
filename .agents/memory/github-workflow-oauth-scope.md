---
name: GitHub workflow OAuth scope
description: GitHub writes to Actions workflow files may require an OAuth scope beyond repo.
---

GitHub requires the `workflow` OAuth permission to modify Actions workflow files. Replit's documentation says reconnecting the GitHub integration can request additional OAuth scopes, even if `getIntegrationReauthorizationContext` does not list the missing scope.

**Why:** A healthy connection and successful writes to ordinary files do not prove that Actions workflow writes are authorized. A path-specific 404 can indicate the missing workflow permission.

**How to apply:** For a user-approved publish that changes `.github/workflows/*`, explain the permission requirement and use the GitHub reconnect flow once. Then judge access from the fresh API response; if it fails for another reason, diagnose the payload rather than repeatedly reconnecting.