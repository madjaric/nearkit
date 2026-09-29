# NearKit Telegram V2: architecture, security and decisions

Status: Phase A (audit and research) is complete, and Phase B (safe UX work) is shipped.
The Telegram-native wallet (Phase C) and native Buy/Sell (Phase D) wait for your decision
in §10. Written 2026-09-29. Every claim about NEAR, Rhea, other products and FadeHost cites
the source it was checked against.

---

## 1. Summary

**Shipped (no new custody risk):**
- Compact `/start`, Wallet, Positions, PnL and Settings screens.
- Buy/Sell with presets, MAX, % buttons and custom amounts.
- Quote screens that show every fee on its own line.
- Errors in plain words, double-tap protection, and "unknown is never zero" everywhere.
- The fee is set in one place and is now 0.50% (`NEARKIT_FEE` in `src/lib/fees.ts`), with referral-ready accounting.
- Buybot V2: USD or NEAR minimums, value per emoji, an emoji cap, media, sell alerts, and
  `/add` `/list` `/remove` `/pause` `/resume`.
- The server builds as a Docker image and reads its port from the host.

**Not shipped: trades that execute inside Telegram.** Today the bot prepares the trade and
the user signs it in the NearKit web app with their own wallet. Making "Confirm" execute in
the chat means NearKit signs, so NearKit must hold a key that can move funds.

**The research result that decides the design:** no NEAR key type can do a normal swap with
limited rights. Every Rhea deposit and swap entry point requires an attached deposit, and
restricted keys cannot attach one (§3.1). So in-chat trading needs one of:
- a key NearKit holds with full rights over a **separate trading account**;
- a **per-user contract** that enforces the limits on chain;
- the user signing each trade inside Telegram with their own wallet.

**Recommendation (§6):** a dedicated NearKit trading wallet per user, separate from their
main wallet. The user's own wallet key is also added to that account, so they can always
recover it without NearKit. It is guarded by:
- encrypted keys;
- a signer that only accepts an allow-list of actions;
- withdrawals only to the user's verified main account;
- limits.

Build it on testnet first. Mainnet stays gated on a KMS-held encryption key and a security
review. A vault contract is the longer-term hardening.

---

## 2. What exists today (audit)

| Part | Where | State |
|---|---|---|
| Bot server (long polling + HTTP API) | `server/` | Runs locally; Docker image and Railway IaC ready (`server/Dockerfile`, `.railway/railway.ts`) |
| Account linking | `server/src/link/` | NEP-413 signed message plus an on-chain check that the key is FULL-ACCESS. One Telegram user per NEAR account per network |
| Trades | `server/src/bot/trade.ts`, `server/src/trade/handoff.ts` | Quote in Telegram → "Confirm & sign in NearKit" opens `/swap` filled in → re-quoted → the user's wallet signs → the server reads the result from chain and reports it |
| Positions / PnL | `src/lib/pnl.ts` (one engine for web and bot) | Average cost from on-chain history; unknown shows as — |
| Buybot | `server/src/buybot/` | FastNEAR tx index, final blocks, idempotent delivery; V2 settings |
| Fee | `src/lib/fees.ts` `NEARKIT_FEE` | 50 bps, collected by Rhea's aggregator as an app fee; testnet collects none; mainnet blocked without a fee account |
| Keys held by NearKit | none | The server holds no key that can move funds |
| Secrets | bot token in `server/.env.local` (git-ignored), redacted from logs | All 25 commits scanned on 2026-09-29: no real token, private key, seed phrase or `.env.local` was ever committed. Token-shaped strings are test constants; the long `ed25519:` values are public transaction signatures in fixtures; `.env.demo`, `.env.e2e` and `.env.mainnet` hold only public Vite mode flags |

---

## 3. What NEAR allows today (checked 2026-09-29)

### 3.1 Function-call access keys
- A function-call key names one contract (`receiver_id`), optionally a list of methods, and a gas allowance.
- The node rejects any transaction from such a key unless it is exactly one function call with a **zero deposit** (error `DepositWithFunctionCall`, [verifier.rs](https://github.com/near/nearcore/blob/master/runtime/runtime/src/verifier.rs), [docs](https://docs.near.org/protocol/access-keys)). No NEP changes this. `one_yocto_on_promise` (protocol 85) only lets a *contract* attach 1 yocto to its own outgoing calls.
- Consequences:
  - These keys **cannot** call `ft_transfer_call`, which requires exactly 1 yocto ([NEP-141](https://github.com/near/NEPs/blob/master/neps/nep-0141.md)).
  - They cannot call `near_deposit`, which is payable.
  - So they cannot use Rhea's aggregator or classic router in the normal way.
- They **can** call a zero-deposit method on a contract deployed on the account itself. That contract can then attach 1 yocto or NEAR from the account's balance, the way NEAR's own [multisig contract](https://github.com/near/core-contracts/tree/master/multisig) works.

### 3.2 Rhea classic `swap` with zero deposit
- In the published source, `swap`, `swap_by_output` and `execute_actions` on `v2.ref-finance.near` are payable but have **no** `assert_one_yocto`.
- With zero deposit they trade the caller's **internal Rhea balance**, but only if every token is already registered in the caller's Rhea account or is on Rhea's whitelist. The code comment says "e.g. trade with access key".
- `withdraw` requires exactly 1 yocto.
- Sources: [lib.rs](https://github.com/DevOfCredit/ref-contracts/blob/main/ref-exchange/src/lib.rs) and [account_deposit.rs](https://github.com/DevOfCredit/ref-contracts/blob/main/ref-exchange/src/account_deposit.rs). These are a mirror: the official repo now returns 404, and the deployed version (1.9.20) is two versions ahead.
- **Not verified on chain.** In a sample of 110 recent swaps, every one attached 1 yocto.
- So a function-call key limited to Rhea's `swap` could trade but **not withdraw**, with three catches:
  - it could still destroy value (`min_amount_out = 0`, hostile pools);
  - every new token needs a user-signed registration first;
  - the aggregator's app fee doesn't apply, so NearKit's 0.50% could not be collected.

### 3.3 Other mechanisms
- **Meta-transactions (NEP-366).** They let a relayer pay gas. The user still signs the exact actions, and a DelegateAction cannot authorize future, unknown actions ([NEP-366](https://github.com/near/NEPs/blob/master/neps/nep-0366.md)).
- **Global contracts (NEP-591, live).** One deployment costs 10 NEAR per 100 KB, and each user account references it for under 0.001 NEAR. Code referenced by hash is immutable ([docs](https://docs.near.org/smart-contracts/global-contracts)). This makes a per-user contract cheap.
- **Deterministic accounts (NEP-616, live since [nearcore 2.10](https://github.com/near/nearcore/releases/tag/2.10.0)).** The account ID comes from the code and state. Only the contract can add keys, which suits a per-user vault.
- **Account creation** burns about 0.007 NEAR (`account_creation_charge`, live), including implicit accounts.
- **NEAR Intents.** Any key registered on `intents.near` can sign any intent, including withdrawals. No swap-only key exists ([docs](https://docs.near-intents.org/integration/verifier-contract/intent-types-and-execution)).
- **Chain Signatures (MPC).** They sign for other chains; each signature needs 1 yocto. They are unnecessary for trading on NEAR.
- **HOT Wallet.** A Telegram Mini App wallet that uses MPC. near-connect reaches it through `t.me/hot_wallet`, so the user stays in Telegram but switches apps. It has **no testnet** ([connector](https://github.com/azbang/near-connect/blob/main/near-wallets/src/hotwallet/index.ts)).
- **Session keys** in Meteor, Intear and MyNearWallet are function-call keys, with the same zero-deposit limit.
- **Finding accounts by key.** FastNEAR's `/v0/public_key/{pk}` lists accounts for a key, and MyNearWallet and Intear use it. So an account that carries the user's own key shows up in their wallet.

---

## 4. How others do it (public information only)

| Product | Bot trading | Keys | Withdrawals | Fee |
|---|---|---|---|---|
| **NearFi** ([site](https://nearfi.trade)) | Server signs ("bot and Terminal are custodial"); its Swap mode is non-custodial | Generated per user; the only claim is that imported keys are "stored encrypted"; export after a new signed message | Any address; no allow-list or 2FA described | 0.5% flat; referrals paid from it (share unpublished); fee account `neartokenbot.near` (visible in site code); product ~5 days old |
| **Dragonbot** ([docs](https://dragonbot.gitbook.io/welcome-to-dragonbot)) | Server signs through a **per-user trading contract** on a sub-account; the user gets the key | Per third-party writeup: a function-call key that can only send to the user's destination wallet (not in the official docs) | To the destination set at onboarding | Referrals "coming soon" |
| **BONKbot** ([docs](https://docs.bonkbot.io/security/signer)) | Server signs | Encrypted in confidential computing (TPM/HSM); staff can't access | 2FA for export and withdrawals | 1%; referrals 30%, 20%, then 10% |
| **Trojan / Maestro / Banana Gun** | Server signs | AES-encrypted keys (Maestro); key shown once (Banana Gun); a password for export and withdrawals (Trojan) | As left | 0.5–1%; referrals 10–35% |

Incidents on record:
- Maestro router exploit, ~280 ETH, refunded ([Decrypt](https://decrypt.co/204444/maestro-trading-bot-refunds-610-eth-to-users-following-router-exploit)).
- Banana Gun message exploit, 563 ETH, refunded ([Cointelegraph](https://cointelegraph.com/news/banana-gun-crypto-bot-refunds-3m)).
- Solareum-linked drains, where BONKbot said users had exported their keys ([Decrypt](https://decrypt.co/224127/solana-wallets-drained-523k-bonkbot-denies-link)).

The pattern: Telegram-native trading bots are custodial hot wallets. The good ones separate the
trading wallet, encrypt keys with hardware-held keys, and gate withdrawals and export.

---

## 5. Options

| | Option | Trade in chat | Who can move funds | Server-compromise impact | Effort | Verdict |
|---|---|---|---|---|---|---|
| A | Plain custodial wallet, keys in the DB | Yes | NearKit | Total loss of every wallet | Low | **No** |
| B | Custodial, keys encrypted (envelope) | Yes | NearKit | Total loss if the running server is taken; DB leak alone is safe | Medium | Part of G |
| C | Hold users' **main** wallet full-access keys | Yes | NearKit | Total loss of users' whole wallets | Low | **Never** |
| D | Function-call key on the user's main account | **No** (no deposit: §3.1) | User | — | — | Not possible for swaps |
| D′ | Function-call key limited to Rhea `swap` on the internal balance (§3.2) | Yes, Rhea classic only | User (withdraw needs their wallet) | Bad trades, no theft path; value extraction through hostile pools possible | Medium | Interesting but: new tokens need registration, the 0.50% fee can't be collected, unverified on chain |
| E | Meta-transactions / relayer | No (user signs each) | User | — | Low | Gas sponsorship only |
| F | Intents keys, Chain Signatures | Yes / no | Intents key = full control of the intents balance | Total loss of the intents balance | Medium | No per-key limits |
| **G** | **Dedicated NearKit trading wallet (separate account) + controls** | **Yes** | NearKit signer (policy-limited) **and** the user's own key | Loss limited to trading-wallet balances; withdrawals only to the linked account | Medium | **Recommended now (testnet)** |
| R | Per-user **vault contract** (global contract) + operator function-call key | Yes | Contract rules: trade on allow-listed DEXes, withdraw only to owner | Bad trades possible, no withdrawal to an attacker | High (Rust contract + audit) | **Recommended later** |
| H | Telegram Mini App + the user's wallet (HOT on mainnet) | Confirm inside Telegram, wallet approves | User | None | Medium | Keep as the "no custody" mode; HOT has no testnet |

---

## 6. Recommendation: G now, R later, H as the non-custodial mode

### 6.1 The trading wallet
- **Separate account.** Each Telegram user gets a NearKit trading account, never their main wallet. Use an implicit (64-hex) account created by the user's first deposit (about 0.007 NEAR burn), or a named sub-account under a NearKit root. The user moves into it only what they want to trade with.
- **Two keys on it.**
  - A key NearKit generates, for signing trades.
  - **The user's own full-access key** (the public key their NEP-413 link already verified), added with `AddKey` at setup.
  - Result: the user can always open the trading account in their own wallet (FastNEAR key lookup) and move everything out, even if NearKit, its database or its servers are gone.
- **Where NearKit's key lives.** Never in plain text anywhere:
  - The private key is encrypted with AES-256-GCM under a per-wallet data key (DEK). The ciphertext is bound to the user and account IDs as additional data.
  - The DEK is encrypted by a key-encryption key (KEK) that is **not** in the database.
    - **Testnet:** a separate secret in the host's secret store.
    - **Mainnet:** a KMS or HSM (AWS KMS, GCP KMS or Vault) that the signer process alone can call. Decrypted keys live only in that process's memory, only while signing.
- **The signer.** An isolated module, and later its own process. It signs only transactions that pass a policy, and refuses anything else. The policy:
  - Allowed actions:
    - `wrap.near` `near_deposit` / `near_withdraw`;
    - `storage_deposit` for the trading account itself;
    - `ft_transfer_call` to Rhea's aggregator or router carrying a **freshly verified** route (the same checks as today: signature, user = the trading account, app fee = `NEARKIT_FEE`, minimum ≥ slippage bound);
    - `ft_transfer` or NEAR transfer **only to the user's linked main account**.
  - Every other receiver, method or amount is refused.
- **Withdrawals** go only to the NEP-413-verified linked account. Changing the destination needs a new wallet signature. A stolen Telegram account can't pull funds to an attacker.
- **Export.** Allowed, after a fresh NEP-413 signature, shown once in the web app, never sent through Telegram (Telegram chats aren't end-to-end encrypted). Export is optional, because the user's own key is already on the account.
- **Limits** (defaults, to be decided): per-trade maximum, daily maximum, and a balance above which the bot suggests moving funds out. All are enforced by the signer.
- **Deletion.** Withdraw everything to the linked account, then delete NearKit's key from the account (`DeleteKey`, signed by NearKit's key) and erase the encrypted key. The account stays with the user's key.
- **Multiple wallets.** Allowed later (for example up to 5 per user), each with its own DEK.
- **Backup and disaster recovery.**
  - Back up the database with its encrypted keys and the KEK separately (KMS handles key durability).
  - Losing both still loses nothing: the user's own key controls every trading account.

### 6.2 A trade inside Telegram (Phase D)
1. The user picks a token and amount, then sees the quote (as today).
2. **Confirm.** The bot records an execution ID (idempotency key = user + quote ID) and moves the button to "Executing…".
3. The server asks for a **fresh** route, bound to the trading account. It validates:
   - the token and network;
   - the balance, plus gas and storage;
   - that slippage is within bounds and the minimum received hasn't moved materially;
   - the route and fees (the existing `swapRouting` checks).
4. If the new quote differs beyond a threshold, the bot shows it and asks again. **Nothing executes silently.**
5. The signer signs, the server submits, and the executor confirms on chain. The executor is the web app's, reused: it handles failure, pause and "unknown" states.
6. The bot reports: received amount, NearKit fee, and the transaction link, or the failure in plain words.
7. Double taps, replays and stale buttons hit the recorded execution ID. **One confirmation, one trade.**

### 6.3 Phasing
- **C (testnet):**
  - Create the trading wallet, add the user's key, encrypt (KEK from host secrets).
  - Deposit address, balance, withdraw to linked account, delete.
  - Tests: creation, encryption, signing policy, withdrawal, recovery with the user's key, deletion.
- **D (testnet):** native Buy/Sell as in §6.2, end to end on testnet.
- **Mainnet gate:**
  - KMS-held KEK and a separate signer process;
  - limits on;
  - an external security review;
  - an incident runbook (kill switch that stops signing);
  - start with low per-user caps.
- **Later:** vault contract (R). It holds funds in a per-user contract account (global contract, deterministic account). The operator key can only swap on allow-listed DEXes and withdraw to the owner, so theft is impossible even if the server falls. It needs a Rust contract and an audit.

---

## 7. Threat model (for option G as designed)

| If this happens | Impact | Why it's bounded |
|---|---|---|
| A user's Telegram account is compromised | Attacker can trade that user's trading-wallet funds (bad trades); **cannot withdraw to their own address** | Withdrawals go only to the linked main account; export needs a wallet signature; limits cap damage |
| A Telegram group is compromised | Buybot settings can be changed; nothing financial | Buybot holds no keys; trading works only in private chats |
| NearKit database leaks | Encrypted keys only; no loss | KEK not in the database; AES-GCM with bound additional data |
| NearKit server is compromised (running process) | Attacker can make the signer sign **within policy** (trades on Rhea, withdrawals to users' own linked accounts) and, with KMS access, could try to decrypt keys | Policy allow-list; KMS usage alerts; limits; kill switch. Residual risk: value extraction through bad trades. This is why mainnet needs a separate signer, KMS and a review, and why R is the long-term fix |
| Environment variables leak | Bot token (and testnet KEK) exposed | Rotate the token with @BotFather; testnet only; mainnet KEK is in KMS, not env |
| Encryption key (KEK) leaks | With a DB copy, trading keys are readable | KMS on mainnet (key never leaves the HSM); rotate by re-wrapping DEKs; the user's own key still controls each account |
| Hosting provider is compromised | Same as server compromise | Same controls; KMS in a separate cloud account |
| NearKit disappears or shuts down | Users keep full control | The user's own full-access key is on every trading account; their wallet finds it by key |
| A user loses their Telegram account | No loss | Their wallet key controls the trading account; relinking a new Telegram needs a wallet signature |

What NearKit can do with this design:
- **Sign trades for users**, as any custodial bot can, but only inside the policy.
- **Not** send funds anywhere except the user's own verified account.
- **Not** stop a user from taking their funds out with their own key.

---

## 8. Fees and referrals
- `NEARKIT_FEE` in `src/lib/fees.ts` is the one source: `bps: 50` (0.50%), `referralShareBps: 0`. Quotes, route checks, reviews, docs and tests derive from it.
- **Rhea keeps 20% of any app fee**, so NearKit's account receives **0.40%** of the 0.50%. Rhea's own 0.10% protocol fee, pool fees and gas are separate lines in every quote. If NearKit should *net* 0.50%, the rate users pay would be 0.625%. **That is your call.**
- **Referral-ready:** `feeLedger(gross, routerShareBps, referralShareBps)` splits a collected fee into router share, received, referral and net. A referral program then only sets `referralShareBps` (paid out of what NearKit receives) and records referrers; the fee and transaction architecture stay as they are.
- **Fee account:** not chosen, not hard-coded; unset = mainnet fee-taking trades blocked (tested).

---

## 9. Hosting

**FadeHost** ([docs](https://fadehost.com/docs/app-hosting/)):
- **Tooling:**
  - An official MCP server exists (`https://api.fadehost.com/mcp`, token from Profile → AI Access, [docs](https://fadehost.com/docs/ai-access/)). Its tools include `create_app` from a GitHub repo, logs, and restart.
  - No CLI. The REST API is undocumented and covers game servers only.
  - GitHub auto-deploy is supported.
- **Runtime:**
  - Node is detected from `package.json`; the version isn't documented (examples use 22).
  - Docker is on paid tiers only.
  - `/data` persists across deploys; code sits in `/data/app` and is reset on each deploy.
  - Env vars are set in the panel and masked; health checks run only with a web address.
- **Free tier:**
  - 256 MB RAM, 0.25 vCPU, 3 GB disk, one app.
  - The docs conflict on the free web address: one page says it "sleeps when idle", another that it isn't offered. They also say sleeping **stops the app**, which would stop Telegram polling.
- **Credibility:** a small, long-running game host whose app hosting is weeks old.
- **Verdict:** the free tier can't safely run the bot **and** the public HTTPS API the web app needs for linking and trade hand-off. The Starter tier plus an always-on address ($4/month) can.

**Railway** has a ready config (`.railway/railway.ts`: volume at `/data`, healthcheck, one instance). It needs the Hobby plan ($5/month) because the trial expired.

**Either host:**
- Leave `NEAR_NETWORK=testnet`, point `NEARKIT_DB_PATH` at persistent storage, set `NEARKIT_API_HOST=0.0.0.0`, and let the host set `PORT`.
- The build command is `npm run server:build`; the start command is `npm run server:start`.
- The bot token goes into the host's secret settings, entered by you.

---

## 10. Decisions needed from you

1. **Custody model for Telegram trading:**
   - **G (recommended):** dedicated trading wallet with the user's own key added, encrypted keys, policy signer, withdrawals only to the linked account;
   - **D′:** restricted key, Rhea-internal balance, no NearKit fee;
   - **H:** Mini App, user signs each trade;
   - or a combination (G for speed, H as the no-custody option).
2. **Export:** allow private-key export (recommended: yes, after a wallet signature, in the web app only)?
3. **Withdrawal destinations:** linked account only (recommended), or any address like NearFi?
4. **Default limits:** per-trade and daily maximum on the trading wallet (suggest 50 NEAR per trade, 200 NEAR per day on mainnet at launch).
5. **Production key custody:** which KMS (AWS, GCP or Vault) for the mainnet KEK. This needs an account and some monthly cost.
6. **Fee:** users pay 0.50% and NearKit nets 0.40% after Rhea's 20% share, or users pay 0.625% so NearKit nets 0.50%?
7. **Hosting:** FadeHost Starter plus always-on address ($4/month) or Railway Hobby ($5/month). The free FadeHost tier can't reliably serve both the bot and the web API.
8. **Production fee account:** still yours to choose; mainnet fee-taking trades stay blocked until it is set.
