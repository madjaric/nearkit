# NEARKITS

[![CI](https://github.com/madjaric/nearkit/actions/workflows/ci.yml/badge.svg)](https://github.com/madjaric/nearkit/actions/workflows/ci.yml)

The trading toolkit for NEAR. Phase 2 runs on the real NEAR network: wallet connection through NEAR Connect, balances and token metadata read from chain, NEP-141 transfers (Batch Send, Split, Consolidate), and swaps routed across Rhea's aggregator, Rhea's classic router and Ref's DCL exchange directly: any NEAR token with an executable route trades, listed or not (see "Routing"). The Phase 1 demo still ships as a separate mode.

Mainnet execution is **off by default**. Prove the testnet checklist below before turning it on.

## Public site

**https://nearkits.com** is NEARKITS' public site (www.nearkits.com redirects to it). Vercel deploys it from `main`; https://nearkit.vercel.app serves the same deployment as a fallback address, and pull requests get preview deployments. The table below is the original testnet beta configuration; production runs on mainnet.

| Vercel variable (Production and Preview) | Value |
|---|---|
| `VITE_NEARKIT_SERVICES` | `near` |
| `VITE_NEAR_NETWORK` | `testnet` |
| `VITE_ENABLE_MAINNET_EXECUTION` | `false` |

Nothing else is set, and none of it is secret. The network chip reads TESTNET BETA. Testnet tokens have no value, and mainnet value-moving execution is off.

The beta ships Swap and Quick Trade, Multi Trade, Split, Consolidate, Batch Send, Wallets, Positions, PnL and Scanner.

**Coming soon:** Limit Orders, DCA, Copy Trade and Sniper (plus Telegram, live only in a build that names a running NEARKITS server).
- Their pages, code and tests stay. In the beta the sidebar lists them last, in a COMING SOON group with SOON tags, and their pages show COMING SOON with every field and key disabled.
- The list is `BETA_COMING_SOON` in `src/config/release.ts`; remove a route there to ship it. [COMING_SOON.md](COMING_SOON.md) says what each held-back feature still needs.
- The hold applies to every production build of the real services, on testnet and mainnet: `npm run dev` and the e2e suites keep these features usable, and `npm run e2e:beta` checks the held-back state.

CI (`.github/workflows/ci.yml`) runs on every push to `main` and every pull request. It covers typecheck, lint, format check, unit and integration tests, and the production build. The e2e suites and live smoke checks run locally (see Tests).

## Run it

Requires Node 20+ (the workstation runs Node 21.5, which is why this uses Vite 6, React Router 7 and ESLint 9).

```bash
npm install
npm run dev            # real services on NEAR testnet       http://localhost:5196
npm run dev:demo       # the Phase 1 simulator, demo data     http://localhost:5198
npm run dev:mainnet    # mainnet (view-only unless enabled)   http://localhost:5200
npm run preview:mainnet  # mainnet production build, local     http://localhost:5199 (MAINNET_SMOKE_TEST.md)
npm run dev:e2e        # testnet + scripted test wallet       http://localhost:5202
npm run build          # typecheck + production build (dist/)
npm run preview        # serves dist/ on http://localhost:5197
```

| Mode | Services | What signs |
|---|---|---|
| `near` on testnet (default) | wallet, RPC, indexers, Rhea classic router, DCL v2 directly | your wallet; no NEARKITS fee |
| `near` on mainnet | same, Rhea aggregator and DCL v2 directly for swaps | your wallet, only when `VITE_ENABLE_MAINNET_EXECUTION=true` |
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
| `VITE_NEARKIT_FEE_RECIPIENT` | none | account that receives the NEARKITS app fee; without it mainnet trades are blocked. Production: `nearkitfee.near`, set in `.env.mainnet` |
| `VITE_KIT_TOKEN_CONTRACT` | none | a stand-in $KITS contract for a test build; mainnet and the demo use `kits.nearlytrade.near` |

Every external host and contract lives in `src/config/networks.ts`, verified live on 2026-09-28.

## What is real, and what isn't

| Area | Status |
|---|---|
| Wallet connect, restore, disconnect, multiple accounts | Real (NEAR Connect: Meteor, Intear, Ledger, Nightly and others per network) |
| NEAR and NEP-141 balances | Real: `view_account` and `ft_balance_of`; indexers only suggest which tokens to check |
| Token metadata, import by contract | Real, validated (`ft_metadata`, `ft_total_supply`) |
| Batch Send, Split, Consolidate | Real: exact amounts, recipient checks, NEP-145 registration, chunking, per-transaction status |
| Swap, Quick Trade | Real: every route source is asked and the best executable route wins (see "Routing"): Rhea's aggregator on mainnet (NEARKITS' 0.50% app fee), Rhea's classic router on testnet (no fee), Ref's DCL v2 pools directly on both (0.50% transferred with the swap on mainnet). The review names the source |
| Multi Trade | Real: one verified route per wallet, signed wallet by wallet. No all-or-nothing: it stops at a failed step or an expired quote, wallets already done keep their swaps, and wallets that can't cover their share are left out |
| Wallet classes | NEARKITS wallets (custody, signed in with the bot's `/web` link) buy, sell, join a Multi Buy or Multi Sell and send right on the web: NEARKITS' server executes each wallet's own transactions, nothing is confirmed in Telegram. Connected accounts sign in their own wallet; watched accounts are observe-only, and the services and the server refuse them anywhere funds move |
| Token screen (`/token/:id`) | Where search leads. Market data from the sources that have it, each figure naming its source or why it's missing: DEX Screener's deepest indexed pair (price, 24h change, liquidity, 24h volume, FDV), NEAR itself from Coinbase and CoinGecko, and a market cap only when CoinGecko knows a circulating supply (via GeckoTerminal), never the FDV relabelled. Chart: real candle closes over 1H to 1M (GeckoTerminal's for the pair, Coinbase's for NEAR), then the live price; gaps are never filled in. Live activity: recent buys and sells against NEAR from FastNEAR's transaction index, classified by the same code as PnL. Whether the token is in your own list is shown apart from all of that; whether a trade has an executable route shows in the quote, with each source's own reason when it doesn't. Buy, Sell and Send open the existing flows |
| Transaction history | Real for operations sent from this browser, reconciled with the chain |
| Scanner | Real: every figure is labelled verified, derived or unknown; never safe/scam |
| Positions, PnL | Real: balances from chain, Rhea prices, average-cost PnL from each account's on-chain history (see "Positions and PnL") |
| Limit/TP/SL, DCA, Copy Trade, Sniper | Drafts saved in this browser; nothing executes them. COMING SOON in the public testnet beta |
| Telegram bot | Real, in `server/` (see `server/README.md`): linking, NEARKITS wallets (up to 10) with Buy/Sell and owner-approved withdrawals right in Telegram (custody on testnet; mainnet waits for the owner's ceremony), buy/sell signed in the linked wallet, buybot, invites, /positions and /pnl. Needs a hosted server; until then the web page stays COMING SOON |
| $KITS (Near Kits, `kits.nearlytrade.near`) | Live on mainnet: its page, token facts, tokenomics, a Buyback & Burn tracker that waits for an on-chain source (no figures until one reads the chain), holder rewards COMING SOON |

## Tests

```bash
npm test              # unit + integration (real services against a fake chain), no network
npm run e2e           # Phase 1 suite, 28 steps, against the demo server (5198)
npm run e2e:real      # real-mode suite, 22 steps, against dev:e2e (5202); fake network, no live calls
npm run e2e:real -- --width 390   # the same suite at phone width (also run at 768)
npm run e2e:beta      # the public beta's COMING SOON features in a production build (port 5204)
npm run e2e:telegram  # the built server + web app with Telegram and NEAR faked over HTTP
npm run smoke:live    # opt-in: read-only checks against live testnet and mainnet endpoints
npm run check         # typecheck + lint + unit tests + production build
```

`e2e`, `e2e:real` and `shots` drive the Chromium that Playwright installed under `%LOCALAPPDATA%\ms-playwright` (or `CHROME_PATH`).

## Positions and PnL

One engine, `src/lib/pnl.ts`, computes every PnL figure NEARKITS shows: the Positions and PnL pages, and the Telegram bot's `/positions` and `/pnl`. Its header defines each term.

- **Method:** weighted average cost, per token and per account. NEAR figures are exact (from on-chain amounts); USD figures use NEAR/USD at the hour of each trade (Coinbase hourly candles). On mainnet, USDC and USDt count at face value. Testnet has no USD prices, so its figures are in NEAR.
- **History:** each account's transactions come from FastNEAR's transaction index (`tx.main.fastnear.com`, `tx.test.fastnear.com`), up to the latest 600 per account. Buys and sells are read from the receipts that succeeded (`src/services/near/flows.ts`, the same analyzer the buybot uses). A trade's value is what moved, so NEARKITS' fee, Rhea's fees and the gas the account paid are inside it. Storage deposits are not trades.
- **Never guessed:**
  - Tokens that arrived by transfer, or through a token-for-token swap, have no known cost. They are tracked apart and left out of cost and PnL.
  - When the history doesn't explain the balance on chain (older than 600 transactions, or not indexed), the figures say "partial" and why.
  - A missing price leaves unrealized PnL unknown, not zero.
- **Share card:** the PnL page and each position can export their figures as a 1200×630 PNG (`src/features/portfolio/pnlCard.ts`). The card marks partial figures and demo data, and shows the account only if the user adds it.

## Routing

NEARKITS is a router over NEAR's DEXes, not a front end for one of them. Every quote asks every source that can trade the pair, in parallel, and the best executable route wins (`src/services/real/swapRouting.ts`, `src/services/routing/select.ts`).

| Source | Where | Quoted from | NEARKITS fee |
|---|---|---|---|
| Rhea aggregator (`aggregatedex.near`) | mainnet | Rhea's quote server, a signed route | 0.50% app fee inside the swap (NEARKITS 0.40%, Rhea 0.10%) |
| Rhea classic router | testnet | Rhea's path finder | none (testnet) |
| Ref DCL v2 directly (`dclv2.ref-labs.near`, `dclv2.ref-dev.testnet`) | both | the pair's pools (four fee tiers, deterministic ids) and the contract's own `quote`, read from chain; directly, or through wNEAR or a stablecoin | 0.50% transferred with the swap (mainnet), none on testnet |

- A route is executable or it is nothing: its pools exist, run and have liquidity, the quote is for this amount, and the minimum sits one slippage below it. Rhea's "token not routed" (code 1008) is one source's answer, not a verdict.
- Selection is deterministic: the highest net expected output after every fee; a Rhea route within 0.25% of the best keeps Rhea (production-proven). The review and the Telegram quote name the source ("Route NEAR → SINGULARTY · DCL").
- Token lists are a convenience of the UI. Any valid NEP-141 contract trades the moment a route exists for it, with no import: a pool created today is routable today, because pool state is read from the contract, not from an index.
- No token is special-cased: there is no "if token X then DEX Y". SINGULARTY (`singularty.nearlytrade.near`), which Rhea does not index, trades through the generic DCL adapter like any other pair with a pool.
- When no source can route the pair, the ticket says "No executable route found for NEAR → X right now." followed by each source's own reason, never "not supported" or "not listed".
- The client (web page or Telegram) only ever submits an intent: token, side, amount, slippage. The server resolves and validates the route and builds the only transaction shapes it supports; the signer re-checks every fact on its own (see "Security model"). Multi Trade routes each wallet separately, and each wallet signs its own transactions.
- Not yet a source: Ref's classic v1 pools directly (no on-chain token-to-pool index; Rhea's router covers them), and limit orders on DCL (see [COMING_SOON.md](COMING_SOON.md)).

## Testnet checklist (before enabling mainnet)

NEARKITS can't create accounts or sign for you, so this is done by hand with your own testnet wallet (Meteor or Intear, funded from the testnet faucet). Run `npm run dev` and:

1. Connect the wallet. The top bar shows your `.testnet` account and the chip reads `NEAR · TESTNET`.
2. Positions shows your NEAR balance, matching the wallet's.
3. Batch Send 0.01 NEAR to a second testnet account. The review shows network, source, recipient and amount; after signing, the modal says **Confirmed** with an explorer link that opens the transaction on testnet.nearblocks.io.
4. Swap 0.5 NEAR to USDT (`usdt.itachicara.testnet`). The review shows the Rhea route, minimum received and "NEARKITS fee: Not charged". After confirmation the USDT balance appears.
5. Batch Send some USDT to an account that never held it. The review shows "Registers with the token contract" and the storage deposit; the recipient receives the tokens.
6. Split USDT to two accounts with custom percentages; each receives the exact amount shown.
7. Reject a signature in the wallet: the modal says **Nothing was sent**.
8. Consolidate from two accounts: NEARKITS pauses and asks you to connect the second account before its step.

Only after all eight pass, run the controlled mainnet smoke test in [MAINNET_SMOKE_TEST.md](MAINNET_SMOKE_TEST.md). It is a local production build with very small amounts; the public site stays on the testnet beta.

## Operator tasks (mainnet fee account)

The production fee account is `nearkitfee.near` (owner decision, 2026-09-29); `<fee account>` below is that account.

The NEARKITS trading fee is 0.50% (50 bps) on Swap and Quick Trade. It is set in one place, `NEARKIT_FEE` in `src/lib/fees.ts`, and everything derives from it: quotes on the web and in Telegram, the rate Rhea is asked to collect, the route checks, reviews, docs and tests.

Rhea's aggregator (`aggregatedex.near`) collects the fee as an app fee. NEARKITS' account receives 0.40% and Rhea keeps 0.10% (20% of the app fee). Rhea also charges its own separate 0.10% protocol fee on every swap, and pools charge their own fees. `feeLedger` is ready for referrals: it splits a collected fee into Rhea's share, what NEARKITS received, a referrer's share and NEARKITS' net. Referrals are off. Fees accrue as an internal balance on the aggregator, not as transfers. Split, Consolidate and Batch Send carry no NEARKITS fee. $KITS' own 2% buy and sell tax belongs to the token contract (its launch through Nearly); it is separate from this fee and not implemented here.

On a direct DCL route the aggregator is not involved, so the fee is a transfer: `floor(amountIn × 0.50%)` of the input token goes to `<fee account>` by `ft_transfer` in the same transaction as the swap, before the exchange receives the rest (`src/services/dcl/swap.ts`, `src/services/rhea/swapTransactions.ts`). NEARKITS receives all of it (no router share); the pool's own fee is in the rate. It is never charged twice: a route is either an aggregator route with the app fee or a direct route with the transfer. The fee account must be registered on the fee token (read live on 2026-10-03, `nearkitfee.near` is registered on neither `wrap.near` nor new tokens); the plan adds that one-time `storage_deposit`, paid by the trader and shown in the review. Known limit: when the exchange refunds a swap after the transfer (the price moved past the slippage between the final re-quote and execution), the fee stays with NEARKITS; the review says so, and collecting after delivery would need a NEARKITS contract on chain.

Launch tokens that tax their own pool are quoted after the tax (`src/services/dcl/tax.ts`). nearlytrade launches answer `get_tax` with `buy_bps` (taken from tokens leaving a pair), `sell_bps` (taken from tokens entering one) and the pairs that count; `singularty.nearlytrade.near` read 1% / 1% / `dclv2.ref-labs.near` on 2026-10-03. A sell is quoted for what the pool receives after the sell tax, so the minimum in the swap message holds and the swap does not revert; a buy's expected and minimum amounts are shown after the buy tax, while the message's minimum stays the pool's (the custody policy and the signer accept a message minimum above the user's, never below). The fee transfer to `<fee account>` is not to a pair, so it is not taxed. The review and the Telegram quote state the tax.

1. **Register the fee account** with the aggregator for the five fee-whitelist tokens (wNEAR, USDC, USDt, USDC.e, USDT.e), 0.005 NEAR each. When a swap's fee lands in another token, NEARKITS adds that one registration to the user's transaction and shows it as a storage cost.

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

4. **If Rhea rotates its route-signing key**, every mainnet quote fails verification and NEARKITS refuses to sign. Update `signerKey` in `src/config/networks.ts` from the aggregator's code, then rebuild. `npm run smoke:live` detects this.

5. **Updating the wallet list.** NEARKITS never fetches NEAR Connect's live wallet manifest: it lives on a mutable branch, and it decides each wallet's code URL and which page objects that code may call. The reviewed copy is `src/config/walletManifest.ts`. To take in new wallets or versions:
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
| `Content-Security-Policy` | `frame-ancestors 'none'` | No other site can frame NEARKITS; the app also refuses to connect or sign when framed |
| `X-Frame-Options` | `DENY` | The same for older browsers |
| `Cross-Origin-Opener-Policy` | `same-origin-allow-popups` | A page that opens NEARKITS in a new window loses its handle on it. Wallet popups keep working; plain `same-origin` breaks them |
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

- NEARKITS never asks for, stores or transmits a seed phrase or private key, and asks for no function-call key when connecting. The wallet signs; NEARKITS only builds transactions and reads the chain.
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
  - It confirms each transaction through NEARKITS' own RPC. A result counts only if its signer, receiver and actions match the plan. Success means the chain said so.
  - Plans are single-use: once any part of a plan has reached the wallet, it can't be started again, and an error after signing shows the results, not the review.
  - **"Nothing was sent"** appears only when NEARKITS refused before asking the wallet, or when the wallet reported a rejection and the signer's access-key nonces didn't move. Anything else reads "unknown", with the explorer as the source of truth.
- **Mainnet routes from Rhea** are verified before signing:
  - their signature is checked;
  - they are decoded, and only an exact set of fields is accepted at each level;
  - each field is compared with the request: signer, recipient, fee rate and account, amounts, tokens, DEX contracts, referral and minimums;
  - the signed minimum must sit within the chosen slippage of the signed expected output.
- **Direct DCL routes** are built by NEARKITS from pool state read on chain, never from anything the client sends, and checked before signing (and again by the signer itself, for NEARKITS wallets: `server/src/custody/policy.ts`, `server/src/signer/routes.ts`): the swap goes to the network's DCL contract; the pools connect the input to the output and match the route's tokens; the message is exactly the canonical `Swap` with the verified minimum; the fee transfer is exactly 0.50% of the input to the one fee account and the exchange receives exactly the rest (no fee on testnet); registrations are of the wallet or the fee account on route tokens only; nothing else is in the transaction; and the minimum sits within the slippage cap of the contract's own `quote`, which the signer reads from chain itself. A direct swap counts as done only once its output provably reached the wallet: the output token's transfer from the exchange, or the exchange's NEAR transfer for an unwrapped output (`src/services/near/outcome.ts`).
- **Storage deposits** are set by token contracts. NEARKITS warns above 0.0125 NEAR and refuses the token above 0.1 NEAR per registration.
- **Token decimals** are re-read from the chain when a plan is prepared, and cached metadata with a future timestamp is ignored.
- **The wallet list** is vendored and pinned (operator task 5). NEAR Connect's auto-connect is off, stale debug wallets are cleared on start, and NEARKITS refuses to connect a wallet while framed.

### Residual risks

These are known and accepted for now. Each needs a decision or infrastructure beyond this repository.

- **Wallets that ignore the requested signer.** NEARKITS asks the wallet to sign as a specific account. A wallet that signs with its active account instead moves that account's funds. NEARKITS then reports the signer mismatch, but only after the transaction has run.
- **Wallet code shares NEARKITS' storage.** NEAR Connect gives wallet code a storage area inside NEARKITS' own `localStorage`. If a wallet kept key material there, a script injection into NEARKITS could read it. NEARKITS renders no raw HTML and never shows token icons, and a full CSP (see Deploying) is the next layer.
- **RPC trust.** Balances, token decimals and outcomes come from the configured RPC providers. A malicious provider, including a `VITE_NEAR_RPC_URL` override, can misreport all of these. A spoofed decimals value makes a typed amount send more than intended. Point NEARKITS only at providers you trust. Cross-checking decimals across two providers would close this.
- **Price feeds.** Price impact is computed from Rhea's price feed, so a wrong feed can hide a bad route. The minimum received comes from the signed route and is checked against your slippage, and it is the binding limit.
- **Tokens opened by link.** A link such as `/swap?to=<contract>` opens any contract without an explicit import. The review shows the full contract and warns when its symbol copies a known token.
- **Testnet routes** come unsigned from a third-party server. NEARKITS checks them against the request, and testnet carries no fee.
- **Rhea's DEX contracts** may honour route fields NEARKITS hasn't audited. The exact-field allowlists refuse any field they don't know, and single-use plans stop a route from being replayed from NEARKITS.
- **A direct route refunded after the fee.** On a DCL route the fee leaves in the swap's own transaction, before the exchange runs; a swap the exchange refunds keeps the fee (rare: re-quoted right before signing, minimum enforced on chain). The review says so.
- **Transfer taxes NEARKITS can't read.** nearlytrade launches publish their tax (`get_tax`) and are quoted after it. A token that taxes transfers through some other interface is quoted as if untaxed: a sell of it can revert on the pool's minimum (the fee stays with NEARKITS, as above), a buy of it delivers less than shown, and NEARKITS reports what arrived. A token that lies in `get_tax` can only make quotes lower than reality; the signer's own quote still bounds the minimum.
- **The signer's floor on taxed sells.** The signer quotes the pool for the input as sent, without the token's sell tax, and refuses a message minimum more than 5% below that. A sell whose sell tax plus chosen slippage exceeds 5% is refused by the signer (fail closed); lower the slippage.

More documents:
- `PHASE2_IMPLEMENTATION.md`: the full design, research and decisions.
- [NEARKIT_TELEGRAM_V2_ARCHITECTURE.md](NEARKIT_TELEGRAM_V2_ARCHITECTURE.md): Telegram-native trading. What is implemented, the signer policy, idempotency, recovery, referrals, the threat model and what mainnet still needs.
- [SECURITY_REVIEW.md](SECURITY_REVIEW.md): ten compromise scenarios and the residual risks.
- [DEPLOYMENT.md](DEPLOYMENT.md): the production topology and operations.
- [MAINNET_CEREMONY.md](MAINNET_CEREMONY.md): the owner's go-live steps, prepared and not run.
- `DESIGN.md`: the visual system.
- `PRODUCT.md`: product truth.
- `server/README.md`: the bot, the signer, the buy bot and their commands.

## Architecture

```
UI (pages, features, components)
  │  only hooks from src/services/queries.ts
  ▼
TanStack Query hooks ──► NearKitServices interfaces (src/services/types.ts)
                            ├─ real/  NEAR: wallet, RPC, indexers, Rhea, DCL, executor
                            └─ mock/  demo simulator
```

```
src/
  config/      env validation, networks (every host and contract)
  services/
    near/      RPC client, accounts, tokens, storage, plans, executor, outcomes, errors, wallet adapters
    rhea/      aggregator quotes and route checks, classic router, fee math, swap transactions
    dcl/       Ref DCL v2: pool ids and state, on-chain quotes and paths, swap messages, the direct-route fee
    routing/   route selection across sources: net output, Rhea kept when equivalent
    real/      service implementations, local stores, activity, scanner
    mock/      demo implementation
  features/    trade/ multi/ split/ consolidate/ batch/ wallets/ orders/ scanner/ portfolio/ tools/
  components/  ui/ domain/ chart/ brand/ page/
  lib/         amounts (BigInt), format, fees, validation, batch parser, wallet overlay
scripts/       e2e.mjs (demo), e2e-real.mjs + lib/fake-near.mjs (real mode), shoot.mjs
```
