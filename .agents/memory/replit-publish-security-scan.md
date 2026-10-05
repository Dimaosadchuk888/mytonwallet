---
name: Replit publish security scan
description: Replit publication scans repository dependency lockfiles beyond the web build and can block on Android Gradle transitive vulnerabilities.
---

Replit's publish Security Scan can block an otherwise successful web build because it inspects committed Android Gradle lockfiles. Affected transitive versions may come from Gradle's internal test-platform configurations rather than the web runtime.

**Why:** A web publication was stopped before promotion by critical findings in `mobile/android/app/gradle.lockfile` and the WalletCore lockfile, even though the configured build only runs webpack and the Node server.

**How to apply:** When publish reports Java/Android CVEs, inspect all committed Gradle lockfiles, update the vulnerable resolved family together, and rerun the web build before republishing. Do not attribute this class of failure to Supabase or the web application's runtime.