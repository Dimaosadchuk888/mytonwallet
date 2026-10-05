---
name: MetaMask mobile MWP URI boundary
description: Wallet-side native versus HTTPS MWP dispatch compatibility, established from public mobile source.
---

Do not treat matching the SDK-generated HTTPS universal link as proof that MetaMask Mobile will display an MWP connection prompt.

**Why:** In the inspected public MetaMask Mobile sources for 8.10.2 and 8.13.1, the earliest MWP dispatcher recognizes the native metamask://connect/mwp prefix only. A URL reaching the later legacy connect handler with p and c but no channelId is marked handled without starting a connection. The original predicate and legacy handler were executed with dummy parameters to reproduce this behavior.

**How to apply:** Check the actual URI representation arriving at the wallet, including Branch rewriting, before choosing a handoff. Native MWP dispatch and HTTPS legacy dispatch differ even though the encoded request is unchanged. This establishes a source-level compatibility risk, not the exact incoming URI of a particular iOS attempt; verify wallet prompt and returned connection on-device.