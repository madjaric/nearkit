# Trading automation

Limit orders (with take profit and stop loss), Copy Trade, Sniper and DCA: configured on NEARKITS web or in the Telegram bot, run by the server, traded from NEARKITS wallets through NEARKITS' existing custody path. Everything here is **off by default** (`NEARKIT_AUTOMATION` empty): a deploy changes nothing until the operator switches a kind on.

## What runs where

- **One engine** (`server/src/automation/`): records (`store.ts`), the trade path (`execute.ts`), the worker (`runner.ts`), the operations NEARKITS web and Telegram share (`service.ts`), the web API (`routes.ts`, `/api/web/auto/*`). Shared rules and types for every surface in `src/lib/automation/` (`config.ts` validation, `price.ts` trigger arithmetic, `api.ts` views).
- **Every automated trade** goes through the same path as a trade its owner confirms on the web: the kill switches, a fresh quote bound to the NEARKITS wallet (the router, NEARKITS' fee, registrations, the funds check), an intent (`group_id = auto-<strategy>`), the engine (re-checks at Confirm), the signer (its own route checks and its 10% price floor), the delivery read from chain. No second swap engine, signer or scheduler exists for it.
- **Browser-connected wallets are never automated.** NEARKITS can't sign for them and never asks for a seed phrase or a key. Automation picks NEARKITS (custodial) wallets only.
- **Pairs:** NEAR and a token, as every NEARKITS-wallet trade is (the custody swap supports NEAR in or out). Token-for-token automation isn't offered.

## Surfaces

- **NEARKITS web** (`src/features/automation/live/`): `/limit-orders`, `/copy-trade`, `/sniper`, `/dca`. A page is server-backed only with real services, a NEARKITS web session and its kind in the server's `features.enabled` (`routeComingSoon` in `src/config/release.ts`, `useAutomationLive`); otherwise it is exactly what it was (Coming Soon in production, browser drafts in dev, the demo untouched). Each page: a form validated with the shared rules, a review on the server's fresh quote (Copy Trade: a summary; it has nothing to quote), the server's refusals on their fields, Active / Paused / History lists with only the controls a status allows, a detail with trades (tx links), detections and the audit trail, NEARKITS' kill-switch notice and limits, and Pause all. Wallet pickers list NEARKITS wallets only (not frozen ones). A trade reads "Submitted · not confirmed" until the server says confirmed.
- **Telegram** (`server/src/bot/automation.ts`, private chats): `/orders`, `/copy`, `/snipe`, `/dca`, `/auto` (in `/help`; Telegram's pinned command menu is unchanged), and a "🤖 Automation" button on the main menu while a kind is on. Every setup is reviewed on a live preview before Confirm is offered; Confirm is used up once (`Store.takeCallback`: a double tap or a replay creates one strategy); a sniper that buys takes a second, separate yes. Every control re-reads the strategy as the presser's own (another user's id gets "not one of your automations"). Settings the bot doesn't ask (Copy Trade exclusions, minimum trade and liquidity, a DCA end date, a sniper's minimum liquidity) are on the web page.
- **Both** call the same service (`service.ts`): one validation, one set of limits, one record.

## Records (migrations: SQLite 18, Postgres 9; new tables only)

| Table | What | Safety |
|---|---|---|
| `auto_strategies` | One strategy: kind, NEARKITS wallet, config (JSON, validated), state, status, `oco_group`, `next_check_at`, lease (`lease_owner`, `lease_until`), expiry, attempts | Status changes are compare-and-set; the lease keeps two workers off one strategy; one live Copy Trade rule per user per followed account (unique index) |
| `auto_executions` | One automated trade: `idem_key` (unique), intent (unique), quote figures, then the amounts the chain moved | Saved before anything is signed; a trigger makes one trade at most (`limit:<id>:<attempt>`, `copy:<id>:<source tx>`, `dca:<id>:<run>`, `sniper:<id>:<attempt>`) |
| `auto_events` | The audit trail: created, trigger seen, trigger, sign, filled, failed, skip, held, paused, cancelled, expired… | Plain text, never a secret |
| `auto_detections` | What Copy Trade (each source transaction) and Sniper (the route) saw, with the decision and reason | Primary key (strategy, source): each seen once |

Retention (`prune` in housekeeping): skipped detections after 30 days; events of strategies closed over 90 days ago. Trades are kept (the financial record).

## States

- **Strategy:** `draft`, `active`, `paused`, `triggered`, `executing`, `submitted`, `filled`, `completed`, `cancelled`, `stopped`, `expired`, `failed`. A limit order moves active → triggered → executing → (submitted →) filled, or back to active when a trade wasn't sent or failed (up to 3 attempts, then `failed`). Copy Trade, Sniper and DCA stay `active` while they trade; they end `stopped` (by their owner), `completed`, `expired` or `failed`.
- **Trade:** `executing` (saved, being signed), `submitted` (sent; the chain's answer pending), `confirmed` (the engine saw the delivery on chain), `failed` (failed on chain), `cancelled` (stopped before anything was signed). **Nothing is called filled or confirmed before the chain confirms it.** A refusal before signing (a switch set meanwhile, funds short at Confirm) is recorded as not sent, not as a failed trade.

## Semantics

- **Limit orders.** The price is the executable quote's: NEAR per whole token for the order's own amount, from its wallet, through the route a trade would take, with every fee, tax and price impact in it. Compared exactly (integers). Limit buy triggers at price ≤ target; limit sell and take profit at price ≥ target; stop loss at price ≤ target. The condition must hold on **two readings at least 5 s apart** (a single odd quote never triggers anything), then again on the quote it trades on. A triggered order is a **market swap** at that quote with the order's slippage (≤ 5%): the minimum received is enforced on chain, the price is **not guaranteed**. Sells spend an exact amount (never more than the wallet holds: revalidated each time) or a percentage of the balance read at trigger time. Optional expiry.
- **Take profit + stop loss** on the same position are created as a pair (`oco_group`): the first to trigger cancels the other.
- **DCA.** Buys a fixed NEAR amount every 1 h, 4 h, 12 h, day or week from its start; up to its end or number of buys. A buy that can't be sent is retried a few times, then that run is skipped (recorded, notified).
- **Sniper.** Watches one token contract until a route trades it within the limits: price impact (the router's, or measured against a 1% probe on the same route) and optional minimum liquidity. **Starts notify-only**: it tells its owner and ends. Buying needs the owner's explicit confirmation (`confirmExecute`); then it buys once (bounded attempts), fails closed when impact is unknown, and ends.
- **Copy Trade.** Reads the followed account's transactions from FastNEAR's transaction index (`tx.main.fastnear.com`, free, the same index the web PnL uses), only those after the rule was created and at least 10 s old (final), each once. Copies a NEAR swap the account itself started, of one token, through Rhea's aggregator, Ref's v2 exchange or Ref DCL (`copy.ts`): transfers, refunds, liquidity moves, token-for-token, multi-token and non-exchange calls are skipped with their reason (tested on real mainnet transactions). Buys: a fixed size or a share of what the account spent, capped by the maximum trade and the rule's exposure limit (NEAR in copied buys not sold back); exclusions; minimum liquidity. Sells exit what the rule bought (never more than the wallet holds). Following a NEARKITS wallet is refused (copies of copies would loop).

## Limits and controls

- **Slippage** ≤ 5% (the NEARKITS-wallet cap), inside the signer's 10% floor. Not raised.
- **NEARKITS' limits** (server-enforced before signing): per trade (`NEARKIT_AUTOMATION_MAX_TRADE_NEAR`, 50), per user per 24 h (`_MAX_DAILY_NEAR`, 200), all users per 24 h (`_MAX_DAILY_NEAR_GLOBAL`, 2,000). Live strategies per user: 20 orders, 5 Copy Trade rules, 5 snipers, 5 DCA plans.
- **Budgets:** the worker asks for at most 60 quotes a minute in all; orders are evaluated every 30 s, snipers every 20 s, Copy Trade reads every 20 s (25 transactions, 10 read in full).
- **Kill switches:** `npm run ops -- pause automation <reason>` (or `NEARKIT_OPS_PAUSED=automation`): no automated trade is sent; trades not signed yet are cancelled; the engine refuses any `auto-` intent while it is set. The trading switch stops them too. Per kind: remove it from `NEARKIT_AUTOMATION` (needs a restart). Per user: Pause all (web, Telegram `/auto`). Per strategy: Pause, Resume, Cancel/Stop.
- **What stopping means:** nothing new is sent from that moment. A trade already sent can't be called back: it is followed to the end from the chain and recorded. An order whose trade is under way can't be cancelled until it settles.

## Notifications (Telegram)

Trigger, fill (only once confirmed on chain), failure, expiry, completion, pause, and risk-limit refusals (Copy Trade exposure). Never a secret, key or internal URL.

## Rollout

1. Merge to `main` (PR, CI green). The web stays Coming Soon (server reports no kind) and the worker doesn't run.
2. Deploy the app on the VPS: backup, `bin/deploy <sha> app`, in-flight check, `docker compose up -d --no-deps --wait app`. The migration (new tables) runs at start. Signer, buy bot, OpenBao, databases untouched.
3. Staging first where possible (testnet app with `NEARKIT_AUTOMATION=limit`), then on mainnet switch one kind on: `NEARKIT_AUTOMATION=limit` in `app.env`, recreate the app. Watch `auto_events`, the watchdog, and the first orders end to end with small amounts.
4. Then `limit,dca`, then `sniper`, then `copy`, one at a time.

## Rollback

- Immediate, no restart: `npm run ops -- pause automation <reason>`.
- Switch kinds off: empty `NEARKIT_AUTOMATION`, recreate the app (strategies keep their records; nothing trades).
- Previous build: `bin/deploy --rollback app <tag>`. The new tables stay (forward-only migrations); the previous build ignores them.

## Known limits

- NEAR↔token only; token-for-token automation isn't offered.
- Sniper watches a named token; it doesn't discover new pools by itself (no reliable launch feed is integrated; nothing is invented).
- Copy Trade depends on FastNEAR's index (free, public): when it lags or fails, copies wait (and a copy that comes too late isn't made). Launchpad bonding-curve buys (nearlytrade launches before their pool) aren't copied: they go through no exchange NEARKITS routes through.
- Triggers are evaluated every 30 s: a price that touches the target between two readings and leaves is not caught.
- A strategy can't be edited after it is made (a notify-only sniper can't be switched to buying): make a new one. Cancelling one order of a take profit / stop loss pair leaves the other active (only a trigger cancels its sibling): the web lists both, tagged Pair, each with its own Cancel; Telegram also offers Cancel both.
- A sniper needs the token contract to exist on chain (its metadata is read when it is made); it watches for the first route, not for the contract's deployment.
- `features.enabled` is read from `NEARKIT_AUTOMATION` at start. Strategies of a kind switched off later can still be listed, paused and cancelled; resuming them is refused until the kind is on again.
- The web page shows its fallback (Coming Soon in production) for the moment the server's answer takes to load after sign-in.
