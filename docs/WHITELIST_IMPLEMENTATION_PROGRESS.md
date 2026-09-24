# ERC-20 White List Implementation Progress

## Scope

This document tracks the staged implementation of the ERC-20 wallet whitelist
flow described in the project brief:

`Audit → Documentation → Libraries → Architecture → UI → Connect Wallet → Approve → Allowance verification → Backend/DB → Purchase integration → Security → Preview testing`

No token, network, spender, or payment-contract addresses are invented here.

## Status

- [x] Stage 0 — repository audit
- [x] Stage 1 — official documentation and Permit2 decision
- [x] Stage 2 — Permit2 integration and environment setup
- [ ] Stage 3 — White List UI
- [ ] Stage 4 — external wallet connection
- [ ] Stage 5 — unlimited USDT approval to Permit2
- [ ] Stage 6 — on-chain Permit2 allowance verification
- [ ] Stage 7 — whitelist persistence after verification
- [ ] Stage 8 — backend/API
- [ ] Stage 9 — database and RLS
- [ ] Stage 10 — purchase-flow integration
- [ ] Stage 11 — security review
- [ ] Stage 12 — Preview testing
- [ ] Stage 13 — final audit

## Stage 0 — Repository audit

### Frontend and build stack

- React/TypeScript application bundled with Webpack.
- Existing `ethers` 6.x dependency.
- Existing Node HTTP server serves `dist` and exposes internal API routes and
  external API proxies.
- Existing localization uses `src/i18n/en.json` and YAML locale files.

### Existing EVM and wallet infrastructure

- EVM chain support and provider construction already exist in:
  - `src/api/chains/evm/`
  - `src/api/chains/evm/constants.ts`
  - `src/api/chains/evm/util/client.ts`
  - `src/config.ts`
- Existing EVM browser/extension connector code:
  - `src/util/injectedConnector/evmConnector.ts`
  - `src/extension/pageScript/EvmConnector.ts`
- Existing WalletConnect/Reown integration is under:
  - `src/api/dappProtocols/adapters/walletConnect/`
- The current WalletConnect integration is for wallet/dapp protocol flows. It
  is not yet a confirmed user-facing external-wallet connection flow for this
  whitelist feature.
- No `viem`, `wagmi`, `web3.js`, or `thirdweb` dependency is present.
- No Solidity/Vyper/Func/Tact contract source or deployment artifact was found.

### ERC-20 functionality already present

- ERC-20 ABI and allowance reads exist in:
  - `src/api/chains/evm/approvals.ts`
- Existing approval discovery reads `allowance(owner, spender)` and classifies
  existing permissions.
- Existing approval write logic revokes permissions with `approve(spender, 0)`.
- Existing EVM transfer logic sends ERC-20 tokens with `transfer(to, amount)`:
  - `src/api/chains/evm/transfer.ts`
- No feature was found that performs the requested
  `approve(spender, uint256.max)` flow for a configured payment contract.
- No verified `transferFrom(user, recipient, amount)` purchase flow was found.

### Existing whitelist-like features

The repository contains unrelated whitelist concepts:

- `IFRAME_WHITELIST` controls technical iframe behavior.
- `whitelistedNftAddresses` controls NFT activity visibility.
- Dapp/vesting payloads contain domain-specific whitelist logic.

No generic Settings-based ERC-20 wallet whitelist exists.

### Authentication, users, and wallet persistence

- Telegram Mini App authentication is server-side HMAC verification:
  - `server/telegram.mjs`
  - `server/index.mjs`
- Telegram users are stored in `internal_ton_users`.
- The application wallet is self-custodial and persisted locally under the
  `accounts` and `currentAccountId` storage keys.
- Browser storage uses IndexedDB; extension storage uses extension-local
  storage.
- No server-side persistence or ownership model currently links a Telegram
  user to an external EVM wallet address.

### Backend and database

- Supabase migrations currently cover internal TON/USDT balances, deposits,
  ledger entries, rewards, and monitoring state:
  - `supabase/migrations/001_internal_deposits.sql`
  - `supabase/migrations/002_reward_checks.sql`
  - `supabase/migrations/003_usdt_reward_checks.sql`
  - `supabase/migrations/004_usdt_reward_rpc_namespace.sql`
- The Node server uses the Supabase service-role key for server calls.
- Existing internal endpoints are Telegram auth, account/balance, and
  admin reward-check routes.
- No whitelist API, wallet ownership table, approval record, or approval
  verification endpoint exists.
- RLS is enabled on the existing internal tables, but the repository migrations
  do not define user-facing policies for this new feature.

### Settings and UI

- Settings navigation is implemented in:
  - `src/components/settings/Settings.tsx`
- Existing wallet-related Settings screens cover wallet variants and wallet
  versions.
- Connected dapp management provides the closest existing Settings pattern:
  - `src/components/settings/SettingsDapps.tsx`
  - `src/components/dapps/DappInfo.tsx`
- New UI must add localization keys and follow the existing mobile layout.
- Dapp connector support is capability-gated and is not generally enabled for
  ordinary Web/Telegram builds.
- Native Air Settings are separate Swift/Kotlin surfaces and are not changed
  by a web `src/` implementation.

## Stage 0 conclusions

### Reusable parts

1. `ethers` 6.x can provide EIP-1193 browser-provider integration and ERC-20
   contract calls without adding a second EVM SDK.
2. Existing EVM chain configuration and provider utilities can be reused.
3. Existing Settings, modal, localization, Supabase, and server patterns can
   host the new feature.
4. Existing allowance-read code can inform the verification implementation,
   but it does not establish the business contract or spender.

### Blocking information required before approval implementation

The following project facts are not present in the repository and must be
confirmed before Stage 5:

- supported EVM network and chain ID;
- ERC-20 token contract address and decimals;
- canonical Permit2 address and selected Permit2 spender/operator identity;
- proof that the selected spender can execute the intended Permit2
  `transferFrom` calls;
- recipient/treasury and purchase-flow semantics;
- whether the whitelist is per Telegram user, per local wallet account, or both;
- whether external wallets must work on Web, mobile Safari, Telegram, and/or
  only Extension/Electron;
- whether native Air parity is required.

Until these values and ownership semantics are confirmed, the implementation
must not send a live unlimited approval request or record an address as
approved.

### Supplied parameters verification

The revised supplied parameters are:

- network: Ethereum mainnet, chain ID `1`;
- token: `0xdAC17F958D2ee523a2206206994597C13D831ec7`;
- operator/spender EOA: `0x13dafa7348873f5fd2ca0ca89f0b28143888ec3a`;
- ownership: link the Telegram user and local wallet account;
- target: Telegram Mini App.

On 2026-09-21, both addresses were checked against the project's Ethereum RPC
endpoint. The token returned deployed bytecode and standard ERC-20 metadata:

- `name()` returned `Tether USD`;
- `symbol()` returned `USDT`;
- `decimals()` returned `6`.

The candidate operator returned `eth_getCode(address, latest) = 0x`, so it is
an EOA rather than a deployed contract. That is acceptable as a Permit2
spender, provided the project verifies control of the EOA and intentionally
uses it as the scheduler/operator. It is not a payment contract and cannot
enforce business rules on-chain.

## Stage 1 — initial documentation baseline

The implementation baseline is:

- EIP-1193 for provider interaction, account changes, chain changes, and
  provider errors.
- EIP-20 for `approve`, `allowance`, and `transferFrom`.
- `ethers` v6, already present in the project, for `BrowserProvider`,
  contract calls, transaction responses, and receipt waiting.
- OpenZeppelin ERC-20 semantics as the reference contract behavior.
- Uniswap Permit2 `AllowanceTransfer` for recurring permissions on USDT.
- Canonical Ethereum mainnet Permit2 address:
  `0x000000000022D473030F116dDEE9F6B43aC78BA3`.

No new connector SDK has been installed or selected yet. The existing ethers
signing path will be reused first; external WalletConnect support remains a
separate compatibility check for Telegram Mini App.

## Revised plan — unlimited recurring deductions

The product requirement is now explicitly:

- USDT on Ethereum mainnet;
- unlimited USDT allowance to canonical Permit2;
- maximum Permit2 AllowanceTransfer permission for the selected operator;
- no financial cap per charge;
- no aggregate financial cap for future subscription types;
- scheduler-driven deductions for multiple subscription models.

This is materially different from a bounded subscription contract. An unlimited
approval means Permit2 and its selected spender can transfer any amount
available under the permission and wallet balance. The UI must state this
plainly, and the integration must not conceal that authority behind a generic
“withdraw” operation.

### What remains mandatory even without financial limits

These are authorization and protocol-integrity controls, not spending caps:

- only the configured USDT contract can be pulled;
- funds go to an explicitly configured treasury or merchant destination;
- a charge must reference an active user authorization/subscription;
- only an authorized merchant/operator or a valid signed authorization can
  trigger a charge;
- each order/charge identifier is replay-protected;
- users can cancel an authorization;
- the contract has emergency pause and role revocation;
- admin and operator privileges are protected by a multisig or equivalent
  operational control;
- there is no arbitrary `ownerWithdrawFrom(user, amount)` or hidden drain
  function.

If the requirement is that an operator can pull any amount from any approved
wallet, this is an unrestricted spending authority rather than a bounded
subscription payment system. The current task records that choice explicitly;
future limits are a separate task.

### Revised staged implementation plan

#### Stage 1 — finalize the authorization model

- Decide whether charges are triggered by a backend operator, approved
  merchants, permissionless keepers, or signed EIP-712 mandates.
- Define how a Telegram user authorizes future subscription categories.
- Define treasury/merchant routing and whether several merchants are supported.
- Keep the unlimited allowance explicit in the consent UI.

#### Stage 2 — integrate Permit2 without a custom Solidity contract

- Use the canonical Ethereum mainnet Permit2 deployment.
- Add the minimal Permit2 ABI and typed-data definitions to the existing
  ethers-based integration.
- Submit the initial `USDT.approve(Permit2, uint256.max)` transaction.
- Sign a Permit2 `AllowanceTransfer` permission for the selected operator EOA.
- Use maximum protocol field values for the current no-limit phase:
  maximum amount and maximum expiration supported by Permit2.
- Verify the operator EOA is controlled by the intended scheduler and is not a
  personal treasury wallet.
- Keep the canonical Permit2 address and USDT address immutable in frontend and
  backend configuration.

#### Stage 3 — USDT approval flow

- Connect the EVM wallet in the Telegram Mini App.
- Verify chain ID 1 and the exact USDT contract.
- Show the canonical Permit2 address and the explicit unlimited-allowance
  warning.
- Submit the initial standard
  `USDT.approve(Permit2, uint256.max)` transaction.
- Handle USDT's legacy approval behavior when changing a nonzero allowance.
- Read back `USDT.allowance(owner, Permit2)` after confirmation.
- Sign and submit the Permit2 `AllowanceTransfer` permission.
- Read back the Permit2 allowance for the selected operator.

Ethereum USDT does not expose usable EIP-2612 `permit` entrypoints in the
on-chain checks already performed. Native Permit is therefore not a substitute
for the first approval transaction in this project.

Permit2 is a separate deployed protocol. Its `AllowanceTransfer` module stores
standing per-spender permissions with an amount, expiration, and nonce, making
it the candidate that best matches recurring subscriptions without deploying a
custom payment contract. `SignatureTransfer` is for one-time signed transfers
and is not suitable for unattended recurring charges.

#### Stage 4 — subscription and scheduler execution

- Store subscription metadata and charge records in the backend for the current
  no-limit phase.
- Let the selected operator submit Permit2 `transferFrom` transactions for
  multiple subscription types and arbitrary amounts.
- Do not add business amount or aggregate caps in this task.
- Make failed charges retryable without allowing duplicate successful charges
  in backend records.
- Support Permit2 allowance revocation and operator rotation.
- Treat the operator key as a critical high-risk secret; never store it in
  frontend code or expose it to the Telegram client.

#### Stage 5 — Telegram/backend identity linking

- Authenticate the Telegram user through the existing server session.
- Prove ownership of the connected EVM address with a wallet signature.
- Link Telegram user, local wallet account, and external EVM address in the
  backend only after verification.
- Never treat a frontend-provided address as proof of ownership.

#### Stage 6 — database/API

Add records for user-wallet links, authorizations, subscriptions, charge
requests, transaction hashes, and statuses. Store the contract-observed result,
not only a frontend claim. Add ownership checks, idempotency, and policies
before enabling the feature in production.

#### Stage 7 — testing and deployment

- Test USDT and Permit2 on a mainnet fork with real token behavior.
- Test unlimited allowance, arbitrary charge amounts, recurring charge timing,
  cancellation, and operator compromise.
- Verify the canonical Permit2 bytecode and domain data before use.
- Deploy no custom payment contract in this task.
- Monitor every charge event and alert on unusual activity.

### Current blocker

The USDT token and canonical Permit2 are confirmed. No custom payment contract
is required for the selected path. Before live approval, the project still
needs the operator EOA ownership/secret path and the recipient/treasury
semantics. The next implementation step is Permit2 integration and test setup,
not a Solidity deployment.

### Architecture correction: a custom payment contract is optional

The earlier audit correctly found no deployed payment contract, but that does
not mean ordinary ERC-20 approval is impossible. `approve` only needs:

1. the token contract (USDT);
2. an owner wallet that signs the approval transaction;
3. a spender address, which can be an EOA or a contract.

The previous flow may therefore have worked as:

`local wallet/private key → USDT.approve(EOA, amount) → EOA calls transferFrom`

That path does not require deploying a custom contract, but the EOA key becomes
the authority that can spend every approved wallet's USDT. It is a custodial
and high-risk architecture, especially with unlimited allowance.

There are three distinct options and they must not be conflated:

1. **Existing EOA spender:** no custom contract; standard on-chain `approve`;
   the scheduler uses the EOA to call `transferFrom`. Fastest, but highest key
   custody and arbitrary-drain risk.
2. **Custom payment/subscription contract:** standard `approve` points to the
   contract; the contract enforces the subscription and emits auditable events.
   This is safer for policy enforcement but requires deployment and review.
3. **Permit2:** an existing external contract can replace repeated direct
   approvals with signed permissions, but USDT still needs an initial approval
   to Permit2. It adds another trusted dependency and is not native USDT
   `permit`.

Native EIP-2612 `permit` is not available on the Ethereum USDT contract based
on the on-chain entrypoint checks already performed. Permit does not remove the
need for a spender anyway; it only changes how allowance is authorized.

The implementation path is now selected: Permit2 `AllowanceTransfer` without a
custom payment contract and without financial limits in this task. It still
requires an initial USDT approval and does not remove the risk of a maximal
permission granted to the selected spender. Adding limits later is a separate
task and is intentionally not part of the current implementation.

## Change log

### 2026-09-21

- Completed the read-only repository audit.
- Confirmed existing EVM/ethers/WalletConnect infrastructure.
- Confirmed no generic whitelist feature or verified payment/spender contract.
- Verified the supplied USDT token and rejected the supplied spender because it
  has no deployed bytecode on Ethereum mainnet.
- Documented the revised unlimited-deduction architecture and its required
  authorization controls.
- Recorded that a custom payment contract is optional for ordinary EOA-based
  approval, while native USDT permit is unavailable.
- Selected canonical Permit2 `AllowanceTransfer` for the current unlimited
  recurring-deduction phase; custom contract deployment is out of scope for
  this phase.
- Added the Permit2 EVM module with canonical addresses, ABI encoders,
  allowance reads, unlimited USDT approval, and EIP-712 signing helpers.
- Added the standard API methods for Permit2 allowance status, approval, and
  permission signing.
- Added focused Permit2 ABI and typed-data tests; no new dependency was needed.
- Added this progress document.
- No new dependency, database schema, secret, or workflow configuration was
  added.