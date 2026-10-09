# Bridge & Buy $KITS, and the Bridge to NEAR

**NEARKITS is the interface and orchestration layer. NEAR Intents provides the cross-chain infrastructure.**

NEARKITS has two bridge products on one engine (one 1Click client, one quote and fee check, one order table, one worker):

| Product | Route | Page | What happens after the NEAR arrives |
|---|---|---|---|
| **Bridge & Buy $KITS** (`buy-kits`) | SOL / ETH / BNB → NEAR → $KITS | `/bridge` | NEARKITS buys $KITS with it (below) |
| **Bridge** (`bridge`) | SOL / ETH / BNB → NEAR | `/bridge-near` | Unwrapped to native NEAR where an authorized unwrap exists ([The Bridge to NEAR](#the-bridge-to-near)) |

The Bridge never buys $KITS. It funds NEARKITS wallets (gas, Multi Trade, Batch Send, transfers) or any NEAR account. Everything below up to [The Bridge to NEAR](#the-bridge-to-near) describes Bridge & Buy; the Bridge shares it all except stage 2.

A user holding SOL, ETH or BNB gets $KITS (`kits.nearlytrade.near`, NEAR mainnet) in one flow on `/bridge`. NEARKITS runs no bridge, deploys no contract, runs no solver and never holds the user's source-chain funds: the user's own wallet sends them to the deposit address of a NEAR Intents quote.

## Supported chains and assets (V1)

| Chain | Asset | 1Click asset id | Decimals | Wallets |
|---|---|---|---|---|
| Solana | SOL | `nep141:sol.omft.near` | 9 | Wallet Standard (Phantom, Solflare, Backpack…) |
| Ethereum | ETH | `nep141:eth.omft.near` | 18 | EIP-6963 / injected EVM wallets (chain 1) |
| BNB Chain | BNB | `nep245:v2_1.omni.hot.tg:56_11111111111111111111` | 18 | the same EVM wallets (chain 56, added if missing) |

- Defined once in `src/config/bridge.ts`.
- The server offers a chain only while 1Click's `GET /v0/tokens` lists that asset with those decimals. It also needs wNEAR (`nep141:wrap.near`, 24 decimals) to be listed.
- No other chain, no Robinhood.
- USDC and USDT on these chains are also 1Click assets. Adding one is a new `BridgeChain`-style entry plus an ERC-20 or SPL transfer in the wallet adapters. It is not in V1.

## Why two stages

1Click does not support $KITS. Its token list has no `kits.nearlytrade.near`, and a quote to `nep141:kits.nearlytrade.near` is refused with "tokenOut is not valid" (checked live 2026-10-08, `server/src/bridge/oneclick.smoke.ts`). So the flow is:

1. **SOL / ETH / BNB → NEAR (NEAR Intents).**
   - The quote is `EXACT_INPUT` with `depositType: ORIGIN_CHAIN`, destination `nep141:wrap.near`, `recipientType: DESTINATION_CHAIN` (the receiving NEAR account) and `refundType: ORIGIN_CHAIN` (the user's source address).
   - NEAR Intents delivers wNEAR, or native NEAR. The server reads which one from the delivery transaction.
2. **NEAR → $KITS (NEARKITS' own trading).**
   - An ordinary buy of `kits.nearlytrade.near` through NEARKITS' route (Rhea / DCL), with the ordinary 0.50% trading fee.
   - It is priced fresh when the NEAR is there.

The page says it is two steps: the route line, the review and the progress steps. It never claims atomicity.

`customRecipientMsg` (1Click's experimental `ft_transfer_call` on delivery) was considered and rejected: 1Click warns that funds can be lost, and it would skip NEARKITS' route checks and fee.

## The fee: 0.25% for NEARKITS

- `BRIDGE_FEE_BPS = 25` in `src/lib/fees.ts` is the one value. It is what NEARKITS receives, in bps of the amount bridged.
- 1Click shares an app fee 50/50 and keeps at least 20 bps itself. Measured with dry quotes on 2026-10-08: asking for 25 pays NEARKITS 13 and 1Click 20; asking for 50 pays 25 and 25.
  - Owner decision 2026-10-08: NEARKITS receives the full 0.25%.
  - So the server asks for `appFees: [{ recipient: <fee account>, fee: 50 }]` (`bridgeAppFeeRequestBps`, `src/lib/bridge/fee.ts`).
- Every quote's echo (`quoteRequest.appFees`) is checked. If NEARKITS' share isn't exactly 25 bps (policy change, wrong key, tampering), the quote is refused (`503 fee`) and logged. Nothing is shown and nothing can be sent.
- The user sees, before confirming:
  - "NEARKITS fee (0.25%)" and "NEAR Intents fee (0.25%)", each in source units;
  - the source chain's own network fee ("Shown in your wallet");
  - "$KITS trading fee (0.50%)", applied to the purchase and already inside the $KITS figure;
  - $KITS' own buy tax, also inside the route's figure.
- The fee is collected into **`nearkitfee.near`'s balance inside NEAR Intents** (the `intents.near` verifier), not sent to the account directly. Withdrawing it needs that account's own key, through near-intents.org or an intents withdrawal.
- 0.50% is never charged on the bridge leg. The purchase is an ordinary trade and carries it.

## Quote flow

The routes are `server/src/bridge/routes.ts`: POST and JSON, rate-limited per route in `server/src/api/limits.ts`.

1. `/api/bridge/assets`: the chains offered now, the destination token, the fee.
2. `/api/bridge/quote`: a **dry** 1Click quote, so no deposit address is made. It returns:
   - the fee split and NEAR delivered, expected and minimum;
   - NEAR Intents' time estimate;
   - stage 2's estimate: $KITS for that NEAR from NEARKITS' route, expected and the minimum at the chosen slippage.

   The page refreshes it every 20 s and shows "Updated X ago". It fabricates nothing while a quote is loading or has failed.
3. `/api/bridge/start`: a **real** quote, `dry: false`.
   - 1Click returns a deposit address, a deadline and its signature.
   - Before it is stored, the server checks:
     - the echo matches the request;
     - the deposit address has the chain's shape;
     - there is no memo, and the deadline leaves at least 10 minutes;
     - the fee share is exactly 25 bps;
     - stage 2 can be priced.
   - It is stored as one order. The order binds the destination, amount, fee, deposit address and stage 2's bound: the least $KITS per NEAR the user accepted.

The server validates everything itself:
- the chain;
- the amount, as a positive decimal within the coin's decimals;
- the source address's shape;
- the destination:
  - a NEARKITS wallet must be one of the session user's own, active and not frozen;
  - a connected account must be a valid mainnet NEAR account that exists on chain;
- the destination token: only `kits.nearlytrade.near`. `createBridgeService` refuses to exist on any network but mainnet or for any other token.

No client-sent amount, fee, route or destination is trusted.

## Execution flow

1. **Review.** It shows the order's own quote and a countdown to `signBy` (5 minutes, and at least 10 minutes before the deposit address closes).
2. **Confirm.** The user's wallet sends exactly `amountIn` to the deposit address:
   - **EVM.** The wallet is asked to switch to chain 1 or 56 (BNB Chain is added if missing), the chain is checked right before sending, then `eth_sendTransaction {from, to: deposit, value}`.
   - **Solana.** NEARKITS builds an unsigned legacy System Program transfer (`src/lib/bridge/solanaTx.ts`; Solana mainnet parses it, see `solanaTx.smoke.ts`) with a recent blockhash from the server (`/api/bridge/solana`). The wallet signs and sends it (`solana:signAndSendTransaction`).
   - **Any other wallet** (no injected wallet, an exchange): the user pastes their source address (refunds go there) and sends the exact amount to the shown deposit address.
3. `/api/bridge/deposit` records the source transaction hash. It is validated per chain, and only one is accepted. The server also tells 1Click (`/v0/deposit/submit`, optional, to speed it up).
4. The page opens `/bridge?order=<id>`. A reload or Activity finds the same order.

## Status tracking

The worker is `server/src/bridge/worker.ts`. Each due order is stepped under its own database lease, every 2 s. The order's own cadence:

- waiting for a deposit: 12 s (30 s after 10 minutes, 6 s once a transfer is known);
- in transit: 6 s;
- errors back off up to 2 minutes.

| 1Click status | Order status | Notes |
|---|---|---|
| `PENDING_DEPOSIT` | `awaiting-deposit` | Expires if nothing arrived 10 minutes past the deadline |
| `KNOWN_DEPOSIT_TX` | `deposit-seen` | |
| `PROCESSING` | `bridging` | |
| `INCOMPLETE_DEPOSIT` | `incomplete-deposit` | NEAR Intents refunds after the deadline unless the rest arrives |
| `REFUNDED` | `refunded` | Amount, reason and transactions recorded. Nothing bought |
| `FAILED` | `failed` | Still followed for 24 h, in case a refund follows |
| `SUCCESS` | `delivered`, only once checked on NEAR | See below |

On `SUCCESS` the server reads the delivery transactions from FastNEAR. Only then is the order `delivered`. It looks for:
- wNEAR: `wrap.near`'s `ft_transfer` from `intents.near` to the receiving account;
- native NEAR: a transfer from `intents.near`.

Until the NEAR is seen there, it stays `bridging` ("confirming it on NEAR") and nothing is bought. The page says "complete" only when $KITS has arrived.

## Stage 2: the $KITS purchase

**To a NEARKITS wallet**, the server runs it through the custody engine, like a web trade or a Volume Bot trade:
- the signer's policy and the wallet's own key;
- the kill switches and freezes;
- route, funds and registration checks;
- the 0.50% trading fee.

The steps:

1. If wNEAR arrived: an `unwrap` intent of exactly that amount.
2. A `buy` intent of the NEAR delivered. It is capped so the wallet keeps its gas reserve (`buyReserve`). Below 0.01 NEAR, nothing is bought.
3. The buy runs only if its minimum is at least `kitsMinPerNear × NEAR spent`, the bound the user accepted at review. A re-quote at signing time is accepted once, and only within the bound.
4. Intent ids are saved on the order before anything runs. A restart follows them; it never starts another, so the purchase is never bought twice.

Anything that stops it ends in `buy-needed` with the reason, and the NEAR stays in the wallet. No signer capability was added or changed.

**To a connected NEAR wallet**, the order stops at `delivered`. The page offers "Buy $KITS", the ordinary Swap review signed in that wallet:
- wNEAR is swapped directly;
- with native NEAR, a 0.05 NEAR gas reserve stays in the wallet.

Afterwards `/api/bridge/settle` checks the transaction on chain before the order is `complete`: signed by the receiving account, succeeded, and $KITS arrived in that account.

When NEAR or $KITS arrives, the receiving wallet's NEAR, wNEAR and $KITS reconcile everywhere: balances, portfolio, positions, activity. This uses the post-trade refresh (`reconcileBalances`).

## Failures and partial failures

| Situation | What happens |
|---|---|
| Quote refused (below a minimum, no route, unavailable) | The 1Click message is classified (`classifyQuoteError`) and shown, e.g. "The amount is below the minimum for this route." Nothing can be started. (BNB had a temporary $1,000 minimum at NEAR Intents on 2026-10-08.) |
| Quote expired before sending | The review says so and offers a new quote. Sending after `signBy` is refused |
| User declines in the wallet | "You declined in your wallet. Nothing was sent." The review stays open |
| Wallet switched account or network | The connection drops ("Connect it again"). The chain is checked again right before sending |
| Transfer sent, NEAR Intents slow | The order follows the deposit address. "Allow up to 15 minutes" is NEAR Intents' own guidance |
| Refunded / failed at NEAR Intents | Shown as such, with the refund amount and transactions. No $KITS claimed |
| NEAR delivered, purchase didn't run (price moved past the bound, trading paused, wallet frozen or busy, too little left after gas) | `buy-needed`: "Bridge completed, $KITS not bought", plus the reason. The NEAR stays in the wallet. Safe next action: "Buy $KITS on Swap", prefilled. No automatic retry beyond a busy wallet (3 tries, 20 s apart) |
| Destination not on NEAR yet | Refused before any quote: a new NEARKITS wallet needs a first NEAR deposit for network fees |

## The Bridge to NEAR

`/bridge-near`. The same quote, fee, order, worker and on-chain delivery check as Bridge & Buy; requests carry `product: 'bridge'` (absent means Bridge & Buy, as the pages before the Bridge sent). Nothing is bought, so there is no slippage and no trading fee.

### What NEAR Intents delivers: wNEAR

Checked 2026-10-09:

- 1Click's token list has **no native NEAR asset** on NEAR. Its only NEAR is `nep141:wrap.near` (wNEAR, 24 decimals).
- 1Click's quote API says withdrawals to NEAR use `ft_transfer` unless `customRecipientMsg` is set (it isn't; see above). So the destination receives **wNEAR**.
- An `ft_transfer` to an account wrap.near doesn't know fails. So the destination must exist on NEAR **and be registered with wrap.near**.

The server still reads the delivery from chain and accepts native NEAR too, exactly as Bridge & Buy does. A native delivery needs no unwrap.

### Destinations and the unwrap

| Destination | Checked by the server | After the wNEAR arrives (checked on chain) |
|---|---|---|
| **My NEARKITS wallet** | One of the session user's own wallets, active, not frozen; on NEAR; registered with wrap.near; NEAR for the unwrap's network fee; the unwrap allowed now | `unwrapping`: NEARKITS runs the engine's existing `unwrap` intent of exactly the wNEAR delivered (one `near_withdraw`, the signer's policy unchanged), once; then `complete` with the native NEAR |
| **Connected NEAR wallet** | A valid mainnet account, on NEAR, registered with wrap.near | `delivered`: the owner unwraps it in their wallet (the ordinary Swap review, wNEAR → NEAR). `/api/bridge/settle` checks the transaction: signed by that account, final, native NEAR back from wrap.near. Then `complete` |
| **External NEAR address** | A valid mainnet account, on NEAR, registered with wrap.near | `complete` as **wNEAR**: no authorized unwrap exists there, and the page says so before the user confirms (and warns the transfer is irreversible) |

- A destination that can't receive it is refused **before** any deposit address exists. The quote carries `delivery: { asset, unwrap, blocked, fix }`, and the page shows the reason and keeps Confirm disabled.
- A connected wallet that isn't registered can register by signing: a 0.001 NEAR wrap, whose review includes wrap.near's one-time registration (`fix: 'register'`).
- A NEARKITS wallet that isn't registered yet gets registered by its first trade. No new signer operation was added for it.
- The unwrap is not a trading or withdrawal operation. The `trading` switch doesn't stop it, and it is allowed on a frozen wallet (`ALLOWED_WHEN_FROZEN`). A frozen wallet is still never a destination.
- **`unwrap-needed`** (partial): the bridge succeeded but the wNEAR wasn't unwrapped. Causes: no NEAR left for the unwrap's fee, a busy wallet three times, the unwrap failing.
  - The order says how much wNEAR is in the wallet.
  - Nothing retries by itself. The owner can press "Unwrap to NEAR now" (`/api/bridge/unwrap`, session-bound, one new unwrap intent per request, of the delivered wNEAR or what the wallet still holds of it), or unwrap on Swap.

### Fee

- **NEARKITS bridge fee:** 0.25%. It is the same `appFees` request (50 bps) and the same check on 1Click's echo; a quote that doesn't pay `nearkitfee.near` exactly 25 bps is refused.
- **NEAR Intents' fee:** as its quote charges it.
- **Network fees:** the source chain's network fee is shown in the user's wallet; the unwrap's network fee is about 0.0005 NEAR, on NEAR.
- **No trading fee.** The fee is charged once, on the bridge.

### Statuses and progress

The progress has five steps: Awaiting the transfer → Bridge processing (NEAR Intents) → wNEAR received on NEAR → Unwrapping (if required) → Complete.

Bridge-only statuses:

- `unwrapping`
- `unwrap-needed`, which is final and shown as partial in Activity.

Activity shows it as "Bridge · 0.06 SOL → 1.42 NEAR · Solana → NEAR · Completed", from the unwrap's or the delivery's own record. It links `/bridge-near?order=<id>`.

### Database

`bridge_orders` gained `product` ('buy-kits' default, 'bridge') and the destination kind 'external'.

- **Migration:** SQLite v16 (a table rebuild, same rows and indexes) and Postgres v7 (the kind check replaced, the column added).
- **Existing orders:** existing rows read back as Bridge & Buy, unchanged.

### Navigation and SEO

- **Sidebar:** Trade → "Bridge" ("Move assets from other chains into NEAR.") and Trade → "Bridge & Buy" ("Bridge your assets and automatically buy $KITS."). Search for "bridge" offers both, each with its line.
- **`/bridge`:** unchanged, with every $KITS link, order link and canonical.
- **`/bridge-near`:** has its own title, description, canonical, sitemap entry, prerendered facts and `llms.txt` lines.

## Activity, navigation, entry points

- **Activity** (Dashboard). Each order is a "Bridge & Buy" row with the summary, the route and the status, linked to `/bridge?order=<id>`. NEARKITS wallets' orders come from `/api/bridge/orders`; a connected wallet's orders are remembered in this browser by id.
- **Navigation.** Trade → "Bridge & Buy" (`/bridge`), plus the `/bridge` command in search.
- **$KITS page.** "Buy $KITS" (the trade drawer) and "Bridge & Buy $KITS".
- **Quick Trade and Swap.** On a $KITS buy short of NEAR: "Need NEAR? Bridge & Buy $KITS". It is only a link; nothing starts without the review.

## Security

- No custody of source funds, no NEARKITS-controlled bridge wallet, no source-chain keys, no seed phrase ever asked for.
- The signer, custody, wallet ownership, Telegram authentication, withdrawal rules and rate limits are unchanged. Stage 2 uses the existing engine path the Volume Bot uses.
- **Kill switch.** `npm run ops -- pause bridge <reason>`, or `NEARKIT_OPS_PAUSED=bridge`, stops new deposit addresses. Orders under way are still followed; their purchase follows the `trading` switch.
- An order holds no secret: addresses, amounts, hashes, and 1Click's signed quote, kept for disputes.
- Logs record quote requests and returns (chain, USD size, latency), status changes, deliveries, refunds and failures. Never keys, never the API key: it is registered with the logger's redaction.

## Environment (server)

| Variable | Default | |
|---|---|---|
| `NEARKIT_BRIDGE` | on (mainnet + `NEARKIT_FEE_RECIPIENT=nearkitfee.near`) | `off` turns it off |
| `ONECLICK_API_URL` | `https://1click.chaindefuser.com` | |
| `ONECLICK_API_KEY` | none | **Secret**, optional: a 1Click partner JWT from partners.near-intents.org, sent as `Authorization: Bearer`. Never exposed to the browser |
| `SOLANA_RPC_URL` | `https://api.mainnet-beta.solana.com` | A private RPC is better under load |

The web app needs nothing new: it calls `VITE_NEARKIT_API_URL`.

## Production setup

1. Deploy the server first. It carries the `bridge_orders` migrations, the routes and the worker. Then deploy the web.
   - Bridge & Buy: SQLite v15 / Postgres v6.
   - The Bridge: SQLite v16 / Postgres v7 (`product`, the 'external' kind, and `/api/bridge/unwrap`).
   - An older server doesn't know `product` and refuses the Bridge's requests ("Missing slippage": they carry none), so the order matters. Nothing is sent either way.
2. Optional: set `ONECLICK_API_KEY`. The fee check works either way. Confirm with `npm run smoke:live -- server/src/bridge/oneclick.smoke.ts` (dry quotes only).
3. `/health` reports `bridge: on|off` and the `bridge` pause.

## Tests

| Area | File |
|---|---|
| Shared rules (fee, chains, addresses, progress) | `src/lib/bridge/bridge.test.ts` |
| Solana transfer bytes | `src/lib/bridge/solanaTx.test.ts` |
| 1Click parsing and error classes | `server/src/bridge/oneclick.test.ts` |
| Service and routes | `server/src/bridge/bridge.test.ts` (Bridge & Buy), `server/src/bridge/nearBridge.test.ts` (Bridge) |
| Orders table and its migration | `server/src/bridge/store.test.ts` |
| How a Bridge reads (steps, Activity) | `src/features/bridge/nearBridge.test.ts` |
| SEO | `src/config/seo.test.ts` |
| Live, read only | `server/src/bridge/oneclick.smoke.ts`, `src/lib/bridge/solanaTx.smoke.ts` |
| End to end (both products) | `npm run dev:bridge-e2e`, then `npm run e2e:bridge` |

The service and route tests in `server/src/bridge/bridge.test.ts` run against a fake 1Click over HTTP, FastNEAR records, and the test chain with the real custody engine. They cover:
- the quote request and fee injection;
- the fee refusal and input validation;
- order ownership;
- the kill switches;
- every status;
- delivery checked on chain;
- stage 2 (native NEAR, wNEAR, price beyond the bound, trading paused, never twice);
- connected-wallet settlement;
- mainnet-only.

The end-to-end run uses a mainnet build against a scripted Bridge API, with fake EVM and Solana wallets. It covers:
- SOL, ETH and BNB to completion, checking the exact bytes and wei the wallet is asked to send;
- below-minimum, refund and buy-needed;
- Activity and reload;
- the entry points;
- layout at 1920, 1440, 1280, 1024, 820, 768, 390, 375 and 360px.
