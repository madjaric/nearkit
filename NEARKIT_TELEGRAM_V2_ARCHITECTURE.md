# NearKit Telegram V2: architecture, security and decisions

**Status (2026-09-29).** Phases A (research), B (UX), C (NearKit trading wallet) and D (native Buy and Sell) are implemented. They run on **testnet only**.
- Mainnet custody is hard-blocked in code: `CUSTODY_NETWORKS` in `server/src/custody/networks.ts` is not configurable.
- The production fee account is decided (`nearkitfee.near`) but configured nowhere, and no mainnet transaction was signed.
- §1 records the owner decisions this build follows.
- §2 describes what is implemented and §3 what must change before mainnet, including the custody gap analysis (§3.3).
- §4–§7 cover the threat model, fees (with the fee-claim runbook, §5.1), hosting and open decisions. The appendix keeps the Phase A research.
- The pre-mainnet custody audit (2026-09-29) added owner binding for recovery (§2.7), the resolver's handling of index lag (§2.4) and the Settings fee split fix; its findings are folded into §2–§7.

---

## 1. Owner decisions (locked for this implementation)

| Topic | Decision |
|---|---|
| Custody model | **G**: each Telegram user gets a separate NearKit trading wallet, never their main wallet. NearKit signs from it under a policy. Testnet only |
| NearKit fee | **0.50% (50 bps) is the total user-facing app fee.** If Rhea takes a share of it, that share comes out of the 0.50%; the rate is not grossed up. Rhea's protocol fee, pool fees and gas are separate lines |
| Production fee account | **`nearkitfee.near`** for web and Telegram (decided 2026-09-29). Not hard-coded and not configured yet: it is set only when mainnet trading is approved. Until then fee-taking mainnet trades stay blocked. The smoke-test account is never the production recipient |
| Withdrawals | To **any valid NEAR address** on the network. The linked wallet is the default, one tap away and marked |
| Trade limits | **None.** No per-trade, daily or per-user monetary cap. Security comes from architecture and validation |
| Recovery / export | Yes. Export happens in the NearKit web app after strong ownership proof, never in Telegram. Recovery must work without Telegram chat access |
| Mainnet custody in Telegram | Stays blocked until §3 is done and the owner approves |

---

## 2. CURRENTLY IMPLEMENTED (testnet)

### 2.1 Trading-wallet lifecycle

| Step | What happens | Where |
|---|---|---|
| Create | Needs a linked wallet. The linked wallet it is created with (the default one) becomes its **owner**: the account and its NEP-413-verified key are recorded, and export, the backup key and revoke answer to the owner alone (§2.7). An ed25519 key is generated. The wallet is a **NEAR implicit account**: its address is the public key in hex. One live wallet per user and network, enforced by a partial unique index, so a double tap, a Telegram retry or a restart never makes two. At most 3 creations per user per day (abuse protection) | `custody/wallets.ts`, `custody/store.ts` |
| Encrypt and persist | The key is envelope-encrypted (§2.2) before it is stored. The database never holds it in plain form | `custody/vault.ts`, `custody/signer.ts` |
| Display and deposit | The Deposit screen shows the exact address (tap to copy), the network and "send testnet assets only". The account exists on chain once it first receives NEAR | `bot/tradingWallet.ts` |
| Balance | Read from chain every time (NEAR spendable, tokens verified by `ft_balance_of`). An unreadable figure shows as —; a never-funded wallet says "Empty" | `custody/wallets.ts` `readWallet` |
| Trade | Native Buy and Sell (§2.5) | `custody/swap.ts`, `bot/nativeTrade.ts` |
| Withdraw | NEAR or any NEP-141 token it holds, to any valid address (§2.6) | `custody/withdraw.ts` |
| Unwrap | wNEAR back to NEAR (a refunded buy returns wNEAR) | `custody/unwrap.ts` |
| Recovery | Backup key on chain, and key export in the web app (§2.7) | `custody/recovery.ts`, `bot/recovery.ts`, `src/pages/TelegramPage.tsx` |
| Revoke | Deletes NearKit's key on chain, then erases its sealed copy. Allowed only once a key on the wallet is, right now, a full-access key of the owner wallet (checked on chain) | `custody/recovery.ts` `revokeHandler` |
| Delete | Only a wallet that was never funded, re-checked at the tap; its sealed key is erased | `bot/recovery.ts` |

Positions and PnL include the NearKit wallet and are re-read from chain after every trade; nothing is shown optimistically.

### 2.2 Key storage and encryption

- **Per wallet:**
  - a random 32-byte data key (DEK) encrypts the ed25519 seed with AES-256-GCM;
  - the key-encryption key (KEK) encrypts the DEK through a `KeyWrapper`;
  - both layers carry additional data `network:account`, so a ciphertext copied onto another wallet's row fails to open.
- **Stored in `trading_wallets.sealed_key`:** JSON holding the ciphertexts and the KEK's reference, a SHA-256 fingerprint (`local:…`), never the KEK itself.
- **Testnet KEK:** `NEARKIT_WALLET_KEK` (32 random bytes, base64).
  - Locally, `npm run server:wallet-key` writes it to the git-ignored `server/.env.wallet.local` without printing it.
  - On a host it is a secret environment variable, never on the data volume.
  - It is redacted from logs.
  - Without it, or on mainnet, trading wallets are off.
- **Decryption:** only inside the signer, for one signature or one export. The seed buffer is wiped right after, which is best effort, since Node keeps a short-lived copy in its KeyObject.
- **Rotation:** `rewrapSecret` moves a sealed key to a new KEK without decrypting the key itself. This is also the migration path to a KMS (§3.2).
- **Never:** keys in logs, API responses (except the one verified export), Telegram, telemetry or commits. Logs also redact anything shaped like a NEAR secret key, and tests assert the key appears nowhere in logs, the audit log, intents, stored transactions or Telegram.

### 2.3 The signer and its policy

- **No generic entry point.** The signer has no "sign these bytes" method. Every signature starts from a typed `WalletOperation`, and the planned transactions must match it exactly. The policy lives in `custody/policy.ts`.

| Operation | Allowed exactly | Refused |
|---|---|---|
| `swap` | Registrations (`storage_deposit {account_id: wallet, registration_only: true}`, ≤ 0.1 NEAR, on the route's tokens only). Then one transaction to the input token (wNEAR for NEAR): optional wrap registration, `near_deposit` = the amount (NEAR in), and `ft_transfer_call {receiver_id: Rhea's classic exchange, amount, msg: the verified route}` with 1 yocto. The route message is re-read: every path starts at the input and ends at the output, amounts cover the input, and the minimum equals the verified one and is **not below the minimum the user confirmed** | Any other receiver, method, argument, deposit, gas or extra action. Aggregator routes (mainnet-only) |
| `withdraw-near` | One `Transfer` of the confirmed amount to the confirmed destination | Another destination or amount; the wallet itself; another network's account; invalid IDs |
| `withdraw-token` | One transaction to the token: optional `storage_deposit` for the destination (the exact deposit shown), then `ft_transfer {receiver_id, amount}` with 1 yocto | `memo` or other fields, a different amount, sending tokens to the token's own contract |
| `unwrap` | `near_withdraw {amount}` with 1 yocto on the wrap contract | Anything else |
| `add-backup-key` | `AddKey` (full access) of a key the handler checked on chain is a full-access key of the owner wallet, by the wallet on itself | Any other key, NearKit's own key, another receiver |
| `revoke` | `DeleteKey` of NearKit's own key, by the wallet on itself | Deleting any other key |

- **Around every signature:**
  - The whole plan is checked before any key is opened: network (testnet only), wallet network, transaction and action counts, gas.
  - The signer builds the transaction itself, signs, reads the signed bytes back and compares them to the plan.
  - Refusals are written to the security log.
- **Security log (`custody_audit`):** public facts only. That means wallet created, intent confirmed, transaction signed (hash, receiver, nonce), unclear send, done or failed, policy refused, export requested, key exported (by which linked account), export refused, backup key added, wallet revoked or deleted.

### 2.4 Transaction intents: one Confirm, at most one transaction

```
quoted ──Confirm──▶ confirmed ──fresh checks OK──▶ signing ──final on chain──▶ done | failed
  │                    ├── price moved / new cost ──▶ replaced (a new quoted intent is shown)
  │                    └── refused before signing ──▶ failed ("Nothing was sent")
  ├── Cancel, or a newer quote ──▶ cancelled                signing ── no clear answer ──▶ submitted
  └── past its TTL ──▶ expired                              submitted ── resolver ──▶ done | failed
```

- **Confirm is atomic.** One DB write checks the owner, `quoted`, not expired, the wallet active, and nothing else of the wallet in flight. A double tap, a replayed callback, a duplicate update or an old message finds it no longer `quoted` and changes nothing. Buttons carry only the intent ID.
- **One live quote per wallet:** a new quote or review cancels older open ones, so two Confirm buttons on screen can never both trade.
- **Saved before sent:** every transaction is signed once, and its bytes, hash, nonce and expiry height are written to disk (`wallet_txs`) **before** it is sent. A step is never signed twice (primary key on intent and step, unique hash).
- **Anchoring:**
  - NEAR transactions stay valid 86,400 blocks after the block they name.
  - NearKit names a final block about 85,800 blocks old, so an unlanded transaction expires about **600 blocks (~10 minutes)** after signing.
  - Checked read-only on testnet: the RPC serves that block. If a node doesn't, NearKit falls back to the newest block.
- **Unclear sends:**
  - A timeout or network error is never re-signed.
  - The same signed bytes may go to the next RPC endpoint; they have the same hash and nonce, so the chain executes them at most once.
  - The chain is asked for the hash until it is final, or provably can't land: past its expiry height **and** NearKit's key nonce still below the transaction's own, so it was never executed and never can be.
  - If the key's nonce did pass it but no node returns the hash (index lag, a node without the history), it may have landed. NearKit keeps asking; 3,000 blocks (about 50 minutes) after expiry it ends the intent with "couldn't confirm whether a transaction went through", marks the transaction `unconfirmed` and tells the user to check the wallet before trying again. It never says "nothing was sent" then, so a retry can't trade twice.
  - A hash any node knows (`EXPERIMENTAL_tx_status` with `wait_until: NONE`) is never treated as lost.
  - Refused outright (invalid, or unparseable bytes) by the first node counts as "never landed".
- **Resolver:**
  - It runs at start and every 15 s.
  - After a restart it only **reads** the chain and never sends. What it settles in the background is messaged to the user.
  - A crash after Confirm but before signing is settled as "nothing was sent".
  - A crash between steps (registration done, swap not sent) is settled as failed, with the landed steps linked.
  - Two resolver runs at once (a slow run overlapping the next) settle an intent once: only the run whose status change lands records it, audits it and messages the user.
- **Concurrency:** one process, one writer (sql.js), and an in-process lock per wallet. Run a **single instance**. sql.js keeps the database in memory and writes the whole file, so two processes on one file silently lose each other's writes, a saved signed transaction included; that would break "saved before sent". Before mainnet this needs a lease that stops a second instance from starting, or a server database (§3).

### 2.5 Native Buy and Sell

- **Token entry:** ticker or exact contract. The exact contract is authoritative and read from chain, so brand-new tokens work. A mainnet contract on testnet is refused in plain words.
- **Amounts:**
  - Buy has the preset NEAR buttons, **MAX** and custom.
  - MAX keeps back what the swap needs available: gas bought upfront for a 300 TGas swap plus registrations. That is about 0.36 NEAR under NearKit's gas model, most of it refunded after execution.
  - Sell has 25/50/75/100% (exact raw amounts, so 100% sells everything) and custom. The screen warns when there isn't enough NEAR for gas.
- **Quote (compact):**
  - you pay, you receive, and the minimum with its slippage;
  - price impact (— on testnet: no prices);
  - NearKit fee ("none on testnet");
  - network fee and first-time registrations;
  - route;
  - validity (60 s).
- **At Confirm:**
  - A fresh route is fetched, bound to the wallet and verified.
  - It is sent only if **its minimum is at least the minimum the user confirmed** and no cost the user didn't see was added. Otherwise the new quote is shown ("Quote changed. Review the new price.") and nothing is sent.
  - The wallet's input balance and the NEAR for registrations and gas are checked right before signing.
- **Result:**
  - Read from the chain's own record (`flows.ts`): spent, received, NearKit fee and transaction link. Nothing is invented; unknown figures show as —.
  - A swap the exchange refunds is a failed buy: the NEAR came back as wNEAR, and **Unwrap** is offered.
- **Without a NearKit wallet:** the non-custodial web hand-off stays; the user's own wallet signs in NearKit web.

### 2.6 Withdrawals to any address

- **Flow:** asset, then amount (25%, 50%, MAX, custom), then destination (the linked wallet, marked, or any typed address), then review.
- **Destination checks:** valid NEAR account ID, not the other network's suffix, exists on chain for named accounts, not the wallet itself, and for tokens not the token's own contract. An implicit address that was never used gets a warning.
- **The review shows:** asset (with contract), exact amount, full destination, network, network fee, and any registration the destination needs ("the address has no USDT account yet"). It is valid for 5 minutes.
- **At Confirm:** everything is re-derived from chain. If the registration need or the address status changed, a new review is shown and nothing is sent. The destination is never changed silently, and an old destination is never reused without showing it.
- **Token withdrawals:** NEP-145 registration of the destination is paid from the wallet (≤ 0.1 NEAR), then `ft_transfer` with 1 yocto, in one transaction, so a failed transfer reverts the registration too.
- **MAX NEAR** keeps back the gas bought upfront.

### 2.7 Recovery and export

- **The owner.** Everything here answers to the wallet's owner, the linked wallet it was created with, never to whichever wallet is linked now. Someone holding a stolen Telegram session can link a wallet of their own; it can't authorize an export, never becomes the backup key, and doesn't count for revoke. Wallets created before this rule got their owner from the link history (migration v6): a wallet linked to the user when the NearKit wallet was created, the default one first.
- **Backup key:**
  - One tap in 🔐 Recovery (review and Confirm) adds the owner wallet's key to the NearKit wallet on chain: the key the owner last proved when linked here (linking the owner wallet again after a key change updates it), else the one recorded at creation.
  - Before signing, NearKit checks on chain that the key is still a full-access key of the owner wallet. Only then is it added.
  - Result: **if NearKit disappears**, the user's own wallet controls the NearKit wallet. Restoring their seed phrase or key in a NEAR wallet app finds it, because wallets look accounts up by key.
  - Tested by moving funds with the user's key alone.
  - 🔐 Recovery names the owner and warns about any other full-access key on the wallet ("If it isn't yours, move your funds").
- **Export (web only):**
  1. Telegram gives a one-time link: `/telegram#recover=<code>`. The code sits in the fragment, so it never reaches a server log. It lasts 10 minutes, is stored as SHA-256, and at most 3 are issued per hour.
  2. The page names the NearKit wallet and the Telegram account that asked, then drops the code from the address bar and history.
  3. The owner wallet signs a NEP-413 message naming the wallet and the Telegram account. The signature is free, moves nothing and uses a fresh 32-byte nonce.
  4. The server checks the code (live, unused, at most 5 attempts), that the signing account **is the wallet's owner** (whether or not it is still linked), the signature over the stored message, nonce and recipient, and that the key is a **full-access** key of that account on chain.
  5. The signer then releases the key **once**, within 5 minutes of verification, and only for a request the owner verified (it checks this itself too).
  6. The page shows it masked until revealed, with copy and import instructions. It stays in memory only, never in storage, the URL or the query cache, and is dropped on leaving.
  7. Telegram is told about every export and names the signing account.
- **The API** (`/api/recovery/describe`, `/api/recovery/export`) is JSON-only with a CORS allowlist, rate-limited (30 and 5 per minute per IP), `no-store`, and logs path and status only. The export response is the single place a key leaves the server, by design.

### 2.8 Security controls (not monetary limits)
- **Telegram and API:** per-user flood control, 6 quotes a minute per user, per-IP limits on API routes.
- **Replays and duplicates:** callback replay and duplicate-Confirm protection, persistent idempotency (§2.4), stale-quote rejection and fresh re-validation.
- **Signing:** operation allowlisting, gas-reserve and balance checks, read-back comparison of signed transactions.
- **Human confirmation:** explicit review and Confirm for every withdrawal, backup key and revoke.
- **Abuse:** wallet creation (3 a day), export links (3 an hour), export attempts (5 per link).
- **What doesn't exist:** a per-trade, daily or per-user amount limit (owner decision).

### 2.9 Tests

| Area | Where |
|---|---|
| Transaction encoding (near-api-js reference vector, round trips, refusals, signatures) | `src/services/near/transaction.test.ts` |
| Keys, envelope encryption, wrong KEK, tampering, other-wallet additional data, rotation | `server/src/custody/vault.test.ts` |
| Store: one live wallet, erasing keys, atomic Confirm, busy wallet, expiry, saved-before-sent, restart persistence | `server/src/custody/store.test.ts` |
| Policy: arbitrary receiver, method, deposit and extra action, modified route, selling more than confirmed, wrong network, backup and revoke keys, withdrawals (switched token, method, deposit, a NEAR transfer tacked on), unwrap | `server/src/custody/policy.test.ts` |
| Signer: real signatures, audited refusals, closed wallet, wrong KEK, export once and only when fresh, restart | `server/src/custody/signer.test.ts` |
| Engine: duplicate or simultaneous Confirm, replay, expiry, requote, busy wallet, unfunded wallet, rejected send, RPC timeout (landed), dropped transaction (expiry), restart (read-only resolution), crash before signing and after saving, a landed transaction the index doesn't return yet, one it never returns, two resolver runs at once; no secret anywhere | `server/src/custody/engine.test.ts` |
| Chain access: send classification across endpoints, anchoring and fallback | `server/src/custody/chain.test.ts` |
| Wallet UI: create (double tap), deposit, balance, NEAR and token withdrawals, custom and invalid destinations, fresh-address warning, changed review, expiry, cancel, MAX | `server/src/bot/tradingWallet.test.ts` |
| Native trading: buy by ticker and by contract, sell by ticker and by contract, presets, custom, MAX, wrong network, no route, insufficient NEAR, worse and better price, expiry, Refresh, canonical fee rate, refunded swap and unwrap, positions | `server/src/bot/nativeTrade.test.ts` |
| Recovery: backup key, the user's key alone moves funds, export once, every refusal, revoke rules, delete only when empty; owner binding (a wallet linked later can't export, can't become the backup key, doesn't count for revoke; a key change on the owner wallet) | `server/src/bot/recovery.test.ts` |
| Owner backfill for wallets made before owners were recorded | `server/src/custody/store.test.ts` |
| A whole lifecycle (create, fund, buy, withdraw, a refused revoke, a timed-out send, backup key, export, revoke): the key reaches no Telegram message, log line or database row in any encoding | `server/src/bot/custodySecrets.test.ts` |
| Built server with wallets on, fake Telegram | `scripts/e2e-telegram.mjs` |

The tests run against a fake NEAR runtime (`src/services/real/testing/fakeRuntime.ts`). It verifies signatures, nonces and expiry and executes transfers, keys, NEP-141/145 calls and a Rhea classic swap, with the chain's receipt and log format.

---

## 3. REQUIRED BEFORE MAINNET

Mainnet custody stays hard-blocked until **all** of these are done and the owner approves:

1. **KMS-held KEK.** Implement a `KeyWrapper` over a KMS or HSM (§3.2) and move the keys over with `rewrapSecret`. The KEK must never exist in the server's environment.
2. **Separate signer process.** The signer and its policy become their own service, the only holder of KMS decrypt rights. The bot talks to it over an authenticated channel, not a generic signing API (§3.3).
3. **Mainnet policy for Rhea's aggregator.** Re-verify the route's signature inside the signer, check the app fee is exactly `NEARKIT_FEE` to the configured fee account, and allowlist the aggregator's `tokens_storage_deposit` registrations. Today the policy refuses aggregator routes.
4. **Production fee account** `nearkitfee.near` configured (`NEARKIT_FEE_RECIPIENT`, `VITE_NEARKIT_FEE_RECIPIENT`) at go-live, funded with a little NEAR for claim gas, with the claim procedure of §5.1 rehearsed read-only.
5. **One writer.** A lease (or lock) that stops a second server instance from opening the database, or a move to a server database; see §2.4.
6. **External security review** of `server/src/custody` and the recovery flow.
7. **Operations:**
   - a kill switch that stops all signing;
   - alerts on `custody_audit` (policy refusals, exports, unclear sends);
   - an incident runbook.
8. **Backups and disaster recovery:** encrypted database backups, with the KEK's durability handled by the KMS. Remind users to add the backup key, which is the only recovery that needs neither NearKit nor its KEK.
9. **Hosting:** a single always-on instance with a persistent volume and secrets outside the volume (§6).
10. **Telegram account safety:** withdrawals go to any address (owner decision), so a stolen Telegram account can empty a NearKit wallet (§4). Tell users to turn on Telegram's two-step verification. An optional, user-chosen withdrawal lock to the linked wallet could be offered later; it doesn't exist today.
11. **Legal and compliance review** of holding user keys on mainnet.

### 3.1 What mainnet does NOT need to change
The intent engine, idempotency, anchoring, resolver, Telegram UX, withdrawals and recovery are network-independent. The fee comes from the one canonical `NEARKIT_FEE`.

### 3.2 KMS migration path
- **AWS KMS:** `wrap` = `Encrypt` (or `GenerateDataKey`), `unwrap` = `Decrypt`, with the additional data as the EncryptionContext. Grant decrypt to the signer's role only.
- **GCP Cloud KMS:** symmetric `encrypt`/`decrypt` with the additional data as AAD. The same shape.
- **HashiCorp Vault transit:** `encrypt`/`decrypt` with `context`.
- **Alternative: non-exportable ed25519 keys.** GCP KMS and Vault transit can sign ed25519 without the key leaving them. That removes key-in-memory risk but makes export impossible for new wallets; the backup key still gives recovery. This is an owner decision, since it trades against the export decision.

### 3.3 Custody gap analysis (pre-mainnet audit, 2026-09-29)

**Today (testnet):** the KEK is in the server's environment (`server/.env.wallet.local` locally), and the signer runs inside the bot process. Code running in that process can open every sealed key. A database copy plus the KEK decrypts every NearKit wallet key, and those keys stay usable after the attacker is gone, until each wallet's key is replaced or revoked. Main wallets are never reachable.

| Option | If the app server is compromised | Key extractable? | Added latency | Operations | Infrastructure | Fit with the policy signer |
|---|---|---|---|---|---|---|
| **A.** KEK in a KMS, signer still in the app process | The attacker calls KMS Decrypt as the app and opens every key while inside | Yes, while access lasts | One KMS call per signature (tens of ms in-region) | Low | A KMS key and IAM | Weak: the policy runs in the compromised process |
| **B.** Separate signer service, KMS envelope encryption (recommended) | The app can only ask for typed operations; the signer enforces the policy. While inside, the attacker can request what a user could (trades, withdrawals to any address). No key leaves the signer, so it stops at eviction, and the kill switch stops it sooner | Not from the app server. Only by compromising the signer host too | KMS call plus a local hop, tens of ms | Medium: a second service, IAM, alerts, kill switch | A KMS key plus a small always-on service on a private channel (Unix socket or mTLS) | Direct: `custody/policy.ts` and `custody/signer.ts` move as they are; export still works (released once, after owner verification) |
| **C.** Non-exportable ed25519 in an HSM or KMS, per wallet | Like B for operations. Even a signer compromise can't copy keys | Never | A remote signature, tens to ~100 ms | Medium to high | One asymmetric key per wallet, billed per key version each month; at scale this dominates the cost | Good for signing, but **no export** (conflicts with owner decision 9; recovery would rest on the backup key alone) |
| **D.** MPC or a wallet-as-a-service vendor | Depends on the vendor | Split key | 100 ms or more | High, vendor-bound | Vendor | Poor: the policy is re-expressed in vendor rules; export depends on the vendor |
| Simpler: B with the KEK on the signer host instead of a KMS | Same as B for the app server | Yes, from the signer host or its backups | None | Medium | A second host | Direct, but without IAM, KMS audit logs or managed rotation |

**Recommendation: B.** A separate signer service with envelope encryption under a cloud KMS (GCP Cloud KMS or AWS KMS):
- IAM lets only the signer's identity decrypt. The app server holds no key material and no KMS rights.
- The channel is authenticated and private, and it carries typed operations only.
- The signer enforces the policy, alerts on anomalies (refusals, exports, withdrawal bursts across users) and has a kill switch. These are not monetary caps.

**Caveat:** withdrawals go to any address and Telegram is the only confirmation channel. So a compromised app server can still send in-policy withdrawals while it is compromised. B bounds that to the compromise window, because keys can't be copied out. Closing it fully needs a confirmation the app server can't forge, such as an owner-wallet signature for new destinations. That is a product decision and is not implemented.

---

## 4. Threat model (as implemented)

| If this happens | Impact | What bounds it |
|---|---|---|
| A user's Telegram account is compromised | The attacker can trade **and withdraw that user's NearKit-wallet balance to any address** (withdrawals go to any address, owner decision). They can't reach the linked wallet: NearKit holds no key to it, and the backup key only lets the linked wallet control the NearKit wallet, not the other way round. Export needs the **owner** wallet's signature: linking their own wallet from the stolen session doesn't help, nor does it become a backup key | Only what the user deposited is exposed; main wallets never are. Every export is announced in Telegram. Advise Telegram two-step verification. An optional withdrawal lock could come later |
| A Telegram group is compromised | Buybot settings change; nothing financial | Trading works only in private chats; the buybot holds no keys |
| NearKit's database leaks | Ciphertext only; no loss | The KEK is not in the database; AES-GCM with bound additional data |
| The database and the KEK leak together | Every NearKit wallet key can be decrypted, and every balance drained, except wallets whose NearKit key was already revoked. Linked wallets are untouched | KMS and a separate signer (§3.3); rotate by moving funds to new wallets; users with a backup key keep control alongside |
| The owner (linked) wallet is compromised | Its key controls the NearKit wallet directly once it is the backup key. Export still needs the one-time link from Telegram | The user's own wallet security; revoke or move funds |
| An export link is intercepted | Nothing without the owner wallet's signature. It works once and expires in 10 minutes | The code is in the URL fragment and hashed at rest; 5 attempts per link |
| An export signature is replayed | Refused: the message, its fresh nonce and the recipient are bound to one request, and a request verifies and exports once | `markRecoveryVerified` and `markExported` change state once |
| A route is tampered with, or the destination changed | Refused before signing | The policy re-reads the route and requires the confirmed minimum; intent parameters can't change after review |
| The running server is compromised | Through the signer: only in-policy actions (Rhea trades, possibly at bad prices; withdrawals as a user could make them). With the KEK in reach, the attacker can sign anything and **drain NearKit-wallet balances**. Main wallets are never reachable | On testnet the KEK is in the process environment. Mainnet requires a KMS, a separate signer, alerts and a kill switch (§3) |
| Environment variables leak | Bot token and testnet KEK exposed | Rotate the token (@BotFather); rotate the KEK with `rewrapSecret`; the mainnet KEK lives in a KMS |
| The KEK leaks | With a database copy, NearKit-wallet keys are readable | KMS on mainnet; rotation; backup keys |
| The KEK is lost | NearKit can no longer sign for existing wallets | Backup keys and exports still control them. A wallet with neither is stuck, so keep the KEK file or secret backed up |
| The hosting provider is compromised | Same as a server compromise | Same controls; KMS in a separate account |
| NearKit disappears | Users with a backup key or an export keep full control. Without either, funds stay on a wallet nobody can sign for | The backup key is on chain; wallets find accounts by key |
| NearKit's access is removed (revoke) | NearKit can no longer sign for the wallet; its sealed copy is erased | Allowed only with an owner key on the wallet |
| A user loses their Telegram account | No loss if a backup key is on the wallet (or the key was exported) | Relinking a new Telegram account needs a wallet signature |
| Replayed or duplicate button, or a double tap | Nothing extra happens | Atomic Confirm, one live quote, persistent intents |
| RPC timeout, crash or restart mid-trade | Nothing is sent twice | Saved-before-sent, anchoring, read-only resolver |
| The chain index lags or a node lacks history | A landed transaction is never reported as "nothing was sent" | Expiry proven by nonce; otherwise pending, then "couldn't confirm" (§2.4) |

---

## 5. Fee and Rhea's share (verified in code)

- **One source:** `NEARKIT_FEE = { bps: 50, referralShareBps: 0 }` in `src/lib/fees.ts`. Quotes (web and Telegram), route checks (`app_fee_rate` = 50 × 100 ppm), reviews, disclosures, accounting and tests derive from it.
- **Testnet:** no fee is collected; the classic router has no app-fee mechanism. Quotes say "NearKit fee none on testnet"; the quote still records `bps: 50`.
- **Mainnet (not enabled for NearKit wallets):**
  - The user pays **0.50%**. Rhea's aggregator keeps 20% of the app fee (`appFeeRouterShareBps: 2000`, from Rhea's docs and on-chain `earn_app_fee` events), so Rhea gets **0.10%** and NearKit's account receives **0.40%**.
  - Rhea's own 0.10% protocol fee, pool fees and gas are separate. The 0.50% is never presented as the whole cost.
- **Accounting:** `feeLedger(gross, routerShareBps, referralShareBps)` gives gross, router share, received, referral and net. Referrals are **not launched** (share 0); a program would only set the share and record referrers.

### 5.1 The production fee account and claiming fees

**`nearkitfee.near`, read on chain on 2026-09-29 (read-only):**
- The account exists with one full-access key, no contract, 0 NEAR and 182 bytes of storage.
- It is not registered with Rhea's aggregator (`aggregatedex.near`) and has no accrued fees.
- It holds no storage on wNEAR, USDC or USDt.

**How fees accrue:**
- Fees accrue **inside the aggregator** as an internal balance of the fee account, per token. They don't arrive as transfers.
- The first fee-bearing trade pays the aggregator's `tokens_storage_deposit` for the fee account on that token; the trade review shows it.
- Balances can be read with `query_user_exist_balance {user, from_index, count}` and `query_user_balance {user, token}`.

**Claiming** (for the owner; not automated, not executed):
- **The call:** `nearkitfee.near` calls `aggregatedex.near` `withdraw({"token": "<fee token>", "return_near": false})` with exactly **1 yoctoNEAR** attached. For wNEAR, `"return_near": true` delivers NEAR instead.
- **What happens:** the aggregator sends the **whole** accrued balance of that token to the caller with `ft_transfer`. If the transfer fails, its callback restores the balance. A real claim of this kind used 300 TGas.
- **Before the first claim:** fund the account with a little NEAR for gas, since it holds 0. Register it on the fee token with `storage_deposit` (wNEAR 0.00125 NEAR), unless using `return_near: true` for wNEAR.
- `withdraw_lost_fund` is owner-only on the aggregator and is not part of this.

---

## 6. Hosting requirements

- **Portable:** a plain Node process (`npm run server:build`, then `npm run server:start`) or the Docker image (`server/Dockerfile`). Nothing in the business logic depends on a host.
- **One always-on instance:** Telegram polling and the resolver must keep running. Don't run two instances; the per-wallet lock and the SQLite writer are in-process, and two writers on one file lose data (§2.4). Mainnet needs this enforced (§3, item 5).
- **Persistent state:** `NEARKIT_DB_PATH` on a persistent volume, never the container's ephemeral disk.
- **Secrets:**
  - `TELEGRAM_BOT_TOKEN` and `NEARKIT_WALLET_KEK` go in the host's secret settings, **not** on the data volume, entered by the owner.
  - `NEARKIT_WALLET_KEK` must be the same value across deploys, or existing wallets can't sign. Back it up.
- **Public HTTPS URL:** needed for the web app's API (linking, trade hand-off, key export), with `NEARKIT_API_PUBLIC_URL`, `NEARKIT_API_ALLOWED_ORIGINS` and `NEARKIT_API_HOST=0.0.0.0`. The host sets `PORT`.
- **FadeHost:**
  - It has an official MCP (`https://api.fadehost.com/mcp`: create an app from GitHub, logs, restart), GitHub auto-deploy, and `/data` persistence.
  - The free tier (256 MB) sleeps when idle, which stops polling and the resolver: fine to experiment, not for real use.
  - Starter plus an always-on address is about $4/month.
- **Railway:** `.railway/railway.ts` is ready (volume at `/data`, `/health`, one replica). It needs the Hobby plan.

---

## 7. Decisions still open
1. **When to configure the fee account.** `nearkitfee.near` is decided; it is configured at mainnet go-live, not before.
2. **KMS provider** for the mainnet KEK: AWS KMS or GCP Cloud KMS behind a separate signer is recommended (§3.3). Non-exportable keys are stronger but conflict with export (§3.2).
3. **Hosting plan:** after the local test, FadeHost free (it sleeps) versus always-on.
4. **Mainnet go/no-go** after §3.

---

## Appendix: Phase A research (2026-09-29)

### A.1 What NEAR allows
- **Function-call keys can't attach deposits.** A transaction from one must be a single function call with a zero deposit ([verifier.rs](https://github.com/near/nearcore/blob/master/runtime/runtime/src/verifier.rs), [docs](https://docs.near.org/protocol/access-keys)).
  - So they can't call `ft_transfer_call` (1 yocto, [NEP-141](https://github.com/near/NEPs/blob/master/neps/nep-0141.md)) or `near_deposit`, and can't use Rhea normally.
  - A zero-deposit method on a contract deployed on the account itself can attach deposits from its balance, as the [multisig contract](https://github.com/near/core-contracts/tree/master/multisig) does.
- **Rhea classic `swap` with zero deposit** trades the caller's internal Rhea balance; `withdraw` needs 1 yocto. That is per the published source mirror, not verified on chain.
  - A swap-only function-call key could trade but not withdraw.
  - It still has three catches: hostile pools, registration friction, and the app fee doesn't apply.
- **Meta-transactions (NEP-366)** can't authorize future actions.
- **Global contracts (NEP-591)** make per-user contracts cheap.
- **Deterministic accounts (NEP-616)** suit a per-user vault.
- **NEAR Intents keys** have no per-key limits.
- **HOT Wallet** has no testnet.
- **Wallets find accounts by key:** FastNEAR `/v0/public_key/{pk}`.

### A.2 Other bots (public information only)

| Product | Keys | Withdrawals | Fee |
|---|---|---|---|
| NearFi ([site](https://nearfi.trade)) | Custodial, server signs; imported keys "stored encrypted"; export after a signed message | Any address | 0.5% |
| Dragonbot ([docs](https://dragonbot.gitbook.io/welcome-to-dragonbot)) | Per-user trading contract on a sub-account | To the onboarding destination | — |
| BONKbot ([docs](https://docs.bonkbot.io/security/signer)) | Keys in confidential computing (TPM/HSM) | 2FA for export and withdrawals | 1% |
| Trojan / Maestro / Banana Gun | AES-encrypted keys; key shown once; a password for export and withdrawals | As set | 0.5–1% |

Incidents: Maestro router exploit, ~280 ETH, refunded ([Decrypt](https://decrypt.co/204444/maestro-trading-bot-refunds-610-eth-to-users-following-router-exploit)); Banana Gun, 563 ETH, refunded ([Cointelegraph](https://cointelegraph.com/news/banana-gun-crypto-bot-refunds-3m)).

### A.3 Options considered

| | Option | Verdict |
|---|---|---|
| A | Plain custodial keys in the database | No |
| B | Encrypted custodial keys | Part of G |
| C | Holding users' main-wallet keys | Never |
| D | Function-call key on the main account | Impossible for swaps (no deposit) |
| D′ | Swap-only key on Rhea's internal balance | No fee, registration friction, unverified |
| E | Meta-transactions | Gas sponsorship only |
| F | Intents keys / Chain Signatures | No per-key limits |
| **G** | **Dedicated trading wallet plus controls** | **Implemented (testnet)** |
| R | Per-user vault contract (global contract, operator key limited to swap and withdraw-to-owner) | The long-term hardening: theft impossible even if the server falls. Needs a Rust contract and an audit |
| H | Telegram Mini App plus the user's wallet | The non-custodial mode; the web hand-off covers it today |
