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

The server needs a long-running host (a VM, Fly.io, Railway, …) with a persistent disk for
the database. Put the API behind HTTPS and set `NEARKIT_API_PUBLIC_URL`, then build the
web app with `VITE_NEARKIT_API_URL` pointing at it. Vercel's static hosting can't run it.
