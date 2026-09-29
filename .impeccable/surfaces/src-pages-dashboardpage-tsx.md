---
version: 1
slug: "src-pages-dashboardpage-tsx"
primary_target: "src/pages/DashboardPage.tsx"
related_targets: ["src/layouts/AppShell.tsx","src/index.css"]
---

# NearKit app shell and dashboard (all Phase 1 routes share this world)

Scope: the whole NearKit web app. Visitor mode: **Operate**. Dashboard is the first surface; every other route inherits the shell and system.

Audience and job: NEAR traders who run several wallets and come back many times a day to read positions and act in seconds. Task surfaces: trade ticket, multi-wallet fan-out, split / consolidate / batch send, automation rules, scanner. Constraints: Phase 1 is UI only. Mock services behind interfaces, demo data labeled, unshipped features marked COMING SOON, NearKit fee 0.50% on every trade surface.

Build path: code-led (no comp round). Direction round not presented interactively because the user's brief pinned the palette, layout and tone and asked for a straight plan → build run. The roll's assignment governs the dimensions the brief left open.

## Direction contract

THESIS: NearKit is a measuring instrument for your wallets. Every screen is a front panel of fixed readouts, labeled controls and armed states. It refuses the category default of glassy KPI cards, gradient area charts and a marketing hero.

OWN-WORLD: A graphite bezel: near-black ground, panels one step lighter, hairline neutral borders. Phosphor-lime is the only lit color (active, connected, positive, primary). Signal red is reserved for sell, loss and danger, and muted amber for caution flags only. Archivo semi-condensed sets legends and labels; group legends are silkscreen-style, bracketed by a hairline. JetBrains Mono sets every number, and every number carries its unit. Square LED indicators mark state (lit, idle outline, fault red). Readout strips use fixed slots, never card grids. Charts sit on graticules. Radii are 2–4px, on a strict 4px grid with 32px controls and 36px rows.

STORY: A trader opens NearKit and reads their portfolio as instrument readouts, scans positions, and fires a trade from the ticket without leaving the page. Tools fan one instruction across many wallets and show the allocation before anything happens. Anything not live says so plainly.

FIRST VIEWPORT: At 1440 the viewport holds a 224px sidebar with bracketed group legends, a 48px top bar (search, NEAR price, network LED, wallet), and a full-width readout strip of five fixed slots (portfolio value with a 7d trace, 24h PnL, available NEAR, active positions, open orders). Below it, a dense sortable positions table and the portfolio trace sit on the left, with a 360px Quick Trade ticket on the right (buy/sell, token, amount, 25/50/75/MAX, slippage, expected output, NearKit fee 0.50%). The primary action is the ticket's BUY/SELL button, above the fold at top right.

FORM: Oscilloscope / test-instrument front panel, candidate 6 of 7 on the ordered list, seed key c4c2d057. Signature interaction: the PnL trace has two draggable measurement cursors (A/B) that read ΔPnL, Δ% and Δt like scope cursors, and are keyboard operable. Raises:
- eBoy: one hard grid shared by every object.
- Depot blind: data freshness is visible (quote age, stale values thin out).
- Seven-segment: absence is designed (ghost zeros, slots that never shift).
- Alphabet storm: search parses what you type (contract → scan, symbol → token, / → command).
- Tensegrity: allocations show their balance state (under, balanced, over, invalid).
- Yé-yé sleeve: secondary info appears as small ranked blocks, never card grids.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance

## Unresolved

- Deploy target and repository not decided (not requested).
- Real token metadata, fee routing and wallet-connection method arrive in Phase 2.
