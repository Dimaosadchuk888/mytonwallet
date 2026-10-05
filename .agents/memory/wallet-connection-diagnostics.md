---
name: Wallet connection diagnostics
description: Evidence requirements for wallet fixes and the MetaMask native-link versus Telegram URL boundary.
---

The user requires confirmed failure evidence before wallet-connection fixes: do not invent errors or make speculative changes that are not verified.

**Why:** The user explicitly requested an audit after repeated generic connection errors and rejected guess-based fixes.

**How to apply:** Establish the deployed build and failure stage. Distinguish a reproduced source-level defect from the cause of a particular phone attempt. Preserve connection-only testing without authorizations or financial operations.

Telegram WebApp.openLink accepts HTTP(S), while the inspected MetaMask Connect preferredOpenLink callback receives a native metamask scheme rather than its separately generated HTTPS universal link.

**Why:** Testing the official Telegram script reproduced WebAppTgUrlInvalid for the SDK-format native URI. An HTTPS-only mocked callback test had incorrectly appeared to validate the handoff.

**How to apply:** Inspect the installed SDK's actual emitted URI and test Telegram's real validation. Carry the original native MWP request through a same-origin HTTPS launcher fragment and require a user tap to hand it to MetaMask; do not assume a universal HTTPS link reaches the MWP handler. Browser validation alone does not verify iOS wallet launch and return. Opening MetaMask on the device is also insufficient: verify that the connection prompt appears and the approved connection returns an account.

A user later reported that this Telegram → HTTPS launcher → native MWP link → MetaMask approval flow returned to Telegram but Gram Wallet still showed “Not connected.” This confirms an end-to-end device failure beyond browser-only tests, but does not establish whether the SDK received the session response or whether the local UI missed a state refresh.

**Why:** The report followed an actual MetaMask connection approval and return to Gram Wallet; the exact phone OS, app versions, emitted URI, and final SDK diagnostic stage were not captured.

**How to apply:** If the failure persists, use safe connection-stage diagnostics and capture device/app versions before changing the URI strategy. Test wallet connection only; do not trigger signatures, authorizations, or financial operations.

An outer UI timeout does not cancel its underlying wallet RPC. Keep the pending-prompt lock until that specific provider request resolves or rejects; do not unlock another signature or approval merely because the UI timed out.

**Why:** EIP-1193 wallet requests do not expose a generic per-request abort, and overlapping prompts can cause duplicate signatures or approvals. A retry is safe after the provider actually settles, not on a `Promise.race` timeout alone.

**How to apply:** On timeout, show clear guidance to confirm or cancel in the wallet and retain the pending state. Only add a force-reset path after verifying that the chosen provider operation cancels the original request; cover that behavior with a real Telegram/MetaMask device test.