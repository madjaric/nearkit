# NearKit

[![CI](https://github.com/madjaric/nearkit/actions/workflows/ci.yml/badge.svg)](https://github.com/madjaric/nearkit/actions/workflows/ci.yml)

The trading toolkit for NEAR. Phase 2 runs on the real NEAR network: wallet connection through NEAR Connect, balances and token metadata read from chain, NEP-141 transfers (Batch Send, Split, Consolidate), and swaps through Rhea. The Phase 1 demo still ships as a separate mode.

Mainnet execution is **off by default**. Prove the testnet checklist below before turning it on.

## Public testnet beta

**https://nearkit.vercel.app** is the public testnet beta. Vercel deploys it from `main`, and pull requests get preview deployments.

| Vercel variable (Production and Preview) | Value |
|---|---|
| `VITE_NEARKIT_SERVICES` | `near` |
| `VITE_NEAR_NETWORK` | `testnet` |
| `VITE_ENABLE_MAINNET_EXECUTION` | `false` |

Nothing else is set, and none of it is secret. The network chip reads TESTNET BETA. Testnet tokens have no value, and mainnet value-moving execution is off.

The beta ships Swap and Quick Trade, Split, Consolidate, Batch Send, Wallets and Scanner.

**Coming soon:** Multi Trade, Limit Orders, DCA, Copy Trade and Sniper.
- Their pages, code and tests stay. In the beta the sidebar tags them SOON, and their pages show COMING SOON with every field and key disabled.
- The list is `BETA_COMING_SOON` in `src/config/release.ts`; remove a route there to ship it.
- The hold applies only to production builds on testnet: `npm run dev` and the e2e suites keep these features usable, and `npm run e2e:beta` checks the held-back state.

CI (`.github/workflows/ci.yml`) runs on every push to `main` and every pull request. It covers typecheck, lint, format check, unit and integration tests, and the production build. The e2e suites and live smoke checks run locally (see Tests).

## Run it

Requires Node 20+ (the workstation runs Node 21.5, which is why this uses Vite 6, React Router 7 and ESLint 9).

```bash
npm install
npm run dev            # real services on NEAR testnet       http://localhost:5196
npm run dev:demo       # the Phase 1 simulator, demo data     http://localhost:5198
npm run dev:mainnet    # mainnet (view-only unless enabled)   http://localhost:5200
npm run dev:e2e        # testnet + scripted test wallet       http://localhost:5202
npm run build          # typecheck + production build (dist/)
npm run preview        # serves dist/ on http://localhost:5197
```

| Mode | Services | What signs |
|---|---|---|
| `near` on testnet (default) | wallet, RPC, indexers, Rhea classic router | your wallet; no NearKit fee |
| `near` on mainnet | same, Rhea aggregator for swaps | your wallet, only when `VITE_ENABLE_MAINNET_EXECUTION=true` |
| `demo` | in-memory simulator | nothing; every result is simulated |
| `e2e` | real services + a scripted wallet | nothing real; test builds only, absent from production bundles |

## Configuration

Every variable is public (none is a secret), documented in `.env.example`, and validated once in `src/config/env.ts`. An invalid value stops the app on a configuration screen; nothing falls back silently.

| Variable | Default | Meaning |
|---|---|---|
| `VITE_NEARKIT_SERVICES` | `near` | `near` or `demo` |
| `VITE_NEAR_NETWORK` | `testnet` | `testnet` or `mainnet`, fixed per build |
| `VITE_NEAR_RPC_URL` | the network's verified list | comma-separated override; first is primary |
| `VITE_ENABLE_MAINNET_EXECUTION` | `false` | must be exactly `true` for value-moving actions on mainnet |
| `VITE_NEARKIT_FEE_RECIPIENT` | none | account that receives the NearKit app fee; without it mainnet trades are blocked |
| `VITE_KIT_TOKEN_CONTRACT` | none | the $KIT contract once it launches on Nearly |

Every external host and contract lives in `src/config/networks.ts`, verified live on 2026-09-28.

## What is real, and what isn't

| Area | Status |
|---|---|
| Wallet connect, restore, disconnect, multiple accounts | Real (NEAR Connect: Meteor, Intear, Ledger, Nightly and others per network) |
| NEAR and NEP-141 balances | Real: `view_account` and `ft_balance_of`; indexers only suggest which tokens to check |
| Token metadata, import by contract | Real, validated (`ft_metadata`, `ft_total_supply`) |
| Batch Send, Split, Consolidate | Real: exact amounts, recipient checks, NEP-145 registration, chunking, per-transaction status |
| Swap, Quick Trade | Real: Rhea aggregator on mainnet (0.10% app fee), Rhea classic router on testnet (no fee) |
| Multi Trade | Real: one verified route per wallet, one approval per wallet, no all-or-nothing. COMING SOON in the public testnet beta |
| Transaction history | Real for operations sent from this browser, reconciled with the chain |
| Scanner | Real: every figure is labelled verified, derived or unknown; never safe/scam |
| Positions | Real balances and Rhea prices; entry price and PnL are not tracked yet |
| Limit/TP/SL, DCA, Copy Trade, Sniper | Drafts saved in this browser; nothing executes them. COMING SOON in the public testnet beta |
| Telegram bot, $KIT | Not live |

## Tests

```bash
npm test              # unit + integration (real services against a fake chain), no network
npm run e2e           # Phase 1 suite, 28 steps, against the demo server (5198)
npm run e2e:real      # real-mode suite, 13 steps, against dev:e2e (5202); fake network, no live calls
npm run e2e:real -- --width 390   # the same suite at phone width (also run at 768)
npm run e2e:beta      # the public beta's COMING SOON features in a production build (port 5204)
npm run smoke:live    # opt-in: read-only checks against live testnet and mainnet endpoints
npm run check         # typecheck + lint + unit tests + production build
```

`e2e`, `e2e:real` and `shots` drive the Chromium that Playwright installed under `%LOCALAPPDATA%\ms-playwright` (or `CHROME_PATH`).

## Testnet checklist (before enabling mainnet)

NearKit can't create accounts or sign for you, so this is done by hand with your own testnet wallet (Meteor or Intear, funded from the testnet faucet). Run `npm run dev` and:

1. Connect the wallet. The top bar shows your `.testnet` account and the chip reads `NEAR · TESTNET`.
2. Positions shows your NEAR balance, matching the wallet's.
3. Batch Send 0.01 NEAR to a second testnet account. The review shows network, source, recipient and amount; after signing, the modal says **Confirmed** with an explorer link that opens the transaction on testnet.nearblocks.io.
4. Swap 0.5 NEAR to USDT (`usdt.itachicara.testnet`). The review shows the Rhea route, minimum received and "NearKit fee: Not charged". After confirmation the USDT balance appears.
5. Batch Send some USDT to an account that never held it. The review shows "Registers with the token contract" and the storage deposit; the recipient receives the tokens.
6. Split USDT to two accounts with custom percentages; each receives the exact amount shown.
7. Reject a signature in the wallet: the modal says **Nothing was sent**.
8. Consolidate from two accounts: NearKit pauses and asks you to connect the second account before its step.

Only after all eight pass, build with `VITE_NEAR_NETWORK=mainnet`, `VITE_NEARKIT_FEE_RECIPIENT=<fee account>` and `VITE_ENABLE_MAINNET_EXECUTION=true`, and repeat steps 3 to 7 with small amounts.

## Operator tasks (mainnet fee account)

The NearKit trading fee is 0.10% (10 bps) on Swap and Quick Trade. Rhea's aggregator (`aggregatedex.near`) collects it as an app fee: NearKit's account receives 0.08%, Rhea keeps 0.02%, and Rhea charges its own 0.10% protocol fee on every swap. Fees accrue as an internal balance on the aggregator, not as transfers. Split, Consolidate and Batch Send carry no NearKit fee. The future 2% buy and sell fee on $KIT belongs to its launch through Nearly; it is separate from this fee and not implemented here.

1. **Register the fee account** with the aggregator for the five fee-whitelist tokens (wNEAR, USDC, USDt, USDC.e, USDT.e), 0.005 NEAR each. When a swap's fee lands in another token, NearKit adds that one registration to the user's transaction and shows it as a storage cost.

   ```bash
   near contract call-function as-transaction aggregatedex.near tokens_storage_deposit json-args '{"user":"<fee account>","tokens":["wrap.near","17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1","usdt.tether-token.near","a0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.factory.bridge.near","dac17f958d2ee523a2206206994597c13d831ec7.factory.bridge.near"]}' prepaid-gas '30.0 Tgas' attached-deposit '0.025 NEAR' sign-as <fee account> network-config mainnet sign-with-keychain send
   ```

2. **See accrued fees:**

   ```bash
   near contract call-function as-read-only aggregatedex.near query_user_exist_balance json-args '{"user":"<fee account>","from_index":0,"count":50}' network-config mainnet now
   ```

3. **Withdraw** a token's balance to the fee account (`return_near: true` unwraps wNEAR):

   ```bash
   near contract call-function as-transaction aggregatedex.near withdraw json-args '{"token":"wrap.near","return_near":true}' prepaid-gas '300.0 Tgas' attached-deposit '1 yoctoNEAR' sign-as <fee account> network-config mainnet sign-with-keychain send
   ```

4. **If Rhea rotates its route-signing key**, every mainnet quote fails verification and NearKit refuses to sign. Update `signerKey` in `src/config/networks.ts` from the aggregator's code, then rebuild. `npm run smoke:live` detects this.

5. **Updating the wallet list.** NearKit never fetches NEAR Connect's live wallet manifest: it lives on a mutable branch, and it decides each wallet's code URL and which page objects that code may call. The reviewed copy is `src/config/walletManifest.ts`. To take in new wallets or versions:
   1. Fetch the live manifest from `https://raw.githubusercontent.com/hot-dao/near-selector/refs/heads/main/repository/manifest.json`, which NEAR Connect 0.11.4 reads first.
   2. Diff it against `walletManifest.ts`.
   3. For every changed entry, read the new executor code and its `permissions` (especially `external`).
   4. Pin GitHub-hosted executors to the reviewed commit (`raw.githubusercontent.com/<owner>/<repo>/<commit>/<path>`), never a branch.
   5. Run `npm test`, then connect each changed wallet on testnet.

   Any changed executor URL changes the pin, which clears NEAR Connect's cached wallet code for every user on their next visit. Intear, NEAR Mobile and Trezu serve their code from their own domains, so it can't be pinned; trusting it is trusting that wallet.

## Deploying

`npm run build` writes a static site to `dist/`. Serve `index.html` for every path that isn't a file, since routes live in the browser. Send these headers on every response; `npm run preview` sends the same set (`vite.config.ts`), and `vercel.json` sets both on Vercel.

| Header | Value | Why |
|---|---|---|
| `Content-Security-Policy` | `frame-ancestors 'none'` | No other site can frame NearKit; the app also refuses to connect or sign when framed |
| `X-Frame-Options` | `DENY` | The same for older browsers |
| `Cross-Origin-Opener-Policy` | `same-origin-allow-popups` | A page that opens NearKit in a new window loses its handle on it. Wallet popups keep working; plain `same-origin` breaks them |
| `X-Content-Type-Options` | `nosniff` | Files are only run as the type they are served as |
| `Referrer-Policy` | `strict-origin-when-cross-origin` | Other hosts see the origin, never the page path |

Checked on 2026-09-28 against the production build with these headers:
- NEAR Connect's wallet frames still run, both classic and module scripts. They are sandboxed `srcdoc` documents that inherit the page's policy.
- Meteor's connect screen opens, and cancelling it reads "You closed or rejected the request".

A full script and connect CSP is not shipped yet. NEAR Connect runs each wallet's code inline in a frame that inherits the page's CSP, so that policy has to meet three conditions:
- Allow that code with a nonce minted for each response and passed to `NearConnector` as `cspNonce`. A static host can't mint one; it takes an edge function or a server.
- Allow inline styles: NEAR Connect injects `<style>` elements without a nonce.
- List every RPC, indexer, price, Rhea and wallet host in `connect-src`.

Roll it out as `Content-Security-Policy-Report-Only` on a preview deployment first, and enforce it only after connect and sign work with every listed wallet.

## Security model

- NearKit never asks for, stores or transmits a seed phrase or private key, and asks for no function-call key when connecting. The wallet signs; NearKit only builds transactions and reads the chain.
- Every value-moving action is a plan the user reviews first. The review shows:
  - the network and source account;
  - the full account ID of every recipient and the full contract of every token;
  - exact amounts;
  - each storage registration, with whom it registers and what it costs;
  - gas bought upfront;
  - the fee and its split;
  - slippage and minimum received.

  Look-alike recipients and token symbols are flagged.
- **One executor runs every plan.**
  - Before the wallet is asked, it checks the mainnet switch, the network, the fee account and the quote's expiry.
  - It confirms each transaction through NearKit's own RPC. A result counts only if its signer, receiver and actions match the plan. Success means the chain said so.
  - Plans are single-use: once any part of a plan has reached the wallet, it can't be started again, and an error after signing shows the results, not the review.
  - **"Nothing was sent"** appears only when NearKit refused before asking the wallet, or when the wallet reported a rejection and the signer's access-key nonces didn't move. Anything else reads "unknown", with the explorer as the source of truth.
- **Mainnet routes from Rhea** are verified before signing:
  - their signature is checked;
  - they are decoded, and only an exact set of fields is accepted at each level;
  - each field is compared with the request: signer, recipient, fee rate and account, amounts, tokens, DEX contracts, referral and minimums;
  - the signed minimum must sit within the chosen slippage of the signed expected output.
- **Storage deposits** are set by token contracts. NearKit warns above 0.0125 NEAR and refuses the token above 0.1 NEAR per registration.
- **Token decimals** are re-read from the chain when a plan is prepared, and cached metadata with a future timestamp is ignored.
- **The wallet list** is vendored and pinned (operator task 5). NEAR Connect's auto-connect is off, stale debug wallets are cleared on start, and NearKit refuses to connect a wallet while framed.

### Residual risks

These are known and accepted for now. Each needs a decision or infrastructure beyond this repository.

- **Wallets that ignore the requested signer.** NearKit asks the wallet to sign as a specific account. A wallet that signs with its active account instead moves that account's funds. NearKit then reports the signer mismatch, but only after the transaction has run.
- **Wallet code shares NearKit's storage.** NEAR Connect gives wallet code a storage area inside NearKit's own `localStorage`. If a wallet kept key material there, a script injection into NearKit could read it. NearKit renders no raw HTML and never shows token icons, and a full CSP (see Deploying) is the next layer.
- **RPC trust.** Balances, token decimals and outcomes come from the configured RPC providers. A malicious provider, including a `VITE_NEAR_RPC_URL` override, can misreport all of these. A spoofed decimals value makes a typed amount send more than intended. Point NearKit only at providers you trust. Cross-checking decimals across two providers would close this.
- **Price feeds.** Price impact is computed from Rhea's price feed, so a wrong feed can hide a bad route. The minimum received comes from the signed route and is checked against your slippage, and it is the binding limit.
- **Tokens opened by link.** A link such as `/swap?to=<contract>` opens any contract without an explicit import. The review shows the full contract and warns when its symbol copies a known token.
- **Testnet routes** come unsigned from a third-party server. NearKit checks them against the request, and testnet carries no fee.
- **Rhea's DEX contracts** may honour route fields NearKit hasn't audited. The exact-field allowlists refuse any field they don't know, and single-use plans stop a route from being replayed from NearKit.

See `PHASE2_IMPLEMENTATION.md` for the full design, research and decisions, `DESIGN.md` for the visual system and `PRODUCT.md` for product truth.

## Architecture

```
UI (pages, features, components)
  │  only hooks from src/services/queries.ts
  ▼
TanStack Query hooks ──► NearKitServices interfaces (src/services/types.ts)
                            ├─ real/  NEAR: wallet, RPC, indexers, Rhea, executor
                            └─ mock/  demo simulator
```

```
src/
  config/      env validation, networks (every host and contract)
  services/
    near/      RPC client, accounts, tokens, storage, plans, executor, outcomes, errors, wallet adapters
    rhea/      aggregator quotes and route checks, classic router, fee math, swap transactions
    real/      service implementations, local stores, activity, scanner
    mock/      demo implementation
  features/    trade/ multi/ split/ consolidate/ batch/ wallets/ orders/ scanner/ portfolio/ tools/
  components/  ui/ domain/ chart/ brand/ page/
  lib/         amounts (BigInt), format, fees, validation, batch parser, wallet overlay
scripts/       e2e.mjs (demo), e2e-real.mjs + lib/fake-near.mjs (real mode), shoot.mjs
```
