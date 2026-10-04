# NearKit Phase 2: Real NEAR Implementation Plan

> Written before any Phase 2 code, from an audit of the Phase 1 repository and verified research into the current NEAR and Rhea stack (2026-09-28). Sections marked **Decision** are settled. The two items that were **Open** at planning time (§12, §13) are now resolved; see "Implementation status".

## Implementation status (2026-09-28, end of Phase 2 build)

Built and tested as planned, with these deviations and resolutions:

- **Router and fee (was Open, now Decision).** The follow-up confirmed both conditions for the aggregator path: a failed swap refunds the full input **including** the app and protocol fees (104 of 104 refunds checked on chain, 25 of them with an app fee), and the signed route can be decoded and its ed25519 signature verified client-side (355 of 355 accepted routes verify; a tampered one fails). Mainnet swaps therefore go through the aggregator with `appFeeRate=10` (0.10%; the plan's 2.00% was corrected on 2026-09-28; 0.50% since 2026-09-29, see §13); testnet uses the classic router with no fee. Details in §12 and §13.
- **Route verification** is stricter than planned: besides the signature, `checkSmartxRoute` (`src/services/rhea/smartx.ts`) refuses any route whose signer, recipient, fee rate or fee account, deadline (under 60 s left), input token or amount, step chaining, output token, DEX contracts or summed minimums differ from the request. Split routes that cover only part of the input (seen on large amounts) are refused.
- **Quote freshness.** Ticket quotes are indicative and refresh on a 30 s cycle. Preparing a swap always fetches a new route bound to the signer. A plan expires at the earlier of 120 s after quoting and 60 s before the route's deadline; the executor refuses an expired plan before signing and pauses with "Quote expired" if it expires between approvals, never signing the rest on the old quote.
- **Quote pacing.** Rhea's quote server once returned stale no-fee amounts for burst requests, so quotes went one at a time, 3 s apart. Re-checked on mainnet 2026-10-04 (`scripts/bench-smartx-burst.ts`: 64 of 64 burst answers carried the fee), NearKit now asks up to 4 at once, 100 ms apart (`src/services/rhea/smartx.ts`).
- **Outcome reading for aggregator swaps.** The aggregator reports the whole input as used whether the swap completed or was refunded, so outcomes are read from its `EVENT_JSON` logs (`single_swap_success`, `swap_failed_refund_started`, `withdraw_started`, `earn_app_fee`). A later-hop failure is reported as "you received the intermediate token instead".
- **Minimum received on fee-from-output routes** is shown as the signed minimum less the app and protocol fees (0.20%: 0.10% + 0.10% at the time; 0.60% at today's 0.50% app fee), because the exchange checks the minimum before the aggregator deducts them.
- **Fee account registration.** If NearKit's fee account isn't registered with the aggregator for the token a swap's fee lands in, the plan adds `tokens_storage_deposit` for it and shows the 0.005 NEAR as a storage cost. The operator pre-registers the five whitelist tokens (README), so this only happens for fee-from-output swaps on other tokens.
- **Wallet popups over dialogs.** NEAR Connect shows some wallets' prompts in a popup appended to `<body>`; NearKit's native modal dialogs made it inert. Dialogs now leave the top layer while that popup is visible (`src/lib/walletOverlay.ts`), verified against the live NEAR Connect build.
- **Scanner.** Holder figures come from NearBlocks v1 on both networks and are dropped (UNKNOWN) when they don't add up against the on-chain supply. Pool liquidity, minting and pause controls are UNKNOWN; NearKit doesn't read pool depth or contract source.
- **Session restore race** (found by the real-mode e2e suite): the wallet session is restored once and every first read waits for it.
- **Security review.** An adversarial review covered every value-moving path and the NEAR Connect 0.11.4 sources. It found no critical issue and two high ones, both fixed.
  - **Re-send after an error** (high). Changes in the executor:
    - malformed wallet or RPC answers now read as unknown;
    - any error after signing marks the in-flight transactions unknown and ends the run;
    - plans are single-use;
    - a plan's shape and any resumed progress are validated.

    The operation modal never returns to the review once anything has left the queue.
  - **Mutable wallet manifest** (high, supply chain). The manifest is now vendored and reviewed (`src/config/walletManifest.ts`), with GitHub-hosted executors pinned to commits. NEAR Connect's code cache is cleared whenever the pin changes, auto-connect is off, and the framing check runs before the connector exists.

  All medium findings are fixed:
  - The signed minimum is checked against the quoted output and the chosen slippage, on both the aggregator and the classic router.
  - Routes pass exact-field allowlists:
    - `referral` must be on an allowlist;
    - `collected_fee` must be false;
    - `near_amounts` must all be "1";
    - the inner `skip_unwrap_near` must be true;
    - pool IDs must be safe integers.
  - Storage deposits are capped at 0.1 NEAR per registration and warned above 0.0125 NEAR, and the review lists each one.
  - Reviews show full token contracts and full account IDs, with look-alike warnings for symbols and recipients.
  - A wallet rejection counts as "nothing sent" only when the signer's access-key nonces didn't move.

  These low findings are fixed:
  - Confirmations must match the planned actions as well as the signer and receiver.
  - Swap success requires a delivery event or receipt.
  - A failed swap prerequisite stops the plan.
  - Quote expiry counts from the quote.
  - Registrations cover only tokens in the signed route.
  - The batch parser keeps a first line whose amount is a number.
  - Cached metadata with a future timestamp is ignored, and decimals are re-read when a plan is prepared.
  - Stale debug wallets are cleared on start.
  - The fee account's registration is labelled in the review.
  - The multi-trade and transfer reviews show the lines they were missing.

  Deployment headers (`frame-ancestors`, opener policy, `nosniff`, referrer policy) ship in `vercel.json` and `npm run preview`. A full script and connect CSP does not; the README explains what it needs.

  The README lists the residual risks:
  - wallets that ignore the requested signer;
  - wallet code sharing NearKit's storage;
  - RPC trust;
  - price-driven impact figures;
  - tokens opened by link;
  - unsigned testnet routes;
  - unaudited DEX route fields.
- **Wallet cancel wording.** A check of the production build with Meteor found its "Action was cancelled" shown as a generic error. The rejection patterns now cover the cancel wording of every wallet in the manifest, taken from their pinned code.
- **Test coverage:**
  - 268 unit and integration tests, running the real services against a fake chain and a fake wallet;
  - the unchanged 28-step demo e2e suite;
  - a 13-step real-mode e2e suite with every external host faked, passing at 390, 768 and 1440 px;
  - 7 opt-in live smoke checks.

Still simulated or not built: automation and orders (local drafts only), PnL and cost basis, value history, pool liquidity in the scanner, the Telegram bot and $KIT.

**Goal:** turn NearKit from a simulator into a real NEAR wallet and trading toolkit: real wallet, real balances, real NEP-141 transfers, real Rhea quotes and swaps, and an honestly disclosed NearKit fee (0.10%; the plan's 2.00% was corrected on 2026-09-28; 0.50% since 2026-09-29, see §13). The approved Phase 1 UI stays as it is.

**Architecture:** keep Phase 1's layering: UI → hooks (`src/services/queries.ts`) → service interfaces (`src/services/types.ts`) → implementation. Phase 2 adds a real implementation (`src/services/real/`) built on NEAR-specific modules (`src/services/near/`, `src/services/rhea/`). One execution engine signs and confirms every value-moving operation.

**Tech stack additions:**
- `@hot-labs/near-connect` 0.11.4 for wallet connection.
- A hand-written, typed JSON-RPC client over `fetch`.
- BigInt amount math.

Nothing else is added at runtime.

**Research sources:** the four verified research notes behind this plan (wallet, protocol, data sources, Rhea), with every fact tied to a URL or a live read-only RPC response. The key facts are restated here with their sources.

## Global constraints

These apply to every task.

**Custody and signing**
- Never request, store, log or transmit seed phrases or private keys. All signing happens in the user's wallet.
- Never silently change a recipient, amount, slippage, token contract or network.
- Never retry a value-moving transaction automatically.
- Never show SUCCESS before the chain confirms the outcome.

**Amounts**
- Raw amounts are `bigint` or decimal strings. JavaScript `number` never carries a raw on-chain amount.
- Token decimals come from `ft_metadata`. NEAR has 24.

**Where things live**
- External contract IDs and endpoints live only in `src/config/networks.ts`.
- The UI never calls RPC, never knows Rhea contract details and never converts to yocto.

**Safety switches**
- Mainnet value-moving execution is off unless `VITE_ENABLE_MAINNET_EXECUTION=true`. The check lives in exactly one place: the transaction executor.
- Fee-bearing mainnet trades are blocked unless `VITE_NEARKIT_FEE_RECIPIENT` is a valid, existing mainnet account.

**Tests**
- The normal test suite never depends on live RPC. Live smoke tests are separate and opt-in.

**UI and design**
- Phase 1 design is frozen: no new colors, fonts, layout systems or marketing. New UI follows DESIGN.md: Figures rule, fire-key rule, 36/44 px rows, one lit color.

**Platform**
- Node 21.5 is the local runtime. Don't add dependencies whose engines exclude it, such as `near-api-js` 7 (which needs ≥ 22.22.2).

---

## 1. Baseline audit (2026-09-28)

**Health.** `npm run check` is green: typecheck, ESLint, 62 unit tests in 7 files, and the production build. The Playwright suite passes 28/28 against the production preview.

**Stack.**
- React 19.3 and TypeScript 5.9 (strict, with `noUncheckedIndexedAccess`).
- Vite 6.4, Tailwind 4.3 with the default palette cleared, React Router 7.18 with lazy routes.
- TanStack Query 5 and Vitest 3.

**Routes (19).** `/`, `/swap`, `/multi-trade`, `/limit-orders`, `/split`, `/consolidate`, `/batch-send`, `/wallets`, `/dca`, `/copy-trade`, `/sniper`, `/positions`, `/pnl`, `/scanner`, `/kit`, `/telegram`, `/settings`, `/docs`, and `*`.

**Service layer.** `NearKitServices` has five services:
- `tokens`: listings, market, scan.
- `wallets`: session, wallets, holdings, presets, split/consolidate/batch.
- `trading`: quote, swap, multi, orders.
- `automation`: DCA, copy, sniper.
- `portfolio`: summary, positions, history, PnL, activity.

`createServices()` in `src/services/index.ts` returns the in-memory mock. Components reach data only through the hooks in `queries.ts`.

**Findings that shape Phase 2:**
1. **Amounts are JS numbers end to end.** Split derives per-recipient amounts from float percentages (`amountsFromPercents`). The batch parser yields `number` amounts. Requests such as `BatchSendRequest.transfers[].amount: number` cross the service boundary as floats.
   - This is fine for demo figures and unsafe for real transfers: 18- and 24-decimal tokens exceed double precision.
   - Real flows will carry exact decimal strings to the service and compute raw `bigint` amounts in shared, tested library code.
2. **The UI imports mock constants.**
   - `TOKEN_IDS` (from `@/mocks/tokens`) appears in 11 components for default tokens and "is NEAR" checks.
   - `MAIN_ACCOUNT` appears in the connect modal.

   These move to configuration (`src/config`) and service data, so no component touches `@/mocks`.
3. **Phase 1 models one user with 12 wallets.** A real wallet session normally exposes one account, and signing needs that account's full-access key in the wallet.
   - Real mode keeps the Wallets & Presets UX on a local account book: accounts you have connected, plus watch-only accounts you add.
   - Tools that move funds from several accounts (Consolidate, Multi Trade) sign account by account, openly, never with a faked one-click.
4. **Execution is a simulated receipt.** Real execution needs a lifecycle (sign → submit → confirm), transaction hashes, explorer links, partial-failure reporting and normalized errors.
   - One execution engine and one progress UI will serve every tool.
5. **Demo mode stays valuable** for demos and for the 28-step E2E suite. It survives as `VITE_NEARKIT_SERVICES=demo`. Real mode (`near`) becomes the default.

---

## 2. What becomes real, and what stays simulated

| Area | Phase 2 (real mode) | Source of truth |
|---|---|---|
| Wallet connect / disconnect / restore | Real, via NEAR Connect | wallet session |
| Account, network, NEAR balance | Real: available (spendable) and total | RPC `view_account` |
| Token list, metadata, balances | Real: configured tokens, discovered holdings and manually imported contracts | RPC `ft_metadata` / `ft_balance_of`; FastNEAR discovery |
| Prices (USD) | Real on mainnet; none on testnet, shown as "—" | Rhea `list-token-price`; Coinbase for NEAR/USD |
| NEAR transfer, NEP-141 transfer, Batch Send, Split | Real | wallet signing + RPC confirmation |
| Consolidate | Real, with an explicit per-source signing workflow | same |
| Quotes | Real Rhea quotes | Rhea router APIs |
| Buy / Sell / Swap | Real Rhea execution with the NearKit fee | Rhea contracts |
| Multi Trade | Real, sequential, per account, non-atomic. Built only after single swaps are stable (bonus). | same executor |
| Activity | Real NearKit-originated records, reconciled with chain status | local storage + RPC `EXPERIMENTAL_tx_status` |
| Scanner | Real facts with provenance: VERIFIED FACT / DERIVED METRIC / UNKNOWN | RPC, FastNEAR, NearBlocks v3, Rhea pools |
| Positions | Real holdings × real prices. **No** average entry or PnL. | RPC + prices |
| PnL, portfolio value history | **Not tracked in Phase 2.** Honest empty states; no invented history. | none |
| DCA, Copy trade, Sniper, Limit / TP / SL | **Non-executing.** Local drafts only; the UI states that nothing monitors or runs them. | local storage |
| Telegram, Nearly, $KIT market data | Placeholders as in Phase 1. $KIT becomes a normal NEP-141 once `VITE_KIT_TOKEN_CONTRACT` is set. | config |

---

## 3. Libraries and SDKs selected

| Need | Choice | Why (verified 2026-09-28) |
|---|---|---|
| Wallet connection | **`@hot-labs/near-connect@0.11.4`** | docs.near.org's Wallet Login page is built on NEAR Connect. Its Wallet Selector tutorial was removed (404), and the Wallet Selector README calls itself "transition period" only. The official `hello-near-examples` switched to near-connect directly on 2026-09-18. It has zero dependencies, no engines field, runs each wallet's code in `sandbox="allow-scripts"` iframes and needs no polyfills with Vite. Wallet Selector's React packages would nest React 18 under React 19. |
| RPC | **Own typed JSON-RPC client over `fetch`** | `near-api-js@7.3.1` requires Node ≥ 22.22.2; this machine runs 21.5. We need only `query` (view_account, call_function), `EXPERIMENTAL_tx_status`, `block` and `EXPERIMENTAL_protocol_config`. A small client is fully testable with mocked `fetch` and saves about 61 KB gzip. |
| Amount math | **Native `BigInt`** with our own parse/format helpers | Exact; no dependency needed. Every helper is unit-tested at 0, dust, 1 NEAR, very large values, 6/18/24 decimals and rounding boundaries. |
| Transaction types | Our own minimal types for actions and `FinalExecutionOutcome` | near-connect types its results through `@near-js/types`, a devDependency of near-connect that is not installed with it, so results arrive as `any`. We validate the shape at runtime instead of trusting it. |
| Rhea SDK | **None.** We call Rhea's HTTP router APIs and build transactions ourselves. | `@ref-finance/ref-sdk@1.5.0` depends on `near-api-js@0.44.2` and defaults to the stale `indexer.ref.finance`, which reports NEAR at $1.33. The aggregator is "not part of the SDK and needs to be integrated independently" (Rhea SDK docs README). |

We add no polyfill plugin and no global `Buffer`.

---

## 4. Network configuration (Decision)

`src/config/networks.ts` holds one frozen object per network. `src/config/env.ts` reads and validates `import.meta.env` once. Nothing else reads env or hardcodes an account ID.

| Key | mainnet | testnet |
|---|---|---|
| `networkId` | `mainnet` | `testnet` |
| RPC (failover order) | `https://free.rpc.fastnear.com`, `https://rpc.intea.rs`, `https://near.drpc.org` | `https://test.rpc.fastnear.com`, `https://testnet-rpc.intea.rs`, `https://near-testnet.drpc.org` |
| Explorer | `https://nearblocks.io` (`/txns/{hash}`, `/address/{id}`, `/tokens/{id}`) | `https://testnet.nearblocks.io` (same paths) |
| wNEAR | `wrap.near` | `wrap.testnet` |
| Token discovery | `https://api.fastnear.com/v1/account/{id}/ft`; fallback NearBlocks v3 `/v3/accounts/{id}/assets/fts` | `https://test.api.fastnear.com/v1/account/{id}/ft`; fallback NearBlocks v1 inventory (deprecated) |
| Prices | `https://api.rhea.finance/list-token-price`; NEAR/USD from Coinbase Exchange with CoinGecko as fallback | none; no usable testnet prices exist |
| Rhea | aggregator `aggregatedex.near` via `smartx.rhea.finance` (see §12); classic exchange `v2.ref-finance.near` via `smartrouter.rhea.finance/findPath` | classic exchange `ref-finance-101.testnet` via `smartroutertest.refburrow.top/findPath` (the host Rhea's own app uses for testnet); no testnet aggregator exists |
| Known tokens (IDs only; metadata always from chain) | USDC `17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1`, USDt `usdt.tether-token.near`, BLACKDRAGON `blackdragon.tkn.near`, SHITZU `token.0xshitzu.near`, plus `VITE_KIT_TOKEN_CONTRACT` if set | `wrap.testnet` and testnet tokens that have Rhea testnet pools, plus KIT if set |

- **Selection.** The network comes from `VITE_NEAR_NETWORK` (default `testnet`). It is fixed for the lifetime of a page, so nothing can mix networks mid-session. `npm run dev` serves testnet and `npm run dev:mainnet` serves mainnet. Wallet storage keys are namespaced by network.
- **Visibility.** The top-bar network chip (Phase 1's "NEAR · DEMO") shows `TESTNET` or `MAINNET`. On mainnet with execution disabled it says so; Settings shows the full configuration.
- **Validation.** Invalid configuration fails closed, with a configuration error screen instead of silent defaults. Examples: an unknown network, a malformed RPC URL, a fee recipient whose suffix belongs to the other network, or a KIT contract that is not a valid account ID.

---

## 5. Wallet strategy (Decision)

- **One connector.** `NearConnector` is created once per page at module scope, as StrictMode double-invokes initializers:
  - `network` is set explicitly.
  - `providers` is set to our RPC list, so wallet executors use our endpoints instead of the deprecated `rpc.*.near.org`.
  - The login key is the default `signInWithoutAddKey`: no function-call key is added. Transfers need the full-access key anyway (1-yocto and multi-action rules).
- **Wallets offered on testnet** (verified against the live manifest): Meteor, Intear, Ledger, Nightly and NEAR CLI. HOT refuses testnet, MyNearWallet is hidden on testnet, and Sender is not in NEAR Connect.
- **Connect.** Our own modal lists `connector.availableWallets` in the NearKit design and calls `connect({ walletId })`.
  - Picker closed or rejected → `USER_REJECTED`.
  - An empty wallet list, e.g. when GitHub raw is blocked → `WALLET_UNAVAILABLE`, with a retry.
- **Restore.** `getConnectedWallet()` at startup. An empty `accountId`, which MyNearWallet returns when signed out, counts as disconnected.
- **Disconnect.** `connector.disconnect()`, then clear session-scoped caches.
- **Session expiry and account changes.** near-connect emits no account-changed event. We re-read `getAccounts()` before every signing step and on window focus. If the signer is no longer present, the operation pauses with a clear state instead of signing for the wrong account.
- **Wrong network.** A connected account ending in `.testnet` on mainnet, or `.near` on testnet, is `NETWORK_MISMATCH`. Otherwise `view_account` must find the account on the active network. An `UNKNOWN_ACCOUNT` becomes a "not found on {network}" state; implicit accounts can legitimately be unfunded.
- **Signing.** Plain `{ type: 'FunctionCall' | 'Transfer', params }` actions, as documented and used by the official example. The outcome is `unknown`, and we validate it at runtime.
- **Supply-chain note (Risk).** The wallet manifest and the wallet executor scripts load at runtime from GitHub and the wallet vendors; wallet code runs in sandboxed iframes. This is NEAR Connect's design. The manifest source can be pinned through the `manifest` option; see Risks.

---

## 6. NEAR RPC strategy (Decision)

**Client.** `src/services/near/rpc.ts`: POST JSON-RPC 2.0 with an 8 s timeout per attempt.
- Failover in configured order on network errors, HTTP 5xx or 408, JSON-RPC `-429` rate limits and timeouts.
- No failover on semantic errors (`UNKNOWN_ACCOUNT`, `UNKNOWN_TRANSACTION`, parse errors).
- No JSON-RPC batching: FastNEAR rejects it.

**Calls.**
- `query view_account` and `query call_function`, with base64 args and a byte-array result decoded as UTF-8 JSON.
- Contract errors return inside `result.error` as a string and are treated as errors.
- `EXPERIMENTAL_tx_status`: `tx_status` is still `METHOD_NOT_FOUND` on mainnet 2.13.
- `EXPERIMENTAL_protocol_config`, for storage price and gas limits.

**Finality.**
- Balances for display use `optimistic`.
- Checks that gate a transaction (storage registration, account existence, spendable balance) use `final`.

**Confirmation.**
- Poll `EXPERIMENTAL_tx_status(hash, signer, wait_until: 'FINAL')` with backoff.
- `TIMEOUT_ERROR` / `UNKNOWN_TRANSACTION` → keep polling up to a deadline, then report `UNKNOWN`. Never re-send.

**Available balance.**
- Spendable = `amount − max(0, required − locked)`, where required = `storage_usage × 1e19` above 770 bytes, else 0 (the protocol rule, nearcore `verifier.rs`).
- MAX keeps a configurable reserve of 0.05 NEAR by default. It also subtracts the upfront gas the operation will buy: attached gas × 0.001 NEAR/TGas under NEP-642, refunded after execution.

---

## 7. Amount handling (Decision; security-critical)

`src/lib/amounts.ts`:
- `parseUnits(text, decimals): bigint` accepts a strict decimal string: digits, one optional dot, no exponent and no separators.
  - It **throws** when the fractional part has more digits than `decimals`: never round a user amount silently.
  - It rejects negatives, empty strings and values above U128.
- `formatUnits(raw, decimals, { maxFraction?, trim? })` is exact. When it shortens for display it **truncates toward zero**, so it never shows more than exists.
- `nearToYocto` / `yoctoToNear` are thin wrappers with `decimals = 24`.
- `mulBps(raw, bps)` floors.
- `splitEqual(total, n)` and `splitByWeights(total, weights)` use deterministic largest-remainder allocation: the sum always equals the total exactly, and ties go to the lower index.

The UI keeps its human-units contract, but a value that reaches a service for execution is a **decimal string**, never a float. Tests cover:
- 0 and tiny values (1 raw unit);
- 1 NEAR = 10²⁴ yocto;
- U128 max;
- 6, 18 and 24 decimals;
- over-precision rejection;
- truncation boundaries;
- remainder distribution;
- round trips.

---

## 8. Token discovery and NEP-141 support (Decision)

- **Discovery and verification are separate.**
  - FastNEAR `/v1/account/{id}/ft` lists candidate contracts. Rows with `"0"`, `""` or `null` balances are dropped.
  - Every candidate is then verified on chain before it is shown as a holding: `ft_metadata` must validate, and the balance is read with `ft_balance_of` (batched, rate-limited, cached for 30 s).
  - The fallback is NearBlocks v3 on mainnet and NearBlocks v1 on testnet.
  - We never brute-force contracts.
- **Metadata validation.**
  - `spec`, `name`, `symbol` and integer `decimals` in 0–255 are required. Symbols are trimmed and limited to 32 characters, since some real tokens are longer.
  - `icon` is accepted only as a `data:image/(svg+xml|png|jpeg|webp|gif)` URL under 64 KB and is rendered only through `<img>`, so scripts can never run.
  - `reference` is ignored.
  - A contract that fails validation is **not a token** to NearKit and is shown as an import error. One bad contract never breaks the list.
- **Cache.** Metadata is cached per network and contract in localStorage (24 h TTL) with an in-memory layer. Balances are never persisted.
- **Manual import.** Enter a contract ID. It must be a valid account ID that exists on the network, has contract code, returns valid `ft_metadata` and returns a U128 `ft_total_supply`. Imported contracts are stored per network.
- **Supply** comes from `ft_total_supply` and is used by the Scanner only.

---

## 9. Storage registration (NEP-145, Decision)

`src/services/near/storage.ts`, reused by Batch Send, Split, Consolidate and swaps:
- Per token: `storage_balance_bounds().min`, cached per session. **Never hardcode 0.00125 NEAR**, even though that is the value on wrap.near, USDt, USDC and wrap.testnet today.
- Per recipient: `storage_balance_of({ account_id })`. `null` means unregistered.
- For each unregistered recipient, the plan adds `storage_deposit({ account_id, registration_only: true })` with deposit = `min` and 10 TGas, immediately **before** that recipient's `ft_transfer` in the same transaction. Actions execute in order.
- A contract without NEP-145 (`MethodNotFound`) is marked "registration can't be checked". The confirmation discloses it; an `ft_transfer` to an unregistered account reverts without loss.
- **Recipient existence.** FT contracts don't check that a receiver exists, so a registered but non-existent name would strand tokens.
  - Named recipients must exist (`view_account`), or the line is blocked.
  - Implicit (64-hex) and ETH-implicit recipients are allowed with a disclosed note.
- The confirmation lists total storage deposits in NEAR, separate from the amount being sent.

---

## 10. Transaction lifecycle (Decision)

**States:** `IDLE → PREPARING → AWAITING_SIGNATURE → SUBMITTED → CONFIRMING → SUCCESS | FAILED`, plus:
- `PROCESSING`: on chain (or possibly sent) and still followed, slower than usual. Never a failure. A run that ends with it is phase `processing`, and Activity shows it as pending until the chain's final record arrives.
- `UNKNOWN`: nobody can tell (the wallet errored and nothing was found on chain; check the explorer).
- `NOT_SENT`: never signed (rejected, or a later group after a stop).

**Delivery before settlement (2026-09-30).** A swap through Rhea's aggregator is `SUCCESS` when its output reached the user: the aggregator's `withdraw_succeeded` for the expected token and recipient (`swapDelivered` in `outcome.ts`). The input's `ft_resolve_transfer` and `callback_swap` (`single_swap_success`) run after that on wrap.near's shard. Under congestion they come minutes later: the first real web swap delivered at 115 s and settled at 203 s. They can't take the tokens back. The executor follows the final record in the background (`settling`), and the chain's final record is what stays in Activity. Native NEAR output and every other transaction are judged when final.

**Plan first.** Every tool builds a serializable `OperationPlan` before anything is signed. The plan contains:
- network and signer(s);
- token;
- exact raw amounts per line;
- storage deposits;
- fee;
- the transactions (receiver and actions) and the signing groups;
- totals and warnings.

The review screen renders the plan itself, never a recomputation.

**Execute.** `src/services/near/executor.ts` walks the signing groups in order. For each group it:
1. Asserts the execution policy: network, and the mainnet switch (the **only** place that check lives).
2. Re-checks that the signer is in the wallet session.
3. Calls `signAndSendTransactions`. Meanwhile it watches the chain for what the wallet sends (`locate.ts`): the signer's key nonces every 2 s, then the chunks of the signer's shard since the last look, matched to the plan exactly. A wallet that waits for every callback, or times out, is never the verdict. On the last approval, once the chain shows everything the wallet sent, the executor goes on without its answer.
4. Takes each hash from the chain or the wallet. After a wallet error:
   - a rejection with the key nonces unchanged is `NOT_SENT`;
   - otherwise the steps show `PROCESSING` ("NEAR network is taking longer than usual") while the chain is searched for up to 2 minutes;
   - what isn't found is `UNKNOWN`, never `FAILED`. Nothing is ever re-sent.
5. Follows every transaction with `EXPERIMENTAL_tx_status` (`wait_until: NONE`, receipts so far):
   - a swap's delivery is `SUCCESS` at once;
   - anything else waits for the `FINAL` record;
   - after 20 s a step shows `PROCESSING`, and after 30 minutes it is left to Activity (`PROCESSING` if the chain has it, `UNKNOWN` if it never did).
6. Classifies each final outcome:
   - `Failure` → failed with the action index.
   - `SuccessValue` → success.
   - For `ft_transfer_call`: used amount = `amount` is success, `0` is a refund (FAILED, "refunded"), partial is partial.
   - Inner receipt failures are surfaced for diagnostics.

**Groups.** A group is at most 10 transactions for one signer. The executor **stops after a group with any failure**. The user can review and explicitly continue; that is a new action, never an automatic retry.

**While it goes.** Once only following the chain is left, the dialog can close: the run goes on and its notice still arrives. Until it settles, a review of the same trade (pair) from the same wallet can't be confirmed (`inFlight.ts`), so it can't be sent twice by accident.

**Busy network.** Before signing a swap with NEAR in or out, the review warns "NEAR network is currently busy. This swap may take longer than usual." when wrap.near's shard has ≥ 5 PGas of delayed receipts (`congestion.ts`: the shard comes from the live shard layout, the backlog from its latest final chunk header). It is informational only and never blocks.

**Batching limits.**
- Max 1 PGas of attached gas per transaction and at most 100 actions (live protocol config).
- FT: at most 20 recipients per transaction (≤ 40 actions with storage deposits), `ft_transfer` at 10 TGas and `storage_deposit` at 10 TGas.
- NEAR: one `Transfer` transaction per recipient.
- Before signing, the upfront cost (deposits + attached gas × 0.001 NEAR/TGas) is checked against spendable balance.

**Persistence.** Pending operations are written to localStorage (network, signer and hashes as they arrive), so a reload can reconcile them. No user secrets are ever stored.

**Errors.** `src/services/near/errors.ts` maps everything to `NearKitError { code, message, detail, cause }`, with codes:
- `USER_REJECTED`, `WALLET_UNAVAILABLE`, `INSUFFICIENT_BALANCE`, `INSUFFICIENT_GAS`, `STORAGE_REQUIRED`;
- `INVALID_ACCOUNT`, `INVALID_TOKEN`, `QUOTE_EXPIRED`, `SLIPPAGE_EXCEEDED`;
- `RPC_ERROR`, `TRANSACTION_FAILED`, `NETWORK_MISMATCH`, `EXECUTION_DISABLED`, `UNKNOWN`.

The UI shows `message` and puts the original error in expandable diagnostics.

---

## 11. Transfers: Batch Send, Split, Consolidate (Decision)

- **Batch Send** (first real tool) supports NEAR and NEP-141. It reuses the Phase 1 parser: it validates, totals, checks balance (including upfront gas), checks existence and storage, chunks, reviews, signs, confirms and shows per-transaction and per-recipient results ("Transaction 2/3").
  - The parser now keeps each amount's **original text**, converted exactly with the token's decimals.
  - A line with more decimals than the token supports is rejected with that reason.
- **Split.** Percentages have at most 4 decimals and must total exactly 100.0000%. Per-recipient raw amounts come from `splitByWeights`, which is deterministic; any indivisible remainder units go by the largest-remainder rule, **documented on screen**. The review shows every recipient's exact amount. Storage and existence checks are the same as Batch Send.
- **Consolidate.** Every source signs its own transfer: no custody, no server.
  - The plan groups transactions by source.
  - The executor asks the wallet for each source in turn and shows a per-source checklist: SIGNED / WAITING / FAILED / NOT SENT.
  - If the current wallet session doesn't expose a source account, that step pauses with "Connect {account} to sign" and resumes after the user switches accounts.
  - NEAR sources leave the reserve and the upfront gas; they never drain to zero.

---

## 12. Rhea integration (Decision)

**Verified facts:**
- **Contracts.** Classic exchange `v2.ref-finance.near` (1.9.20), DCL `dclv2.ref-labs.near`, aggregator `aggregatedex.near`. Rhea's own app routes through the aggregator by default.
- **Classic quote.** `GET smartrouter.rhea.finance/findPath?amountIn=<raw>&tokenIn=<wrap>&tokenOut=<id>&pathDeep=<1-3>&slippage=<fraction>` returns raw integer amounts and `min_amount_out` with slippage applied. `pool_id` arrives as a string and must be sent as a number. It returns no price impact, has CORS `*`, and only covers classic pools.
- **Aggregator quote.** `GET smartx.rhea.finance/swapMultiDexPath` returns `amount_out`, `min_amount_out`, an opaque server-signed `msg` and its `signature`. The signature is bound to `user` and has a deadline of about 300 s. The quote accepts `appFeeRate` (basis points) and `appFeeRecipient`, and routes across DCL and classic pools.
- **Classic execution.**
  - One `ft_transfer_call` on the input token to the exchange, with 1 yocto and 300 TGas. `msg` = `{"actions":[{pool_id,token_in,amount_in?,token_out,min_amount_out}],"skip_unwrap_near":false?}`.
  - No exchange storage is needed (virtual account); the user must be registered on the output token.
  - NEAR input needs `near_deposit` on wNEAR first.
  - NEAR output needs `"skip_unwrap_near": false`, because the default is **not** to unwrap.
- **Slippage failure** panics (`E68` classic / `E204` DCL) inside the receiver. `ft_transfer_call` then returns used = `"0"` and refunds, so the top-level status still says `SuccessValue`. Our outcome classifier must read the used amount.

**Plan:**
- **Quotes** (`src/services/rhea/quotes.ts`) normalize into our `Quote`: input, expected output, minimum received, route (pools and tokens), estimated price impact, slippage, NearKit fee, `quotedAt` and `expiresAt`.
  - Price impact is **estimated**: the quote compared with Rhea spot prices. It is labeled as an estimate, and shown as UNKNOWN on testnet.
  - Quotes older than 15 s are stale in the UI.
  - Execution **always re-quotes**. If the new minimum received is worse than the reviewed one, it asks for re-confirmation instead of signing.
- **Execution** (`src/services/rhea/execution.ts`) builds the swap as an `OperationPlan`:
  - output-token registration if needed;
  - NEAR wrap if needed;
  - the swap call;
  - native NEAR out if the output is NEAR.

  The same executor as transfers signs and confirms it.
- **Decision (resolved): mainnet swaps use the aggregator.**
  - The aggregator is Rhea's current default and the only Rhea path with an integrator fee. The classic exchange has none: `referral_id` is a whitelisted ~4% share of the pool fee, about 0.012% of volume.
  - The follow-up verified what the decision depended on: failed swaps refund in full, fees included, and the signed `msg` decodes (base64, every byte minus 7, JSON) and verifies (ed25519 over the hex SHA-256 of the msg string, with the key compiled into `aggregatedex.near`).
  - Implementation: `src/services/rhea/smartx.ts` (quote client, decode, signature, route checks), `src/services/rhea/fees.ts` (fee token, split, true minimum), `src/services/rhea/swapTransactions.ts` (registrations, wrap, swap call), `src/services/real/swapRouting.ts` (live prerequisites), `src/services/real/tradingService.ts` (quotes, plans, multi trade, order drafts), `src/services/near/outcome.ts` (event-based outcomes).
  - Prerequisites batched before the swap, as Rhea's own app does: `wrap.near` registration and `near_deposit` for NEAR input; the signer's registration on the output token (and on intermediate tokens when the route spans two exchanges); the aggregator's registration on each token it holds; `tokens_storage_deposit` inside the aggregator for the signer and, when missing, for the fee account.
- **Testnet:** classic path only (`ref-finance-101.testnet`). There is no testnet aggregator.

---

## 13. NearKit fee strategy (0.10%)

**Changed again on 2026-09-29:** the fee is now 0.50% (50 bps), set in `NEARKIT_FEE` in `src/lib/fees.ts`. NearKit receives 0.40% and Rhea keeps 0.10%. The mechanism below is unchanged. The figures below are the 2026-09-28 ones.

**Changed on 2026-09-28:** the NearKit trading fee is 0.10% (10 bps), not the 2.00% this plan was first written with. Everything below reflects 0.10%. It applies to Swap and Quick Trade only: Split, Consolidate and Batch Send carry no NearKit fee. The future 2% buy and sell fee on $KIT belongs to its launch through Nearly; it is separate and not implemented.

- **Configuration** (`src/lib/fees.ts`, single source):
  - `NEARKIT_FEE_BPS = 10`.
  - `NEARKIT_FEE_RECIPIENT` comes from `VITE_NEARKIT_FEE_RECIPIENT`; there is no default and no personal wallet in code.
  - If the recipient is missing or invalid on mainnet, fee-bearing mainnet execution is **blocked**, with a stated reason. The fee is never sent anywhere else.
- **Default decision: mainnet swaps go through Rhea's aggregator** with `appFeeRate=10` and `appFeeRecipient=NEARKIT_FEE_RECIPIENT`, which is Rhea's own app-fee mechanism. Verified on-chain split:
  - Rhea keeps **20% of the app fee**, so of the 0.10% the user pays, NearKit receives **0.08%** and Rhea 0.02%.
  - The aggregator also charges every swap a **0.10% protocol fee**, not stated in its docs but visible on-chain (`earn_protocol_fee`).
  - The fee is collected in the first whitelisted token on the route (wNEAR, USDC or USDt), so on NEAR pairs it is the NEAR leg, matching Phase 1's copy.
  - Fees accrue as the recipient's internal balance on `aggregatedex.near` and must be withdrawn by the fee account; that is an operator task, documented in the README.
- **Disclosure.**
  - The UI shows "NearKit fee 0.10%".
  - The confirmation shows the actual amount (e.g. "0.01 NEAR" on a 10 NEAR trade) **and** the split: NearKit receives 0.08% and Rhea 0.02%, plus the Rhea protocol fee of 0.10%.
  - Nowhere do we claim NearKit receives the full 0.10%.
- **No double charge.** On the aggregator path NearKit adds **no** separate fee transfer; the app-fee parameter is the only fee.
- **Tests prove it:**
  - the quote request carries exactly `appFeeRate=10` and the configured recipient;
  - the transaction contains no extra fee transfer;
  - the displayed fee equals `mulBps(nearLeg, 10)`;
  - execution is refused when the recipient is unset on mainnet.
- **Resolved.** The follow-up confirmed full refunds (fees included) and client-side verification, so the fallback (our own `ft_transfer` fee on the classic path) was not needed and is not built.
- **Where the fee is taken.** The first whitelisted token the aggregator holds: the input, a token between two exchanges, or else the output. For input-side fees the review shows exact amounts; for later tokens it shows an estimate labelled as such, and the exact amounts appear in the outcome (from `earn_app_fee`).
- **Tests that prove it** (`src/services/real/real.test.ts`, `src/services/rhea/*.test.ts`): the quote request carries `appFeeRate=10` and the configured recipient; routes signed with any other fee rate or account are refused, including a real route still signed at the old 2.00%; the plan contains exactly one `ft_transfer_call` and no fee transfer; the disclosed split is 0.10% = 0.08% + 0.02%, plus Rhea's 0.10%; a live smoke check confirms Rhea signs NearKit quotes at 1000 ppm; trades are blocked (and Rhea is never asked) when the fee account is missing; the mainnet switch stops execution before the wallet.
- **Testnet** swaps use the classic path. The NearKit fee line reads "Not charged on testnet": no Rhea app-fee router exists there, and testnet tokens have no value.

---

## 14. Mainnet safety switch (Decision)

- `VITE_ENABLE_MAINNET_EXECUTION` defaults to `false`. When it is false on mainnet, all reads work, but every value-moving action stops in `executor.assertExecutionAllowed()` with `EXECUTION_DISABLED` **before** the wallet is asked to sign.
- The UI reads the same policy object to explain it ahead of time: the network chip, a notice in reviews, and the fire key's reason line. It never re-implements the check.
- Enabling mainnet execution is a deliberate build-time choice. The README says to prove the testnet checklist (§17) first.

---

## 15. Activity, positions and PnL (Decision)

- **Activity.** Every NearKit-originated operation writes a local record: operation type, account, token, amount, timestamp, tx hashes, network and status.
  - Pending records reconcile through `EXPERIMENTAL_tx_status` on load.
  - Records are scoped per network and account.
  - Arbitrary wallet activity is never labelled as NearKit's.
- **Positions.** Real balances and real prices give value only.
  - Average entry and PnL show "Not tracked", because we don't infer cost basis from balances.
  - The Dashboard's 24h PnL and value history show honest empty states.
- **PnL page.** In real mode it shows "PnL isn't tracked yet" and why (entry prices of trades made outside NearKit are unknown, and a wrong PnL is worse than none). Demo mode keeps the Phase 1 report, labelled demo.

---

## 16. Scanner with real data (Decision)

Every figure carries a provenance tag: **VERIFIED FACT** (read from chain), **DERIVED** (computed from facts or an indexer), or **UNKNOWN**. The page never prints SAFE or SCAM.
- **Facts (RPC):**
  - contract account exists;
  - `code_hash` (whether a contract is deployed; global contracts handled);
  - storage usage;
  - `ft_metadata` fields and `ft_total_supply`.
- **Derived (as built):**
  - holder count and the ten largest holders (NearBlocks v1 on both networks), shown only when their balances fit inside the on-chain supply;
  - contract creation date (NearBlocks `created`);
  - price (Rhea's price list; none on testnet).
- **Also verified from chain:** the contract account's full-access keys (`view_access_key_list`). Keys present means whoever holds them can replace the code; that is an observation, not a verdict.
- **UNKNOWN (as built):** pool liquidity (not read yet; a quote shows price impact for a given size), minting after launch, pause and blocklist controls (they need the source).
- We don't claim to detect every malicious contract.

---

## 17. Testing strategy

**Unit tests (Vitest):**
- amounts and yocto;
- decimals;
- fee math and fee-param construction;
- split rounding;
- storage planning;
- batch chunking and upfront gas;
- the transaction state reducer and outcome classifier;
- quote normalization and staleness;
- network and env config validation;
- error normalization;
- metadata validation;
- account validation, extended with implicit-account kinds.

**Integration tests (Vitest, no network):**
- real services with a mocked `fetch` (JSON-RPC and HTTP fixtures captured from the research's live responses);
- a fake wallet adapter.

They assert:
- the exact actions, args, deposits and gas;
- chunk boundaries;
- partial failure;
- refund detection;
- the blocked mainnet switch;
- the blocked missing fee recipient.

**E2E (Playwright):**
- the Phase 1 suite runs unchanged against **demo mode**;
- a new real-mode suite runs an `e2e` build that swaps in a **test-only wallet adapter**, excluded from normal builds and asserted absent from the production bundle, with RPC and HTTP routes mocked. It covers:
  - disconnected state;
  - connect;
  - wrong network;
  - rejected signature;
  - batch send progress, success, failure and explorer links;
  - storage disclosure;
  - expired quote;
  - mainnet-disabled.

**Live smoke (opt-in, `npm run smoke:live`):** read-only calls against testnet and mainnet (account view, metadata, discovery, prices, findPath). They never send anything.

**Testnet proof (manual, by the user with their own testnet wallet: Meteor or Intear):**
- connect;
- NEAR balance;
- NEAR transfer;
- NEP-141 metadata and balance;
- NEP-141 transfer;
- Batch Send;
- Split.

The build can't create accounts or sign on the user's behalf, so this checklist ships in the README. Mainnet execution stays disabled until it passes.

---

## 18. Risks

1. **Wallet supply chain.** NEAR Connect loads its manifest and wallet executors at runtime, from GitHub and the wallet vendors. They run sandboxed, but a compromised executor could misrepresent what it signs.
   - Mitigations: we show every detail before signing, confirm outcomes independently through our own RPC, and can pin the manifest.
2. **Rhea trust.**
   - The contract sources are no longer public: the repo returns 404 and the newest mirror is 1.9.18 while 1.9.20 is deployed.
   - The exchange upgrades by DAO vote without a timelock.
   - The aggregator depends on Rhea's signing server and an owner account, and its fee terms are partly undocumented.
3. **Free public infrastructure.** FastNEAR, Intear, dRPC, NearBlocks (keyless ~6/min), Coinbase and Rhea have no SLAs or published keyless limits. Mitigations: failover, caching, graceful UNKNOWN states and optional keys later.
4. **Protocol parameters change.** Gas buy price, account-creation charge and limits are read from `EXPERIMENTAL_protocol_config` where they matter.
5. **Non-standard tokens.** Metadata validation, a registration-can't-be-checked state and conservative gas.
6. **Batch atomicity.** Transactions in a wallet batch are not atomic, and the wallet decides their order. The UI reports per-transaction truth and never implies atomicity.
7. **Node 21.5.** It has been end-of-life since 2024-06 and is outside Vite 6's declared engines. It works, but moving to Node 22 LTS is recommended.

---

## 19. Implementation order and task map

Each step lands with its tests before the next starts. Files are indicative.

| Step | Deliverable | Main files |
|---|---|---|
| 2 | Network + env config, validation, `.env.example` | `src/config/env.ts`, `src/config/networks.ts`, `.env.example`, tests |
| 3 | Wallet adapter + connect/disconnect/restore UI | `src/services/near/wallet.ts`, `src/state/ConnectProvider.tsx`, `src/layouts/TopBar.tsx` |
| 4 | RPC client, real NEAR balance, spendable balance | `src/services/near/rpc.ts`, `src/services/near/account.ts` |
| 5 | Amount library | `src/lib/amounts.ts` + tests |
| 6 | NEP-141 metadata + balances | `src/services/near/tokens.ts` |
| 7 | Discovery + manual import | `src/services/near/discovery.ts`, TokenSelect import row |
| 8 | Storage checks + actions | `src/services/near/storage.ts` |
| 9 | Plans, executor, outcome classifier, errors | `src/services/near/{transactions,executor,outcome,errors,explorer}.ts`, `src/features/tools/OperationModal.tsx` |
| 10–13 | NEAR transfer, Batch Send, Split, Consolidate | `src/services/real/transferService.ts`, the feature components |
| 14–17 | Rhea quotes, fee, swaps | `src/services/rhea/*`, `src/services/real/tradingService.ts`, tickets |
| 18 | Multi Trade (sequential), if stable | same executor |
| 19 | Scanner facts | `src/services/real/scanner.ts`, `ScanReport` provenance |
| 20 | Activity records | `src/services/near/activity.ts`, `ActivityList` |

---

## 20. Environment variables

| Variable | Required | Default | Meaning |
|---|---|---|---|
| `VITE_NEARKIT_SERVICES` | no | `near` | `near` runs the real implementation. `demo` runs the Phase 1 simulator: demo data, nothing signed. |
| `VITE_NEAR_NETWORK` | no | `testnet` | `testnet` or `mainnet`. Fixed per page load. |
| `VITE_NEAR_RPC_URL` | no | the network's list (§4) | A comma-separated override. The first URL is primary and the rest are failover. |
| `VITE_ENABLE_MAINNET_EXECUTION` | no | `false` | Must be exactly `true` to allow value-moving actions on mainnet. |
| `VITE_NEARKIT_FEE_RECIPIENT` | for mainnet trading | none | The NEAR account that receives the NearKit app fee. It is public, not a secret. Without it, fee-bearing mainnet execution is blocked. |
| `VITE_KIT_TOKEN_CONTRACT` | no | none | The $KIT NEP-141 contract, once launched on Nearly. Until it is set, $KIT shows the honest not-live state. |

No variable is secret; `.env.example` documents each one. Real `.env*` files are git-ignored.
