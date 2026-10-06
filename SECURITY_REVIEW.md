# NearKit security review: ten compromise scenarios

The review covers custody (NearKit wallets in Telegram), the signer, recovery and export, referrals, kill switches and the web app, as of 2026-09-29 (after commit `54e3e46`).
- For each scenario: what an attacker gets, what stops them (code), the tests that show it, and what remains.
- Two findings were fixed during the review (§3).
- Residual risks that need an owner decision are in §4.

**Production (2026-09-30):**
- The owner accepted R1.
- The key-encryption key is in self-hosted OpenBao on the production VPS instead of AWS KMS (§5).
- NearKit wallets stay off until the owner's go-live.

**Verdict:**
- **No known code-level security blocker.**
- One residual risk needs an owner decision before mainnet custody: **R1**, trade authority.
- The rest are infrastructure and operations work that the ceremony covers ([MAINNET_CEREMONY.md](MAINNET_CEREMONY.md)).

---

## 1. Who holds what

| Component | Holds | Can do alone |
|---|---|---|
| Web app | Nothing secret | Nothing without the user's wallet signing |
| App / API + bot | Bot token, app DB credentials, signer auth key | Ask the signer. The signer's own policy decides |
| Signer | Signer auth key, signer DB credentials, an OpenBao token for the wallet key (encrypt and decrypt only) | Open wallet keys (one OpenBao unwrap per signature) and sign what its policy allows |
| OpenBao (the KMS) | The key-encryption key (never leaves; stored sealed under OpenBao's master key, which only the owner's unseal key opens) | Unwrap a wallet's data key, only for the signer's token, with that wallet as the derivation context |
| Owner wallet (user's own NEAR wallet) | The user's full-access key | Approve destinations, export, add the backup key, revoke NearKit's key |

The signer enforces its policy itself: `server/src/signer/core.ts` (`authorize`, `sign`), `server/src/custody/policy.ts` (`checkPlan`) and `server/src/signer/routes.ts` (`verifySwapRoute`).
- **Withdrawals** go only to the owner wallet or a destination the owner approved with a signature. The approval is re-verified at every use: the signature, and the approving key still a full-access key of the owner on chain.
- **Swaps** go only through Rhea's aggregator. The route must carry Rhea's signature, NearKit's fee (5000 ppm) must go to `nearkitfee.near`, and the minimum may sit at most the slippage cap below the signer's own Rhea quote.
- **One step, one transaction:** every (intent, step) is signed as exactly one transaction, ever.

---

## 2. Scenarios

### 2.1 A Telegram session is compromised (stolen phone, session hijack)

**Attacker gets:** the victim's bot menu.

**What stops them:**
- **Withdrawals:** only to the owner wallet or owner-approved destinations (`authorize` → `DestinationNotApprovedError`). Approving needs the owner wallet's signature in NearKit web; Telegram can't approve anything.
- **Export:** never in Telegram. It needs an owner-signed request in NearKit web and is held 24 hours (§5e); the key is sealed to that browser. Telegram can release a held export sooner or cancel it, but can’t start one.
- **Relinking:** the attacker can link their own wallet to the Telegram account, but existing wallets stay bound to the original owner. The owner is sealed into each key's envelope (AAD); a rewritten owner makes the key unopenable, not usable.
- **New wallets:** they inherit the existing owner, not a newly linked wallet (fixed in this review, §3).
- **Referral payouts:** only to a wallet linked at least 48 hours earlier (fixed in this review, §3).

**Tests:**
- `server/src/bot/destinations.test.ts`: "someone in the Telegram account links their own wallet…"; "a new NearKit wallet answers to the same owner…"
- `server/src/signer/core.test.ts`: "a rewritten owner in the signer's own database…"
- `server/src/bot/referrals.test.ts`

**Remains:**
- The attacker can **trade** the victim's funds within the signer's policy (R1).
- The attacker can **close an empty wallet**.

### 2.2 The web origin is compromised (hosting account, DNS, a malicious dependency)

**Attacker gets:** the page users load.

**What stops them:**
- **Web trades are signed in the user's own wallet**, which shows each transaction. The web holds no key.
- **The owner's wallet shows owner requests:** exports and approvals are NEP-413 messages whose recipient must be NearKit's configured host (the signer checks `recipient`). The message names every fact it authorizes: wallet, destination, browser key fingerprint, network, expiry.
- **A lookalike site on another domain:** a message it has signed for itself fails (the signer checks the recipient, and the page refuses a request made for another site, `challengeProblem` in `src/services/recovery.ts`). One that relays NEARKITS' own request does get a valid owner signature, because NEAR wallets don't check which site asked. So a signed export is held 24 hours and announced in Telegram, where the owner cancels it (§5e).

**Remains (R5):**
- A compromised **real** origin controls both the browser key and what the page shows. It can therefore phish an export or an approval from an owner who signs without reading, and propose malicious transactions for the wallet.
- **Mitigations:**
  - account security on Vercel, the domain registrar and GitHub (2FA, least access);
  - dependency pinning (`npm ci` from the lockfile);
  - `vercel.json` already sends `frame-ancestors 'none'`, `X-Frame-Options: DENY` and `nosniff`;
  - a full script CSP is a hardening item (the wallet connectors must be allowlisted first).

### 2.3 A database dump (app or signer, or a backup)

**App database:** no key material.
- It holds users, links, wallets (addresses only), intents, audit, referrals, buybot settings and switches (`server/src/custody/store.ts` has no key column).
- The impact is **privacy**: Telegram ids, linked accounts, referral relations, trade history. It has **no fund impact**.
- Test: `server/src/bot/remoteSigner.test.ts` ("…the app's database never holds a key").

**Signer database:**
- **Sealed keys** are ciphertext of per-wallet data keys wrapped by OpenBao transit. The derivation context names the wallet, so a copied row opens for no other wallet, and not at all without an unsealed OpenBao and the signer's token.
- **OpenBao's storage and snapshots** are sealed by its master key, which only the owner's unseal key opens. The unseal key is not on the server, so even a dump of both databases plus OpenBao's data opens nothing.
- **Owner approvals** are signatures, re-verified at every use. A tampered or inserted row fails verification.
- **Challenges** are one-time and expire.
- Tests: `server/src/signer/kms.test.ts` ("a key that isn't the wallet's own never opens as it"); `server/src/bot/destinations.test.ts` ("a tampered database can't add a destination…").

**Remains:** privacy. Backups need the same access control as the databases.

### 2.4 The app server is compromised (including the signer auth key)

**Attacker gets:** everything the app can ask of the signer.

**What stops them:**
- **Withdrawals:** the signer refuses any destination the owner didn't sign for ("a compromised app that skips every check still can't withdraw…", `destinations.test.ts`).
- **Exports:** they need a fresh owner signature over a message naming the browser key's fingerprint, and the result is sealed to that browser. The app relays only ciphertext it can't open. Each export is held 24 hours. The app can't release one sooner (that needs Telegram's signature), though it could withhold the Telegram notice (§5e).
- **Backup key:** it must be a full-access key of the owner on chain.
- **Revoke:** it only removes NearKit's key when another owner key is on the wallet, so a wallet is never left to nobody.
- **Key erasure:** never while the wallet exists on chain (deleted) or still carries NearKit's key (revoked), checked by an RPC quorum.
- **Swaps:** as §1 (aggregator only, Rhea-signed, fee to `nearkitfee.near`, slippage cap against the signer's own quote, registrations only of the wallet, the aggregator and the fee account).
- **Replays:** every request is HMAC-signed over its method, path, time, a one-time nonce and a hash of its body, and is accepted once within 30 seconds. Every answer is signed too (`server/src/signer/auth.ts`, `http.test.ts`). One transaction per (intent, step).

**Remains:**
- **R1:** trades the policy allows, including into an attacker's token.
- **R2:** forged referral earnings in the app database.
- **R3:** a new wallet created with the attacker as owner, shown as a deposit address. The signer takes the owner of a *new* key from the app. Existing wallets are unaffected.
- **R4:** phishing messages sent with the bot token.

### 2.5 The signer is compromised (host, image or role)

**Attacker gets:**
- **Inside the signer container:** the ability to unwrap wallet keys through OpenBao with the signer's token while they are there. With a cloud KMS it would be the same.
- **With root on the VPS while OpenBao is unsealed:** they could read OpenBao's memory and keep every wallet key. This is the crown jewel.

**What limits it:**
- **Exposure:** internal Docker networks only, with no public address. Requests are HMAC-only, with a strict request codec. OpenBao is reachable from the signer alone.
- **Containers:** read-only, with no capabilities and `no-new-privileges`, under separate uids. There is no Docker socket in any container.
- **The host:** keys-only SSH, a firewall allowing 22, 80 and 443, and unattended security upgrades.
- **One unwrap per signature:** no key stays in the signer's memory, and the seed is zeroed after use.
- **Audit:** every unwrap is a line in OpenBao's audit log, with values HMAC-ed.
- **Scope:** the signer's token may encrypt and decrypt with this one key and nothing else. It gets 403 on reading, exporting, backing up, rotating or deleting the key (tested against a real OpenBao).
- **Emergency brake:** **stop OpenBao** (`docker compose stop openbao`), and nothing can be unwrapped until the owner restarts and unseals it. The signer fails closed.
- **Wallets already safe:** those whose owners added a backup key and revoked NearKit's key.

**Remains (R6):** a root compromise of the VPS while OpenBao is unsealed exposes the keys (§5). Monitoring of the audit log and the host is operations work (ceremony B17).

### 2.6 The KMS is unavailable (OpenBao sealed after a restart, stopped, or its token expired)

**Fails closed:**
- `KmsUnavailableError`: nothing is signed, exported or approved, and the app says so plainly.
- `/health` shows the signer as unhealthy (KEK), and `signer:admin status` shows it too.
- Transactions already sent are followed to the end (read-only).
- Funds stay on chain. Owners with a backup key can move them in any wallet app.
- **After any restart, OpenBao is sealed until the owner unseals it** (`openbao-unseal`). Until then this is the state NearKit wallets are in (R8).

**Tests:** `kms.test.ts` ("an unreachable KMS fails closed as 'unavailable', never as a wrong key"), and `remoteSigner.test.ts` (paused and unavailable signer).

### 2.7 One exported key leaks

- Every NearKit wallet has its own random key: an implicit account, with no seed phrase and no master or derivation.
- A leaked key controls that wallet only.
- The wallet’s Telegram account hears about every export when it is requested (it can release it sooner or cancel it) and again when the key is collected.

**Tests:** `multiWallet.test.ts` ("export is per wallet…"), `core.test.ts` ("export: sealed to the browser key…"), `export.test.ts` (held exports, §5e), `custodySecrets.test.ts` (the key never reaches Telegram, logs, databases or the API in plain form).

**Remains:** after an export the key is the user's responsibility. If they suspect a leak, they move the funds.

### 2.8 Two instances race (scaling out, a restart during a send)

- **Execution:** execution leases with compare-and-set, one intent in flight per wallet (a unique index), and a lease lost while signing records and sends nothing.
- **Signer:** one signature per (intent, step), including when requested concurrently.
- **Roles and updates:** role leases for the Telegram poller and the buy bot runner; `processed_updates` dedup.

**Tests:**
- `server/src/custody/concurrency.test.ts`: "two intents of one wallet confirmed at once on two instances…", "an instance that stalls past its lease signs nothing…", "resolvers on both instances race…".
- `core.test.ts`: "two different signatures of one step requested at once: exactly one is released".
- `server/src/db/leases.test.ts`: "racing instances: exactly one gets a free lease".
- These run on SQLite, PGlite and real PostgreSQL in CI.

### 2.9 An RPC provider lies (or serves another network)

- **At start:** every process checks each provider's `chain_id`. A provider serving the wrong network stops the process (`server/src/chainId.ts`).
- **Security facts** (owner key permissions, account existence) come from a **quorum** of providers. One disagreeing provider decides nothing (`server/src/signer/chain.ts`, `chain.test.ts`).
- **Transaction outcomes are resolved conservatively:**
  - an unclear answer stays pending;
  - a missing transaction is proven failed only past its expiry height;
  - a timeout after landing is confirmed from the chain, never sent twice.
- **A lie can't redirect funds:** the signer signs only the planned, policy-checked transaction. A lying RPC can make a transaction fail, never go elsewhere.

### 2.10 Telegram retries and duplicate updates

- An update delivered twice (a retry, or a re-read after a restart) is handled once (`processed_updates`).
- Confirm works once: a second press, a replayed callback or two presses at once still send one transaction.
- Wallet creation is idempotent per Create button.

**Tests:** in `server/src/bot/bot.test.ts`, `server/src/bot/tradingWallet.test.ts` and `server/src/custody/engine.test.ts`: "an update Telegram delivers twice… is handled once", "sends exactly once…", "two presses at the same moment still send once", "creating twice (a double tap, a replayed update) gives one wallet…".

---

## 3. Fixed during this review (`54e3e46`)

1. **New wallets could answer to a later-linked wallet.**
   - **Risk:** someone in the Telegram account could link their own wallet, create a NearKit wallet owned by it, and receive the victim's future deposits.
   - **Fix:** new wallets inherit the user's existing owner.
   - **Test:** `destinations.test.ts`.
2. **Referral payouts could go to a freshly linked wallet.**
   - **Fix:** a claim is paid only to a wallet linked at least 48 hours before (`PAYOUT_LINK_AGE_MS`, `server/src/bot/referrals.ts`).
   - **Test:** `referrals.test.ts`.

---

## 4. Residual risks and owner decisions

| # | Risk | Class | Decision or action |
|---|---|---|---|
| **R1** | **Trade authority.** Whoever controls a user's Telegram account (2.1) or the app server (2.4) can swap that user's NearKit wallet balances into any token Rhea routes. That includes a token and pool the attacker controls, which extracts value without a withdrawal. The signer bounds the *form* of a swap (router, Rhea's signature, fee, slippage against its own quote), not the user's *intent*. This is inherent to Telegram trading bots | SECURITY / OWNER ACTION | **Decide before mainnet custody:** (a) accept and disclose it, as other Telegram trading bots do; (b) add a signer-side rule for tokens (minimum pool liquidity or age); or (c) require an owner-signed trading allowance per wallet. (b) and (c) are code work after the decision |
| R2 | A compromised app can write fake referral earnings | SECURITY / OWNER ACTION | Payouts are manual. Before paying, reconcile: total referral earnings (`npm run referrals -- summary`) can't exceed 20% of the NearKit fees `nearkitfee.near` received on chain in the period. Start with small payouts |
| R3 | A compromised app can create a wallet whose owner is the attacker and show it as a deposit address | SECURITY | The bot shows each wallet's owner ("Owner … (the wallet it was created with)"). Tell users to check it before depositing. Harden the app host |
| R4 | A leaked bot token allows phishing messages to users | INFRASTRUCTURE | Store the token in the secret store only. Rotate it with BotFather on suspicion. The app refuses a token of another bot (`TELEGRAM_BOT_USERNAME`) |
| R5 | A compromised web origin can phish exports, approvals and signatures | INFRASTRUCTURE / SECURITY | 2FA and least access on Vercel, the registrar and GitHub. A script CSP is a hardening item |
| R6 | A root compromise of the VPS while OpenBao is unsealed exposes wallet keys | INFRASTRUCTURE / SECURITY | Keys-only SSH, firewall, unattended upgrades, isolated read-only containers. Watch OpenBao's audit log for decrypt volume. Stopping OpenBao is the emergency brake. A dedicated OpenBao host, or a cloud KMS or HSM, would narrow it (§5) |
| R7 | Losing the signer database loses every key without a backup key or export | INFRASTRUCTURE | Hourly verified dumps plus the server's weekly backups. Copies off the server are still to do. Encourage backup keys in the product |
| R8 | The unseal key: after a restart, wallets stay locked until the owner unseals OpenBao. If the key is lost, every wallet key without a backup key or export is lost | OWNER ACTION | Keep the unseal key in a password manager plus an offline copy. Be reachable to unseal after restarts |
| R9 | A wallet with no owner wallet is controlled by its Telegram account: whoever holds that account can approve an address in the Mini App and withdraw, or bind their own owner (§5b). NearKit's app alone can do neither | PRODUCT / SECURITY | Accepted with the optional-link model: say so where wallets are created, and offer "make your linked wallet the owner" in Recovery |
| R10 | A stolen NearKit web session (a shared computer, or script on the real origin, R5) can trade the user's NearKit wallets within the signer's policy, as a stolen Telegram session can (R1), and create and rename wallets (§5c). It can't send to an address the custody model hasn't approved | SECURITY / OWNER ACTION | **Accepted by the owner (2026-10-01):** web and Telegram are independent clients. Sessions last 7 days; "Sign out of NearKit web everywhere" in Telegram; every wallet created on the web is announced there |

---

## 5b. Wallets with no owner wallet (2026-09-30)

Linking an external wallet is optional. A wallet created without one is controlled by the Telegram account that created it.

**The authorization model for its withdrawals:**
1. **Controller fixed in the signer.** The signer records the Telegram user who asked for the key. It seals the key to that user (envelope v3: `nearkit:wallet:v3|network|account|controller:telegram:<id>`), so a rewritten controller in any database leaves the key unopenable, not usable.
2. **Addresses approved with Telegram's signature, not NearKit's.**
   - A new withdrawal address is approved in NearKit's Mini App.
   - The Mini App opens with `startapp=<digest>`, where the digest is SHA-256 of the signer's request: kind, network, wallet, address, request id, expiry (`src/lib/telegramApproval.ts`).
   - Telegram signs the launch data, including that start parameter and the user who opened it, with its Ed25519 key, for NearKit's bot only (third-party validation, `server/src/signer/telegram.ts`).
3. **The signer checks all of it itself before recording an approval.** It checks, as `tg-approve` in `core.ts`:
   - Telegram's signature, under Telegram's published key and NearKit's bot id from the signer's own configuration;
   - that the user who opened the Mini App is the wallet's controller;
   - that the start parameter is the digest of a live request, recomputed from the stored row, so an edited row fails;
   - that the launch falls inside the request's lifetime;
   - that the request is used once, with five attempts at most.
4. **Re-verified at every withdrawal.** The approval is stored with Telegram's signed data. `authorize` checks the signature, the user and the digest again whenever it is used.
5. **Everything else as before:** the typed-plan policy, one signature per (intent, step), request authentication and replay protection, the RPC quorum, the kill switches and the audit logs. Every request, approval, refusal and binding is a `signer_events` row.

**Why it stays secure:**
- **NearKit's app can't forge an approval.** It relays Telegram's signature; making one needs Telegram's private key. A compromised app can ask for a request and show the user a link, but the Mini App page shows the address it would approve, checked against the signed digest. The app can't withdraw to an address the user didn't approve, can't export the key (no owner wallet), and can't bind itself as owner, which needs the same Telegram-signed approval.
- **Telegram's signature binds exactly one request.** A launch captured for one request approves nothing else, and a launch by another Telegram account counts for nothing.
- **The Mini App page is served by the web app, a separate trust domain from the app server.** It refuses a request that doesn't hash to the start parameter, so a lying API is caught in the page.

**Owner binding (optional, later):**
- It needs the controller's Telegram-signed approval naming that owner.
- The signer reseals the key from v3 to v2 with compare-and-set on "no owner yet": once, one way, never replaced.
- Telegram approvals end at binding, and from then on the wallet follows the owned rules (§1).

**Tests:**
- `server/src/signer/unowned.test.ts`: approvals; refusals for another account, another request, stale, used and expired launches, and a tampered row; bind and hijack attempts; owner powers; fail-closed without Telegram.
- `server/src/signer/telegram.test.ts`, including aiogram's independent vector.
- `server/src/signer/kms.test.ts`: v3 sealing and one-way binding.
- `server/src/bot/unowned.test.ts`: create, deposit, trade and withdraw without linking; link after creation; hijacks; export permissions; owned wallets unchanged.

**Remains (R9):**
- Whoever controls the Telegram account controls a wallet with no owner wallet. They can approve an address and withdraw, or bind their own wallet as owner. That is the product's choice for these wallets (Telegram-based control).
- Mitigations: users who want an independent key link a wallet and make it the owner. Every approval and binding is announced in Telegram.
- R3 applies to such wallets too: a compromised app could create a new wallet controlled by another Telegram account. Existing wallets are unaffected.
- A compromised web origin together with a compromised app could make the page approve on opening (R5).

## 5c. NearKit web sessions and direct web trading (2026-10-01)

NearKit web and Telegram are two independent clients of the same NearKit wallets. Signed in to NearKit web, a user creates and renames NearKit wallets, buys, sells, runs Multi Buy and Multi Sell, and sends, with no Telegram step: the web session is the authorization, as a Telegram session is for the bot.

**Signing in:**
- `/web` (or the website's "Sign in with Telegram", which opens `/start web`) sends a one-time link: `<web>/wallets#login=<code>`.
- The code is 256 random bits, kept only as its SHA-256. It is valid for 10 minutes and used once, and a user gets at most 5 an hour (`server/src/web/sessions.ts`).
- It travels in the URL fragment, which never reaches a server or a log. The page takes it out of the address bar before signing in.
- Signing in turns it into a session token: 256 random bits, SHA-256 at rest, valid 7 days. It is kept in the browser's storage per network and sent in the JSON body, never in a URL.
- The session ends on sign-out, on expiry, or with "Sign out of NearKit web everywhere" in Telegram.

**What a session can do** (`server/src/web/routes.ts`; every route is rate-limited per IP):
- **List** the user's active NearKit wallets: name, address, slot, owner, frozen. Never a key or key reference.
- **Create** a wallet through the bot's own path (`ownerForNewWallet`, the 10-wallet and daily limits, the signer's key). A per-press `createKey` makes a double submit one wallet. The creation is announced in Telegram (a security notice, not a step).
- **Rename:** the label only.
- **Trade** (one wallet, or a Multi Buy / Multi Sell): `trade/quote` quotes each wallet on the server (one intent each, grouped by `wallet_intents.group_id`); `trade/execute` runs the quotes the web confirms, by intent id; `trade/status` follows each wallet.
- **Send:** `send/review` reviews it like the bot's withdrawal review and holds it (an intent); `send/execute` sends exactly that; `send/status` follows it.

**What enforces it:**
- **The server decides, the client claims nothing:** a wallet is resolved only through `ownedWallet(sessionUser, id)`. A watch account, another user's wallet, an address or a made-up id gets 403 `not-executable` before anything is read or quoted. A leg's claimed type, owner, account or signer is ignored; the fee, the route, the destinations allowed and who signs come from the server and the signer.
- **Each wallet trades alone:** every intent runs through `engine.execute` on its own, as a Confirm in Telegram does: its owner, expiry, wallet (active, not frozen, not busy), the kill switches, a fresh route with funds, gas and registration checks, the signer's policy (Rhea's signed route, NearKit's fee, the slippage cap) and that wallet's own key, held by the signer (OpenBao). One wallet's run never touches another wallet's funds.
- **A worse price never runs unseen:** a leg whose price moved past its minimum is quoted again under a new intent id; it runs only when the web sends that id, which it learns only from the status it shows.
- **Sends keep the custody rule:** only to the wallet's owner, or an address approved for it. The signer enforces it. An unapproved address is refused with how it gets approved: the owner wallet's signature on NearKit web, or, for a wallet with no owner wallet, the Telegram account's approval in the Mini App (Telegram signs it; §5b). That approval is the custody safeguard, not a trading step.
- **The kill switches apply at both ends:** paused trading or withdrawals refuse at the quote or review and at execute (409 `paused`), and again in the engine's gate. Production withdrawals stay paused.
- **Telegram stays out of web activity:** web intents carry no chat (`WEB_CHAT`), so the resolver doesn't message Telegram about them; the web follows them through its status routes.

**Tests:**
- `server/src/web/sessions.test.ts`, `server/src/web/api.test.ts`, `server/src/web/trade.test.ts` (ownership, forged ids and claims, frozen, paused, expired sessions and quotes, independent wallets, requotes, sends, approvals).
- `scripts/e2e-telegram.mjs`: sign-in, create, rename, a single Buy and a Multi Buy run from the web, a web send with an unapproved address and a review, forged requests, sign out everywhere; Telegram receives nothing for any of them.

**Remains (R10):**
- A stolen session can trade the user's NearKit wallets within the signer's policy, as a stolen Telegram session can (R1). It can't send to an address the custody model hasn't approved.
- A compromised real origin can read the session from storage and act as the user on NearKit web (R5).
- Mitigations: 7-day sessions, "Sign out of NearKit web everywhere" in Telegram, one-time links that never touch a server log, rate limits.

## 5d. Sends between a user's own wallets, and deleting dust (2026-10-06)

Two signer rules changed. Both are in `server/src/signer/core.ts` and covered by `server/src/signer/core.test.ts`. An independent review of the change (same day) narrowed both; this section describes the result.

**Sibling sends (`siblingHolds` in `authorize`).** A withdrawal may go, with no approval, to another NEARKITS wallet of the same Telegram user under the same authority:
- both wallets are that user's and bound to the same owner wallet; or
- both are that user's, have no owner and are sealed to the same Telegram account.

It is refused in every other case:
- to another user's wallet, even one bound to the same owner wallet (binding an owner proves nothing about who uses the wallet);
- from a wallet with an owner to one without (owner-signed protection would become Telegram-only, R9);
- to a wallet with another owner;
- to a closed wallet;
- to the wallet itself;
- when either key was sealed before bindings existed (v1, testnet legacy): its sealing proves no owner.

The destination's `signer_keys` row is not trusted as stored. Its sealed key is opened under its own binding (v2 owner or v3 controller), and the key must be that account's own. A row edited to name this owner or this Telegram user therefore opens nothing (test: "a row edited in the signer's database…"). The opened seed lives only inside `withSeed` and is wiped there.

Funds moved this way stay under exactly the same authority, so nothing becomes reachable that wasn't before. One consequence to know: an address approved for one of the user's wallets is reachable from their other wallets under the same owner through the first one (W2 → W1 → D). Outside addresses, other users' wallets and differently owned wallets keep the approval flow. The app (`siblingWallet`) and the bot mirror the rule only for the review; the signer decides. The app and the bot both refuse to send into a frozen wallet.

**Deleting a wallet (`erase-key` with reason `deleted`).** Unchanged in what it erases: only a key whose account was never funded (it doesn't exist on chain). It now also reads, with its own RPC quorum, every token contract the app lists **and the network's known tokens**, and refuses if any holds a balance: tokens can be credited to an address that doesn't exist yet, and the signer no longer depends on the app's list for the tokens it knows.

A wallet holding only dust (under 0.05 NEAR, `src/lib/walletDust.ts`) can be deleted in the app, but its key is **not erased**: the app closes the wallet (its slot is free) and the key stays sealed, so a token the app's indexer missed, or anything that reaches the address later, is never lost. The app refuses to delete a wallet with a trade or send in flight, or one a live Volume Bot trades from.

Deploy order: the signer first. An older signer refuses an `erase-key` request that carries `tokens` (the app sends the list only when it found a token, so the failure is a refused deletion, never a wrong one).

## 5e. Key exports are held (2026-10-06, AUTH-05)

**Why.** An owner's NEP-413 signature names NEARKITS' host as its recipient, but NEAR wallets don't check which site asked for it. A phishing site can request NEARKITS' own export challenge for its own browser key, show the message to the owner and get a valid signature. Before this change that signature alone released the key.

**Now the signature only asks; the signer holds the export.**
- **Held:** the export message the owner signs states `Held until` (the end of the signing window plus 24 hours) and `Collect by` (24 hours after that). Nothing is sealed before `Held until`.
- **Told:** the app tells the wallet's Telegram account at once, with ✅ Release it now (NEARKITS' Mini App) and ❌ Cancel export. If the account can't be told (bot blocked, Telegram down, no bot running), the app cancels the export. It never relays a collection for an export it didn't announce.
- **Released sooner:** only by the wallet's own Telegram account, in a Mini App launch Telegram signed for exactly this export, opened after the request, once. Its digest binds the request, wallet, network, browser key and deadline. The signer checks Telegram's signature itself; the app can't make one. The Mini App's own "Not me" only closes it, so a launch for cancelling never doubles as a release.
- **Cancelled:** from the chat's button (only the wallet's Telegram account: the signer checks the user the app reports) or from the page that asked (it holds the export's ID). A cancel is final, works while the signer is paused, and empties the stored owner signature.
- **Collected once:** by the browser that asked, while the export is open and in time. Before sealing, the signer verifies everything again:
  - the owner's signature over the stored message;
  - every field of that message (wallet, owner, network, request, browser key, both times);
  - the signing key is still a full-access key of the owner on chain;
  - the wallet still answers to that owner;
  - and either the signed hold is over or Telegram's stored release holds.

  A row edited in the signer database doesn't hold up.
- **One open export per wallet,** kept by a unique index on open rows.
- **Protocol gate:** the signer refuses an app that asks for an export without `held: true`, before the request is used. An older app can't release a key during a deploy.

**Remains.**
- An owner who signs on a phishing site and ignores the Telegram notice for 24 hours: the phishing site's browser can then collect the key. The hold buys time and the notice tells the owner; neither can stop an owner who reads neither what they sign nor their Telegram.
- A compromised app could withhold the Telegram notice (the signer can't send Telegram messages). The hold still applies.
- A compromised Telegram account can release an export early, but only one the owner wallet signed for: Telegram alone exports nothing.
- A signer-database write can't skip the hold or forge a release, because both are verified again against the owner's and Telegram's signatures. It could revive a cancelled export only together with the owner's original signature, which the cancel wiped (compare SG-05 for destination revocations).

**Tests:**
- `server/src/signer/export.test.ts`: normal release, wrong Telegram user, wrong wallet, replay, expiry, cancellation, release after cancel, duplicate release, phishing relay, edited rows.
- `server/src/signer/exportStore.test.ts`: one open export, and each step once, on SQLite, PGlite and PostgreSQL with two instances.
- `server/src/bot/recovery.test.ts`: the notice and its buttons, cancel by another Telegram account, a notice that can't be delivered, the Recovery screen.
- `server/src/api/api.test.ts`: another site's page can't reach the export routes.
- `scripts/e2e-telegram.mjs`: the web flow end to end, in a browser.

**Deploy order:** the signer first (migration v3 adds `signer_exports`; the new signer refuses an older app's export before anything is used), then the app, then the web.

## 5. KMS: OpenBao on the VPS versus AWS KMS

What stays the same:
- **Envelope encryption:** each wallet key is sealed by its own data key, which the KMS wraps, bound to the wallet and its owner.
- **The app never holds a key or KMS access.** An app compromise alone reveals no wallet key.
- **Unchanged:** the signer's policy, owner-approved withdrawals, replay protection, the RPC quorum and the kill switches.
- **Backups and database dumps open nothing by themselves.**

| | AWS KMS (the earlier design) | OpenBao on the same VPS (production) |
|---|---|---|
| Where the KEK lives | AWS hardware security modules, another provider | OpenBao's memory while unsealed. On disk only encrypted under the master key |
| A copy of the server's disk or backups | Contained the signer's static AWS access key, so it could decrypt everything through KMS | Opens nothing: OpenBao's storage is sealed and the unseal key is not on the server. **Stronger** |
| Root on the VPS while running | Could decrypt every key through KMS with the signer's credentials, in seconds | Could read OpenBao's memory and keep every key. **About the same outcome** |
| Audit trail | CloudTrail, off the host, beyond the attacker's reach | OpenBao's audit log on the same host; a root attacker could alter it. **Weaker** |
| Emergency brake | Disable the key from the AWS console, even if the VPS is taken | Stop or seal OpenBao on the VPS, which needs access to it. **Weaker** if the host is lost |
| Availability | Survives any restart | **Locked after every restart until the owner unseals** |
| Key loss | Held by AWS | **Lost with the unseal key** (R8) |
| Cost and dependencies | AWS account and card | None beyond the VPS |

The main difference is off-host tamper-proof audit and an off-host kill switch.

To narrow it without AWS:
- run OpenBao on a separate small VPS, reached over WireGuard, so a compromise of the NearKit host reaches only the signer's token, never OpenBao's memory;
- ship the audit log to a second host.

