# Launch Radar and Top Wallets

Two analytics tools: **Launch Radar** (new NEAR tokens and their markets) and **Top Wallets**
(wallets ranked by verifiable trading performance). Discovery only: nothing here trades. A Trade
action opens the existing token page, where the user reviews and confirms as anywhere else.

This file is the methodology of record. The formulas below are implemented as pure functions in
`server/src/discovery/accounting.ts` and `src/features/discovery/model.ts` and tested there; the
pages print the same rules.

## Data sources (verified 2026-10-16)

| Source | Used for | Access | Notes |
|---|---|---|---|
| **Intear API** `api.intea.rs` | Tokens (creation block and time, dev account, price, liquidity, volume, buys/sells, traders, holders count, main pool, reputation); chain-wide swaps by trader with USD value; holders; candles | Free, keyless, CORS open | No published rate limit or terms; "credits" are reported but not charged. Called **server-side only**, one request at a time, and cached. Trade history starts 2026-09-18 (the indexer's start). Covers Ref v1, Ref DCL (Rhea), the Rhea router's per-pool legs, Aidols and Intear pools. |
| **NEAR RPC** (existing failover list) | Launchpad validation: a parent account has a deployed contract (`view_account`) | Free | Account structure is on-chain fact: only `x.near` can create `token.x.near`. |
| Not used | GeckoTerminal (10 calls/min, storage/derivation limits), DEX Screener (no new-pairs endpoint; anti-compete clause), NearBlocks (free tier is personal use, 6/min), NEAR Lake (requester-pays) | | |

No API key, no paid provider. Nothing is fetched by a visitor's page load beyond NEARKITS' own
server, which reads each source once for everyone.

## Architecture

- **Server** (`server/src/discovery/`, behind `NEARKIT_DISCOVERY=on`, mainnet):
  - `intear.ts`: the client (timeouts, one request in flight, back-off on errors).
  - `launches.ts`: one query a minute for every token created in the last 7 days, with its market
    fields. Each launch is recorded once (`disc_tokens`, keyed by token): first block and time,
    dev account, parent account, source, and our first observation time. Launchpads are the
    parent accounts that have a contract and at least 3 launched tokens (`disc_sources`); known
    ones get their product name.
  - `trades.ts`: the chain-wide swap follower. It backfills oldest-first from the configured start,
    then follows the head, with a cursor in `meta` (`disc_trades_cursor`: last timestamp and id).
    Each page is applied in the same database transaction that moves the cursor, so a page is
    applied exactly once, even across a restart or a crash.
    It keeps per-wallet aggregates, not every trade: `disc_wallet_tokens` (the position state
    for average cost), `disc_wallet_days` (per-day realized PnL and counts), and `disc_wallets`
    (first and last activity). Trades in tokens launched in the last 7 days are also kept as rows
    (`disc_launch_trades`) for launch-to-wallet signals; pruned after 8 days.
  - `holders.ts`: top holders of recent launches that have a market (at most every 2 hours per
    token) for concentration and dev-holding flags.
  - `ranking.ts`: window aggregates, qualification and categories (pure, tested), cached for 2 minutes.
  - `routes.ts`: public POST routes (`/api/discovery/*`, rate-limited per IP) and session routes for
    followed wallets with Telegram alerts (`/api/web/discovery/*`).
  - One role lease (`discovery-indexer`) runs the indexer on one instance only.
- **Web** (`src/features/discovery/`): `/launch-radar`, `/launch-radar/:id`, `/top-wallets`,
  `/top-wallets/:id`. Sorting, filters, search, score weights and pagination run on the list the
  server returns (one cached list per period for everyone). Watchlist (tokens) and followed wallets
  are kept in the browser; a signed-in NEARKITS user can turn on Telegram alerts for a followed wallet.

## Launch Radar

- **Launch**: a NEP-141 token whose first block (Intear `created_at`) is within the period. The
  launchpad is the token's parent account when it is a validated launchpad; otherwise "Direct" with
  the first liquidity venue (the main pool: Rhea DCL, Ref v1, Intear, Aidols).
- **Verified facts**: the token account and its parent account (on-chain account structure: only
  `x.near` can create `token.x.near`). The first block and time, the deployer and the pools are
  Intear's report, labeled as such. Intear's first block is not checked on chain yet: for a few older
  tokens it is a later contract update (seen 2026-10-16: `token.v2.ref-finance.near`,
  `meta-token.near`, `sol.token.a11bd.near` existed before their reported block), so an established
  token can show up as a launch (Limitations).
- **Market figures** (Intear, refreshed every minute): price, change over 5m/1h/6h/24h, volume,
  liquidity, buys/sells, traders, holders. Absent values print "—", never zero.
- **Summary**: launches in the period; with an active market (main pool and liquidity > 0); their
  combined 24h volume and current liquidity.
- **Last**: newest first by creation time.
- **Last Best**: launches with an active market, ranked by the quality score (0-100):
  `score = 100 × Σ wᵢ·cᵢ / Σ wᵢ` with
  `c_liquidity = clamp(log10(liquidity_usd) / log10(50 000))`,
  `c_holders = clamp(log10(holders) / log10(1 000))`,
  `c_traders = clamp(log10(traders_24h) / log10(200))`,
  `c_buys = buys_24h / (buys_24h + sells_24h)` (0.5 under 5 trades),
  `c_reputation = Reputable 1, NotFake 0.75, Unknown 0.4, Spam 0`.
  Default weights 3, 2, 2, 1, 1; the page lets the user change them.
- **Top**: launches with liquidity ≥ $1,000 and ≥ 10 trades in 24h, ranked by price change over the
  period's window (1h → 1h, 6h → 6h, 24h and 7d → 24h). A launch younger than that window has no price
  that old, so Intear reports no change over it: such a launch is ranked by the longest shorter window
  Intear reports (24h → 6h → 1h → 5m), and the page names that window beside the figure. The change
  column of every tab reads the same way.
- **Risk flags** (each with its evidence): reputation Spam (Intear), liquidity under $1,000, no
  active market, top 10 holders over 50% of supply, dev account over 10% of supply. Pool, launchpad,
  token-contract and burn accounts are excluded from concentration. "No flags" is not "safe".
- **Tracked wallets**: how many distinct tracked wallets (qualified Top Wallets plus the user's
  followed wallets) traded the token in the period, with each trade's transaction.

## Top Wallets: accounting

Per wallet and token, in USD at each trade's own value (Intear's `usd_value`, priced the block
before), weighted average cost:

- Currency: NEAR (wNEAR) and USD stablecoins. Currency↔currency swaps are not token trades.
- A swap's legs are netted per wallet and transaction first, so a route through an intermediate
  token (A → B → C in one transaction) is a sale of A and a purchase of C, not a round trip in B.
- **Buy** (currency → token, or token → token): `qty += amount`, `cost += usd`.
- **Sell** of `q` units: matched part `m = min(q, qty)`. `realized += usd·m/q − cost·m/qty`;
  `cost −= cost·m/qty`; `qty −= m`. The unmatched part (units with no indexed buy: transfers in,
  buys before the index) adds `usd·(q−m)/q` to **unmatched proceeds**, never to PnL.
- A **closed trade** is a sale with a matched part; a win when its realized PnL is above zero.
- A position closes when what is left is under one millionth of what it held; its holding time
  counts from the buy that opened it.
- Gas is not included (NEAR gas is a fraction of a cent); pool fees and token taxes are inside the
  traded amounts. Liquidity provision is not a trade and is not counted.
- Transfers between wallets are not trades and never count as profit: a token received by transfer
  has no cost, so its sale is unmatched.

Window figures (7D, 30D, 90D; "Top 100" = the whole indexed history), from daily rows:

- **Realized PnL** = Σ realized. **Return %** = realized ÷ cost basis of the units sold.
- **Win rate** = wins ÷ closed trades. **Average gain / loss** = Σ gains ÷ wins, Σ losses ÷ losses.
- **Coverage** = matched sale value ÷ all sale value.
- **Window covered** (Top Wallets' summary): the window's days between the index start and the newest
  indexed swap, never up to "now" while the indexer is still catching up on history ("Partial").
- **Max drawdown** = the largest fall of cumulative realized PnL from a previous peak (daily).
- **Unrealized PnL** (estimate) = open quantity × current price − its cost, for positions built
  from indexed trades only.

## Top Wallets: ranking integrity

- **Qualified** for PnL ranking: at least 5 (7D), 10 (30D), 15 (90D, Top 100) closed trades; sales
  in at least 2 tokens; coverage ≥ 80%; at least 2 days between first and last indexed trade.
- Not qualified: listed only in the **Activity** ranking (trades and volume), never by PnL.
- **Automated**: more than 300 swap legs on any single day in the window. Flagged everywhere;
  excluded from Smart Money, Traders, Early Buyers and Fresh Wallets.
- **Smart Money**: qualified over 30D with ≥ 20 closed trades, win rate ≥ 55%, realized PnL ≥ $250,
  realized profit in at least 3 different tokens, not automated.
- **Traders**: qualified, not automated, ≥ 10 closed trades in the window.
- **Early Buyers**: bought at least 3 different tokens within 60 minutes of the token's creation
  during the window.
- **Fresh Wallets**: first indexed trade within the last 14 days. Shown only once the index covers
  at least 28 days (before that, every wallet would look fresh).
- Each swap leg belongs to exactly one trader (the signer), and each trade is applied once, so the
  same activity is never counted for two wallets. Wallet clusters and self-transfers are not
  detected: transfers are not indexed. The page says so.
- Windows longer than the index say how much they cover ("21 of 30 days").

## Limitations

- History starts at 2026-09-18 (Intear's trade index); 90D fills in by 2026-12-17.
- Swaps outside the indexed venues (NEAR Intents, Veax, meme.cooking presale deposits) are not seen.
- A multi-hop route whose legs land on two different pages of the index is netted per page, so its
  intermediate token can show as a tiny round trip (rare; close to zero PnL either way).
- A token's creation time for tokens older than Intear's start (2026-08-05) is the index start, so
  launches are only listed from then.
- Intear's first block can be a later contract update of an older token, so an established token can
  appear as a launch until the first block is checked on chain (planned: the account must not exist
  one block before it).
- Intear is a single free dependency without published terms; when it fails, the pages keep the last
  data with its age and say it is stale.
