# Trading automation

Limit orders (with take profit and stop loss), Copy Trade, Sniper and DCA: configured on NEARKITS web or in the Telegram bot, run by the server, traded from NEARKITS wallets through NEARKITS' existing custody path. Everything here is **off by default** (`NEARKIT_AUTOMATION` empty): a deploy changes nothing until the operator switches a kind on.

## What runs where

- **One engine** (`server/src/automation/`): records (`store.ts`), the trade path (`execute.ts`), the worker (`runner.ts`), Copy Trade's reading of transactions (`copy.ts`), Sniper's new-pool feed (`pools.ts`), the operations NEARKITS web and Telegram share (`service.ts`), the web API (`routes.ts`, `/api/web/auto/*`). Shared rules and types for every surface in `src/lib/automation/` (`config.ts` validation, `price.ts` trigger arithmetic, `api.ts` views).
- **Every automated trade** goes through the same path as a trade its owner confirms on the web: the kill switches, a fresh quote bound to the NEARKITS wallet (the router, NEARKITS' fee, registrations, the funds check), an intent (`group_id = auto-<strategy>`), the engine (re-checks at Confirm), the signer (its own route checks and its 10% price floor), the delivery read from chain. No second swap engine, signer or scheduler exists for it.
- **Browser-connected wallets are never automated.** NEARKITS can't sign for them and never asks for a seed phrase or a key. Automation picks NEARKITS (custodial) wallets only.
- **Pairs:** every automated trade is NEAR and a token (the custody swap is NEAR in or out). A token-for-token swap someone else makes is copied as two NEAR trades (see Copy Trade); NEARKITS never sends a direct token-for-token custody swap (that would change the custody swap path and need a signer release).

## Surfaces

- **NEARKITS web** (`src/features/automation/live/`): `/limit-orders`, `/copy-trade`, `/sniper`, `/dca`. A page is server-backed only with real services, a NEARKITS web session and its kind in the server's `features.enabled` (`routeComingSoon` in `src/config/release.ts`, `useAutomationLive`); otherwise it is exactly what it was (Coming Soon in production, browser drafts in dev, the demo untouched). Each page: a form validated with the shared rules, a review on the server's fresh quote (Copy Trade and a new-pools sniper: a summary; they have nothing to quote yet), the server's refusals on their fields, Active / Paused / History lists with only the controls a status allows, a detail with trades (tx links), detections (new pools by exchange and pool id, copied legs linked to their transaction; "Seen" is never a trade) and the audit trail, NEARKITS' kill-switch notice and limits, and Pause all. The Sniper page has a "One token" / "New pools" switch (new pools: sources, the pool's NEAR minimum, tokens to buy in buy mode). Each review makes one request key, sent with every Confirm of that review (a retry or a second click makes nothing twice; a create the server never answered is resent once with it, a refusal never); editing and reviewing again makes a new one. Cancelling an order of a pair says both are cancelled only when the list read again shows it. Wallet pickers list NEARKITS wallets only (not frozen ones). A trade reads "Submitted · not confirmed" until the server says confirmed.
- **Telegram** (`server/src/bot/automation.ts`, private chats): `/orders`, `/copy`, `/snipe` (one token, or new pools), `/dca`, `/auto` (in `/help`; Telegram's pinned command menu is unchanged), and a "🤖 Automation" button on the main menu while a kind is on. Every setup is reviewed on a live preview before Confirm is offered; Confirm is used up once (`Store.takeCallback`) and carries a request key (a replay creates nothing on the server either); a sniper that buys takes a second, separate yes. Every control re-reads the strategy as the presser's own (another user's id gets "not one of your automations"). Settings the bot doesn't ask (Copy Trade exclusions, minimum trade and liquidity, a DCA end date, a sniper's minimum liquidity) are on the web page.
- **Both** call the same service (`service.ts`): one validation, one set of limits, one record.

## Records (migrations: SQLite 18, Postgres 9; new tables only)

| Table | What | Safety |
|---|---|---|
| `auto_strategies` | One strategy: kind, NEARKITS wallet, config (JSON, validated), state, status, `oco_group`, `next_check_at`, lease (`lease_owner`, `lease_until`), expiry, attempts | Status changes are compare-and-set; the lease keeps two workers off one strategy; one live Copy Trade rule per user per followed account (unique index) |
| `auto_executions` | One automated trade: `idem_key` (unique), intent (unique), quote figures, then the amounts the chain moved | Saved before anything is signed; a trigger makes one trade at most (`limit:<id>:<attempt>`, `copy:<id>:<source tx>[:buy\|:sell]`, `dca:<id>:<run>`, `sniper:<id>:<attempt>`, `sniper:<id>:pool:<source>:<pool>`) |
| `auto_events` | The audit trail: created, trigger seen, trigger, sign, filled, failed, skip, held, paused, cancelled, expired… | Plain text, never a secret |
| `auto_detections` | What Copy Trade (each source transaction, and each leg of a copied token-for-token swap) and Sniper (the route, or each new pool) saw, with the decision and reason | Primary key (strategy, source): each seen once |
| `auto_create_requests` | A create request's key (per user), what was asked (a hash) and the strategies it made | Written in the same transaction as the strategies: the same key returns them; the key with another request is refused |
| `auto_pools` | New liquidity pools the feed saw (source, pool id, the token paired with wNEAR, launchpad, NEAR side, watching / ready / dropped / unpaired) | Unique per network, source and pool id: each pool once |
| `auto_feed_cursors` | Where each exchange's pool counter was read to | Moved only after the pools of a batch are written: a restart replays one batch at most |

Retention (`prune` in housekeeping): skipped detections after 30 days; events of strategies closed over 90 days ago; request keys after 7 days; pools after 7 days. Trades are kept (the financial record).

## States

- **Strategy:** `draft`, `active`, `paused`, `triggered`, `executing`, `submitted`, `filled`, `completed`, `cancelled`, `stopped`, `expired`, `failed`. A limit order moves active → triggered → executing → (submitted →) filled, or back to active when a trade wasn't sent or failed (up to 3 attempts, then `failed`). Copy Trade, Sniper and DCA stay `active` while they trade; they end `stopped` (by their owner), `completed`, `expired` or `failed`. An expiry (or a DCA's end) that passes while a strategy is paused ends it too (`expired`, or `completed` for a DCA).
- **Trade:** `executing` (saved, being signed), `submitted` (sent; the chain's answer pending), `confirmed` (the engine saw the delivery on chain), `failed` (failed on chain), `cancelled` (stopped before anything was signed). **Nothing is called filled or confirmed before the chain confirms it.** A refusal before signing (a switch set meanwhile, funds short at Confirm, a frozen wallet) is recorded as not sent, not as a failed trade.

## Semantics

### Limit orders

- **Price:** the executable quote's: NEAR per whole token for the order's own amount, from its wallet, through the route a trade would take, with every fee, tax and price impact in it. Compared exactly (integers). Limit buy triggers at price ≤ target; limit sell and take profit at price ≥ target; stop loss at price ≤ target.
- **Trigger:** the condition must hold on **two readings at least 5 s apart** (a single odd quote never triggers anything), then again on the quote it trades on. A triggered order is a **market swap** at that quote with the order's slippage (≤ 5%): the minimum received is enforced on chain, the price is **not guaranteed**.
- **Amounts:** sells spend an exact amount (never more than the wallet holds: revalidated each time) or a percentage of the balance read at trigger time. Optional expiry.
- **Polling:** each order reads its price every 30 s. An order far from its trigger reads the token's **shared reference price** instead (one small-buy quote per token, every 25 s, for all orders on it): a limit buy whose reference is more than 1% above its target, or a limit sell / take profit whose reference is more than 1% below it, can't trigger (its own executable price is never better than a small buy's), so it skips its own quote; it still reads its own price at least every 5 minutes. A stop loss always reads its own price. The quote budget (`NEARKIT_AUTOMATION_QUOTES_PER_MINUTE`, 60) goes to orders near their trigger.
- **Take profit + stop loss pairs** (`oco_group`) are made together, both or neither (one transaction). While one order of a pair is trading (triggered, executing, submitted), the other waits, even past its own trigger; the two are never traded at once (the trigger is checked and set with the pair's rows locked). The other order is cancelled **once a trade of the pair fills on chain** — not at the trigger, so a trade that isn't sent (a limit, a frozen wallet, the price moving back) leaves the protection in place. Cancelling either order (web or Telegram) cancels both, unless the other is already trading (then its result decides).

### DCA

Buys a fixed NEAR amount every 1 h, 4 h, 12 h, day or week from its start; up to its end or number of buys. A buy that can't be sent is retried a few times, then that run is skipped (recorded, notified).

### Sniper

Two kinds, both **notify-only by default**; buying needs the owner's explicit confirmation (`confirmExecute`; on Telegram a second, separate yes).

- **One token** (`target: 'token'`): watches one token contract until a route from the NEARKITS wallet trades it within the limits: price impact (the router's, or measured against a 1% probe on the same route) and optional minimum market liquidity. Notify-only tells its owner and ends; buying buys once (bounded attempts), fails closed when impact is unknown, and ends. The token contract must exist on chain (its metadata is read when it is made). When the pool feed sees a pool of that token become ready, the sniper looks again at once.
- **New pools** (`target: 'new-pools'`): acts on new liquidity pools as NEARKITS' exchanges create them, from the sources chosen:
  - **Nearly launches** (`nearly`): every Nearly launch creates its Ref DCL pool (`<token>.nearlytrade.near` against wNEAR) in its own launch transaction; there is no bonding curve. A launch counts once Nearly's `get_launch_by_token` says `Done` (a `Failed` launch is dropped). The launch's own dev buy happens inside the launch transaction: a sniper is never first.
  - **meme.cooking graduations** (`meme-cooking`): a graduating meme adds a Ref v2 pool of its `<symbol>-<id>.meme-cooking.near` token against wNEAR.
  - **Other new pools** (`other`): any other new Ref DCL or Ref v2 pool of a token against wNEAR (other launchpads, people's own pools).

  **How pools are found** (`pools.ts`, verified on mainnet 2026-10-14): Ref DCL's `get_metadata.pool_count` and `list_pools` (insertion order) every 3 s, Ref v2's `get_number_of_pools` and `get_pools` (a pool's id is its index) every 5 s; two view calls per scan through NEARKITS' RPC failover. Each pool is recorded once and the cursor moves after it. The feed starts at the counters' current values and runs only while a new-pools sniper is live: pools made before (or while the feed was idle for over 10 minutes) are never reported as new. A new pool is usually empty: pools against wNEAR are watched every 4 s until they hold NEAR liquidity (DCL: running, liquidity at the current point, NEAR on its wNEAR side; Ref v2: every reserve above zero), then **ready**; dropped after 30 minutes. Pools without wNEAR are recorded, not watched.

  **What it checks on each ready pool** (once per pool, pools made after the sniper only): the source is one it watches; the pool holds at least its NEAR minimum; the token's metadata reads from chain; an executable quote from the NEARKITS wallet for its amount (no route yet: tried again for 5 minutes); price impact within its limit (fails closed when unknown); a **round trip** (the buy, then selling back what it gets) losing at most 25% (fees, a tax, or a pool too thin to leave). Notify-only tells its owner of each such pool and keeps watching; buying buys each once, up to its number of tokens (1–10), then completes; failed or unsent buys count against its attempts.

### Copy Trade

- **Source:** the followed account's transactions from FastNEAR's transaction index (`tx.main.fastnear.com`, free, the same index the web PnL uses). Each step reads the index's `/status` lag, lists the account's transactions paged back to where the rule got to (its cursor), and reads in full only the transactions the account started (the index says which); one the index can't serve is read from NEAR RPC (`EXPERIMENTAL_tx_status`, the same reading, tested on the recorded fixtures); one neither can serve is tried a few steps, then recorded as skipped. Only transactions after the rule was created and at least 10 s old (final), each once.
- **What is copied** (`copy.ts`, tested on real mainnet transactions): a swap the account itself started, through Rhea's aggregator, Ref's v2 exchange or Ref DCL:
  - NEAR (or wNEAR) for one token, or back: a buy or a sell;
  - one token for one other token, with no NEAR traded: copied as **two NEAR trades** — a sell of what this rule holds of the first token (recorded as nothing to sell when it holds none) and a buy of the second with NEAR (a fixed size, or a share of the first token's executable NEAR value now).
  Transfers, refunds, liquidity moves (two tokens the same way), trades of more than two tokens or with two tokens and NEAR, failed transactions and calls that touched no such exchange are recorded with their reason.
- **Late trades:** a trade seen more than 3 minutes after it happened (the index behind or down) is recorded, **not copied**: its price has moved. The index more than 60 s behind is said on the rule; the index not answering makes the rule wait (said on the rule) and, after 10 minutes, tells its owner once; when it answers again, what is still fresh is copied.
- **Sizes and limits:** buys are a fixed size or a share of what the account spent, capped by the maximum trade and the rule's exposure limit (NEAR in copied buys not sold back **and in copied buys still under way**); exclusions; minimum liquidity. Sells exit what the rule bought (never more than the wallet holds, read right before). Every copied trade goes through the custody path with the rule's slippage (≤ 5%) and NEARKITS' limits; the wallet is read again before the intent and before signing. Following a NEARKITS wallet is refused (copies of copies would loop).

## Limits and controls

- **Slippage** ≤ 5% (the NEARKITS-wallet cap), inside the signer's 10% floor. Not raised.
- **NEARKITS' limits** (server-enforced before signing): per trade (`NEARKIT_AUTOMATION_MAX_TRADE_NEAR`, 50), per user per 24 h (`_MAX_DAILY_NEAR`, 200), all users per 24 h (`_MAX_DAILY_NEAR_GLOBAL`, 2,000). Live strategies per user: 20 orders, 5 Copy Trade rules, 5 snipers, 5 DCA plans.
- **Budgets:** the worker asks the router for at most `NEARKIT_AUTOMATION_QUOTES_PER_MINUTE` (60) quotes a minute in all; orders are evaluated every 30 s (far ones on a shared reference price), token snipers every 20 s, new-pools snipers every 4 s (a database read; quotes only for a new ready pool), Copy Trade every 20 s (up to 100 transactions listed, 10 read in full). The pool feed: about one view call a second while a new-pools sniper is live, plus a few per new pool.
- **Kill switches:** `npm run ops -- pause automation <reason>` (or `NEARKIT_OPS_PAUSED=automation`): no automated trade is sent; trades not signed yet are cancelled; the engine refuses any `auto-` intent while it is set (`npm run ops -- resume automation <reason>` lifts it). The trading switch stops them too. Per kind: remove it from `NEARKIT_AUTOMATION` (needs a restart). Per user: Pause all (web, Telegram `/auto`). Per strategy: Pause, Resume, Cancel/Stop.
- **What stopping means:** nothing new is sent from that moment. A trade already sent can't be called back: it is followed to the end from the chain and recorded. An order whose trade is under way can't be cancelled until it settles.
- **Creates are idempotent:** with a request key (both clients send one per review) the server makes the strategies once; a retry, a double tap, concurrent repeats and a replay answer with what was made.

## Notifications (Telegram)

Trigger, fill (only once confirmed on chain), failure, expiry (also while paused), completion, pause, risk-limit refusals (Copy Trade exposure, at most hourly), the index down for 10 minutes (once per outage), and each new pool a notify-only new-pools sniper finds. Never a secret, key or internal URL.

## Rollout

1. Merge to `main` (PR, CI green). The web stays Coming Soon (server reports no kind) and the worker doesn't run.
2. Deploy the app on the VPS: backup, `bin/deploy <sha> app`, in-flight check, `docker compose up -d --no-deps --wait app`. The migration (new tables) runs at start. Signer, buy bot, OpenBao, databases untouched.
3. Staging first where possible (testnet app with `NEARKIT_AUTOMATION=limit`), then on mainnet switch one kind on behind the kill switch: pause automation, set `NEARKIT_AUTOMATION=limit` in `app.env`, recreate the app, check `/health`, make one small order from the owner's own wallet, resume automation. Watch `auto_events`, the watchdog, and the first orders end to end with small amounts.
4. Then `limit,dca`, then `sniper` (notify-only first), then `copy`, one at a time.

## Rollback

- Immediate, no restart: `npm run ops -- pause automation <reason>`.
- Switch kinds off: empty `NEARKIT_AUTOMATION`, recreate the app (strategies keep their records; nothing trades).
- Previous build: `bin/deploy --rollback app <tag>`. The new tables stay (forward-only migrations); the previous build ignores them.

## Known limits

- Every automated trade is NEAR↔token. Token-for-token swaps are copied as two NEAR trades (two fees, two slippages), never as one swap.
- **Sniper's sources are Ref DCL and Ref v2 only** — NEARKITS' own exchanges. Launches that trade elsewhere (another DEX, a launchpad's own bonding curve that never reaches Ref, intents-only markets) are not seen. Nearly and meme.cooking are recognised by their token accounts (`*.nearlytrade.near` on DCL, `*.meme-cooking.near` on Ref v2) and Nearly's launch state; other launchpads' pools count as "other new pools". meme.cooking memes still cooking (before graduation) are not reported: only their Ref pool is.
- The pool feed assumes the exchanges never remove pools (true for Ref v2's indices; for DCL observed, not documented): if DCL's list changes order under the cursor, the feed anchors again and pools in that gap are not reported (logged).
- A sniper is never first on a Nearly launch (the dev buy is in the launch transaction) and reacts within seconds (3–5 s scans, 4 s watch), not within a block.
- Copy Trade depends on FastNEAR's index (free, public): when it lags or fails, copies wait, and a trade seen more than 3 minutes late is not copied. A delegated (meta) transaction the index can't serve can't be read from RPC (its relayer isn't known).
- Triggers are evaluated every 30 s: a price that touches the target between two readings and leaves is not caught.
- A strategy can't be edited after it is made (a notify-only sniper can't be switched to buying): make a new one.
- `features.enabled` is read from `NEARKIT_AUTOMATION` at start. Strategies of a kind switched off later can still be listed, paused and cancelled; resuming them is refused until the kind is on again.
- The web page shows its fallback (Coming Soon in production) for the moment the server's answer takes to load after sign-in.
