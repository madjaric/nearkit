# Mainnet smoke test

A controlled first run of NearKit on NEAR mainnet, with very small amounts, before any public mainnet deployment. It runs as a local production build on your machine; the public site at https://nearkit.vercel.app stays on the testnet beta throughout, and nothing is deployed.

## What you need first

1. **The NearKit fee account.** This is an existing mainnet account you control, for example `nearkit-fees.near`.
   - On every Swap and Quick Trade it receives 0.40% (NearKit's share of the 0.50% fee) as an internal balance on Rhea's aggregator (`aggregatedex.near`), and only this account can withdraw it.
   - NearKit refuses to trade if the account is missing, malformed, belongs to testnet or does not exist.
2. **The fee account registered with the aggregator** (recommended). This is one transaction, signed by the fee account (0.025 NEAR):

   ```bash
   near contract call-function as-transaction aggregatedex.near tokens_storage_deposit json-args '{"user":"<fee account>","tokens":["wrap.near","17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1","usdt.tether-token.near","a0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.factory.bridge.near","dac17f958d2ee523a2206206994597c13d831ec7.factory.bridge.near"]}' prepaid-gas '30.0 Tgas' attached-deposit '0.025 NEAR' sign-as <fee account> network-config mainnet sign-with-keychain send
   ```

   Without it, a swap whose fee lands in one of these tokens adds that 0.005 NEAR registration to your own transaction, disclosed in the review.
3. **A mainnet test wallet** (HOT, Meteor or any wallet NearKit lists) with three accounts you control:
   - A, with about 1 NEAR;
   - B, with about 0.1 NEAR;
   - C, any account, even an empty named one that exists.
4. **Your explicit go-ahead** to switch mainnet execution on for this run.

## Run it

1. Create `nearkit/.env.mainnet.local`. It is git-ignored and never committed:

   ```bash
   VITE_ENABLE_MAINNET_EXECUTION=true
   VITE_NEARKIT_FEE_RECIPIENT=<fee account>
   ```

2. Run `npm run preview:mainnet`, then open http://localhost:5199. This is a production build on mainnet with the same security headers and the same held-back features as the public beta.
3. Check the top bar: the chip reads `NEAR · MAINNET` (amber) **without** `VIEW ONLY`.

When you're done, delete `.env.mainnet.local`. Mainnet builds are view-only again.

## Checklist

Amounts are deliberately tiny. Budget about 0.3 NEAR on A for the whole run: registrations are one-time costs of 0.00125 NEAR per token account and 0.005 NEAR per aggregator token, and gas is mostly refunded.

| # | Step | Amount | Passes when |
|---|---|---|---|
| 1 | **Wallet connection.** Connect A with HOT (or Meteor); disconnect; reconnect | none | The top bar shows A's `.near` account; after a reload the session is restored; disconnect clears it |
| 2 | **NEAR balance.** Open Positions and Wallets | none | A's NEAR balance matches the wallet (minus storage reserve) |
| 3 | **Token balance.** Any token A already holds, or USDC after step 4 | none | The amount matches the wallet and the explorer to the last digit |
| 4 | **Swap.** Swap 0.1 NEAR → USDC | 0.1 NEAR | The review shows the Rhea route, the minimum received, and a NearKit fee of 0.50% (0.0005 NEAR) split as NearKit 0.40% and Rhea 0.10%, plus Rhea's own 0.10% protocol fee and any storage. After signing it reads **Confirmed** with an explorer link, and the USDC balance rises by about the expected amount |
| 5 | **Quick Trade.** From the sidebar's Quick Trade, buy USDC with 0.05 NEAR | 0.05 NEAR | Same checks as step 4, fee 0.00025 NEAR |
| 6 | **Split.** Split 0.2 USDC from A to B and C, 50/50 | 0.2 USDC | The review says "NearKit fee: None on transfers" and lists any registration; B and C each receive exactly 0.1 USDC |
| 7 | **Batch Send.** Two lines: 0.01 NEAR to B, 0.01 NEAR to C | 0.02 NEAR | No NearKit fee; each recipient receives exactly 0.01 NEAR |
| 8 | **Consolidate.** Gather 0.1 USDC from B into A | 0.1 USDC | NearKit pauses and asks you to connect B for B's step; A receives exactly 0.1 USDC; no NearKit fee |
| 9 | **Scanner.** Scan `usdt.tether-token.near` | none | Facts carry VERIFIED, DERIVED or UNKNOWN labels, holders and supply load, and there is no SAFE/SCAM verdict |
| 10 | **Fee receipt.** See below | none | The fee account's balance on the aggregator grew by NearKit's share of steps 4–5 |
| 11 | **Rejection.** Start any send and reject it in the wallet | none | The modal says **Nothing was sent** |
| 12 | **Held back.** Open Multi Trade from COMING SOON | none | The page says COMING SOON and every field and key is disabled |

### Fee receipt verification (step 10)

1. **In NearKit:** each swap's result line reads "NearKit fee … wNEAR". NearKit takes it from the aggregator's `earn_app_fee` event in that transaction.
2. **On the explorer:** the swap transaction on nearblocks.io shows an `earn_app_fee` event whose `receipt` is your fee account.
3. **On chain:**

   ```bash
   near contract call-function as-read-only aggregatedex.near query_user_exist_balance json-args '{"user":"<fee account>","from_index":0,"count":50}' network-config mainnet now
   ```

   After steps 4 and 5, wNEAR (`wrap.near`) should have grown by about 0.0006 wNEAR: 0.40% of 0.15 NEAR. That is `600000000000000000000` in yocto. If the route took the fee in another whitelisted token, look for it there instead.
4. **Transfers:** the Split, Batch Send and Consolidate transactions on the explorer contain only `ft_transfer`, `storage_deposit` or plain NEAR transfers. Nothing goes to the fee account.

## Stop and report if

- any NearKit fee other than 0.50% appears, or a transfer shows a NearKit fee;
- anything reads **Confirmed** before the explorer shows the transaction;
- an amount or recipient on chain differs from the review;
- a COMING SOON feature lets you sign anything;
- a value-moving step logs a console error.

## After it passes

The public site stays on the testnet beta until you approve a mainnet deployment. That deployment needs `VITE_NEAR_NETWORK=mainnet`, `VITE_NEARKIT_FEE_RECIPIENT=<fee account>` and `VITE_ENABLE_MAINNET_EXECUTION=true` set on Vercel. Fees accrue on the aggregator; withdraw them with the commands in the README's operator tasks.
