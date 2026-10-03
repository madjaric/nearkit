# NearKit universal routing layer — technical plan (2026-10-03)

Goal: NearKit trades any valid NEAR NEP-141 token that has a real, executable liquidity route, through one
router that web (Buy / Sell / Multi Buy / Multi Sell) and Telegram (Buy / Sell) share. Rhea is one routing
source, not the definition of "tradable". Token lists are a UI convenience, never trading authorization.

## A. Existing routing and DEX integrations

| Piece | Where | What it does today |
|---|---|---|
| Rhea aggregator (Smart Router V2, `aggregatedex.near`) | `src/services/rhea/smartx.ts` | Mainnet quotes from `smartx.rhea.finance`: a server-signed, obfuscated route that the aggregator contract executes across `v2.ref-finance.near` (classic) and `dclv2.ref-labs.near` (DCL). NearKit decodes and checks every field (user, fee rate and account, amounts, receivers, minimums, deadline) and verifies Rhea's Ed25519 signature before signing. Carries NearKit's fee as `app_fee_rate` (5000 ppm); Rhea keeps 20% of it and charges its own 0.10% protocol fee. |
| Rhea classic router (`findPath`) | `src/services/rhea/classic.ts` | Testnet only (mainnet's answers 1007 for everything). Builds the classic exchange's `{"actions":[…]}` message. No fee mechanism. |
| Router of record | `src/services/real/swapRouting.ts` `createSwapRouter` | One function for both clients: aggregator on mainnet, classic on testnet; `prerequisites` reads the NEP-145 registrations a swap needs. Used by the web (`tradingService.ts`) and by the server's custody swap (`server/src/custody/swap.ts`). |
| Transaction builder | `src/services/rhea/swapTransactions.ts` | Registrations, Rhea `tokens_storage_deposit`, then one `ft_transfer_call` from the input token contract (wrapping NEAR first in the same transaction). |
| Custody policy | `server/src/custody/policy.ts` | What the signer may sign: on mainnet only an aggregator swap with the fee, on testnet only the classic exchange; exact receivers, methods, arguments, deposits, gas. |
| Signer's own route check | `server/src/signer/routes.ts` | Independently verifies Rhea's signature and asks Rhea for its own quote (the oracle); refuses a minimum further below it than its cap. |
| Outcome reading | `src/services/near/outcome.ts`, `flows.ts` | Aggregator events (`earn_app_fee`, `withdraw_succeeded`, refunds); for any other `ft_transfer_call` the "used" amount (0 = refunded) and the token movements. A real direct DCL buy (`fixtures/flows/direct-buy-wrap-dcl.*`) is already a test fixture. |
| Token discovery | `src/services/real/tokenService.ts` `lookupToken`, `server/src/trade/tokens.ts` `resolveToken` | Any contract: account exists, NEP-141 `ft_metadata`, total supply, network check. Not tied to any list. |
| Market data | `src/services/market/*` | DEX Screener / GeckoTerminal / CoinGecko: display only, never an execution authority. |

## B. Rhea's current role

Rhea's aggregator is the only mainnet route. A token Rhea does not index (code 1008, e.g. SINGULARTY while its DCL
pool quotes fine on chain) or a pool created hours ago (code 0, empty) is untradable, although the liquidity is
on chain and a direct `ft_transfer_call` to the DEX would fill it. After this plan Rhea stays the primary
multi-DEX source (production-proven, carries the app fee inside the swap) and becomes one adapter among several.

## C. Protocols to support

1. **Rhea aggregator** (mainnet) — kept as is.
2. **Rhea classic router** (testnet) — kept as is.
3. **Ref/Rhea DCL v2 direct** (`dclv2.ref-labs.near` mainnet, `dclv2.ref-dev.testnet` testnet) — new. Concentrated
   liquidity; every new nearlytrade-style launch and most new memecoin markets open a DCL pool. Pool IDs are
   deterministic (`tokenX|tokenY|fee`, tokens in lexicographic order, fee tiers 100 / 400 / 2000 / 10000), the
   contract quotes on chain (`quote`) and swaps by `ft_transfer_call` with `{"Swap":{pool_ids, output_token,
   min_output_amount}}`, which already supports a multi-pool path. Verified live on 2026-10-03: `get_pool`
   returns the state or `null` (no scan needed), `quote` returned 17,928 SINGULARTY for 1 wNEAR and 5.46 wNEAR for
   100,000 SINGULARTY on `singularty.nearlytrade.near|wrap.near|10000`; a USDC/wNEAR pool exists at fee 400.
4. **Ref classic v1 direct** (`v2.ref-finance.near`) — designed for, not built now. Quotes (`get_return`) and the
   swap message (`{"actions":[…]}`, already parsed and policed for the classic router) are known; what is missing
   is a protocol-native pool index (8,870 pools, no token→pool view). It is the next adapter once a paged
   `get_pools` index with a cache is worth its RPC cost; the aggregator already routes v1 pools it knows.

Not added: anything without a stable public on-chain interface, a read-only quote and meaningful liquidity.

## D. Pool discovery per protocol

- Aggregator / classic: Rhea's router finds the pools (external service).
- DCL direct: for a pair (A, B) the four candidate pools `sort(A,B)|fee` are read with `get_pool` in parallel;
  a pool exists when the answer is not `null`, is `Running` and has liquidity. Multi-hop candidates are the
  direct pair and two-hop paths through the network's stablecoins (USDC, USDT) to wNEAR. Nothing is registered
  in a database: a pool created a minute ago is found the next time someone quotes the pair. Existence is cached
  60 s (a `null` too), state is re-read for every quote.

## E. Quotes per protocol

- Aggregator: `smartx` quote (signed route) — unchanged.
- Classic: `findPath` — unchanged.
- DCL direct: `quote({pool_ids, input_token, input_amount, output_token})` on the contract itself, at `final`
  finality: the exact amount the pool would give now, after its fee. The user's slippage sets
  `min_output_amount = amountOut × (1 − slippage)`. Price impact from USD prices where known.

Every candidate route carries: source, path (tokens, pools), input, expected output, minimum output, DEX fee,
NearKit fee, estimated network fee, timestamp and its execution metadata (receiver and message). A route that
lacks any of these, whose pool is not `Running`, or whose quote is older than its window, is invalid.

## F. Swap construction per protocol

- Aggregator: `ft_transfer_call(aggregatedex.near, amountIn, {msg, signature})` — unchanged.
- Classic: `ft_transfer_call(exchange, amountIn, {actions})` — unchanged.
- DCL direct: on the input token contract (wNEAR after `near_deposit` for NEAR): `ft_transfer(feeAccount, fee)`,
  then `ft_transfer_call(dclv2, amountIn − fee, {"Swap":{…}})`, in ONE transaction (atomic batch). A wNEAR
  output is unwrapped by the DEX itself (native NEAR delivery) unless the user asked for wNEAR
  (`skip_unwrap_near: true`). Registrations (NEP-145) of the wallet on route tokens and of the fee account on the
  fee token come first, as today.

## G. The NearKit fee on direct DEX routes

0.50% of the swap, exactly once, whichever adapter executes:

- Aggregator: unchanged (`app_fee_rate`, collected inside the swap; Rhea keeps 20%).
- Direct DEX: `fee = floor(amountIn × 50 / 10000)` of the input token, transferred to the canonical fee account
  (`nearkitfee.near`, from `src/lib/fees.ts`) in the same transaction as the swap; the DEX receives the rest. No
  router share: NearKit receives the whole 0.50%. The fee account must be registered on the fee token
  (`nearkitfee.near` is registered on neither `wrap.near` nor new tokens, read live): the plan adds that
  one-time `storage_deposit`, paid by the trader like every other registration and shown in the review.
- Never both: a route is either an aggregator route with the app fee or a direct route with the transfer.
- Known limit (documented in the fee disclosure): a direct swap that the DEX refunds after the transfer
  (slippage) keeps the fee, because the fee leaves in the batch that submits the swap; the server re-quotes
  right before signing and the minimum is enforced, so this is rare. Collecting after delivery would need a
  NearKit router contract on chain (future work), not a client-side workaround.

## H. New tokens and pools without registration

- Discovery: `lookupToken` / `resolveToken` already read any contract from chain; the web's token selector,
  search, Token Detail and the bot (paste a contract) open a trade for a token no list knows.
- Routing: every adapter is asked for every quote; the DCL adapter reads pool state from the contract, so a
  pool created today is routable today. No migration, no list, no deployment.
- Lists stay what they are: what the UI shows by default and what a user imported for convenience.

## I. Router and adapter architecture

```
src/services/routing/
  types.ts     RouteSource, RouteCandidate (one adapter's executable route), RouterAdapter
  select.ts    selectRoute(candidates): valid only, highest net expected output after DEX, protocol and
               NearKit fees; a route within 0.25% of Rhea's keeps Rhea (production-proven); deterministic
  router.ts    createSwapRouter(ctx): asks every adapter that canQuote(pair), ignores the ones that refuse,
               validates each candidate, selects, returns RoutedSwap (one shape for every client)
src/services/rhea/   aggregator and classic adapters (existing code behind the adapter interface)
src/services/dcl/    pools.ts (ids, discovery, cache), quote.ts (on-chain quote, paths), swap.ts (message, fee)
```

`RouterAdapter`: `id`, `canQuote(pair)`, `quote(request, user, verify) → RouteCandidate | null`,
`prerequisites(route, signer)`, `buildSwap(route, prerequisites)`. `RoutedSwap` gains `source` and, for direct
routes, `pools` and `fee.transfer`. Web `tradingService`, server `custody/swap.ts` and the bot keep calling the
same `createSwapRouter`: Multi Buy / Multi Sell route each wallet separately and each wallet signs its own
transactions, as today.

## J. Security boundaries

- The client (web page, Telegram) submits an intent: token, side, amount, slippage. The server routes, builds and
  validates; the signer re-validates. No client-supplied contract, pool, method, deposit, gas or action is ever
  used.
- `policy.ts` gains `checkDclSwap`: receiver is the network's DCL contract, the message is exactly
  `{"Swap":{pool_ids, output_token, min_output_amount}}` with pools that connect `routeIn` to `routeOut`,
  the minimum is the verified one and never below what the user confirmed, the fee transfer goes to the one
  canonical fee account for exactly `floor(amountIn × 50 / 10000)`, the DEX gets exactly the rest, registrations
  are of the wallet or the fee account on route tokens only, and nothing else is in the transaction.
- `signer/routes.ts` gains a DCL oracle: the signer quotes the same pools on chain itself and refuses a minimum
  further below that than its slippage cap, as it does with Rhea.
- Unchanged: custody wallet ownership, WATCH/FOLLOW restrictions, trading pause, in-flight and double-tap
  guards, delivery-based confirmation and reconciliation, the OpenBao/signer boundary, Telegram and web
  authorization, the 0.50% fee and `nearkitfee.near`.
- UI: the route's source is shown ("Route · Rhea", "Route · DCL", "DCL: wNEAR → USDC → TOKEN"); no executable
  route reads "No executable route found for this pair right now", never "not supported" or "not listed".

## Acceptance (before any deployment)

SINGULARTY buys and sells through the generic DCL adapter with no token-specific condition; NEARLY and
BLACKDRAGON still route through Rhea unchanged; an unlisted token fixture is resolved and routed without
being added to any list; the fee is exactly 0.50% once on every route; policy, signer, discovery, routing,
execution and regression tests pass; unit, e2e (demo, real, beta, Telegram), typecheck, lint and builds pass.
Production deployment (web, app server, signer) only after the owner reviews this architecture.

## Status (2026-10-03): built, verified, not deployed

What exists now (web and Telegram share it):

- `src/services/dcl/` — `pools.ts` (deterministic pool ids per fee tier, `get_pool` read with a 60 s memory of missing
  tiers, running pools with liquidity only), `quote.ts` (the contract's own `quote`; paths directly, through wNEAR or a
  stablecoin; the best executable route by output), `swap.ts` (the canonical `Swap` message, `directFee`).
- `src/services/routing/select.ts` — deterministic selection by net expected output; Rhea kept within 0.25%.
- `src/services/real/swapRouting.ts` — every source asked in parallel (Rhea's aggregator or classic router, DCL); one
  `RoutedSwap` shape with `source`, `pools`, `swapAmount` and `fee.transfer`; "No executable route found for X → Y right
  now." with each source's own reason. Direct routes: fee = `floor(amountIn × 0.50%)` transferred to the canonical fee
  account by `ft_transfer` in the swap's own transaction (`swapTransactions.ts`), the DEX receives the rest, no router
  share; the fee account's registration on the fee token is planned and disclosed. Testnet: no fee.
- `src/services/near/outcome.ts` — a DCL swap is a success only once the output provably reached the wallet (the output
  token's NEP-141 transfer from the exchange, or the exchange's NEAR transfer for an unwrapped output), read from the
  exchange's `dcl.ref` `swap` event; the direct fee is reported from the plan's transfer. Delivery before the exchange's
  callbacks counts (web executor and Telegram "Buy confirmed").
- Server: `custody/policy.ts` `checkDclSwap`, `signer/routes.ts` DCL branch with the signer's own on-chain `quote` as the
  price floor, `signer/codec.ts` carries `pools` and `direct`; `custody/swap.ts` passes the fee transfer and the route
  facts. The client never names a contract, pool, method, deposit, gas or action: it submits an intent.
- UI: "Route NEAR → SINGULARTY · DCL" in the web review and the Telegram quote; the Telegram fee line says a direct fee is
  "sent with the swap". Token lists stay a UI convenience: a token outside every list trades from Token Detail, search or
  a pasted contract, without import.
- Not built: Ref v1 pools directly (no on-chain token-to-pool index; Rhea's router covers them), limit orders on DCL.

Verification on 2026-10-03 (no real transaction sent):

| Check | Result |
|---|---|
| Unit and integration (`npm test`) | 1,162 passed, 1 skipped (119 files) |
| Typecheck, lint, format | clean |
| e2e demo / real / beta / Telegram | 28 / 25 / 16 / 20 passed, 0 failed |
| Production build (`npm run build`) | passes |
| Live, read-only (`npm run smoke:live`) | 9 of 10: DCL quotes NEAR ↔ SINGULARTY both ways on `singularty.nearlytrade.near\|wrap.near\|10000`, read from `dclv2.ref-labs.near`; Rhea's mainnet quotes unchanged; the one failure is Rhea's testnet router answering HTTP 502 (their outage, retried twice) |

Acceptance, as the brief lists it: SINGULARTY buys and sells through the generic DCL adapter with no token-specific
condition (web plan/execute tests on the fake mainnet, signer tests with the on-chain oracle, the live quote); a token
launched today ("Launched Today", "FRESH") routes without being added to any list (web, Telegram and e2e); USDT and the
Rhea-routed pairs still go through Rhea unchanged (every existing aggregator and classic test, "Route NEAR → USDT ·
Rhea"); the fee is 0.50% exactly once on every route (policy, signer, web disclosure and codec tests); the security tests
pass (fee account, fee rate, remainder, pools, message, minimum, registrations, extra actions, forged clients).

Known limits, documented in the review and the README: a direct swap the exchange refunds after the fee transfer keeps
the fee (the server re-quotes right before signing, the minimum is enforced on chain); a token that taxes transfers
through an interface other than nearlytrade's `get_tax` is quoted as if untaxed, and NearKit reports what arrived.

Production-safety review (2026-10-03, `src/services/dcl/tax.ts` and the tax-aware adapter came out of it): nearlytrade
launch tokens tax 1% of every transfer to or from their DCL pair (`get_tax`: `buy_bps`, `sell_bps`, `pairs`). Before the
fix a direct sell was quoted on the pre-tax amount, so the pool received 1% less than quoted and a 0.5%–1% slippage sell
could revert, costing the user the fee and the tax. Now the pool's input is quoted after the sell tax, a buy's expected
and minimum amounts are shown after the buy tax, the message minimum stays the pool's (`signedMin`; policy and signer
accept it above the user's `minOut`, never below), and the signer's price floor applies to the message minimum against
its own untaxed quote (conservative). Verified by the adapter, router, policy, signer, web and Telegram tests and the
live read-only smoke (`get_tax` on SINGULARTY, both directions quoted).

Deployment: nothing deployed. Pushing `main` deploys the web through Vercel, and the app server and signer deploy by hand,
so the commit stays local until the owner reviews this architecture (production safety, items 1–8 of the brief).
