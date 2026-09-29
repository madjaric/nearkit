# COMING SOON inventory

This is every feature the public beta has marked COMING SOON, checked on 2026-09-29.

A feature leaves COMING SOON only when all of these hold:
- what it does is real;
- it is tested;
- its failure states are handled.

Having a page is not enough. The gate is `BETA_COMING_SOON` in `src/config/release.ts`, and `npm run e2e:beta` checks it.

Each feature has one category:

| | Category |
|---|---|
| **A** | can be built properly now |
| **B** | needs another external service or API |
| **C** | needs product decisions first |
| **D** | needs custody or signing architecture that NearKit doesn't have |
| **E** | should stay COMING SOON |

| Feature | Category | Status |
|---|---|---|
| PnL | A | **Shipped** in the beta |
| Multi Trade | A | **Shipped** in the beta |
| Limit Orders (limit, take-profit, stop-loss) | C, and D for stop-loss | COMING SOON |
| DCA | D | COMING SOON |
| Copy Trade | D, and C for an alerts-only version | COMING SOON |
| Sniper | D and B, so E | COMING SOON |
| Telegram | B (hosting) | Built; COMING SOON on the site until its server is hosted |
| $KIT | E and C | Not launched |

## Shipped

### PnL

- **How it works:** average cost from each account's on-chain history (FastNEAR's transaction index), with one engine for web and Telegram (`src/lib/pnl.ts`).
- **Tests:** unit and integration, plus an e2e step on the beta build.
- **When it can't be exact:** figures that history can't support are marked partial, with the reason. This covers capped history, a balance the history doesn't explain, costs that aren't known, and missing prices.

### Multi Trade

- **How it works:** one route per wallet, verified by the same checks as Swap, and signed wallet by wallet through the shared executor.
- **Tests:** integration tests cover a failed first wallet, a quote that expires between wallets, a disconnected wallet, and an underfunded wallet. e2e covers success and an underfunded wallet being skipped.
- **Fixed before shipping:**
  - Wallets allocated nothing were sent to the router.
  - Wallets marked "will be skipped" reached the review anyway.
  - A multi sell's fee showed as 0 NEAR when Rhea takes it in the input token.

## Limit Orders: C, and D for stop-loss

- **Today:** orders are validated drafts saved in the browser. Nothing watches the price or executes them.
- **A real path exists:** Rhea DCL v2 limit orders are on chain and non-custodial, and the pool fills them when the price crosses. DCL v2 is `dclv2.ref-labs.near` on mainnet (2,085 pools) and `dclv2.ref-dev.testnet` on testnet (464 pools), both read live on 2026-09-29. That path would cover a limit buy below the price and a take-profit sell above it, for pairs that have a DCL pool.
- **Decisions needed first:**
  1. **Fee.** The NearKit fee (0.50%) is collected by Rhea's aggregator, and DCL orders don't go through it. Choose between no fee on limit orders and another fee mechanism.
  2. **Expiry.** DCL orders don't expire. The 1h, 24h, 7d and 30d options would have to go, or be done by manual cancel.
  3. **Price unit.** Orders fill at a NEAR-per-token price. A USD trigger would drift with NEAR's price.
  4. **Stop-loss.** It can't be a DCL order, because a sell below the price fills at once. It needs a keeper that signs for the user (D).

## DCA: D

A DCA plan buys on a schedule while the user is away, so something has to sign for them.

No DCA contract exists on NEAR at the likely names (`dca.ref-labs.near`, `dca.rhea.near`, `dca-v1.ref-labs.near` don't exist). The options are:
- a NearKit keeper holding a limited function-call key per user, with allowance and receiver limits;
- a custody service.

Both are a security design NearKit doesn't have. Today plans are drafts, and nothing runs.

## Copy Trade: D, or C for an alerts-only version

Watching a wallet's trades is possible with what exists: the buybot's FastNEAR follower and the shared trade analyzer (`src/services/near/flows.ts`). Copying them automatically means signing without the user (D).

A non-custodial version is buildable now if the product wants it (C). It would be "copy alerts": a Telegram message for each trade by the followed wallet, with a one-tap trade prepared through the existing handoff and signed in the user's wallet.

## Sniper: D and B, so E

Buying in a token's first blocks needs:
- automatic signing (custody or a keeper, D);
- launch detection per launchpad (B).

It also carries the highest risk of loss. It should stay COMING SOON until the signing architecture exists.

## Telegram: B (hosting)

The bot and its API are built and tested in `server/` (see `server/README.md`):
- account linking;
- NearKit wallets (up to 10 per user) with Buy/Sell, owner-approved withdrawals and recovery right in Telegram. Custody is on testnet; mainnet waits for the owner's ceremony (MAINNET_CEREMONY.md);
- invites (referrals);
- buy and sell from a linked wallet, signed in the wallet;
- the buybot;
- `/positions` and `/pnl`.

The site's Telegram page goes live on its own when a build sets `VITE_NEARKIT_API_URL` and `VITE_TELEGRAM_BOT`. What's missing is hosting: a long-running host with HTTPS, and for mainnet the signer, PostgreSQL and a KMS key ([DEPLOYMENT.md](DEPLOYMENT.md)). Vercel's static hosting can't run the server.

## $KIT: E and C

The token hasn't launched. Its launch through Nearly and its tokenomics are product decisions. The 2% buy and sell fee on $KIT is separate from NearKit's trading fee and is not implemented here.
