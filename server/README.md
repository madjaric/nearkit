# NearKit server: Telegram bot and API

One Node process that runs the NearKit Telegram bot (long polling) and a small HTTP API
the web app calls. It shares NearKit's own code with the web app through the `@` alias
(`src/`): token lookup, Rhea quotes and every route check, prices and NEAR RPC. Trading
logic is never re-implemented here.

## Run it locally

```bash
npm run server
```

That builds `dist-server/main.js` and starts it. Settings come from the environment and
from `server/.env.local` (git-ignored; see `server/.env.example`). Only the names of
loaded variables are logged, never values.

The web app finds the server through two public build variables:
`VITE_NEARKIT_API_URL` (e.g. `http://localhost:8787`) and `VITE_TELEGRAM_BOT`
(the bot's username). Without them, the Telegram page stays COMING SOON and says why.

## Security model

- **No custody.** The server holds no keys and cannot sign. Anything that moves funds is
  signed in the user's own wallet in the NearKit web app, after the usual review.
- **Account linking** (`src/link/service.ts`): `/link` issues a one-time code (128 bits,
  10 minutes, single use, bound to that Telegram user; only its SHA-256 is stored). The
  web page (`/telegram#link=…`, a URL fragment, so it never reaches server logs) shows
  which Telegram account asked, and the wallet signs a NEP-413 message naming it. The
  server verifies the signature over the stored message, nonce and recipient, then checks
  on chain that the key is a **full-access** key of the account. Function-call keys are
  refused: any app can hold one.
- **No silent hijack.** A NEAR account links to one Telegram account per network. Moving
  it needs the owner's signature again, and the previous Telegram account is told.
- **Secrets.** The bot token lives only in the environment or `server/.env.local`. Every
  log line passes through redaction, which also removes anything shaped like a bot token.
- **Abuse limits.** Per-user event limits in the bot, per-IP and per-route limits on the
  API, 16 KB request bodies, a CORS allow-list, and `no-store` responses.
- **Input.** Everything from outside (token names from chain metadata, user text) is
  HTML-escaped and stripped of control and bidi characters before it reaches Telegram.

## Trading from Telegram

`/buy`, `/sell`, `/quote`, `/token` and `/balance`, in a private chat, on the linked
default account. Tokens are found by symbol or by exact contract (the same `lookupToken`
as the web app's exact-contract import, so a token launched minutes ago works).

The quote comes from NearKit's own trading service: Rhea's router with every route
check the web app runs, the same NearKit fee on mainnet (`NEARKIT_FEE`, 0.50%), and "Rhea found no route" said
plainly when there is none. Nothing is ever faked or estimated into a trade.

**Signing stays in the wallet.** NearKit has no custody and the bot holds no keys, so a
trade can't be signed in Telegram itself. "Review & sign in NearKit" opens the web app's
swap page with the trade filled in and a random handoff ID (`src/trade/handoff.ts`).
There the route is quoted again, the usual review shows the exact transactions, and the
user's wallet signs (HOT Wallet signs inside Telegram; other wallets open as usual).
The web app then reports the transaction hashes to the API. The server believes none of
it: each hash is read from chain and must be signed by the linked account the trade was
prepared for, and the amounts come from the chain's record. Only then does the bot
report "Bought … for …", "the swap failed", or "confirmed, but no swap went through".

## Positions and PnL in Telegram

`/positions` and `/pnl [7d|30d|90d]` run the web app's own engine, tracker and report
(`src/lib/pnl.ts`, `src/services/real/pnlTracker.ts`, `pnlReport.ts`) over the user's linked
accounts, and link back to the NearKit pages. Figures the history can't support are marked
partial, with the reason. Gas is reported for the history actually read.

## Buybot

Group admins send `/buybot` in their group, add a token by its exact contract (NearKit
reads its metadata from chain and shows it before anything is saved), and choose a
minimum buy size, emoji scale and sound. From then on every buy is posted in the group.

- **Detection** (`src/buybot/follower.ts`, `pipeline.ts`): each followed token's contract
  history is read from FastNEAR's transaction index (about two blocks behind the chain).
  A transaction is read in full only after its block is final by a margin and every receipt
  it created is present. Buys are found by the shared analyzer `src/services/near/flows.ts`
  (also used for positions): the transaction's initiator ended with more of the token and
  gave something up. Failed swaps, refunds, transfers and launchpad tax payouts are not buys.
- **Figures**: amounts come from the chain. USD uses NEAR/USD from Coinbase (CoinGecko
  fallback) or Rhea's price list for other tokens. Price is this buy's own price. FDV is total
  supply × that price, labelled as such. Market cap and liquidity are not shown: circulating
  supply and per-token liquidity aren't reliably known. Unknown figures are left out.
- **Delivery**: one row per (buy, chat), whose status only moves forward. Messages are spaced
  per chat, `retry_after` is honoured, a chat that removed the bot is paused, and a group
  that became a supergroup is followed to its new ID. A buy more than 15 minutes old is
  not posted. A crash between Telegram accepting a message and it being marked sent can
  repeat that one message; nothing else can.
- **Restarts**: each token's cursor trails the final head by a few blocks and is saved with
  the transactions found, so a restart resumes without gaps; seeing a transaction twice is
  harmless. After a long outage it skips ahead instead of posting old buys.
- **Network**: `BUYBOT_NETWORK` defaults to mainnet (read-only), independent of the network
  trading uses. The "Trade on NearKit" button appears only when both match.

Channels aren't supported yet: add the bot to a group.

## Data

SQLite through sql.js (WebAssembly, no native build). The database is written after every
committed change: to a temporary file first, then renamed over the old one. Stored: Telegram
user IDs and names, linked NEAR account IDs and public keys, preferences, short-lived
conversation state. Nothing secret.

## Tests

- `npm test` includes `server/src/**/*.test.ts`: config, redaction, database, Telegram
  client (rate limits, 429), polling, linking (real ed25519 signatures), API, and bot flows
  against a fake Telegram.
- `npm run e2e:telegram` runs the built server and the web app together, with Telegram and
  NEAR faked over HTTP, and links an account end to end.

## Deploying

The server needs a long-running host with a persistent disk for the database; Vercel's
static hosting can't run it. `server/Dockerfile` builds it for any Docker host (build
context: the repository root). Nothing secret goes into the image, and `.dockerignore`
keeps every local `.env` file out of the build.

### Railway

`.railway/railway.ts` declares the whole setup:

- one instance in `europe-west4`, because Telegram allows one long-polling client per bot token;
- a 1 GB volume at `/data` holding `NEARKIT_DB_PATH`. The deploy refuses to start without it;
- a healthcheck on `/health`, and no overlap between an old and a new deploy;
- the domain `nearkit-api.up.railway.app`;
- every non-secret variable: testnet trading like the public beta, the buybot reading mainnet, and no fee account.

1. `railway config plan`, then `railway config apply`: creates the service, volume, domain and variables.
2. In Railway, add `TELEGRAM_BOT_TOKEN` to `nearkit-server` (Variables). It is the only secret,
   and the file keeps it as set (`preserve()`).
3. From the repository root, run `railway up --service nearkit-server --detach`.
   Git-ignored files, such as `server/.env.local`, are not uploaded.
4. Check `https://nearkit-api.up.railway.app/health`. It should show `bot: true` and
   `buybot: "running"`. `boot` goes up by one on every start that found the database, so
   `boot: 1` after a restart means the data did not survive.
5. Build the web app with `VITE_NEARKIT_API_URL=https://nearkit-api.up.railway.app` and
   `VITE_TELEGRAM_BOT=NearKitBot` (Vercel, Production). The Telegram page then goes live.

While Railway runs the bot, don't start a local server with the same token. Telegram gives
one poller per token, and the other one gets 409 Conflict.
