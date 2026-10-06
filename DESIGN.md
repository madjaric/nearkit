---
name: NEARKITS
description: The trading toolkit for NEAR, drawn as a dark, dense trading terminal.
colors:
  well: "oklch(0.122 0.006 250)"
  canvas: "oklch(0.145 0.006 250)"
  panel: "oklch(0.18 0.007 250)"
  raised: "oklch(0.225 0.008 250)"
  hover: "oklch(0.255 0.009 250)"
  line-soft: "oklch(0.235 0.008 250)"
  line: "oklch(0.28 0.009 250)"
  line-strong: "oklch(0.37 0.01 250)"
  fg: "oklch(0.965 0.004 250)"
  fg-2: "oklch(0.79 0.006 250)"
  fg-3: "oklch(0.64 0.008 250)"
  fg-4: "oklch(0.49 0.008 250)"
  accent: "oklch(0.905 0.19 124)"
  accent-hi: "oklch(0.94 0.16 124)"
  accent-ink: "oklch(0.19 0.035 124)"
  pos: "oklch(0.875 0.175 126)"
  neg: "oklch(0.7 0.185 27)"
  neg-solid: "oklch(0.665 0.2 27)"
  neg-hi: "oklch(0.72 0.19 27)"
  neg-ink: "oklch(0.18 0.04 27)"
  warn: "oklch(0.83 0.13 78)"
  chart-pos: "oklch(0.78 0.17 127)"
  chart-neg: "oklch(0.64 0.19 27)"
typography:
  display:
    fontFamily: "'JetBrains Mono Variable', ui-monospace, 'SFMono-Regular', Menlo, Consolas, monospace"
    fontSize: "1.75rem"
    fontWeight: 400
    lineHeight: "2.125rem"
    letterSpacing: "-0.012em"
    fontFeature: "'tnum' 1, 'calt' 0"
  readout:
    fontFamily: "'JetBrains Mono Variable', ui-monospace, 'SFMono-Regular', Menlo, Consolas, monospace"
    fontSize: "1.375rem"
    fontWeight: 400
    lineHeight: "1.75rem"
    letterSpacing: "-0.012em"
    fontFeature: "'tnum' 1, 'calt' 0"
  headline:
    fontFamily: "'Archivo Variable', ui-sans-serif, system-ui, sans-serif"
    fontSize: "1.125rem"
    fontWeight: 650
    lineHeight: "1.75rem"
    fontVariation: "'wdth' 110"
  title:
    fontFamily: "'Archivo Variable', ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.75rem"
    fontWeight: 600
    lineHeight: "1rem"
    letterSpacing: "0.08em"
    fontVariation: "'wdth' 88"
  body:
    fontFamily: "'Archivo Variable', ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.8125rem"
    fontWeight: 400
    lineHeight: "1.25rem"
    fontVariation: "'wdth' 94"
  body-num:
    fontFamily: "'JetBrains Mono Variable', ui-monospace, 'SFMono-Regular', Menlo, Consolas, monospace"
    fontSize: "0.8125rem"
    fontWeight: 400
    lineHeight: "1.25rem"
    letterSpacing: "-0.012em"
    fontFeature: "'tnum' 1, 'calt' 0"
  label:
    fontFamily: "'Archivo Variable', ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.6875rem"
    fontWeight: 560
    lineHeight: "1rem"
    letterSpacing: "0.08em"
    fontVariation: "'wdth' 88"
  keycap:
    fontFamily: "'Archivo Variable', ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.75rem"
    fontWeight: 650
    lineHeight: "1rem"
    letterSpacing: "0.045em"
    fontVariation: "'wdth' 90"
rounded:
  xs: "4px"
  sm: "6px"
  md: "8px"
  lg: "10px"
  xl: "12px"
  full: "9999px"
spacing:
  hair: "1px"
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "16px"
  xl: "24px"
components:
  button-primary:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.accent-ink}"
    typography: "{typography.keycap}"
    rounded: "{rounded.sm}"
    padding: "0 12px"
    height: "32px"
  button-primary-hover:
    backgroundColor: "{colors.accent-hi}"
    textColor: "{colors.accent-ink}"
  button-primary-disabled:
    backgroundColor: "{colors.raised}"
    textColor: "{colors.fg-3}"
  button-fire:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.accent-ink}"
    typography: "{typography.keycap}"
    rounded: "{rounded.sm}"
    padding: "0 16px"
    height: "40px"
    width: "100%"
  button-sell:
    backgroundColor: "{colors.neg-solid}"
    textColor: "{colors.neg-ink}"
    typography: "{typography.keycap}"
    rounded: "{rounded.sm}"
    padding: "0 12px"
    height: "32px"
  button-sell-hover:
    backgroundColor: "{colors.neg-hi}"
    textColor: "{colors.neg-ink}"
  button-secondary:
    backgroundColor: "{colors.raised}"
    textColor: "{colors.fg}"
    typography: "{typography.keycap}"
    rounded: "{rounded.sm}"
    padding: "0 12px"
    height: "32px"
  button-secondary-hover:
    backgroundColor: "{colors.hover}"
  button-ghost:
    textColor: "{colors.fg-2}"
    typography: "{typography.keycap}"
    rounded: "{rounded.sm}"
    padding: "0 12px"
    height: "32px"
  button-quiet-buy:
    textColor: "{colors.fg-2}"
    typography: "{typography.keycap}"
    rounded: "{rounded.sm}"
    padding: "0 10px"
    height: "28px"
  button-quiet-buy-hover:
    textColor: "{colors.accent}"
  button-quiet-sell-hover:
    textColor: "{colors.neg}"
  input:
    backgroundColor: "{colors.well}"
    textColor: "{colors.fg}"
    typography: "{typography.body}"
    rounded: "{rounded.sm}"
    padding: "0 12px"
    height: "36px"
  input-sm:
    backgroundColor: "{colors.well}"
    textColor: "{colors.fg}"
    rounded: "{rounded.sm}"
    padding: "0 10px"
    height: "32px"
  panel:
    backgroundColor: "{colors.panel}"
    rounded: "{rounded.md}"
  panel-header:
    textColor: "{colors.fg-2}"
    typography: "{typography.title}"
    padding: "8px 16px"
    height: "44px"
  readout-strip:
    backgroundColor: "{colors.line-soft}"
    rounded: "{rounded.md}"
  readout-slot:
    backgroundColor: "{colors.panel}"
    textColor: "{colors.fg}"
    typography: "{typography.readout}"
    padding: "12px 16px"
  table-header:
    textColor: "{colors.fg-3}"
    typography: "{typography.label}"
    padding: "0 12px"
    height: "36px"
  table-row:
    textColor: "{colors.fg}"
    typography: "{typography.body}"
    padding: "0 12px"
    height: "36px"
  table-row-double:
    textColor: "{colors.fg}"
    typography: "{typography.body}"
    padding: "0 12px"
    height: "44px"
  table-row-hover:
    backgroundColor: "{colors.raised}"
  tag:
    textColor: "{colors.fg-2}"
    rounded: "{rounded.xs}"
    padding: "0 6px"
    height: "18px"
  tag-accent:
    textColor: "{colors.accent}"
  tag-soon:
    textColor: "{colors.fg-2}"
    rounded: "{rounded.xs}"
    padding: "0 6px"
    height: "18px"
  sim-mark:
    textColor: "{colors.fg-3}"
    rounded: "{rounded.xs}"
    padding: "0 3px"
    height: "14px"
  led:
    backgroundColor: "{colors.accent}"
    rounded: "1px"
    size: "6px"
  nav-item:
    textColor: "{colors.fg-2}"
    typography: "{typography.body}"
    rounded: "{rounded.sm}"
    padding: "0 8px"
    height: "32px"
  nav-item-active:
    backgroundColor: "{colors.raised}"
    textColor: "{colors.fg}"
  tab-bar:
    backgroundColor: "{colors.well}"
    height: "56px"
---

# Design System: NEARKITS

## Overview

> **Direction of record (2026-10-02): the Dashboard reference.** The owner's Dashboard reference is the source of
> truth for the whole app: a professional trading terminal, dark and technical, never a glossy Web3 page. Where
> the older text below disagrees, this block wins.
>
> - **Ground:** near-black, slightly cool neutrals (hue 250): `canvas` for the page, sidebar and top bar, `panel`
>   for modules, `well` for fields. Thin low-contrast borders; no shadows at rest; no glow.
> - **One lit color:** lime for the primary action, the active state and gains. Red only for sell, loss, danger.
>   Amber only for caution (view-only, stale, a review before signing on mainnet). Row-level BUY keys carry the
>   lime text at rest; SELL lights red on hover. The network tag is lime in the top bar's chip only; a page's own
>   network or data tag is neutral.
> - **Type:** page title 28px bold; stat values 28-32px mono; panel names 12px uppercase mono after a chevron;
>   table heads and group labels in the small uppercase legend; body 14px, tables 13px. Mono only for figures,
>   addresses and hashes.
> - **Shape:** 4px tags, 6px small keys and nav items, 8px keys and fields, 10px panels and stat cards, 12px
>   dialogs. Status dots and token glyphs are round.
> - **Stats are cards** (`ReadoutStrip` / `ReadoutSlot`): a plain label, a large mono value, a caption, an icon
>   or sparkline at the edge. They sit on the page, like the Dashboard's. Inside a panel the same slots are
>   flat cells divided by hairlines (`inset`): never cards inside a card. The value sizes to its slot (a share of
>   the slot's width, between 18px and the display size), so a figure of up to eleven characters fits at any
>   width; a unit or a sparkline prints only when it fits beside the value.
> - **Keys:** 28 / 32 / 36 / 40 / 52px (`xs` to `xl`); the ticket's fire key is `xl`. Segmented BUY / SELL fill
>   solid lime / red when selected. Fire keys keep a constant label; the blocking reason prints below.
> - **Fields:** 40px (36px small) on `well`; the amount field of a ticket is 64px with a 32px mono figure and its
>   unit inside. Where the unit is a choice (Swap), a token chip sits inside the field. The figure shrinks as it
>   grows, so it is never cut off. Preset keys (25 / 50 / 75 / MAX, slippage) are separate 36px bordered keys.
> - **Tables fit their own box.** Columns drop out as the table's panel narrows (measured against the panel, not
>   the window) and, below the last tier, the rows print as a card list holding every figure. A table scrolls its
>   panel sideways only where it has no card list (documentation tables).
> - **Shell:** 232px sidebar (40px items, a lime bar and raised ground on the active one, plain uppercase group
>   labels, the version in its footer), 64px top bar (40px search, ticker, network chip, wallet chip), 64px
>   phone tab bar. On a phone the Connect key is 36px, the account chip truncates rather than widening the
>   page, and the strip under the bar prints the ticker and the network flat. Nothing overflows at 360px.
> - **Page head:** title, status tag, one line of context, and the page's actions at right; the Dashboard's are
>   BUY, SELL, SEND and MULTI BUY.
> - **Charts:** a lime trace on the graticule with a faint fill fading to the panel (20% to 0). Candles and
>   points are only ever observed data. The time axis prints the time of day for a window within a day and the
>   date beyond it; its inner labels drop out where the plot is too narrow for all of them.

**Creative North Star: "The Wallet Oscilloscope"**

NearKit is drawn as a measuring instrument for your wallets. Every screen is a front panel: fixed readouts, silkscreened labels, square status lamps and armed keys, mounted on a graphite bezel. The build rejects the category's default dashboard look. It has no glassy KPI cards, no gradient area charts and no marketing hero. Portfolio figures sit in a readout strip of fixed slots separated by hairlines. Charts are traces on a scope graticule, measured with A/B cursors.

The panel is dense and quiet. Surfaces step up in lightness by about 0.03 L each (well, canvas, panel, raised) at a warm-neutral hue of 115 with almost no chroma, and hairlines do the separating. One color is lit: phosphor lime. When something glows, it is active, connected, positive, or the action you are about to fire. Signal red is kept for sell, loss and danger, and muted amber only flags caution or staleness. Numbers are the interface. Every figure is set in tabular JetBrains Mono, and the words around it stay in semi-condensed Archivo.

The product runs on demo data, and the panel says so in its own vocabulary. It uses a DEMO tag on the network chip, dashed COMING SOON tags, dashed SIM marks on pre-launch figures, and freshness ages that turn amber when a value goes stale.

**Key Characteristics:**
- A graphite bezel with one lit color (phosphor lime); red only for sell, loss and danger.
- Mono for every figure, sans for every word, even inside a single caption.
- Readout strips with fixed slots and 1px rules, never card grids.
- Square LED lamps, silkscreen legends and bracketed panel heads.
- Charts on a 10-division oscilloscope graticule with keyboard-operable A/B cursors.
- Visible freshness: quote drain bars, "Ns" ages, amber "stale" after 20s.
- Honest state marks: DEMO, SIM, COMING SOON, "Simulation only".

## Colors

A near-achromatic graphite ramp (hue 115) carries one saturated lime and one signal red.

### Primary
- **Phosphor Lime** (`accent`): the only lit color. It fills the primary key and the active BUY segment, lights LEDs for connected and current page, runs the scan bar on route loads, draws the focus outline and the input caret, and tints the selection highlight at 28% alpha. **Lime Glare** (`accent-hi`) is its hover state. **Lime Ink** (`accent-ink`) is the dark text set on a lime fill.
- **Positive Phosphor** (`pos`): text for gains, a touch deeper than the accent so a positive figure reads as data, not as a control.

### Secondary
- **Signal Red** (`neg`): loss figures, field errors, fault LEDs, the over-allocated segment, and danger hover. **Solid Red** (`neg-solid`) fills the SELL key, with **Red Glare** (`neg-hi`) on hover and **Red Ink** (`neg-ink`) as the label on it.

### Tertiary
- **Caution Amber** (`warn`): the caution LED, field warnings, the under-allocated state and the "stale" freshness age. It is never decorative.

### Neutral
- **Well** (`well`): the deepest ground, used for the sidebar, the phone tab bar, the status strip, input fields and the allocation-bar trough.
- **Canvas** (`canvas`): the page ground and the top bar.
- **Panel** (`panel`): every module surface and readout slot.
- **Raised** (`raised`): secondary keys, the active nav item, row hover (at 50%), skeletons and token glyph tiles.
- **Hover** (`hover`): the hover state of the secondary key.
- **Hairlines**: `line-soft` for internal rules, row dividers, graticule and readout-strip gaps; `line` for panel borders and table-head rules; `line-strong` for input borders, bracket corners, the graticule baseline and scrollbars.
- **Text ramp**: `fg` for primary values, `fg-2` for secondary text and panel titles, `fg-3` for legends, captions, units and placeholders, `fg-4` for ghost zeros, idle LEDs and dashed outlines.
- **Chart poles** (`chart-pos`, `chart-neg`): stroke and fill for chart polarity only. They were validated for deutan separation and at least 3:1 contrast on the panel. Text keeps `pos` and `neg`.

### Named Rules
**The One Lit Color Rule.** Lime means active, connected, positive or primary action, and nothing else. Row-level BUY/SELL keys stay neutral until hover or focus, so the lamp keeps its meaning.

**The Signal Red Rule.** Red appears only for sell, loss, danger and errors. It is never an accent or a highlight.

**The Cleared Palette Rule.** The default Tailwind palette is cleared (`--color-*: initial`). Every color on screen comes from these tokens.

## Typography

**Display Font:** JetBrains Mono Variable (with ui-monospace, SFMono-Regular, Menlo, Consolas)
**Body Font:** Archivo Variable, width axis (with ui-sans-serif, system-ui)
**Label/Mono Font:** JetBrains Mono for figures; Archivo at 88–90% width for legends and keycaps.

**Character:** a condensed, engineered grotesque that labels a precise tabular mono, like printing on an instrument beside its readouts. Body text is set at 94% width. Legends are narrower at 88%, and the page title and wordmark widen (110% and 118%) to act as a nameplate.

### Hierarchy
- **Display** (mono 400, 28px/34px): the lead readout value (portfolio value) from `sm` up. It drops to 22px on phones.
- **Readout** (mono 400, 22px/28px): other readout slot values from `sm` up; 18px on phones.
- **Headline** (Archivo 650, 18px/28px, width 110%): the page title in the page header, one per route.
- **Title** (Archivo 600, 12px, uppercase, 0.08em, width 88%): panel-head titles after the corner bracket.
- **Body** (Archivo 400, 13px/20px, width 94%): the base UI text. Page-header descriptions are capped at 70ch.
- **Label / legend** (Archivo 560, 11px/16px, uppercase, 0.08em, width 88%, `fg-3`): silkscreen legends above readouts, control groups and table heads.
- **Keycap** (Archivo 650, 12px, uppercase, 0.045em, width 90%): the label on every button.
- **Scale**: 11 / 12 / 13 / 14 / 16 / 18 / 22 / 28px. The default Tailwind text scale is cleared.

### Named Rules
**The Figures Rule.** JetBrains Mono (tabular, `calt` off, −0.012em) sets every figure, and Archivo sets the words around it, even inside one caption. A figure is the number plus everything bound to it: sign, ≈, $, thousands separators, decimals, K/M/B/T magnitude, %, a ticker unit of three or more capitals written after the number ("850 SHITZU"), durations ("2h 15m"), dates and times ("Sep 25, 11:59") and counts. "TP" and "SL" stay words, and digits inside ids ("w01") are left alone. The rule is implemented once, in `splitFigures` (src/lib/figures.ts, covered by tests) rendered by `Figures`. It is applied centrally in readout sub-lines, panel-head meta, summary Line labels and values, field messages, page-header descriptions, empty-state bodies and toasts. New caption surfaces route through `Figures`; they do not hand-split.

**The Display Unit Rule.** At display size the unit leaves the figure. In readout values and the `Amount` component, the unit is a smaller (0.86em or 14px), medium-weight sans label in `fg-3` beside the mono value ("11,490.28 NEAR").

**The Toned Figure Rule.** When a caption carries tone, only the figure takes the pos/neg color ("**+0.69%** vs 24h ago", "Unrealized **+$3,961.59**"). The words stay in the caption color.

## Layout

The layout is a strict 4px grid with hairline separation. Page gutters are 16px (24px from `lg`), module gaps are 16px, panel bodies are padded 16px, and panel heads have a 44px minimum height.

- **Shell (from `lg`, 1024px):** a sticky 224px sidebar on the `well` ground with bracketed group legends, and a sticky 48px top bar holding search (max 420px), NEAR/USD ticker with age, the network chip and the wallet chip. A 1px lime scan bar runs under the top bar while a route loads.
- **Context column (from `xl`, 1280px):** `PageGrid` sets main content beside a right aside, 360px by default and 372px for the dashboard's Quick Trade ticket, which is sticky at 64px from the top. Below `xl` the aside stacks, first on the dashboard so the ticket leads.
- **Readout strip:** 2 columns on phones, 3 at `md`, 5 at `xl` on the dashboard; the lead slot spans both phone columns.
- **Controls:** keys are 24/28/32/40px (xs/sm/md/lg). Fields are 32px (sm) or 36px (md). Nav items are 32px and table heads 36px. Table body rows are 36px, or 44px when the table declares two-line cells.
- **Phone (under `sm`, 640px):** the top bar carries the wordmark only (the square mark is hidden below `sm`), search as an icon, and the wallet chip with the full account; long names are middle-truncated at 20 characters. A 36px status strip on the `well` ground sits under the top bar with NEAR/USD plus its age and the NEAR · DEMO chip. Below `lg`, a fixed 56px bottom tab bar (Home, Trade, Multi, Positions, Menu) and a left drawer replace the sidebar, and main content reserves the tab bar's height plus the safe-area inset.
- **Tables** scroll horizontally inside their panel and never widen the page. On phones, positions collapse into ranked row blocks with legend/value pairs and full-width BUY/SELL keys.

## Elevation & Depth

Depth comes from tone: well, canvas, panel and raised, separated by hairlines. Surfaces at rest have no shadow. Shadows appear only on things that float above the panel.

### Shadow Vocabulary
- **Pop** (`box-shadow: 0 12px 32px -8px oklch(0 0 0 / 0.7), 0 2px 6px oklch(0 0 0 / 0.45)`): menus, tooltips, dialogs, toasts and chart hover readouts.
- **Sheet** (`box-shadow: 0 -8px 32px -12px oklch(0 0 0 / 0.8)`): bottom sheets rising from the phone edge.
- Dialog backdrop: `oklch(0.08 0.004 115 / 0.72)`.

### Named Rules
**The Flat Panel Rule.** Modules never cast shadows and are never nested inside another bordered panel. Depth on the panel face is tonal; shadow is only for floating layers.

## Shapes

The panel is machined, not soft. Corners are 2px (`xs`: tags, SIM marks, kbd, allocation bar), 3px (`sm`: keys, fields, nav items, token tiles) and 4px (`md`: panels and readout strips). 6px (`lg`) appears only on the scrollbar thumb. LEDs are squares with 1px corners. `full` is reserved for true circles such as chart cursor dots, never for pills. Borders are 1px hairlines. Dashed 1px outlines mean "not real yet": COMING SOON tags and SIM marks. Panel heads open with a small corner bracket (a 6×8px top-left L in `line-strong`), and group legends are followed by a hairline that runs to the edge.

## Components

### Buttons
Every button is a key: uppercase keycap type, one 3px shape, and color changes only on interaction (150ms).
- **Shape:** gently squared (3px).
- **Primary:** lime fill with lime-ink label, 32px (md) or 40px (lg, full width for fire keys). Hover goes to Lime Glare. Disabled uses the raised surface with `fg-3` text.
- **Sell:** solid red with red-ink label, Red Glare on hover.
- **Secondary / Ghost / Outline / Danger:** secondary is raised with a `line` border; ghost is text-only in `fg-2`; outline is a lime border at 45% with lime text; danger is a neutral border with red text that tints red on hover.
- **Quiet row keys (quiet-buy / quiet-sell):** 28px, hairline border, `fg-2` text. They light lime or red only on hover or focus.
- **Loading:** three 4px square dots pulsing (ghost animation) instead of a spinner.
- **Focus:** a 2px lime outline at 2px offset, globally.

### Fire Keys
- **Constant label:** a primary action key always names its action: "Buy BLACKDRAGON", "Execute multi buy", "Create DCA". It never becomes "Enter an amount" or "Insufficient NEAR".
- **Blocked state:** the key is disabled, and the blocking reason prints directly below it as a 12px `fg-3` line, never as its label. This holds on every ticket and form: Quick Trade, Swap (through Figures, via `ArmStatus`), Multi Trade, limit orders and DCA.
- **Touched invalid input:** the reason line turns red (`neg`) only when it reports an invalid input the user has already touched. On Copy Trade and Sniper the key stays live until the first submit attempt (or, on Copy Trade, leaving the target field). After that the reason prints in red and the key disables until the input is valid.
- **Arm and confirm:** when the `twoStepConfirm` setting is on (the default), the first press arms the key. The label becomes "Confirm buy …", and a thin drain bar in the side's color replaces the reason line, reading "Armed. Press again to confirm" with a Cancel link. With the setting off, one press executes.
- **Execution note:** the standing note under the reason line follows the build. In the demo it reads "Simulation only. Nothing is signed or sent in demo mode." (off LED); on a network, "You sign in your wallet; NearKit confirms the result on NEAR testnet." (lit LED); when this build can't sign, the reason in amber (amber LED).

### Chips and Tags
- **Style:** 18px, 2px corners, 10.5px uppercase semibold at 0.07em. Neutral (hairline), accent (lime at 12%), neg (red at 14%), warn (amber at 14%) and solid (raised).
- **COMING SOON:** a dashed `fg-4` outline marks anything not live.
- **Held back in the public beta:**
  - Features the testnet beta doesn't ship yet (`src/config/release.ts`) keep their sidebar entry with the same dashed SOON tag.
  - Their page swaps its status tag for COMING SOON, with a dashed-outline notice under the header.
  - The page body renders read-only: every field and key is disabled, and the execution note reads "Coming soon."
  - This applies to every production build of the real services, on testnet and mainnet, so development and tests keep the features usable.
- **Network chip:** a 32px hairline chip with an LED, "NEAR" and the network tag: DEMO (idle LED), TESTNET BETA (lit, neutral tag; the public testnet build) or MAINNET (lit, amber tag, because real funds move). When the build can't sign it adds a dashed VIEW ONLY tag and an amber LED. The tooltip says which. The sidebar status line repeats the network name ("NEAR testnet beta · live").
- **Page status tags:** tools that move value carry `ExecutionTag` (EXECUTION SIMULATED, TESTNET, MAINNET, or "{network} · VIEW ONLY" in amber); data pages carry `DataTag` (DEMO DATA or TESTNET DATA). Automation pages say DRAFTS ONLY in real mode.
- **Watch tag:** accounts added by ID carry a dashed WATCH tag in wallet lists; they show balances and can receive, and never sign.

### SIM Mark
A 14px dashed-outline "sim" micro-label (9px uppercase, `fg-3`) placed after every $KIT price, entry, market and exit figure. It is focusable and carries a tooltip disclosure ("Simulated figure. $KIT has not launched, so it has no market price."). The $KIT page prints "Published at launch" in place of price, market cap and supply and shows no figures for them.

### Cards / Containers (Panels)
- **Corner Style:** 4px.
- **Background:** `panel` with a 1px `line` border.
- **Shadow Strategy:** none (see Elevation).
- **Head:** min 44px, bottom rule in `line-soft`, corner bracket plus title, meta in `fg-3` routed through Figures, actions right-aligned.
- **Internal Padding:** 16px.
- **Summary lines:** label left in `fg-3`, measurement right in `fg-2`, both routed through Figures.

### Readout Strip
Fixed-slot measurement strip. The strip ground is `line-soft` and slots sit on it with a 1px gap, so slots are separated by 1px rules. Each slot has a legend (with an optional freshness age at right), a mono value that truncates rather than reflowing, and one caption line with a fixed 16px minimum height. Absent values are ghost zeros in `fg-4` ("$0.00"), so slots never shift.

### Tables
- **Head:** 36px, legend type, `line` bottom rule. Sortable heads are legend buttons with 11px sort arrows.
- **Rows:** 36px body rows; 44px when a cell carries a second line; the table declares it (`rows="double"` on `Table`). Double tables stack a value over a 12px `fg-3` sub-line (symbol over name, amount over wallet, figure over %): Positions, Open orders and Order history, Multi Trade wallets, Consolidate source wallets, Swap balances by wallet, and PnL by token and recent closed trades. Every other data table stays single at 36px. Editable input lists, such as Split recipients, are not data tables and follow field sizing.
- **Rows, shared:** `line-soft` dividers, row hover at `raised` 50% (100ms), numeric columns right-aligned mono.

### Inputs / Fields
- **Style:** `well` fill, 1px `line-strong` border, 3px corners, 36px (md) or 32px (sm). Number fields have no native spinners; values are typed or set by preset keys (25/50/75/MAX).
- **Focus:** the border turns lime with a 2px lime ring at 20%.
- **Error / Disabled:** an invalid field gets a red border and ring. A field shows one message line below it, in red for errors, amber for warnings and `fg-3` for hints, routed through Figures. Disabled fields drop to 50% opacity.

### Navigation
- **Sidebar:** 224px on `well`. Group legends open with the corner bracket. Items are 32px with a 16px line icon: active is `raised` with `fg` text, a lime icon and a lit LED at right; inactive is `fg-2`. Unshipped entries carry a SOON tag.
  - **Order:** live features come first, in their groups (Trade, Tools, Portfolio, Intelligence); a group left empty is hidden. Every entry that is not live in the build sits in one COMING SOON group at the end, above Settings and Documentation.
  - **Quick Trade:** it has no page of its own. Its entry opens the Quick Trade ticket over the current page, on the default trade token.
  - **Phone:** the drawer mirrors the sidebar, and a held-back tab moves after the live tabs in the tab bar.
- **Top bar:** 48px on `canvas` (see Layout).
- **Phone:** a 56px tab bar with 18px icons and 11px labels. The active tab has a lime icon, `fg` label and an LED at the icon's corner. The drawer slides from the left in 240ms.

### LED Lamps
Square status lamps, 6px or 8px, with 1px corners. On is lime (active/connected), off is a `fg-4` outline, fault is red, caution is amber and idle is solid `fg-4`. A labelled LED is exposed as an image with an aria-label.

### Transaction Lifecycle
Every value-moving action opens the same review modal (`OperationModal`): a plan review (network tag, signer, amounts, recipients, storage deposits, "Gas bought upfront (mostly refunded)" rounded up and prefixed ≈, the NearKit fee with its split, warnings in an amber box) and a constant fire key. After signing, each transaction is a row with a status lamp: SIGN IN WALLET (amber), SUBMITTED (idle), CONFIRMING (lit), CONFIRMED (lit), FAILED (red), UNKNOWN (amber) and NOT SENT (off), plus the short hash, an Explorer link and the outcome note. The headline states the truth ("Confirmed", "Nothing was sent", "Outcome not confirmed", "Quote expired"); nothing reads as confirmed before the chain says so. Technical detail sits behind a "Technical details" disclosure.

### Provenance Lamps (Scanner)
Each scanner figure carries its provenance as an LED plus a word: VERIFIED (lit; read from chain by NearKit), DERIVED (idle; from an indexer or price feed) and UNKNOWN (off; public data can't say, value printed as "Unknown" in `fg-4`). The source ("RPC · ft_total_supply", "NearBlocks indexer") follows in 11px `fg-4`. Observations use the risk-flag row (ELEVATED amber, INFO neutral tags); there is no verdict.

### Wallet Picker
The connect modal lists the wallets NEAR Connect offers for the network as 48px rows: a neutral monogram keycap (no vendor logos), name, a one-line description, an EXTENSION tag for injected wallets and "Connect" at right. A pending row reads "Waiting for wallet…". Errors sit in a red box below the list, with the rejection case phrased as "You closed or rejected the request in the wallet." A standing line says NearKit never asks for a seed phrase or private key.

### Configuration Error
An invalid build configuration replaces the whole app with a single centered panel: the wordmark, a red "Configuration error" legend, and one row per problem (the variable in mono, the message in `fg-2`). Nothing loads behind it.

### Freshness
- **Ages:** "Ns" in 11px mono `fg-4`. After 20s the age becomes the word "stale" in amber.
- **Quote drain bar:** a thin `fg-3` bar that scales from full to empty (linear) across the quote's lifetime, next to a countdown in seconds. At expiry it reads "refreshing".
- **Price ticks:** a changed price flashes lime (up) or red (down) and settles to `fg` over 900ms.

### AllocationBar
A 10px `well` trough with 1px-gapped segments per wallet, alternating between two strengths. It has four balance states, each named in text with an LED: **Balanced** (lime segments, on LED), **Under-allocated** (neutral segments, amber LED), **Over-allocated** (red overflow segment, red LED) and **Invalid value** (red LED).

### Scope Charts
- **Geometry:** CSS-driven. x is a percentage of the plot box and y is pixels in a fixed-height plot. SVG draws in a 1000-wide viewBox stretched with `preserveAspectRatio="none"` and non-scaling strokes. Dots, labels and cursors are HTML placed by percentage, so a resize never desyncs marks from axes.
- **Graticule:** 10 major divisions in `line-soft`, value-tick rules, the baseline in `line-strong` with 5 minor ticks per division, and right-hand mono tick labels at 10.5px.
- **Cursors:** A/B measurement cursors with square lettered flags read the A value, the B value and Δ (value and %) in mono above the plot. They are keyboard-operable: arrows, Shift = 7 steps, PageUp/PageDown = 7, Home/End.
- **Scale readout:** reads "{value}/div · {time}/div" (e.g. "$5K/div · 16h/div").

## Do's and Don'ts

### Do:
- **Do** set every figure in mono through `Figures` / `splitFigures`, and keep the words around it in Archivo.
- **Do** keep lime for active, connected, positive and primary action only, and red for sell, loss, danger and errors only.
- **Do** put readouts in fixed-slot strips with 1px rules and ghost zeros in `fg-4` for absent values.
- **Do** keep fire-key labels constant and print the blocking reason on a line below the key.
- **Do** set table body rows at 36px, and declare `rows="double"` for 44px only when a cell carries a second line.
- **Do** mark every $KIT price, entry, market and exit figure with the dashed SIM mark, and mark unshipped features with the dashed COMING SOON tag.
- **Do** show freshness on live values: "Ns" ages, amber "stale" after 20s, and a drain bar on quotes.
- **Do** draw charts as traces on the 10-division graticule with the "/div" scale readout.
- **Do** keep corners at 2–4px and panels flat, with shadows only on floating layers.
- **Do** make every real-mode figure say how it is known: "—" or "Unknown" with a reason when a value doesn't exist (no USD on testnet, PnL not tracked), never a zero that looks measured.
- **Do** let wallet prompts sit above NearKit: dialogs step out of the top layer while NEAR Connect's popup is visible.

### Don't:
- **Don't** light row-level BUY/SELL keys at rest; they stay neutral until hover or focus.
- **Don't** tint a whole toned caption; only the figure takes pos or neg.
- **Don't** replace a fire key's label with its blocking reason.
- **Don't** use KPI card grids, gradient area fills, glassmorphism or pill-shaped controls.
- **Don't** show a price, supply or market cap for $KIT before launch.
- **Don't** print SAFE, SCAM or any verdict in the scanner, or claim NearKit receives the full 0.50% fee (Rhea's aggregator keeps 0.10% of it).
- **Don't** nest a bordered panel inside another panel.
- **Don't** introduce colors outside the token set; the default palette is cleared.
