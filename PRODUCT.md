# Product

<!-- impeccable:product-schema 1 -->

> Source: the user's Phase 1 brief (2026-09-28). No interview round was run because the brief answered the init questions and asked for plan → build without stopping. Facts marked *(inferred)* came from the brief's intent, not from an explicit statement.

## Platform

web

## Stack

React + TypeScript (strict) + Vite + Tailwind CSS, specified by the user. Vite 6 is pinned because the workstation runs Node 21.5 and Vite 7 needs Node 20.19+/22.12+. *(inferred)* React Router 7 for routing and TanStack Query for async state over service interfaces. Deploy target not decided.

## Users

Retail and semi-professional traders in the NEAR ecosystem. They run several wallets, trade fast-moving NEAR tokens (memecoins included), and currently piece together swaps, transfers and wallet housekeeping across separate tools. They come back many times a day, often with a position open, and they want to act in seconds. *(inferred)* Many will also use the future Telegram bot while away from a desk.

## Product Purpose

NearKit is an all-in-one trading terminal and wallet toolkit for NEAR, covering trading (swap, quick buy/sell, multi-wallet buy/sell, limit orders, take profit, stop loss), wallet tools (split, consolidate, batch send, wallet groups/presets), automation (DCA, copy trading, sniper), intelligence (token scanner, positions, PnL, wallet monitoring), and a Telegram bot on the same account.

Success for Phase 1: a polished, working frontend that shows the real product shape with mock services, built so Phase 2 can plug in NEAR execution without rewriting UI.

## Positioning

The one place on NEAR where multi-wallet execution and wallet housekeeping (split / consolidate / batch send over saved wallet groups) sit in the same terminal as trading, automation, and scanning. The app *is* the product: users open straight into useful data and actions, not a marketing page. NearKit is **not** a launchpad.

## Operating Context

- Desktop is the primary trading surface; mobile must be genuinely usable (drawer or bottom navigation, tables that collapse into rows/cards, trading actions reachable).
- Users compare prices, balances and PnL at a glance, so numbers must align and read as terminal output.
- The $KIT token launches separately through Nearly. NearKit links to it but does not host the launch.
- A Telegram bot on the same account will offer quick execution (`/buy`, `/sell`, `/positions`, `/split`, `/wallets`, `/orders`).

## Capabilities and Constraints

- **Phase 1 is UI/UX only.** No real NEAR transactions, smart contracts, Rhea or Nearly integration, private key handling, Telegram bot, swaps, or blockchain execution.
- The UI talks only to service interfaces (`TradingService`, `WalletService`, `TokenService`, `AutomationService`, plus portfolio/scanner as needed). Phase 1 ships mock implementations, and components must not know whether data comes from mocks or chain.
- NearKit fee: **0.50%** (50 bps) on Swap and Quick Trade on the web and on Buy and Sell in Telegram, shown on every trade surface and set once, in `NEARKIT_FEE` (`src/lib/fees.ts`). Of it NearKit receives 0.40% and Rhea's aggregator keeps 0.10%; Rhea's own protocol fee, pool fees and gas are separate. (0.10% from 2026-09-28 and 2.00% before that; 0.50% since 2026-09-29.) Split, Consolidate and Batch Send carry no NearKit fee. The future 2% buy and sell fee on $KIT belongs to its Nearly launch and is separate.
- Mock state may reset on refresh; persistence is not required.
- Terminology: Split = distribute one wallet's tokens to many; Consolidate = gather from many into one; Batch Send = many transfers from one list; Presets = saved wallet groups.

## Brand Commitments

- Name **NearKit**, token **$KIT**, tagline "The trading toolkit for NEAR."
- Must feel like a serious trader tool: Bloomberg-terminal simplicity + modern crypto terminal + clean developer tooling, high information density, still approachable for retail.
- Must not borrow the visual identity of Banana Gun, Maestro or Archery Tools (they inspire features only).
- Dark-first. One distinctive accent used sparingly for active / connected / positive / primary action. Red only for sell / loss / danger. No generic purple-blue Web3 look, no neon-gradient overload, no glassmorphism, no giant rounded cards or pills, no gimmick or pixel fonts.
- Wordmark is text-based (e.g. `NEAR/KIT`). No robots, lightning bolts, rockets, blockchain cubes, or AI sparkles.

## Evidence on Hand

None. There are no users, volumes, partners, endorsements, testimonials, token price, market cap, or supply figures. Every number in Phase 1 is demo data and must be labeled as such. Anything not live is marked **COMING SOON**. Never imply NEAR Foundation, Rhea, Nearly, or Telegram endorsement.

## Product Principles

1. **The terminal is the homepage.** First screen = portfolio, positions, and a trade ticket, not persuasion.
2. **Honest state over impressive state.** Demo data is labeled demo, unshipped features say COMING SOON, and nothing pretends to execute.
3. **Many wallets, one action.** Multi-wallet flows are first-class, not an advanced tab.
4. **Numbers are the interface.** Alignment, tabular figures, units and signs carry the design; decoration never competes with them.
5. **Swap-ready seams.** Every screen reaches data through a service interface so real execution drops in without UI rewrites.

## Accessibility & Inclusion

*(inferred)* WCAG 2.2 AA contrast for text on the dark ground; buy/sell and profit/loss never rely on color alone (signs, labels, arrows); full keyboard operation of tables, modals, and forms; honor `prefers-reduced-motion`.
