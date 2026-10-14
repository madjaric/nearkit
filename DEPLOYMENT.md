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
| `NEARKIT_VOLUMEBOT_RUNNER` | `app` (default) or `off` | The Volume Bot's worker runs in the app process (no second holder of the signer credential). Each bot is stepped under a database lease, so several app instances never double up. `npm run ops -- pause volumebot <reason>` pauses every bot at once; manual trading goes on |
| `NEAR_RPC_URL` | two or more mainnet providers | Checked at start |
| `NEARKIT_BRIDGE` | unset (on) or `off` | Bridge & Buy $KITS (BRIDGE.md): on with mainnet and the production fee account; `off` hides it |
| `ONECLICK_API_URL` | unset | NEAR Intents' 1Click API, `https://1click.chaindefuser.com` |
| `ONECLICK_API_KEY` | secret, optional | A 1Click partner JWT. Never logged; sent only to 1Click |
| `SOLANA_RPC_URL` | unset, or a private Solana RPC | Blockhash and balance reads for the page's SOL transfer |

### 3.2 Signer (`server/.env.signer.example`)

| Variable | Production value | Notes |
|---|---|---|
| `NEAR_NETWORK` | `mainnet` | Never assumed |
| `NEARKIT_MAINNET_CUSTODY` | `enabled` at go-live | Without it the signer refuses to start on mainnet |
| `NEARKIT_SIGNER_AUTH_KEY` | secret | Same as the app's |
| `NEARKIT_KMS_KEY_ARN` | `arn:aws:kms:<region>:<account>:key/<id>` | An exact key ARN, not an alias. `NEARKIT_KMS_PREVIOUS_KEY_ARNS` during a rotation |
| `NEARKIT_SIGNER_DATABASE_URL` | secret `postgres://…` | Its own database and credentials |
| `NEARKIT_SIGNER_RECIPIENT` | the web app's host | What every owner signature must name |
| `NEARKIT_SIGNER_TELEGRAM_BOT_ID` | the bot's numeric id (public) | The signer checks approvals given in the bot's Mini App with Telegram's own key. Without it, wallets with no owner wallet can't approve withdrawal addresses, so the app creates none (a linked wallet is then required) |
| `NEARKIT_FEE_RECIPIENT` | `nearkitfee.near` | Exactly this on mainnet |
| `NEARKIT_SIGNER_RPC_URLS`, `NEARKIT_SIGNER_RPC_QUORUM` | ≥ 2 providers, quorum ≥ 2 | Security facts need agreeing providers |
| `NEARKIT_SIGNER_MAX_SLIPPAGE_PCT` | `10` (required on mainnet; the signer refuses to start without it) | The signer's price floor: a swap's minimum may not sit further below the signer's own quote (Rhea, or the DCL contract on chain). NEARKITS wallets trade with at most 5% slippage (web, Telegram and the Volume Bot refuse more), so 10 leaves room for a token's sell tax. A quote of nothing, or one the signer can't get, refuses the swap |
| `NEARKIT_SIGNER_HOST`, `NEARKIT_SIGNER_PORT`, `NEARKIT_SIGNER_TLS_CERT`, `NEARKIT_SIGNER_TLS_KEY` | private interface and TLS | TLS is required unless it listens on 127.0.0.1 |
| `NEARKIT_SIGNER_PAUSED`, `NEARKIT_SIGNER_PAUSE_FILE` | `false`, a path on persistent storage | Host-level kill switches, checked on every request. The flag is read at start (change it with a restart); the file pauses while it exists. `signer:admin -- resume` does not lift either |

It must **not** have `TELEGRAM_BOT_TOKEN`, `NEARKIT_DATABASE_URL` or `NEARKIT_WALLET_KEK`. It warns if they are present.

### 3.3 Buy bot

- **Needs:** the app's environment subset: `NEAR_NETWORK`, `TELEGRAM_BOT_TOKEN`, `NEARKIT_DATABASE_URL`, `NEARKIT_WEB_URL`, `BUYBOT_NETWORK=mainnet`, `BUYBOT_RPC_URL`, `BUYBOT_DATA_URL`, `BUYBOT_HEALTH_PORT`.
- **Refused:** it refuses to start with `NEARKIT_WALLET_KEK`, `NEARKIT_SIGNER_AUTH_KEY`, `NEARKIT_SIGNER_KEK` or `NEARKIT_KMS_KEY_ARN`.

### 3.4 Web (Vercel)

- `VITE_NEAR_NETWORK`, `VITE_NEARKIT_FEE_RECIPIENT=nearkitfee.near`, `VITE_ENABLE_MAINNET_EXECUTION`, `VITE_NEARKIT_API_URL`, `VITE_TELEGRAM_BOT`, optionally `VITE_NEAR_RPC_URL`.
- The bot's Mini App is the web app's `/tg` page. In BotFather: `/mybots` → the bot → **Bot Settings** → **Configure Mini App** → **Enable Mini App**, URL `https://<web host>/tg`. Approvals of wallets with no owner wallet open it with `t.me/<bot>?startapp=<digest>`. `vercel.json` lets only Telegram's web client frame `/tg`; every other page stays unframeable.
- On mainnet any fee account but `nearkitfee.near` blocks trading, and the reason is shown.
- The tracked mainnet profile `.env.mainnet` keeps execution **off**.

---

## 4. Health checks

| Service | Check | Healthy when |
|---|---|---|
| App | `GET /health` (public, secret-free) | `ok: true`; `wallets: "on"` (when custody is on); `signer: "ok"`; `pauses` as intended; `bot: true`; `buybot` as configured; `ops: "ok"` (the host watchdog's last verdict, §13; `degraded` or `unknown` otherwise); `version` = the commit the app was built from |
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
| Volume Bots | `npm run ops -- pause volumebot <reason>` | Every Volume Bot: each pauses with the reason "Paused by NEARKITS", nothing new is sent; Start and Resume are refused | Manual trading, withdrawals, everything else |
| Trading automation | `npm run ops -- pause automation <reason>` | Every limit order, take profit, stop loss, Copy Trade, Sniper and DCA trade; their trades not signed yet are cancelled and the engine refuses `auto-` intents (AUTOMATION.md) | Manual trading, withdrawals, the Volume Bot; trades already sent are followed to the end |
| Bridge & Buy | `npm run ops -- pause bridge <reason>` | New Bridge & Buy deposit addresses | Orders already under way are followed to the end; their $KITS purchase follows the trading switch |
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
- **Alert on:** signer denials, refused owner proofs, exports, withdrawal bursts, KMS Decrypt volume (CloudTrail), `/health` not ok, and the resolver's "couldn't confirm" outcomes. On the VPS, `bin/monitor` does this (§13).

---

## 9. Reference container layout

[`deploy/docker-compose.production.yml`](deploy/docker-compose.production.yml) is a reference, **not** a deployment: the app, the signer and the buy bot from one image, with two Postgres databases, the private network and the health checks. Secrets come from the host's secret store, never from the file.

---

## 10. Production: one VPS with OpenBao (2026-09-30)

NearKit's production backend runs on one Hostinger VPS: `srv2021581.hstgr.cloud` in Manchester (UK), Ubuntu 24.04, 2 vCPU, 8 GB.
- The owner pays it monthly in crypto.
- The owner chose it over FadeHost, and chose OpenBao over AWS KMS: no card, no AWS account.
- The stack is `deploy/vps` (Docker Compose) in `/opt/nearkit`.

```
internet ──443──► caddy ──► app ──(signer-link)──► signer ──(kms-link)──► openbao
                             │                        │
                        (app-data)              (signer-data)
                          app-db ◄── buybot        signer-db
```

- **Only Caddy publishes ports** (80 and 443, Let's Encrypt for the server's own `hstgr.cloud` name, which is on the Public Suffix List). Every other network is internal. The signer and OpenBao have no public address.
- **Isolation:** the buy bot can't reach the signer or OpenBao; the app can't reach OpenBao or the signer's database; the signer can't reach the app's database. Checked on the server.
- **The key-encryption key is in OpenBao 2.6.3**, the open-source fork of HashiCorp Vault, through its transit engine (`server/src/signer/openbao.ts`):
  - The transit key `nearkit-wallets` is derived per context: the wallet's network, account and owner. It is not exportable and not deletable, and rotates yearly.
  - The signer's token may only encrypt and decrypt with it, and renew itself.
  - OpenBao is reached over TLS pinned to its own certificate, on a network shared with the signer alone. It has no outbound access at all.
  - It runs read-only, as uid 64100 (no account on the host), with no capabilities and no core dumps, on a host without swap.
- **OpenBao is sealed at rest.** Its storage, raft snapshots and any disk copy are encrypted under its master key, which only the owner's unseal key opens.
  - That key was shown once to the owner by `openbao-init` and is not on the server. The init also revoked the root token.
  - **After any restart of OpenBao or the server, wallet keys stay locked until the owner runs** `ssh -t root@<host> /opt/nearkit/bin/openbao-unseal`. Until then the signer fails closed; the bot, the web app and read-only features keep working.
- **Secrets** are files in `/opt/nearkit/secrets`, mode 400, mounted only into the containers that need them:
  - made on the server, never printed: the signer auth key and the database passwords;
  - entered by the owner, unseen: the bot token, through `bin/set-secret`;
  - written by `openbao-init`: OpenBao's signer and backup tokens.
- **Operations**, with the server's shell:
  - `docker compose exec app node dist-server/ops-admin.js <command>`: kill switches, freeze, events.
  - `docker compose exec signer node dist-server/signer-admin.js status`: the signer's health.
  - `touch control/signer.paused`: stops all signing.
  - `docker compose stop openbao`: the emergency brake. Nothing can be unwrapped until the owner restarts and unseals it.
  - `NEARKIT_OPS_PAUSED` in `app.env`: the kill switches held on the host.
- **Deploying** a commit: `/opt/nearkit/bin/deploy <commit> [service …]`, then the `up` command it prints, per service (§11). Every image is built on the server from the public repository.
- **Backups:** `nearkit-backup.timer` runs hourly and writes to `/opt/nearkit/backups` (root-only).
  - It keeps both database dumps (each checked with `pg_restore --list`) and an OpenBao raft snapshot.
  - Retention is 48 hours, then daily for 30 days. Hostinger's weekly server backups include it.
  - No backup opens a wallet key without the owner's unseal key.
  - Each backup is also encrypted and copied off the server (§12).
- **The host:** keys-only SSH, a firewall allowing 22, 80 and 443, unattended security upgrades, Docker from Docker's repository with log rotation, and OpenBao's audit log rotated daily for 30 days.

---

## 11. Deploying and rolling back (VPS)

Each node service runs its own image tag, set in `/opt/nearkit/.env`: `NEARKIT_APP_TAG`, `NEARKIT_BUYBOT_TAG` and `NEARKIT_SIGNER_TAG`. Compose refuses to start a service without its tag, so a build for the app never moves the signer or the buy bot.

**The signer is pinned.** It moves only in a signer release of its own: a reviewed change under `server/src/signer`, deployed with `bin/deploy <commit> signer`. A change to `signer.env` alone (for example the price floor) recreates the signer on the tag it already runs.

**Releases go through a pull request.** `main` is protected: both CI jobs ("Typecheck, lint, test, build" and "Server on PostgreSQL (multi-instance races)") must pass before a merge, for admins too, and nothing force-pushes. A merge to `main` deploys the web app on Vercel; the VPS moves only when the owner deploys.

**Deploying a commit:**
1. `/opt/nearkit/bin/deploy <commit> [app|buybot|signer …]` (default: `app`).
   - It refuses a commit unless every GitHub check run on it passed (`NEARKIT_DEPLOY_SKIP_CI=1` skips this, for an emergency only).
   - It builds `nearkit-server:<sha>` (the build records the commit; `/health` reports it as `version`). A failed build changes nothing.
   - It installs this directory's scripts, compose file, Caddyfile, `openbao.hcl` and the backup and monitor timers.
   - It sets the tag of the named services only, keeps every image a service is set to plus the five newest, and **restarts nothing**.
2. **Check that nothing is in flight:** `/opt/nearkit/bin/monitor --inflight`. It counts wallet operations under way, sent transactions not yet settled, bridge orders in their NEARKITS step (buy or unwrap) and the signer's signatures in the last minute, and exits 0 only when all are zero. While a Volume Bot runs, wait for a moment between its trades, or pause Volume Bots first (§7).
3. Apply it per service, with the command `deploy` printed: `docker compose up -d --no-deps --wait app` (`--profile signer` for the signer). `--no-deps` keeps the databases, OpenBao and Caddy running as they are.
4. Verify: `/health` shows the new `version`, `ok: true`, `signer: "ok"` and `ops: "ok"`; `bin/monitor --status` prints "all checks ok".

**Rolling back a service:** `/opt/nearkit/bin/deploy --rollback <service> <tag>` points it back at an image still on this host (`docker images nearkit-server` lists them), then apply it as in step 3. Migrations are forward-only (§6): roll the app back only to a build that runs on the current schema. The web app rolls back on its own in Vercel (promote the previous production deployment); it holds no state.

**On a fresh host,** or one still on the old shared `NEARKIT_IMAGE_TAG`, `deploy` sets each service's tag from the image that service runs now, so nothing moves until it is deployed on purpose.

---

## 12. Off-site backups and restore

Every hourly backup (§10) is also copied off the server, encrypted, by `bin/backup-offsite`, which `bin/backup` runs after each local backup.

- **What:** both database dumps, OpenBao's raft snapshot, and the configuration the stack needs to start again (`secrets/`, the env files, compose file, Caddyfile, `openbao.hcl`, the backup and monitor settings, and the TLS material of OpenBao and the signer).
- **Encryption:** [age](https://age-encryption.org), to the public keys in `deploy/vps/backup-recipients.txt`. Only public keys are on the server. The identity that decrypts is kept by the owner on their own workstation, never on the server or in any repository. Even decrypted, no wallet key opens without OpenBao's unseal key, which only the owner holds.
- **Where:** the private GitHub repository `madjaric/nearkit-backups`, one branch per backup (`b-<stamp>`), pushed over SSH with a deploy key that can write to that repository only (`secrets/backup_deploy_key`) and GitHub's host keys pinned (`github_known_hosts`). Each branch holds the ciphertext and a manifest of sizes and checksums; after the push, the script checks that GitHub holds exactly that commit.
- **Retention:** every backup for 48 hours, then the midnight (UTC) one of each day for 30 days, as locally.
- **Status:** `backups/.offsite.ok` or `.offsite.error`; the watchdog alerts when the copy fails or is over two hours old (§13).

**Restore check** (on a workstation with Docker and the identity; nothing touches production):

```
deploy/vps/restore-check.sh <identity file> [b-<stamp>] [--unseal]
```

It clones the newest backup (or the one named), checks the manifest's checksums, decrypts everything, restores both databases into throwaway PostgreSQL 17 containers and counts their rows, restores the raft snapshot into a throwaway OpenBao 2.6.3 (and checks that the throwaway key no longer opens it), and lists the configuration archive. With `--unseal`, run by the owner only, it asks for the unseal key on the terminal and round-trips a value through the restored transit key with the signer's token from the backup: proof that the wallet keys would open. It sends the key only in an unseal key's form (44 Base64 characters ending in `=`, as `openbao-init` showed it, or 64 hex); `bash deploy/vps/unseal-key-check.sh` checks a key's form (length, characters, stray whitespace) without printing, storing or sending it. Last run: 2026-10-12, backup `b-20261012T230207Z`, passed without `--unseal`.

**Disaster recovery outline** (not yet rehearsed on a new host): provision a host (`bootstrap.sh`), decrypt the configuration archive into `/opt/nearkit`, restore both databases from their dumps, restore the raft snapshot into OpenBao, have the owner unseal it, then deploy each service at its tag from the restored `.env` (§11).

---

## 13. Monitoring and alerts

**On the host:** `bin/monitor`, every two minutes (`nearkit-monitor.timer`). It runs outside the app, so it reports when the app itself is down.
- **Checks:** every container running, healthy and not restarting on its own; the app's `/health` through Caddy (`ok`, `bot`, `signer`); OpenBao sealed or unreachable; the running signer's price floor (`NEARKIT_SIGNER_MAX_SLIPPAGE_PCT` set and at most 10, `MONITOR_SIGNER_MAX_FLOOR`; the pinned signer falls back to 50% without it); signer refusals (5 or more in 15 minutes); the local backup and its off-site copy (failed, or over two hours old); both databases accepting connections; bridge orders past their expected lifecycle; Telegram polling errors and a rejected bot token; bursts of app errors; wallet operations in flight for over 10 minutes; sent transactions not settled after 15; failed operations (5 or more in an hour); buy alerts not delivered; a stalled Volume Bot runner. A query that returns no number is an alert of its own, never read as zero.
- **Alerts** go to the owner's Telegram chat through NEARKITS' bot: once when a check starts failing, again every 6 hours while it fails, and once when it recovers, plus a daily line at 07:00 UTC that says all is well (so a silent channel is noticed). They name the check and counts only: no secret, account, amount or transaction.
- **Setup:** set `ALERT_TELEGRAM_CHAT_ID` (the owner's numeric Telegram id; the owner must have started the bot) in `/opt/nearkit/monitor.env`, then `bin/monitor --test`. Until it is set, alerts go to the journal only (`journalctl -u nearkit-monitor`). Thresholds can be tuned there too (`monitor.env.example`).
- `bin/monitor --status` prints every check's state and sends nothing; `bin/monitor --inflight` is the pre-restart check (§11).
- Each run writes its verdict to `control/monitor.json`, which the app reports on `/health` as `ops` (`ok`, `degraded`, or `unknown` when the watchdog has not run for 10 minutes).

**From outside:** the GitHub Actions workflow `Uptime` (`.github/workflows/uptime.yml`) checks every 10 minutes that nearkits.com answers and that `/health` reports `ok`, the bot, the signer and `ops`. A failed run emails the repository owner. It still reports when the VPS, its watchdog or the Telegram alerts are down. GitHub can start scheduled runs late and turns schedules off in a repository without activity for 60 days.