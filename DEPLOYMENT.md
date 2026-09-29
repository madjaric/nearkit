# NearKit production deployment

How NearKit runs in production: which processes, what each may reach, what each is configured with, and how to start, check, pause, back up, migrate and roll back.

> **Status (2026-09-29).**
> - Nothing here is deployed.
> - The public site (nearkit.vercel.app) is the **testnet beta**, with mainnet execution off.
> - Mainnet custody is off until the owner runs the ceremony in [MAINNET_CEREMONY.md](MAINNET_CEREMONY.md).
> - Hosting (FadeHost or another) needs the owner's explicit authorization before anything is deployed.

---

## 1. Services

| Service | What it is | Built as | Reachable from | Holds |
|---|---|---|---|---|
| **Web** | The React app. Users sign every web transaction in their own wallet | `npm run build` → `dist/` (Vercel, static) | Public | Nothing secret (public `VITE_*` settings only) |
| **App / API + Telegram bot** | Telegram bot (long polling), the web app's API (linking, handoffs, recovery relay), the intent engine, resolver, referrals, kill switches | `dist-server/main.js` | The API is public over HTTPS behind a reverse proxy. Telegram traffic is outbound only | Bot token, the app database's credentials, the signer auth key |
| **Buy bot** | Buy alerts in groups. Read-only on NEAR | `dist-server/buybot.js` | Outbound only, plus an optional private `/health` | Bot token (to post), database credentials (buybot tables). Refuses any custody setting |
| **Signer** | The only process that opens NearKit wallet keys. Enforces the policy itself | `dist-server/signer.js` | **Private network only**, from the app | The signer auth key, its own database's credentials, and an IAM role that may use the KMS key |
| **PostgreSQL (app)** | Users, links, wallets (no keys), intents, audit, referrals, buybot, switches | managed Postgres 16 | Private (app and buybot) | — |
| **PostgreSQL (signer)** | Sealed keys, request nonces, owner challenges, approved destinations, signatures, signer events | managed Postgres 16 | Private (signer only) | Sealed keys: ciphertext under the KMS key |
| **KMS** | The key-encryption key (AWS KMS, symmetric) | — | IAM: the signer's role only (`kms:Encrypt`, `kms:Decrypt` on this key) | The KEK. It never leaves the KMS |

The web never talks to the signer: web trades are user-signed. The signer never talks to Telegram and has no public address.

Operator commands, each a script over the same build:
- `npm run ops` (app host): kill switches, frozen wallets, security events.
- `npm run referrals` (app host): payouts.
- `npm run signer:admin` (signer host): status, pause/resume, reseal.

---

## 2. Network layout

```
                 Internet
   users ── web (Vercel, static) ──┐
   Telegram ◄── polling ─────────┐ │ HTTPS (CORS: web origin)
                                 ▼ ▼
                         ┌──────────────────┐        ┌──────────────┐
                         │  App / API + bot │──TLS──►│    Signer    │──IAM──► AWS KMS
                         │  (1..n instances)│ HMAC   │ (private net)│
                         └────────┬─────────┘        └──────┬───────┘
                                  │                         │
                          ┌───────▼────────┐        ┌───────▼────────┐
                          │ Postgres (app) │        │Postgres(signer)│
                          └───────▲────────┘        └────────────────┘
                                  │
                         ┌────────┴─────────┐
                         │     Buy bot      │── posts ──► Telegram
                         └──────────────────┘
      NEAR RPC providers (several), Rhea, FastNEAR, NearBlocks: outbound HTTPS from app, signer, buy bot
```

App ↔ signer runs over TLS on a private network (or the signer as a sidecar on 127.0.0.1), and every request and answer is HMAC-signed (`server/src/signer/auth.ts`).

---

## 3. Configuration per service

Every server process fails closed on its configuration: a missing or doubtful critical value stops it at start. Each checks that its RPC providers serve its network (`chain_id`). Secrets are never printed, not even in a configuration error.

### 3.1 App / API + bot (`server/.env.example`)

| Variable | Production value | Notes |
|---|---|---|
| `NEAR_NETWORK` | `mainnet` | |
| `TELEGRAM_BOT_TOKEN` | secret | Production bot only |
| `TELEGRAM_BOT_USERNAME` | e.g. `NearKitBot` | A token of another bot stops the server |
| `NEARKIT_DATABASE_URL` | secret `postgres://…` | Required for mainnet custody and for more than one instance |
| `NEARKIT_WEB_URL` | the mainnet web app, `https://…` | Its host is the NEP-413 recipient of every owner signature |
| `NEARKIT_API_PUBLIC_URL`, `NEARKIT_API_ALLOWED_ORIGINS`, `NEARKIT_API_HOST=0.0.0.0` | | Behind the reverse proxy |
| `NEARKIT_FEE_RECIPIENT` | `nearkitfee.near` | Exactly this on mainnet; any other refuses to start |
| `NEARKIT_SIGNER_URL` | `https://signer.internal:8790` | Private DNS name |
| `NEARKIT_SIGNER_AUTH_KEY` | secret, 32 bytes base64 | The same value as the signer's |
| `NEARKIT_MAINNET_CUSTODY` | `off` until go-live, then `enabled` | With `enabled`, the signer URL (https), Postgres, the fee account and an https web URL are all required |
| `NEARKIT_WALLET_KEK` | **unset** | Testnet only; refused on mainnet |
| `BUYBOT_RUNNER` | `separate` | The app keeps the groups' `/buybot` settings; the buy bot posts |
| `NEAR_RPC_URL` | two or more mainnet providers | Checked at start |

### 3.2 Signer (`server/.env.signer.example`)

| Variable | Production value | Notes |
|---|---|---|
| `NEAR_NETWORK` | `mainnet` | Never assumed |
| `NEARKIT_MAINNET_CUSTODY` | `enabled` at go-live | Without it the signer refuses to start on mainnet |
| `NEARKIT_SIGNER_AUTH_KEY` | secret | Same as the app's |
| `NEARKIT_KMS_KEY_ARN` | `arn:aws:kms:<region>:<account>:key/<id>` | An exact key ARN, not an alias. `NEARKIT_KMS_PREVIOUS_KEY_ARNS` during a rotation |
| `NEARKIT_SIGNER_DATABASE_URL` | secret `postgres://…` | Its own database and credentials |
| `NEARKIT_SIGNER_RECIPIENT` | the web app's host | What every owner signature must name |
| `NEARKIT_FEE_RECIPIENT` | `nearkitfee.near` | Exactly this on mainnet |
| `NEARKIT_SIGNER_RPC_URLS`, `NEARKIT_SIGNER_RPC_QUORUM` | ≥ 2 providers, quorum ≥ 2 | Security facts need agreeing providers |
| `NEARKIT_SIGNER_MAX_SLIPPAGE_PCT` | owner decision (default 50) | A swap's minimum may not sit further below the signer's own Rhea quote. Lower means safer against a compromised app, but refuses trades with more slippage |
| `NEARKIT_SIGNER_HOST`, `NEARKIT_SIGNER_PORT`, `NEARKIT_SIGNER_TLS_CERT`, `NEARKIT_SIGNER_TLS_KEY` | private interface and TLS | TLS is required unless it listens on 127.0.0.1 |
| `NEARKIT_SIGNER_PAUSED`, `NEARKIT_SIGNER_PAUSE_FILE` | `false`, a path on persistent storage | Host-level kill switches, checked on every request. The flag is read at start (change it with a restart); the file pauses while it exists. `signer:admin -- resume` does not lift either |

It must **not** have `TELEGRAM_BOT_TOKEN`, `NEARKIT_DATABASE_URL` or `NEARKIT_WALLET_KEK`. It warns if they are present.

### 3.3 Buy bot

- **Needs:** the app's environment subset: `NEAR_NETWORK`, `TELEGRAM_BOT_TOKEN`, `NEARKIT_DATABASE_URL`, `NEARKIT_WEB_URL`, `BUYBOT_NETWORK=mainnet`, `BUYBOT_RPC_URL`, `BUYBOT_DATA_URL`, `BUYBOT_HEALTH_PORT`.
- **Refused:** it refuses to start with `NEARKIT_WALLET_KEK`, `NEARKIT_SIGNER_AUTH_KEY`, `NEARKIT_SIGNER_KEK` or `NEARKIT_KMS_KEY_ARN`.

### 3.4 Web (Vercel)

- `VITE_NEAR_NETWORK`, `VITE_NEARKIT_FEE_RECIPIENT=nearkitfee.near`, `VITE_ENABLE_MAINNET_EXECUTION`, `VITE_NEARKIT_API_URL`, `VITE_TELEGRAM_BOT`, optionally `VITE_NEAR_RPC_URL`.
- On mainnet any fee account but `nearkitfee.near` blocks trading, and the reason is shown.
- The tracked mainnet profile `.env.mainnet` keeps execution **off**.

---

## 4. Health checks

| Service | Check | Healthy when |
|---|---|---|
| App | `GET /health` (public, secret-free) | `ok: true`; `wallets: "on"` (when custody is on); `signer: "ok"`; `pauses` as intended; `bot: true`; `buybot` as configured |
| Signer | `GET /livez` | Process alive (no details) |
| Signer | `npm run signer:admin -- status` on its host, or the app's `/health` `signer` field | KEK `ok` (a KMS round trip), database `ok`, `paused false`, network `mainnet` |
| Buy bot | `GET /health` on `BUYBOT_HEALTH_PORT` | `ok: true` (followed within 2 minutes); `posting: true` on exactly one instance |

---

## 5. Persistence, backups, restarts

- **App database.** All financial state: wallets without keys, intents, signed transactions saved before sending, audit, referrals and switches.
  - Point-in-time recovery, daily snapshots, restore tested quarterly.
  - Many app instances can share it: execution leases, one intent in flight per wallet, one Telegram poller and one buy bot runner (leases).
- **Signer database.** Sealed keys (KMS ciphertext), owner approvals (self-verifying signatures), nonces and signatures.
  - Point-in-time recovery, separate credentials and backups with restricted access. A backup without the KMS key is useless ciphertext.
  - **Losing it loses every NearKit wallet key**, except where the user added a backup key or exported. Back it up like money.
- **KMS key.**
  - Automatic rotation on.
  - Never schedule it for deletion while any wallet key is sealed under it (`npm run signer:admin -- status` shows the keys held).
  - Moving to a new key: add it as current, keep the old ARN in `NEARKIT_KMS_PREVIOUS_KEY_ARNS`, run `reseal`, then `reseal --apply`.
- **Restarts.** Every process is stateless apart from its database:
  - Intents in flight when a process stops are settled from the chain by the resolver (read-only), without sending anything again.
  - The buy bot resumes from its stored cursor.

---

## 6. Migration order and rollback

**Order at every deploy:**
1. **Signer first.** It migrates its own tables at start (its own track, `signer_schema_version`).
2. **App.** It migrates at start under a Postgres advisory lock (instances take turns).
3. **Buy bot.**

**Migrations are forward-only.**
- The PostgreSQL baseline (`server/src/db/pgSchema.ts`, version 1) may still be edited until the first production deploy.
- From then on every change is a new migration that the previous release can run against: add columns before using them, drop them one release later.

**Rollback:**
- Redeploy the previous build.
- If a migration must be undone, restore from point-in-time recovery; don't hand-edit.
- Rolling back only the web is always safe: it holds no state.

**Custody emergency rollback:**
- `NEARKIT_MAINNET_CUSTODY=off` on the app, then restart. NearKit wallets disappear from Telegram; no key is touched.
- Or pause (§7). Users with a backup key or an export keep full control on chain either way.

---

## 7. Kill switches (fail closed)

| Switch | How | Stops | Keeps working |
|---|---|---|---|
| Trading | `npm run ops -- pause trading <reason>` | New quotes and Confirms of Buy/Sell from NearKit wallets | Withdrawals, deposits, unwrap, backup key, export, revoke |
| Withdrawals | `npm run ops -- pause withdrawals <reason>` | Every withdrawal from NearKit wallets | Trading, backup key, owner-signed export (web) |
| One wallet | `npm run ops -- freeze <wallet or account> <reason>` | That wallet's trades and withdrawals | Its backup key, revoke, unwrap, export |
| Signer (from the app) | `npm run ops -- signer-pause <reason>` | Every signature, export, approval and erasure | Everything read-only. Only the signer's operator resumes |
| Signer (on its host) | `npm run signer:admin -- pause/resume <reason>`, `NEARKIT_SIGNER_PAUSED=true`, or the pause file | Same | Same |
| Mainnet custody | `NEARKIT_MAINNET_CUSTODY=off` and restart | NearKit wallets in Telegram | Everything else |
| KMS key (emergency brake) | Disable the key in AWS KMS (`aws kms disable-key --key-id <ARN>`); enable it again to resume | Every unwrap anywhere, so nothing is signed or exported, even by a compromised signer host | Everything read-only. Funds stay on chain |
| Web execution | `VITE_ENABLE_MAINNET_EXECUTION=false` and redeploy | All web signing | Balances, quotes |

- Switches that can't be read count as paused.
- Transactions already sent are always followed to the end (read-only).
- Every switch change is a security event (`npm run ops -- events`).

---

## 8. Logs and audit

- **Structured JSON logs.**
  - Every secret the process knows (bot token, database password, KEKs, the auth key) is registered with the logger and redacted if it ever appears.
  - Request bodies are never logged: path, status and time only.
- **Security events.** App: `custody_audit`, listed by `npm run ops -- events`. Signer: `signer_events`, via `signer:admin status`.
  - Events: wallet create/delete/revoke/freeze, owner binding, backup key, export link, recovery session, export, destination approval, intent confirmed/blocked/done/failed, transaction signed/sent/resolved, referral attribution/earning/claim, signer denials and refused owner proofs, switch changes.
  - None ever holds a secret, and the lifecycle secret scan tests that (`server/src/bot/custodySecrets.test.ts`).
- **Alert on:** signer denials, refused owner proofs, exports, withdrawal bursts, KMS Decrypt volume (CloudTrail), `/health` not ok, and the resolver's "couldn't confirm" outcomes.

---

## 9. Reference container layout

[`deploy/docker-compose.production.yml`](deploy/docker-compose.production.yml) is a reference, **not** a deployment: the app, the signer and the buy bot from one image, with two Postgres databases, the private network and the health checks. Secrets come from the host's secret store, never from the file.

---

## 10. On FadeHost (the owner's choice, 2026-09-30)

FadeHost runs apps from this GitHub repository (branch `main`, redeployed on every push) in the Europe West region (France). What maps where:

| NearKit service | FadeHost | Build command | Start command | Web address |
|---|---|---|---|---|
| App / API + bot | app `nearkit-app` | `npm run server:build` | `npm run server:start` | **On**, with the always-on add-on: its `https://…fadehost.app` is the API the web app calls |
| Signer | app `nearkit-signer` | `npm run server:build` | `npm run signer:start` | **Off**: reached only over the private network |
| Buy bot | app `nearkit-buybot` | `npm run server:build` | `npm run buybot` | Off |
| App database | PostgreSQL 17, public access **off** | | | |
| Signer database | PostgreSQL 17, public access **off** | | | |

- **Node.** `package.json` pins Node 24 (`engines`), which FadeHost follows. The start scripts need Node 22 or later.
- **Build tools.** The build needs the dev dependencies (Vite). If the install step leaves them out, use `npm ci --include=dev && npm run server:build` as the build command.
- **Private network.** Databases and apps talk over FadeHost's WireGuard network, by internal names (`db-<id>`, or `<name>.fh.internal`).
  - The signer listens on `0.0.0.0:8790` of that network only.
  - Confirm once at go-live that the app reaches it: the app's `/health` shows `signer: "ok"`.
- **TLS to the signer, with no certificate to carry.**
  1. The signer has `NEARKIT_SIGNER_TLS_DIR=/data/tls`, which survives deploys. At its first start it makes its own key and a self-signed certificate there, and logs `signer TLS certificate` with a `pin`, which is public.
  2. That pin goes into the app's `NEARKIT_SIGNER_TLS_PIN`. The app then trusts that one certificate and nothing else, and every request stays HMAC-signed.
  3. If `/data/tls` is ever lost, the signer makes a new certificate. The app fails closed until it is re-pinned.
- **KMS from outside AWS.** FadeHost has no IAM roles, so the signer uses the access key of an IAM user that may use only the NearKit key, and only with NearKit's encryption context:

  ```json
  {
    "Version": "2012-10-17",
    "Statement": [
      {
        "Sid": "NearKitSignerWalletKeys",
        "Effect": "Allow",
        "Action": ["kms:Encrypt", "kms:Decrypt"],
        "Resource": "arn:aws:kms:eu-west-3:<account>:key/<key id>",
        "Condition": { "StringEquals": { "kms:EncryptionContext:purpose": "nearkit-wallet-dek" } }
      }
    ]
  }
  ```

  - The key is a symmetric KMS key in `eu-west-3` (Paris, next to FadeHost's France region), with automatic rotation on.
  - Only the signer's environment holds `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY`. The signer registers the secret half with its logger, so it is never logged.
  - Rotate the access key like any credential. Disabling the KMS key remains the emergency brake.
- **Kill switches without a shell.** FadeHost apps have no shell, so the host-level switches are environment variables, applied with a restart:

  | Switch | Where | Value |
  |---|---|---|
  | Trading and/or withdrawals | `nearkit-app` | `NEARKIT_OPS_PAUSED=trading,withdrawals`. The database can't lift it; removing it and restarting does |
  | Every signature, export and approval | `nearkit-signer` | `NEARKIT_SIGNER_PAUSED=true` |
  | NearKit wallets entirely | `nearkit-app` | `NEARKIT_MAINNET_CUSTODY=off` |

  `npm run ops` and `npm run signer:admin` need a shell with each service's configuration and the private network. Use them from a machine that joins that network (FadeHost supports Tailscale for your devices), or not at all. Never use `ops signer-pause` without such a machine: only `signer:admin` on the signer's side resumes it.
- **Environment.** Settings are `KEY=value` lines on each app's Environment page. The non-secret ones follow §3. The secrets the owner enters there, never in the repository or a chat, are:

  | App | Secrets |
  |---|---|
  | `nearkit-app` | `TELEGRAM_BOT_TOKEN`, `NEARKIT_DATABASE_URL` (the app database), `NEARKIT_SIGNER_AUTH_KEY` |
  | `nearkit-signer` | `NEARKIT_SIGNER_AUTH_KEY` (the same value), `NEARKIT_SIGNER_DATABASE_URL` (the signer database), `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` |
  | `nearkit-buybot` | `TELEGRAM_BOT_TOKEN`, `NEARKIT_DATABASE_URL` (the app database) |

  Each database's connection string names its private host, for example `postgresql://postgres:<password>@db-<id>:5432/<database>`. The signer's goes to the signer only.
- **One poller.** Telegram allows one poller per bot token. Stop every other copy of the bot, including a local one, before `nearkit-app` starts on the same token.
