# NearKit mainnet ceremony

The owner's steps to take NearKit to mainnet, in order, with the exact checks. **Nothing here has been executed.**
- Until the owner runs it, the public site stays the **testnet beta** with mainnet execution off.
- Mainnet custody stays off.
- Nothing is deployed to a host.
- Every step that spends money, signs a transaction, creates a credential or changes a live deployment is the **owner's** action.

Fee economics (locked; one source, `NEARKIT_FEE` in `src/lib/fees.ts`):
- The trader pays **0.50%**.
- Rhea's aggregator keeps **0.10%** (20% of the fee), so NearKit's account `nearkitfee.near` receives **0.40%**.
- On a referred trade the referrer earns **0.08%** (20% of NearKit's 0.40%), and NearKit keeps **0.32%**.

Rollback at any step:
- **Web:** `VITE_ENABLE_MAINNET_EXECUTION=false`, then redeploy.
- **Telegram:** `NEARKIT_MAINNET_CUSTODY=off`, then restart, or the kill switches in [DEPLOYMENT.md §7](DEPLOYMENT.md#7-kill-switches-fail-closed).
- **Buy bot:** stop the process.

---

## A. Web (13 steps)

1. **Release.** The release commit is on `main` with CI green: typecheck, lint, format, unit and PostgreSQL tests, server build, Telegram e2e.
   - Run locally too: `npm run e2e:real` against `npm run dev:e2e`, and `npm run e2e` against `npm run dev:demo`.
2. **Mainnet profile.** `.env.mainnet` says `VITE_NEAR_NETWORK=mainnet`, `VITE_NEARKIT_FEE_RECIPIENT=nearkitfee.near` and `VITE_ENABLE_MAINNET_EXECUTION=false`. Nothing else is tracked.
3. **The fee account.** Read-only on chain, check `nearkitfee.near`:
   - it exists, and its only full-access key is one you hold (`near account list-keys nearkitfee.near network-config mainnet now`);
   - it has at least **0.1 NEAR** for gas when claiming fees ([NEARKIT_TELEGRAM_V2_ARCHITECTURE.md §5.1](NEARKIT_TELEGRAM_V2_ARCHITECTURE.md#51-the-production-fee-account-and-claiming-fees)).
4. **Local preview, execution off.** `npm run preview:mainnet` builds the mainnet profile into `dist/mainnet` and serves it on http://localhost:5199. Check the page:
   - The top bar says **mainnet** and **view only**.
   - A quote (NEAR→USDC, 1 NEAR) shows the **0.50%** NearKit fee with Rhea's **0.10%** share and the fee account **nearkitfee.near**.
   - The Swap button says execution is disabled.
5. **Read-only smoke test** ([MAINNET_SMOKE_TEST.md](MAINNET_SMOKE_TEST.md), no signing):
   - balances of a known account;
   - token search by exact contract;
   - quotes for NEAR→USDC, USDC→NEAR and NEAR→a meme token;
   - route checks pass (signature, fee, recipient).
6. **RPC.** Decide the mainnet providers. Dedicated or paid providers are recommended for reliability. Set `VITE_NEAR_RPC_URL` if they are not the defaults.
7. **Where mainnet lives (owner decision).**
   - **Recommended:** a separate Vercel project or domain for mainnet, keeping `nearkit.vercel.app` as the testnet beta.
   - **Alternative:** switch the existing production deployment.
   - Write the decision down.
8. **Environment.** On the mainnet project set `VITE_NEAR_NETWORK=mainnet`, `VITE_NEARKIT_FEE_RECIPIENT=nearkitfee.near` and **`VITE_ENABLE_MAINNET_EXECUTION=false`**. If Telegram is live, also set `VITE_NEARKIT_API_URL` and `VITE_TELEGRAM_BOT`.
9. **First deploy, execution off.** Check the live bundle: `curl -s https://<mainnet host>/ | grep -o 'assets/index-[^"]*\.js'`, then fetch that file and find:
   - `"mainnet"`;
   - the execution flag `"false"`;
   - the recipient `nearkitfee.near`.
10. **Plan the first trade.** Use the owner's own wallet only and small amounts (for example 0.5 NEAR). Pick a liquid pair, NEAR→USDC.
11. **Turn execution on.** Set `VITE_ENABLE_MAINNET_EXECUTION=true` on the mainnet project and redeploy. Check the bundle's execution flag is `"true"`.
12. **First real trade (owner).**
    - The review shows the 0.50% fee to `nearkitfee.near`, the minimum received and the storage lines. Confirm in the wallet.
    - The result shows **Confirmed**, and **"Updating balances…"** gives way to the new balance without a reload.
    - On nearblocks, the transaction's `earn_app_fee` event credited `nearkitfee.near` 0.40% of the fee base, and `earn_app_protocol_fee` Rhea's share.
13. **Watch and announce.**
    - Watch errors and wallet reports for the first day before announcing.
    - Rollback: `VITE_ENABLE_MAINNET_EXECUTION=false` and redeploy. Execution is off again on the next page load.

---

## B. Telegram NearKit wallets (17 steps)

1. **Owner decisions, written down:**
   - the go-live date;
   - `NEARKIT_SIGNER_MAX_SLIPPAGE_PCT` (default 50; lower refuses high-slippage trades but limits what a compromised app could extract);
   - the hosting plan and **explicit authorization to deploy** (FadeHost or another);
   - whether to require extra trade authorization (see SECURITY_REVIEW.md, residual risk R1).
2. **Two PostgreSQL databases.** One for the app and one for the signer, with separate users, TLS, point-in-time recovery, a private network and backups tested ([DEPLOYMENT.md §5](DEPLOYMENT.md#5-persistence-backups-restarts)).
3. **The KMS key** (AWS KMS):
   - a symmetric `ENCRYPT_DECRYPT` key;
   - a key policy that allows **only the signer's IAM role** `kms:Encrypt` and `kms:Decrypt`;
   - automatic rotation on, and CloudTrail data events on;
   - note the key **ARN**.
4. **The signer host.** Private network only, with no public address. It runs under the IAM role from step 3, with a TLS certificate for its private name, or as a sidecar on 127.0.0.1.
5. **The shared auth key.** Generate one (`openssl rand -base64 32`, or `npm run signer:auth-key` for local files) and store it as `NEARKIT_SIGNER_AUTH_KEY` in both hosts' secret stores. Never in a file on a shared volume.
6. **Signer configuration** ([server/.env.signer.example](server/.env.signer.example)):
   - `NEAR_NETWORK=mainnet` and `NEARKIT_MAINNET_CUSTODY=enabled`;
   - `NEARKIT_KMS_KEY_ARN` and `NEARKIT_SIGNER_DATABASE_URL`;
   - `NEARKIT_SIGNER_RECIPIENT=<mainnet web host>` and `NEARKIT_FEE_RECIPIENT=nearkitfee.near`;
   - `NEARKIT_SIGNER_RPC_URLS` (≥ 2 providers) with `NEARKIT_SIGNER_RPC_QUORUM=2`;
   - TLS, the slippage cap from step 1, and **`NEARKIT_SIGNER_PAUSED=true`** (a host switch, read on every request: while it is set nothing is signed, exported or approved).
7. **Start the signer paused.** `npm run signer:start`.
   - Check `npm run signer:admin -- status`: network `mainnet`, KEK `ok` (a real KMS round trip), database `ok`, `paused true`, keys held `0`. While paused it exits with status 1; that is expected here.
   - A wrong RPC network, a missing KMS key or a wrong fee account stops it at start.
8. **App configuration** ([server/.env.example](server/.env.example)):
   - `NEAR_NETWORK=mainnet`, the production `TELEGRAM_BOT_TOKEN` and `TELEGRAM_BOT_USERNAME`;
   - `NEARKIT_DATABASE_URL`, `NEARKIT_SIGNER_URL` (https) and `NEARKIT_SIGNER_AUTH_KEY`;
   - `NEARKIT_FEE_RECIPIENT=nearkitfee.near` and `NEARKIT_WEB_URL=<mainnet web>`;
   - the API URLs and origins, `BUYBOT_RUNNER=separate`, and **`NEARKIT_MAINNET_CUSTODY=off`**;
   - no `NEARKIT_WALLET_KEK`.
9. **Start the app, custody still off.** `npm run server:start`.
   - `GET /health` shows `wallets: "off"`, `bot: true` and the network.
   - The bot answers `/start`. Link the owner's wallet with `/link` on mainnet.
10. **Pause trading and withdrawals** before turning custody on:
    - `npm run ops -- pause trading "go-live"`
    - `npm run ops -- pause withdrawals "go-live"`
11. **Turn custody on.** Set `NEARKIT_MAINNET_CUSTODY=enabled` on the app and restart.
    - `/health` shows `wallets: "on"`, `signer: "paused"` and `pauses: {trading: true, withdrawals: true}` (it refreshes every 15 s).
    - A missing requirement (signer over https, Postgres, fee account, https web app) stops it at start.
12. **Resume the signer** on its host:
    - remove `NEARKIT_SIGNER_PAUSED` (and the pause file, if one exists) and restart the signer;
    - `npm run signer:admin -- resume "go-live"` clears a pause set from the app (`ops signer-pause`), if any;
    - `npm run signer:admin -- status` shows `paused false` and exits 0, and the app's `/health` shows `signer: "ok"` within 15 s.
13. **Owner's wallet.**
    - In Telegram, create a NearKit wallet. Its owner is your linked wallet.
    - Deposit a small amount (for example 1 NEAR) from your own wallet.
    - In 🔐 Recovery, add the **backup key**. Check on chain that your key is now a full-access key of the NearKit wallet.
14. **Withdrawals.**
    - `npm run ops -- resume withdrawals "go-live"`.
    - Withdraw 0.1 NEAR to your owner wallet (no approval needed) and check it arrives.
    - Withdraw to a second account of yours: the bot asks for an **approval**. Approve it in NearKit web (`/recover`) with your owner wallet, tap Continue, and check it arrives.
    - `npm run signer:admin -- status` lists `tx-signed` events.
15. **Trading.**
    - `npm run ops -- resume trading "go-live"`.
    - Buy a small amount of a liquid token (NEAR→USDC, 0.2 NEAR). The review shows 0.50% to nearkitfee.near.
    - After confirming, the chain shows `earn_app_fee` to `nearkitfee.near`. Sell it back.
16. **Recovery without Telegram.** On `/recover`:
    - sign the owner session and check your wallets are listed;
    - export the key of a test wallet. It is sealed to the page; check it imports into a wallet app, then empty and delete that test wallet;
    - check Telegram received the export notice.
17. **Readiness.**
    - Alerts are set on:
      - signer denials, refused owner proofs and exports;
      - withdrawal bursts;
      - KMS Decrypt volume (CloudWatch on CloudTrail);
      - `/health` of all three services.
    - The kill switches are rehearsed: `npm run ops -- pause trading`, `signer-pause`, and resume on the signer host.
    - The incident runbook is written. Then announce.

---

## C. Buy bot (7 steps)

1. **Configuration.**
   - `NEAR_NETWORK=mainnet`, `BUYBOT_NETWORK=mainnet`, a reliable `BUYBOT_RPC_URL` and `BUYBOT_DATA_URL` (default `https://tx.main.fastnear.com`);
   - the production `TELEGRAM_BOT_TOKEN`, `NEARKIT_DATABASE_URL` and `NEARKIT_WEB_URL`, plus `BUYBOT_HEALTH_PORT`;
   - **no custody variable** (it refuses them).
2. **The app.** `BUYBOT_RUNNER=separate`: the app keeps the groups' `/buybot` settings, and the buy bot process posts.
3. **Start** `npm run buybot`. Its `/health` shows `ok: true`, `posting: true` (it holds the lease) and `network: "mainnet"`. A wrong RPC network stops it at start.
4. **Test group.** Add the bot to a test group. `/buybot`, then add a liquid token by exact contract, then **Preview**.
5. **A real alert.** Check each field:
   - `$TOKEN Buy!`, the USD value, the NEAR value, the amount and the buyer;
   - **Market cap (FDV)**, holders from NearBlocks, the **CA** and the transaction link.
   - The buttons: **Buy $TOKEN** opens `NEARKIT_WEB_URL/swap?to=<contract>` (shown only when the buy bot's `NEAR_NETWORK` is the alert's network, so point `NEARKIT_WEB_URL` at the mainnet web app), **Chart** opens DexScreener, **Copy CA** copies the contract.
6. **Resilience.** Stop and start the process: no alert is posted twice, and none is lost. A second instance doesn't post (one lease). Logs show `retry_after` being honoured if Telegram rate-limits.
7. **Wrap up.** Remove the test group. Alerts then run for the groups that set them up.
