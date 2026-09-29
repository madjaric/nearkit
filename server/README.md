# NearKit server: Telegram bot and API

The app process runs the NearKit Telegram bot (long polling) and a small HTTP API the web
app calls. It shares NearKit's own code with the web app through the `@` alias (`src/`):
token lookup, Rhea quotes and every route check, prices and NEAR RPC. Trading logic is
never re-implemented here.

Two more processes come from the same build:
- **the signer** (`npm run signer`), the only holder of NearKit wallet keys;
- **the buy bot** (`npm run buybot`), which is read-only.

Production topology, configuration and operations are in [DEPLOYMENT.md](../DEPLOYMENT.md).
The mainnet go-live steps are in [MAINNET_CEREMONY.md](../MAINNET_CEREMONY.md), and the
compromise review is in [SECURITY_REVIEW.md](../SECURITY_REVIEW.md).

## Run it locally

```bash
npm run server
```

That builds `dist-server/main.js` and starts it. Settings come from the environment and
from `server/.env.local` (git-ignored; see `server/.env.example`). Only the names of
loaded variables are logged, never values.

NearKit wallets need a signer. On testnet the app can host it in-process with a local
key-encryption key. Create it once:

```bash
npm run server:wallet-key
```

It writes `NEARKIT_WALLET_KEK` to `server/.env.wallet.local` (git-ignored) without printing
it. Back that file up: without it the stored wallet keys can't be opened.

Or run the signer as its own service, as mainnet requires:
- configure `server/.env.signer.local` (see `server/.env.signer.example`);
- `npm run signer:auth-key` writes the shared auth key for both sides;
- then `npm run signer`, and set `NEARKIT_SIGNER_URL` on the app.

Without a signer, NearKit wallets are off (`/health` says `"wallets": "off"`). On mainnet
they stay off until the owner's `NEARKIT_MAINNET_CUSTODY=enabled`, and that mode needs:
- the signer service;
- a KMS key;
- PostgreSQL;
- `nearkitfee.near`.

Operator commands, each from the same build:

```bash
npm run ops -- status            # kill switches, frozen wallets, the signer (pause|resume|freeze|events)
npm run signer:admin -- status   # on the signer's host: KEK, database, keys held (pause|resume|reseal)
npm run referrals -- summary     # referral earnings and claims (claims|paid|reject)
npm run buybot                   # buy alerts as a separate process (BUYBOT_RUNNER=separate on the app)
```

The web app finds the server through two public build variables:
`VITE_NEARKIT_API_URL` (e.g. `http://localhost:8787`) and `VITE_TELEGRAM_BOT`
(the bot's username). Without them, the Telegram page stays COMING SOON and says why.

## Security model

- **Custody only in NearKit wallets.** A user's NearKit wallet is a separate implicit
  account whose key only the signer holds.
  - The key is envelope-encrypted and bound to its wallet and owner, under a KMS key on
    mainnet. The app's database holds no key.
  - The signer enforces its own policy. It signs verified Rhea swaps, withdrawals to the
    owner wallet or owner-approved destinations, unwrap, the backup key, and revoking its
    own key.
  - Everything else, including every linked wallet, is signed by the user in the web app.
  - Mainnet custody is off unless the owner enables it (`src/custody/networks.ts`).
  - The full design, threat model and mainnet status: `NEARKIT_TELEGRAM_V2_ARCHITECTURE.md`.
- **Account linking** (`src/link/service.ts`): `/link` issues a one-time code (128 bits,
  10 minutes, single use, bound to that Telegram user; only its SHA-256 is stored). The
  web page (`/telegram#link=…`, a URL fragment, so it never reaches server logs) shows
  which Telegram account asked, and the wallet signs a NEP-413 message naming it. The
  server verifies the signature over the stored message, nonce and recipient, then checks
  on chain that the key is a **full-access** key of the account. Function-call keys are
  refused: any app can hold one.
- **No silent hijack.** A NEAR account links to one Telegram account per network. Moving
  it needs the owner's signature again, and the previous Telegram account is told.
- **Secrets.** The bot token lives only in the environment, `server/.env.local`, or a
  secret file (`TELEGRAM_BOT_TOKEN_FILE`). The testnet key-encryption key lives in the
  environment or `server/.env.wallet.local`. Every log line passes through redaction,
  which also removes anything shaped like a bot token or a NEAR secret key.
- **Abuse limits.** Per-user event limits in the bot, per-IP and per-route limits on the
  API, 16 KB request bodies, a CORS allow-list, and `no-store` responses.
- **Input.** Everything from outside (token names from chain metadata, user text) is
  HTML-escaped and stripped of control and bidi characters before it reaches Telegram.

## NearKit wallets

`/wallet` (the menu's 👛 Wallet), `/deposit`, `/withdraw` and 🔐 Recovery:

- **Up to 10 wallets per user.** Each has its own key, balance and lifecycle, and every
  screen and confirmation names the wallet it acts on.
  - A linked wallet is required: it becomes the **owner**. Later wallets keep the same
    owner.
  - Deposit shows the exact address and network. Balances are read from chain.
- **Withdraw** NEAR or any token it holds to the owner wallet, or to **any valid address**
  the owner wallet approved once, with a signature in NearKit web. The signer checks that
  approval at every use.
  - The review shows wallet, asset, amount, destination, network, fees and any
    registration the destination needs.
  - Everything is re-checked right before signing.
- **Recovery, per wallet:**
  - Add the owner wallet's key as a backup key. The user's own wallet then controls this
    one without NearKit.
  - Export the key in NearKit web (`/recover`) after an owner-wallet signature. It works
    without Telegram and never happens in Telegram.
  - Remove NearKit's key, or delete a wallet that was never funded.
- **One Confirm, at most one transaction.**
  - Every Confirm is a persisted intent.
  - Each transaction is saved before it is sent and never signed twice.
  - An unclear send is resolved from the chain (transactions are anchored to expire ~10
    minutes after signing), also after a restart.
  - With PostgreSQL, several instances can run: leases make sure only one of them executes
    an intent. With SQLite, run a single instance.
- **Invite friends** (`/referral`): a permanent invite link. A referrer earns 20% of
  NearKit's net fee on the trades of the people they brought. Claims are paid by the owner.

## Trading from Telegram

`/buy`, `/sell`, `/quote`, `/token` and `/balance`, in a private chat. With a NearKit
wallet, trades run right here (below); without one, on the linked default account through
the web app. Tokens are found by symbol or by exact contract (the same `lookupToken`
as the web app's exact-contract import, so a token launched minutes ago works).

**From the NearKit wallet:** a compact quote (you pay, you receive, minimum and slippage,
NearKit fee, network fee, registrations, route), then Confirm. Right before signing,
NearKit fetches a fresh route bound to the wallet and sends it only if its minimum is at
least the one confirmed; otherwise the new quote is shown and nothing is sent. The result
(spent, received, fee, transaction) is read from the chain.

The quote comes from NearKit's own trading service: Rhea's router with every route
check the web app runs, the same NearKit fee on mainnet (`NEARKIT_FEE`, 0.50%), and "Rhea found no route" said
plainly when there is none. Nothing is ever faked or estimated into a trade.

**From a linked wallet (no NearKit wallet): signing stays in the wallet.** "Confirm & sign in NearKit" opens the web app's
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

Group admins send `/buybot` (or `/add <contract>`) in their group. They add a token by its
exact contract; NearKit reads its metadata from chain and shows it before anything is saved.
From then on every buy is posted in the group.

Per token, admins choose:

- the minimum trade, in NEAR or in USD;
- the emoji, and how much value each one stands for;
- a cap on emoji;
- a photo, GIF or video posted with every alert;
- whether sells are posted too;
- whether alerts make a sound.

`/list` shows the group's tokens, `/remove` drops one, and `/pause` and `/resume` switch
every alert in the group. Only group admins can do any of this.

A USD minimum is never checked against a guess. A trade whose USD value isn't known is
posted only when the minimum is "Any". If Telegram no longer knows the media file, alerts
fall back to text and the media is dropped, so the group isn't left silent.

- **Detection** (`src/buybot/follower.ts`, `pipeline.ts`): each followed token's contract
  history is read from FastNEAR's transaction index (about two blocks behind the chain).
  A transaction is read in full only after its block is final by a margin and every receipt
  it created is present. Buys are found by the shared analyzer `src/services/near/flows.ts`
  (also used for positions): the transaction's initiator ended with more of the token and
  gave something up. Failed swaps, refunds, transfers and launchpad tax payouts are not buys.
- **The alert:**
  - `$TOKEN Buy!`, the USD value, the NEAR value, the amount and the buyer;
  - **Market cap (FDV)**, holders (NearBlocks), the contract (CA) and the transaction link;
  - buttons: **Buy $TOKEN** (NearKit's swap), **Chart** (DexScreener) and **Copy CA**.
- **Figures:**
  - Amounts come from the chain.
  - USD uses NEAR/USD from Coinbase (CoinGecko fallback), or Rhea's price list for other
    tokens. Price is this buy's own price.
  - Market cap is shown as FDV (total supply × that price) and labelled as such, because
    circulating supply isn't known on chain. Liquidity is not shown.
  - Unknown figures are left out, never estimated.
- **Delivery**: one row per (buy, chat), whose status only moves forward. Messages are spaced
  per chat, `retry_after` is honoured, a chat that removed the bot is paused, and a group
  that became a supergroup is followed to its new ID. A buy more than 15 minutes old is
  not posted. A crash between Telegram accepting a message and it being marked sent can
  repeat that one message; nothing else can.
- **Restarts**: each token's cursor trails the final head by a few blocks and is saved with
  the transactions found, so a restart resumes without gaps; seeing a transaction twice is
  harmless. After a long outage it skips ahead instead of posting old buys.
- **Network**: `BUYBOT_NETWORK` defaults to mainnet (read-only), independent of the network
  trading uses. The Buy button appears only when both match.
- **Process**: in the app by default. In production, run `npm run buybot` on its own with
  `BUYBOT_RUNNER=separate` on the app. It holds no custody setting (it refuses one), and one
  instance posts at a time.

Channels aren't supported yet: add the bot to a group.

## Data

- **Engines:**
  - **PostgreSQL** (`NEARKIT_DATABASE_URL`): production, several instances. Migrations run
    under an advisory lock.
  - **SQLite** through sql.js (WebAssembly, no native build): local and a single testnet
    host. It is written after every committed change, to a temporary file first and then
    renamed over the old one.
- **Stored:**
  - Telegram user IDs and names, linked NEAR account IDs and public keys, preferences and
    short-lived conversation state;
  - for NearKit wallets: addresses, owners, intents, the signed transactions (public once
    sent) and a security log;
  - referrals and kill switches.
- **The signer has its own database:** sealed keys, owner requests, approved destinations
  and its events. No plain secret is stored anywhere.

## Tests

- `npm test` includes `server/src/**/*.test.ts`: config, redaction, database, Telegram
  client (rate limits, 429), polling, linking (real ed25519 signatures), API, and bot flows
  against a fake Telegram.
- `server/src/custody/*.test.ts`, `server/src/signer/*.test.ts` and the bot's wallet tests
  cover the following against a fake NEAR runtime that verifies signatures and nonces:
  - keys, encryption and KMS;
  - the signer's policy and transport;
  - intents, idempotency and concurrency;
  - several wallets and owner-approved destinations;
  - native trading, recovery, kill switches and referrals.
- The database, custody, signer and referral suites also run against PostgreSQL when
  `NEARKIT_TEST_DATABASE_URL` is set (CI does).
- `npm run e2e:telegram` runs the built server and the web app together, with Telegram and
  NEAR faked over HTTP, links an account end to end, and creates a NearKit wallet.

## Deploying

The server needs a long-running host; Vercel's static hosting can't run it.
`server/Dockerfile` builds it for any Docker host (build context: the repository root).
Nothing secret goes into the image, and `.dockerignore` keeps every local `.env` file out of
the build.

- **Production (mainnet):** follow [DEPLOYMENT.md](../DEPLOYMENT.md):
  - the app, the signer and the buy bot;
  - two PostgreSQL databases;
  - AWS KMS;
  - secrets from the host's secret store.
- **A single testnet host:** one instance, always on (polling and the wallet resolver). The
  SQLite database goes on a persistent volume, with `TELEGRAM_BOT_TOKEN` and
  `NEARKIT_WALLET_KEK` as host secrets, not on the volume.

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
