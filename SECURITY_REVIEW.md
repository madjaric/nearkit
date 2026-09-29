# NearKit security review: ten compromise scenarios

The review covers custody (NearKit wallets in Telegram), the signer, recovery and export, referrals, kill switches and the web app, as of 2026-09-29 (after commit `54e3e46`).
- For each scenario: what an attacker gets, what stops them (code), the tests that show it, and what remains.
- Two findings were fixed during the review (§3).
- Residual risks that need an owner decision are in §4.

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
| Signer | Signer auth key, signer DB credentials, IAM role for the KMS key | Open wallet keys (one KMS unwrap per signature) and sign what its policy allows |
| KMS | The key-encryption key (never leaves) | Unwrap a wallet's data key, only for the signer's role, with that wallet in the encryption context |
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
- **Export:** never in Telegram. It needs an owner-signed request in NearKit web, and the key is sealed to that browser.
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
- **A lookalike site on another domain fails:** the signer checks the recipient, and the page refuses a request made for another site (`challengeProblem` in `src/services/recovery.ts`).

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
- **Sealed keys** are ciphertext of per-wallet data keys wrapped by the KMS. The encryption context names the wallet, so a copied row opens for no other wallet, and not at all without the KMS role.
- **Owner approvals** are signatures, re-verified at every use. A tampered or inserted row fails verification.
- **Challenges** are one-time and expire.
- Tests: `server/src/signer/kms.test.ts` ("a key that isn't the wallet's own never opens as it"); `server/src/bot/destinations.test.ts` ("a tampered database can't add a destination…").

**Remains:** privacy. Backups need the same access control as the databases.

### 2.4 The app server is compromised (including the signer auth key)

**Attacker gets:** everything the app can ask of the signer.

**What stops them:**
- **Withdrawals:** the signer refuses any destination the owner didn't sign for ("a compromised app that skips every check still can't withdraw…", `destinations.test.ts`).
- **Exports:** they need a fresh owner signature over a message naming the browser key's fingerprint, and the result is sealed to that browser. The app relays only ciphertext it can't open.
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

**Attacker gets:** the ability to unwrap wallet keys through the KMS while they hold the signer's role. This is the crown jewel.

**What limits it:**
- **Exposure:** a private network with no public address, HMAC-only requests and a strict request codec.
- **One unwrap per signature:** no key stays in memory, and the seed is zeroed after use. Every unwrap is a KMS `Decrypt` in CloudTrail naming the wallet.
- **Scope:** the key policy grants only the signer's role.
- **Emergency brake:** **disable the KMS key**, and nothing can be unwrapped anywhere. The signer then fails closed (`DisabledException` is a refusal).
- **Wallets already safe:** those whose owners added a backup key and revoked NearKit's key.

**Remains (R6):** host hardening, image provenance and monitoring are infrastructure work. They are in the ceremony (B3, B4, B17).

### 2.6 The KMS is unavailable (outage, throttling, revoked permission)

**Fails closed:**
- `KmsUnavailableError`: nothing is signed, exported or approved, and the app says so plainly.
- `/health` shows the signer as unhealthy (KEK), and `signer:admin status` shows it too.
- Transactions already sent are followed to the end (read-only).
- Funds stay on chain. Owners with a backup key can move them in any wallet app.

**Tests:** `kms.test.ts` ("an unreachable KMS fails closed as 'unavailable', never as a wrong key"), and `remoteSigner.test.ts` (paused and unavailable signer).

### 2.7 One exported key leaks

- Every NearKit wallet has its own random key: an implicit account, with no seed phrase and no master or derivation.
- A leaked key controls that wallet only.
- The owner hears about every export in Telegram.

**Tests:** `multiWallet.test.ts` ("export is per wallet…"), `core.test.ts` ("export: sealed to the browser key…"), `custodySecrets.test.ts` (the key never reaches Telegram, logs, databases or the API in plain form).

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
| R6 | A compromised signer host exposes wallet keys | INFRASTRUCTURE | Private network, KMS key policy for the signer role only, CloudTrail alerts on `Decrypt` volume, image provenance. Disabling the KMS key is the emergency brake |
| R7 | Losing the signer database loses every key without a backup key or export | INFRASTRUCTURE | Point-in-time recovery, tested restores. Encourage backup keys in the product |
