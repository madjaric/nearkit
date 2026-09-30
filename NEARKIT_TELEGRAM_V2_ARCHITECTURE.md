# NearKit Telegram V2: architecture, security and decisions

**Status (2026-09-29).** Phases A–D are implemented and run on **testnet** (the public beta):
- A: research;
- B: UX;
- C: NearKit wallets;
- D: native Buy and Sell.

The production and mainnet readiness phase is implemented in code:
- up to 10 NearKit wallets per user;
- a separate signer service with AWS KMS;
- owner-approved withdrawal destinations;
- recovery and export without Telegram;
- PostgreSQL for several instances;
- kill switches;
- referrals;
- the buy bot as its own process.

**Mainnet custody is off.** It turns on only with the owner's switch (`NEARKIT_MAINNET_CUSTODY=enabled`) on both the app and the signer. Each refuses to start in that mode without all of these:
- the signer service;
- a KMS-held KEK;
- PostgreSQL;
- the production fee account `nearkitfee.near`.

No mainnet transaction has been signed. The go-live steps are the owner's: [MAINNET_CEREMONY.md](MAINNET_CEREMONY.md), prepared and not run.

Where to look:
- §1: owner decisions.
- §2: what is implemented.
- §3: what mainnet still needs, split into code (done) and owner actions.
- §4–§7: threat model, fees and referrals (with the fee-claim runbook, §5.1), hosting and open decisions.
- The appendix keeps the Phase A research.
- The compromise review is [SECURITY_REVIEW.md](SECURITY_REVIEW.md). Production topology and operations are in [DEPLOYMENT.md](DEPLOYMENT.md).

---

## 1. Owner decisions (locked for this implementation)

| Topic | Decision |
|---|---|
| Custody model | **G**: each Telegram user gets separate NearKit wallets, never their main wallet. NearKit signs from them under a policy the signer enforces itself |
| Wallets per user | Up to **10** active NearKit wallets per user and network (`MAX_ACTIVE_WALLETS_PER_USER`), each with its own key, balance, owner and lifecycle |
| NearKit fee | **0.50% (50 bps) is the total user-facing app fee.** Rhea's aggregator keeps 20% of it (0.10%), so NearKit's account receives **0.40%**. The rate is not grossed up. Rhea's protocol fee, pool fees and gas are separate lines. One source: `NEARKIT_FEE` in `src/lib/fees.ts` |
| Production fee account | **`nearkitfee.near`** for web and Telegram. It is the canonical constant `PRODUCTION_FEE_RECIPIENT` in `src/lib/fees.ts`. On mainnet the configured account (`VITE_NEARKIT_FEE_RECIPIENT`, `NEARKIT_FEE_RECIPIENT`) must equal it, or trading is blocked (web) and the server refuses to start in custody mode. Test accounts (`testone.near`) are refused on mainnet |
| Referrals | A referrer earns **20% of NearKit's net fee** (0.08% of volume). NearKit keeps 0.32%. The trader pays the same 0.50% as everyone. Payouts are made by the owner, with no hot wallet |
| Withdrawals | To **any valid NEAR address**, with no monetary limit. The owner wallet is always allowed. **A new destination needs the owner wallet's signature once** (in NearKit web), and the signer enforces it |
| Trade limits | **None.** No per-trade, daily or per-user monetary cap. Security comes from architecture and validation |
| Recovery / export | Export happens only in the NearKit web app, per wallet, after the owner wallet signs. Never in Telegram. Recovery works without Telegram (`/recover`) |
| Mainnet custody in Telegram | Implemented, **off** until the owner runs the ceremony |

---

## 2. CURRENTLY IMPLEMENTED

### 2.1 NearKit wallet lifecycle

| Step | What happens | Where |
|---|---|---|
| Create | See below | `custody/wallets.ts`, `custody/store.ts`, `signer/core.ts` |
| Select | Every screen names the wallet it acts on. A flow started on one wallet stays on it (`flowWallet`), even if another is selected meanwhile | `bot/tradingWallet.ts` |
| Display and deposit | The Deposit screen shows the exact address (tap to copy), the network and "send \<network\> assets only". The account exists on chain once it first receives NEAR | `bot/tradingWallet.ts` |
| Balance | Read from chain every time (NEAR spendable, tokens verified by `ft_balance_of`). An unreadable figure shows as —; a never-funded wallet says "Empty" | `custody/wallets.ts` `readWallet` |
| Trade | Native Buy and Sell (§2.5) | `custody/swap.ts`, `bot/nativeTrade.ts` |
| Withdraw | NEAR or any NEP-141 token it holds, to the owner or an owner-approved destination (§2.6) | `custody/withdraw.ts` |
| Unwrap | wNEAR back to NEAR (a refunded buy returns wNEAR) | `custody/unwrap.ts` |
| Recovery | Backup key on chain, and key export in the web app (§2.7) | `custody/recovery.ts`, `bot/recovery.ts`, `src/pages/RecoverPage.tsx` |
| Revoke | See below | `custody/recovery.ts` `revokeHandler` |
| Delete | Only a wallet that was never funded, re-checked at the tap. The signer erases its key only if the account doesn't exist on chain. The slot is freed | `bot/recovery.ts` |

**Create:**
- It needs a linked wallet.
- **The owner:** the new wallet answers to the same owner as the user's other NearKit wallets, else to the linked wallet it is created with. The owner is sealed into the key (§2.2). Export, the backup key, revoke and new destinations answer to the owner alone.
- **The key:** the **signer** generates an ed25519 key and seals it. The wallet is a **NEAR implicit account**: its address is the public key in hex.
- **Slots:** 1–10, with a database CHECK and a unique partial index, so no race opens an 11th.
- **Idempotent:** each Create button carries a key (`create_key`), so a double tap, a Telegram retry or two instances make one wallet.
- **Abuse limit:** at most 10 creations per user per day. This is abuse protection, not a trading limit.

**Revoke:**
- It deletes NearKit's key on chain, then the signer erases its sealed copy.
- Allowed only once another key on the wallet is, right now, a full-access key of the owner wallet, checked on chain by an RPC quorum.

Positions and PnL include the NearKit wallets and are re-read from chain after every trade; nothing is shown optimistically.

### 2.2 Key storage and encryption

- **Where:** only in the **signer's** database (`signer_keys`), never in the app's. The app knows addresses, slots and owners.
- **Per wallet:**
  - a random 32-byte data key (DEK) encrypts the ed25519 seed with AES-256-GCM;
  - the key-encryption key (KEK) wraps the DEK.
- **Additional data (v2):** both layers carry `nearkit:wallet:v2|<network>|<account>|owner:<owner>`. A sealed key opens only for its own wallet **and owner**, so rewriting an owner anywhere leaves the key unopenable instead of exportable to someone else (`signer/envelope.ts`).
- **KEK:**
  - **Mainnet:** AWS KMS (`NEARKIT_KMS_KEY_ARN`, an exact key ARN, `signer/kms.ts`). The KEK never leaves the KMS.
    - Each signature unwraps its wallet's DEK with one `Decrypt`, and the encryption context names the wallet, so CloudTrail shows which wallet every unwrap was for.
  - **Testnet:** a local KEK, either `NEARKIT_SIGNER_KEK` on the signer service or `NEARKIT_WALLET_KEK` for the in-process testnet signer, refused on mainnet.
    - Locally, `npm run server:wallet-key` writes it to the git-ignored `server/.env.wallet.local` without printing it.
- **Rotation:**
  - The KMS's automatic rotation needs nothing.
  - Moving to another key: make it current, keep the old one in `NEARKIT_KMS_PREVIOUS_KEY_ARNS` (or `NEARKIT_SIGNER_KEK_PREVIOUS`), then run `npm run signer:admin -- reseal` and `reseal --apply`. That rewraps the DEK only, and moves v1 keys to v2.
- **Decryption:** only inside the signer, for one signature or one export. The seed buffer is zeroed right after, which is best effort, since Node keeps a short-lived copy in its KeyObject.
- **Never:** keys in logs, API responses, Telegram, telemetry or commits. An export leaves the signer only sealed to the owner's browser (§2.7). Logs redact anything shaped like a NEAR secret key. Tests assert the key appears nowhere in logs, the audit logs, intents, stored transactions, databases or Telegram.

### 2.3 The signer and its policy

- **A separate service** (`npm run signer`, `server/src/signer/`). It is the only process that opens wallet keys.
  - It has a private network address, TLS, and HMAC-signed requests and answers (`signer/auth.ts`): the method, path, time, a one-time nonce and a body hash are signed, and a request is accepted once, within 30 seconds.
  - It has its own database and configuration (`server/.env.signer.example`).
  - On testnet the app can host it in-process instead (`NEARKIT_WALLET_KEK`), through the same core.
- **Typed methods only:**
  - `create-key`, `sign`, `erase-key`, `key-info`, `challenge`, `owner-wallets`, `approve-destination`, `revoke-destination`, `destinations`, `export`, `pause` and `health`;
  - a strict codec refuses extra fields and malformed values.
  - There is no "sign these bytes" method. Every signature starts from a typed `WalletOperation`, and the planned transactions must match it exactly (`custody/policy.ts` `checkPlan`).

| Operation | Allowed exactly | Refused |
|---|---|---|
| `swap`, testnet | Registrations (`storage_deposit {account_id: wallet, registration_only: true}`, ≤ 0.1 NEAR, on the route's tokens only). Then one transaction to the input token (wNEAR for NEAR): optional wrap registration, `near_deposit` = the amount (NEAR in), and `ft_transfer_call` to Rhea's classic exchange with the verified route and 1 yocto. The minimum may not sit further below the signer's own Rhea quote than the slippage cap | Any other receiver, method, argument, deposit, gas or extra action |
| `swap`, mainnet | See below | Rhea's classic exchange (no fee there); another fee account, rate or no fee; a route for someone else; an unsigned or altered route |
| `withdraw-near` | One `Transfer` of the confirmed amount to the confirmed destination, which must be **the owner wallet or a destination the owner approved** (re-verified at every use: the signed message, the signature, and the approving key still a full-access key of the owner on chain) | Another destination or amount; an unapproved destination; the wallet itself; another network's account |
| `withdraw-token` | The same destination rule. One transaction to the token: optional `storage_deposit` for the destination (the exact deposit shown), then `ft_transfer {receiver_id, amount}` with 1 yocto | `memo` or other fields, a different amount, sending tokens to the token's own contract |
| `unwrap` | `near_withdraw {amount}` with 1 yocto on the wrap contract | Anything else |
| `add-backup-key` | `AddKey` (full access) of a key that is, on chain right now, a full-access key of the owner wallet | Any other key, NearKit's own key, another receiver |
| `revoke` | `DeleteKey` of NearKit's own key, once another key on the wallet belongs to the owner | Deleting any other key; leaving the wallet to nobody |

**Mainnet swaps** go through Rhea's aggregator only:
- The route carries **Rhea's signature**, verified in the signer.
- The app fee is exactly **5000 ppm to `nearkitfee.near`**.
- The route's tokens and minimum are as signed.
- The minimum sits at most `NEARKIT_SIGNER_MAX_SLIPPAGE_PCT` below the signer's **own** Rhea quote.
- The only registrations are those of the wallet and the aggregator, and Rhea's registrations of the wallet and NearKit's fee account on the route's tokens (`signer/routes.ts`).

- **Around every signature:**
  - Security facts come from a **quorum** of RPC providers (`NEARKIT_SIGNER_RPC_QUORUM`, at least 2 on mainnet); a disagreement decides nothing.
  - The signer builds the transaction itself, signs it, reads the signed bytes back and compares them to the plan.
  - **One transaction per (intent, step), ever:** the same request gets the same answer, and a different one is refused.
  - Every refusal is a `signer-denied` event.
- **Pause:** the app may pause the signer. Only the signer's operator resumes (`npm run signer:admin -- resume`), and the host switches (`NEARKIT_SIGNER_PAUSED`, the pause file) can't be lifted from the app.
- **Security logs:** public facts only, never a secret.
  - **App (`custody_audit`):** wallet created, closed, frozen; intent confirmed, blocked, done or failed; transaction sent and resolved; export and approval notices; referrals; switch changes.
  - **Signer (`signer_events`):** key created, sealed or erased; transaction signed; denials; owner proofs refused; exports; destinations approved or revoked; pause and resume.

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
- **Saved before sent:** every transaction is signed once, and its bytes, hash, nonce and expiry height are written to the database (`wallet_txs`) **before** it is sent. A step is never signed twice: a primary key on intent and step in the app, and the signer's own (intent, step) record.
- **Anchoring:**
  - NEAR transactions stay valid 86,400 blocks after the block they name.
  - NearKit names a final block about 85,800 blocks old, so an unlanded transaction expires about **600 blocks (~10 minutes)** after signing.
  - If a node doesn't serve that block, NearKit falls back to the newest block.
- **Unclear sends:**
  - A timeout or network error is never re-signed.
  - The same signed bytes may go to the next RPC endpoint; they have the same hash and nonce, so the chain executes them at most once.
  - The chain is asked for the hash until it is final, or provably can't land: past its expiry height **and** NearKit's key nonce still below the transaction's own.
  - If the key's nonce did pass it but no node returns the hash (index lag, a node without the history), it may have landed. NearKit keeps asking; 3,000 blocks (about 50 minutes) after expiry it ends the intent with "couldn't confirm whether a transaction went through" and tells the user to check the wallet before trying again. It never says "nothing was sent" then, so a retry can't trade twice.
  - A hash any node knows is never treated as lost. A refusal by the first node (invalid, or unparseable bytes) counts as "never landed".
- **Resolver:**
  - It runs at start and every 15 s, and only **reads** the chain after a restart; it never sends.
  - What it settles in the background is messaged to the user.
  - A crash after Confirm but before signing is settled as "nothing was sent". A crash between steps is settled as failed, with the landed steps linked.
- **Several instances (PostgreSQL):**
  - An intent executes under an **execution lease** taken by compare-and-set.
  - An instance that stalls past its lease signs and sends nothing; the one that took over settles it.
  - One intent per wallet is in flight at a time (a unique index).
  - Resolvers on several instances settle an intent once, and the user hears once.
  - The Telegram poller and the buy bot runner are role leases (one at a time); Telegram updates are deduplicated (`processed_updates`).
  - SQLite (local development, a single testnet host) stays single-instance.

### 2.5 Native Buy and Sell

- **Token entry:** ticker or exact contract. The exact contract is authoritative and read from chain, so brand-new tokens work. A token of the other network is refused in plain words.
- **Amounts:**
  - Buy has the preset NEAR buttons, **MAX** and custom.
  - MAX keeps back what the largest first buy needs besides its amount: every registration, and the gas the network holds while the swap runs. That is about 0.39 NEAR on mainnet; all of it but the network fee stays in the wallet.
  - Sell has 25/50/75/100% (exact raw amounts, so 100% sells everything) and custom. The screen warns when there isn't enough NEAR for gas.
- **Quote (compact):**
  - you pay, you receive, and the minimum with its slippage;
  - price impact;
  - NearKit fee (0.50%, "none on testnet");
  - network fee and first-time registrations;
  - what the wallet needs available, and how much of it is gas held while the swap runs. When the wallet has less, how much to deposit;
  - route;
  - validity (60 s).
- **Every confirmation names the wallet** it trades from.
- **At Confirm:**
  - A fresh route is fetched, bound to the wallet and verified.
  - It is sent only if **its minimum is at least the minimum the user confirmed** and no cost the user didn't see was added. Otherwise the new quote is shown ("Quote changed. Review the new price.") and nothing is sent.
  - The wallet's input balance and the NEAR the plan needs at its peak are checked right before signing (see "NEAR a trade needs" below).
- **Result:**
  - Read from the chain's own record (`flows.ts`): spent, received, NearKit fee and transaction link. Nothing is invented; unknown figures show as —.
  - A swap the exchange refunds is a failed buy: the NEAR came back as wNEAR, and **Unwrap** is offered.
- **Without a NearKit wallet:** the non-custodial web hand-off stays; the user's own wallet signs in NearKit web.

#### NEAR a trade needs

- **The rule (NEP-642, protocol 85+):** when the chain accepts a transaction, it holds its attached gas and execution fees at 0.001 NEAR per TGas. After execution it refunds everything but the gas actually burnt, at the real gas price (a tenth of that today). The swap call attaches 300 TGas (the route's receipts burn about 85 TGas), so a swap transaction needs about 0.31–0.32 NEAR available for a few seconds. It really costs about 0.008 NEAR.
- **Steps go one after another.** Registrations, then Rhea registrations, then wrap and swap; each step is sent only once the one before is final. So a plan needs the largest step's gas once, not every step's gas summed:
  - the peak is the amount;
  - plus every registration deposit;
  - plus each earlier step's gas, counted as if it burnt all of it at twice the minimum gas price (real steps burn a quarter of it or less at the minimum);
  - plus the swap's own held gas.

  `peakNeedYocto` computes this. `txGas` computes a transaction's gas exactly as nearcore's `tx_cost` does. It matches mainnet to the unit on NearKit's real transactions.
- **The engine checks each later step before signing it:** the wallet must be able to pay that step's deposits and held gas. If the previous step's refund is still on its way, the engine waits for it (up to 20 s). If the wallet still can't pay, it stops cleanly: "Earlier steps went through". Nothing more is signed.
- **Measured on mainnet (2026-09-30)** for the production wallet, buying 0.05 NEAR of USDT, route NEAR → RHEA → USDt (four transactions):

  | | NEAR available |
  |---|---|
  | NearKit requires (first buy, 0.02375 NEAR of registrations) | 0.413929 |
  | The chain itself (typical burns between steps) | ≈ 0.3984 |
  | Before this rule, every step's gas summed | 0.481603 |
  | A repeat buy, everything registered | 0.362274 |

  Whatever the trade size, a wallet that trades keeps about 0.31 NEAR idle as gas float.

### 2.5b Wallets with or without an owner wallet (linking is optional)

- **Create, deposit, trade and withdraw need no other wallet.** A user who never links one gets a NearKit wallet **with no owner wallet**. The Telegram account that created it controls it, and the signer seals its key to that account (envelope v3). The user is never told to link a wallet to get their funds out.
- **Withdrawals from a wallet with no owner wallet** go to any valid NEAR address. A new address is approved once, in NearKit's Mini App inside Telegram:
  - the bot asks the signer for a request, and shows `t.me/<bot>?startapp=<digest>`;
  - the page (`/tg`, served by the web app) shows the request only if it hashes to the digest Telegram signed;
  - on Approve, Telegram's signed launch data goes to the signer, which checks Telegram's Ed25519 signature for this bot, the Telegram account that controls the wallet, the digest of exactly this request, its lifetime, and that it is used once.

  Approvals are stored with Telegram's signature and re-verified at every withdrawal. NearKit's app relays them and can't make one.
- **No owner powers without an owner wallet:** no key export, no backup key, no removing NearKit's key. The signer refuses them.
- **Linking later is optional.** In 🔐 Recovery, the linked wallet can become the owner of a wallet with no owner wallet. The Telegram account approves that in the Mini App; the signer then reseals the key to the owner (envelope v2), once and one way. From then on the wallet is an owned wallet: the Telegram approvals end, only the owner's signed approvals count, and the owner can export and add the backup key.
- **Owned wallets are unchanged.** A wallet created while a wallet is linked is owned by it. A user's later wallets inherit their existing owner. Telegram can never approve anything for an owned wallet.
- **A server whose signer checks no Mini App approvals** creates no wallet without an owner wallet: the user is asked to link one (fail-safe).

### 2.6 Withdrawals to any address, approved by the owner

- **Flow:** wallet, asset, amount (25%, 50%, MAX, custom), destination (the owner wallet, marked, or any typed address), then review.
- **Destination checks:** valid NEAR account ID, not the other network's suffix, exists on chain for named accounts, not the wallet itself, and for tokens not the token's own contract. An implicit address that was never used gets a warning.
- **Owner approval:**
  - The owner wallet is always allowed.
  - Any other destination needs the owner's approval once per wallet and destination. The bot says so and links to NearKit web, where the owner wallet signs a NEP-413 message naming the NearKit wallet, the destination, the network and the request.
  - Telegram then offers **Continue withdrawal**.
  - The signer re-verifies the approval at every use. An approval made with a key the owner later removed no longer counts.
  - The signer can remove an approval (`revoke-destination`, always safe). No screen offers it yet.
- **The review shows:** the wallet, the asset (with contract), exact amount, full destination, network, network fee, and any registration the destination needs ("the address has no USDT account yet"). It is valid for 5 minutes.
- **At Confirm:** everything is re-derived from chain. If the registration need or the address status changed, a new review is shown and nothing is sent. The destination is never changed silently.
- **Token withdrawals:** NEP-145 registration of the destination is paid from the wallet (≤ 0.1 NEAR), then `ft_transfer` with 1 yocto, in one transaction, so a failed transfer reverts the registration too.
- **MAX NEAR** keeps back the gas bought upfront.

### 2.7 Recovery and export (without Telegram)

- **The owner.** Everything here answers to the wallet's owner, never to whichever wallet is linked now.
  - Someone holding a stolen Telegram session can link a wallet of their own. It can't authorize an export or a destination, never becomes the backup key, doesn't count for revoke, and doesn't become the owner of new wallets.
  - Wallets created before owners were recorded got theirs from the link history (migration v6).
- **Backup key (Telegram, per wallet):**
  - One tap in 🔐 Recovery (review and Confirm) adds the owner wallet's full-access key to that NearKit wallet on chain, after the signer checks the key on chain.
  - Result: **if NearKit disappears**, the user's own wallet controls the NearKit wallet. Restoring their seed phrase or key in a NEAR wallet app finds it, because wallets look accounts up by key.
  - Tested by moving funds with the user's key alone.
- **The web recovery page** (`/recover`, `src/pages/RecoverPage.tsx`) works without Telegram:
  1. The owner connects the owner wallet and signs an **owner session**: a NEP-413 message the signer wrote, naming the owner, the network, NearKit's site and an expiry. It is free and moves nothing. NearKit then lists the owner's NearKit wallets.
  2. **Export, per wallet.** The page makes a P-256 browser key. The owner signs a message naming the NearKit wallet and the browser key's fingerprint. The signer seals the wallet key to that browser key (ECDH P-256, HKDF, AES-GCM). The app relays ciphertext it can't read, and only that page opens it. The page shows the key masked until revealed; it stays in memory only and is dropped on leaving. The response is `no-store`.
  3. **Approve or remove a destination**, per wallet, in the same way.
- **Every owner request:**
  - It is one-time and expires in 5 minutes, with at most 5 attempts and at most 20 requests per owner in 10 minutes.
  - It is verified by the signer: the signature over its own stored message, nonce and recipient (NearKit's host), and the key being a **full-access** key of the owner **on chain** (quorum).
  - The page refuses a request made for another site, wallet, network, kind or browser key before asking the wallet to sign (`src/services/recovery.ts`).
- **Telegram is told** about every export and approval.
- **No secret in a URL:** the recovery page takes only a wallet address in the fragment (`/recover#wallet=…`). Keys, signatures and challenges travel in JSON bodies.
- **The API** (`/api/recovery/challenge`, `/wallets`, `/export`, `/destination`) is JSON-only with a CORS allowlist, rate-limited per IP (20, 10, 5 and 10 a minute), `no-store`, and logs path and status only.

### 2.8 Security controls (not monetary limits)

- **Telegram and API:** per-user flood control, 6 quotes a minute per user, per-IP limits on API routes.
- **Replays and duplicates:** callback replay and duplicate-Confirm protection, persistent idempotency (§2.4), stale-quote rejection and fresh re-validation, Telegram update deduplication.
- **Signing:** typed operations, the signer's own policy, owner-approved destinations, gas-reserve and balance checks, read-back comparison of signed transactions.
- **Human confirmation:** explicit review and Confirm for every trade, withdrawal, backup key and revoke, naming the wallet.
- **Kill switches (fail closed):**
  - trading, withdrawals, one wallet (freeze), the signer (pause), mainnet custody (off);
  - switches that can't be read count as paused;
  - `npm run ops` (DEPLOYMENT.md §7).
- **Abuse:** wallet creation (10 a day), owner requests (20 per owner in 10 minutes, 5 attempts each).
- **What doesn't exist:** a per-trade, daily or per-user amount limit (owner decision).

### 2.9 Tests

| Area | Where |
|---|---|
| Transaction encoding (near-api-js reference vector, round trips, refusals, signatures) | `src/services/near/transaction.test.ts` |
| Keys, envelope encryption, wrong KEK, tampering, other-wallet additional data, rotation | `server/src/custody/vault.test.ts`, `server/src/signer/kms.test.ts` |
| The signer: sealed keys bound to their owner, one transaction per (intent, step) (also under concurrency), plan mismatches, backup key and revoke rules, owner requests (every refusal, replay, expiry, flooding, RPC disagreement), export sealed to the browser, destinations re-verified, erasure rules, pause, restart | `server/src/signer/core.test.ts` |
| Signer transport: signed requests and answers, replay, alteration, a lost answer asked again | `server/src/signer/http.test.ts` |
| RPC quorum; mainnet route verification (Rhea's signature, fee, recipient, tokens, registrations) | `server/src/signer/chain.test.ts`, `server/src/signer/routes.test.ts` |
| Signer and app configuration (mainnet refusals, fee account, KMS ARN, TLS, quorum) | `server/src/signer/config.test.ts`, `server/src/config.test.ts` |
| Store, schema and leases on SQLite, PGlite and PostgreSQL | `server/src/custody/store.test.ts`, `server/src/db/*.test.ts`, `server/src/signer/schema.test.ts` |
| Engine and concurrency: duplicate or simultaneous Confirm, replay, expiry, requote, busy wallet, RPC timeout, dropped transaction, restart, crashes, index lag, two instances, lost leases | `server/src/custody/engine.test.ts`, `server/src/custody/concurrency.test.ts` |
| Policy: receivers, methods, deposits, extra actions, modified routes, wrong network, keys, withdrawals, unwrap | `server/src/custody/policy.test.ts` |
| Several wallets (10, legacy buttons, flows stay on their wallet, per-wallet recovery and export) | `server/src/bot/multiWallet.test.ts` |
| Destinations (a stolen session, a compromised app, a tampered database, stale and replayed approvals) | `server/src/bot/destinations.test.ts` |
| The app against the signer service (no key in the app database; paused signer) | `server/src/bot/remoteSigner.test.ts` |
| Kill switches and the operator's command line | `server/src/bot/killSwitches.test.ts` |
| Referrals (links, attribution, earnings, claims, payouts checked on chain) | `server/src/bot/referrals.test.ts`, `server/src/referrals/*.test.ts` |
| Wallet UI, native trading, recovery | `server/src/bot/tradingWallet.test.ts`, `nativeTrade.test.ts`, `recovery.test.ts` |
| A whole lifecycle: the key reaches no Telegram message, log line, database row or API response in any encoding | `server/src/bot/custodySecrets.test.ts` |
| Built server with wallets on, fake Telegram; web recovery page checks | `scripts/e2e-telegram.mjs`, `src/services/recovery.test.ts` |

The tests run against a fake NEAR runtime (`src/services/real/testing/fakeRuntime.ts`). It verifies signatures, nonces and expiry and executes transfers, keys, NEP-141/145 calls and Rhea swaps, with the chain's receipt and log format. CI runs the database, custody, signer and referral suites against a real PostgreSQL too.

---

## 3. BEFORE MAINNET: what is done and what is the owner's

| # | Requirement | Code | Remaining |
|---|---|---|---|
| 1 | KMS-held KEK | **Done:** AWS KMS `KeyWrapper` with encryption context, rotation and reseal (`signer/kms.ts`, `signer/admin.ts`) | **Owner / infrastructure:** create the key, a policy for the signer's role only, CloudTrail |
| 2 | Separate signer | **Done:** its own service, database, typed methods, HMAC, TLS, policy (`server/src/signer/`) | **Infrastructure:** a private host |
| 3 | Mainnet policy for Rhea's aggregator | **Done:** Rhea's signature, fee 5000 ppm to `nearkitfee.near`, slippage against the signer's own quote, registrations (`signer/routes.ts`) | — |
| 4 | Production fee account | **Done:** canonical `nearkitfee.near`, and a mismatch refuses | **Owner:** fund it with a little NEAR for claim gas (§5.1) |
| 5 | Several instances | **Done:** PostgreSQL, leases, compare-and-set, dedup | **Infrastructure:** two managed databases |
| 6 | Security review | **Done internally:** [SECURITY_REVIEW.md](SECURITY_REVIEW.md), 10 scenarios, 2 fixes | **Owner:** an external review is recommended; decide R1 (trade authority) |
| 7 | Operations | **Done:** kill switches, frozen wallets, signer pause, health, audit events | **Owner:** alerts, an incident runbook, a kill-switch rehearsal |
| 8 | Backups and disaster recovery | Point-in-time recovery supported (stateless processes) | **Infrastructure:** backups and tested restores |
| 9 | Hosting | [DEPLOYMENT.md](DEPLOYMENT.md), reference container layout | **Owner:** authorize and choose hosting (FadeHost or another) |
| 10 | Telegram account safety | **Done:** new destinations need the owner wallet's signature | Trades remain the session's (R1). Advise Telegram two-step verification |
| 11 | Legal and compliance review of holding user keys on mainnet | — | **Owner** |

The go-live order is in [MAINNET_CEREMONY.md](MAINNET_CEREMONY.md).

### 3.1 What mainnet does NOT change
The intent engine, idempotency, anchoring, resolver, Telegram UX, withdrawals and recovery are network-independent. The fee comes from the one canonical `NEARKIT_FEE`.

### 3.2 KMS
- **Implemented: AWS KMS.** `Encrypt` wraps a wallet's DEK and `Decrypt` unwraps it. The encryption context is the wallet's additional data, and only the signer's role may use the key. Aliases are refused: an exact key ARN only.
- **Other KMSs** (GCP Cloud KMS, Vault transit) would be another `KmsApi` with the same shape.
- **Non-exportable ed25519 keys** in a KMS would remove key-in-memory risk, but make export impossible. The owner chose export.

### 3.3 Custody design (option B, implemented)

The options compared before mainnet were:
- **A.** A KMS with the signer in the app.
- **B.** A separate signer with KMS envelope encryption.
- **C.** Non-exportable keys per wallet.
- **D.** MPC or a wallet vendor.

**B is implemented.** The app server holds no key material and no KMS rights; it can only ask for typed operations. The signer enforces its policy and alerts, and has a pause the app can't lift.

The earlier caveat (a compromised app could withdraw to any address) is **closed**: new destinations need the owner wallet's signature, which the app can't forge.

What a compromised app or a stolen Telegram session can still do is trade within the policy. That is residual risk R1 in SECURITY_REVIEW.md, and an owner decision.

---

## 4. Threat model (as implemented)

The full review, with code and tests for each case, is [SECURITY_REVIEW.md](SECURITY_REVIEW.md). In short:

| If this happens | Impact | What bounds it |
|---|---|---|
| A user's Telegram account is compromised | The attacker can **trade** that user's NearKit wallets. They can't withdraw except to the owner or owner-approved destinations, can't export, can't approve, and can't make wallets owned by their own wallet | Owner approvals in the signer; owner-bound keys. Advise Telegram two-step verification |
| A Telegram group is compromised | Buybot settings change; nothing financial | Trading works only in private chats; the buybot holds no keys |
| The app database leaks | Privacy (Telegram ids, linked accounts, history); no keys | Keys live only in the signer's database |
| The signer database leaks | KMS ciphertext bound to each wallet and owner | Useless without the KMS key's role |
| The app server is compromised | In-policy trades (R1), forged referral rows (R2), new wallets owned by the attacker shown as deposit addresses (R3), phishing messages (R4). No withdrawal to a new destination, no export | The signer's policy, owner approvals, the pause |
| The signer host is compromised | Wallet keys can be unwrapped while the attacker holds its role | Private network, KMS key policy, CloudTrail, **disabling the KMS key** stops every unwrap |
| The KMS is unavailable | Nothing is signed or exported (fails closed) | Funds stay on chain; backup keys work without NearKit |
| An exported key leaks | That wallet only (no master key) | Per-wallet random keys |
| Two instances race | Nothing is sent twice | Leases, compare-and-set, the signer's (intent, step) record |
| An RPC lies | Nothing decided on one provider's word; nothing sent elsewhere | Quorum, `chain_id` checks, a conservative resolver |
| Replayed button, duplicate update, double tap | Nothing extra happens | Atomic Confirm, update dedup, persistent intents |
| NearKit disappears | Users with a backup key or an export keep full control | The backup key is on chain |
| A user loses their Telegram account | No loss: the web recovery page lists and exports their wallets with the owner wallet alone | Owner-signed requests, no Telegram needed |

---

## 5. Fee, Rhea's share and referrals (verified in code)

- **One source:** `NEARKIT_FEE = { bps: 50, referralShareBps: 2000 }` in `src/lib/fees.ts`. Quotes (web and Telegram), route checks (`app_fee_rate` = 50 × 100 ppm = 5000), reviews, disclosures, accounting and tests derive from it.
- **Testnet:** no fee is collected; the classic router has no app-fee mechanism. Quotes say "NearKit fee none on testnet"; the quote still records `bps: 50`.
- **Mainnet:**
  - The user pays **0.50%**. Rhea's aggregator keeps 20% of the app fee (`appFeeRouterShareBps: 2000`, from Rhea's docs and on-chain `earn_app_fee` events), so Rhea gets **0.10%** and `nearkitfee.near` receives **0.40%**.
  - Rhea's own protocol fee, pool fees and gas are separate. The 0.50% is never presented as the whole cost.
- **Accounting:** `feeLedger(gross, routerShareBps, referralShareBps)` gives gross, router share, received, referral and net. `referralSplit` splits what NearKit received:
  - referrer: 20% (0.08% of volume);
  - NearKit: 0.32%.
- **Referrals** (`server/src/referrals/`, `bot/referrals.ts`):
  - **Invite link:** every user has one permanent code, `t.me/<bot>?start=ref_<CODE>`, with a Copy link button.
  - **Attribution:** a **new** user (first seen within 10 minutes, no linked wallet, no NearKit wallet) is attributed once, for good. There is no self-referral, no loop and no change.
  - **Earnings:** a referrer earns 20% of what `nearkitfee.near` actually received on chain (`earn_app_fee`) from each settled trade of the people they referred, whether a NearKit wallet trade or a web hand-off started in Telegram. There is one earning per trade, whatever the retries.
  - **Claims:** per token, requested to the referrer's linked wallet, but only one linked at least 48 hours earlier.
  - **Payouts:** the owner pays from NearKit's own account and records it with `npm run referrals -- paid <claim> <tx> <payer>`, which checks the payout on chain first. There is no hot wallet.

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

- **Production topology:** [DEPLOYMENT.md](DEPLOYMENT.md). It covers the services, the private signer, two PostgreSQL databases, the KMS, health, backups, migration order, rollback, kill switches and log redaction.
- **Portable:**
  - plain Node processes: `npm run server:build`, then `server:start`, `signer:start` and `buybot`;
  - or the Docker image (`server/Dockerfile`);
  - a reference layout is in `deploy/docker-compose.production.yml`.
  - Nothing in the business logic depends on a host.
- **Several instances** can run with PostgreSQL (`NEARKIT_DATABASE_URL`), thanks to leases (§2.4). SQLite (`NEARKIT_DB_PATH`) is for local development and a single testnet host: one instance only, on a persistent volume.
- **Secrets:**
  - They live in the host's secret store, or as files (`NAME_FILE`, for the allowlisted secrets). Never on a data volume or in the image.
  - The signer's secrets never go on the app host, and the app's never on the signer host.
- **Public HTTPS URL** for the app's API (linking, trade hand-off, recovery), with `NEARKIT_API_PUBLIC_URL`, `NEARKIT_API_ALLOWED_ORIGINS` and `NEARKIT_API_HOST=0.0.0.0`. The host sets `PORT`. The signer has no public address.
- **FadeHost:**
  - It has an official MCP (`https://api.fadehost.com/mcp`: create an app from GitHub, logs, restart), GitHub auto-deploy, and `/data` persistence.
  - The free tier (256 MB) sleeps when idle, which stops polling and the resolver: fine to experiment, not for real use.
  - Nothing is deployed there without the owner's explicit authorization.
- **Railway:** `.railway/railway.ts` is ready for a single testnet instance (volume at `/data`, `/health`, one replica). It needs the Hobby plan.

---

## 7. Decisions still open

1. **R1, trade authority** ([SECURITY_REVIEW.md](SECURITY_REVIEW.md) §4), needed before mainnet custody. The options:
   - accept and disclose it;
   - a signer-side rule for tokens;
   - an owner-signed trading allowance per wallet.
2. **Hosting:** the provider and the explicit authorization to deploy (FadeHost or another), and the AWS account for the KMS key.
3. **Mainnet web:** a separate mainnet project or domain (recommended), or switching the current one (MAINNET_CEREMONY.md, A7).
4. **The signer's slippage cap** (`NEARKIT_SIGNER_MAX_SLIPPAGE_PCT`, default 50).
5. **An external security review and a legal and compliance review.**
6. **Mainnet go/no-go:** the owner runs [MAINNET_CEREMONY.md](MAINNET_CEREMONY.md).

**Decided:**
- the fee account `nearkitfee.near` (canonical);
- the KMS: AWS KMS (implemented);
- up to 10 wallets;
- owner-approved destinations;
- referrals at 20% of the net fee.

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
