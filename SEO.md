# NEARKITS: search and AI visibility

The SEO plan of record. Business: a trading toolkit (SaaS-style web app plus Telegram bot) for the NEAR
blockchain. Language: English (`lang="en"`), one locale, no hreflang. Not a local business. Canonical
domain: **https://nearkits.com** (nearkit.vercel.app is kept as a fallback host; every page names
nearkits.com as its canonical address).

## Pages and their intent

| Path | Intent | Indexed | Served as |
|------|--------|---------|-----------|
| `/` | Brand / what NEARKITS is | yes | `index.html` (own head, app renders) |
| `/swap`, `/multi-trade`, `/split`, `/consolidate`, `/batch-send`, `/scanner` | Tool ("swap NEAR tokens", "multi-wallet NEAR trading", …) | yes | `<path>.html` (own head + `<noscript>` summary) |
| `/volume-bot` | "NEAR trading bot", "market making on NEAR" | yes | `volume-bot.html`: whole page prerendered, no script |
| `/kit` | The $KIT token (not launched: no price, contract or supply claimed) | yes | `kit.html` |
| `/telegram`, `/docs` | Telegram bot, documentation | yes | `<path>.html` |
| `/token/:id` | A token's page | a token NEARKITS lists: yes (not in sitemap); one only looked up by its contract, or one that doesn't exist: **noindex** (set by the app) | `app.html`; head set by the app (`useTokenHead`) |
| `/wallets`, `/positions`, `/pnl`, `/settings`, `/recover`, `/tg`, `/volume-bot/console` | Personal / app inside | **noindex** | `app.html` + `X-Robots-Tag: noindex` |
| `/limit-orders`, `/dca`, `/copy-trade`, `/sniper` | COMING SOON in production | **noindex** | `app.html` + `X-Robots-Tag: noindex` |
| anything else | — | — | `404.html` with status **404** (with a no-JavaScript summary linking every public page) |
| `/<page>.html`, `/index.html` | — | — | **308** to the page's own address; `/favicon.ico` serves `favicon-48.png` |

## How it is built (one source of truth)

- `src/config/seo.ts`: every public page's title, description and name; structured data
  (`Organization`, `WebSite` on every page; `WebPage` per public page; `SoftwareApplication` on `/` and
  `/volume-bot`; `BreadcrumbList` and `FAQPage` only on `/volume-bot`, where both are visible);
  `robots.txt` (everyone allowed, AI crawlers named explicitly) and `llms.txt` (the pages, the Telegram bot, and key facts: who signs, where withdrawals go, the risks, $KIT, what is coming soon).
- `src/prerender.tsx` (run by `vite.config.ts` → `prerenderSite` after each build): writes each public
  page's HTML with its own head, `app.html`, `404.html`, `robots.txt`, `sitemap.xml`, `llms.txt`.
- `useRouteMeta` (`src/lib/hooks.ts`): keeps the same head as the app navigates.
- `vercel.json`: explicit rewrites (no catch-all, so unknown addresses are real 404s),
  `trailingSlash: false`, `X-Robots-Tag: noindex` for private and COMING SOON routes.
  `src/config/hosting.test.ts` checks it against the router and `seo.ts`.
- `scripts/serve-dist.mjs`: serves a build locally the way `vercel.json` says (used by `npm run e2e:beta`
  and for audits). `scripts/brand-images.mjs` makes `og.png`, the favicons, the app icons (`manifest.webmanifest`)
  and the logo files in `public/brand/` from the official logo, `brand/nearkits-logo.jpg`.

## Rules

- A description says what its page shows; structured data only describes visible content. No ratings,
  reviews, authors or profiles that don't exist. The FAQ JSON-LD is the visible FAQ, question for question.
  (Google no longer shows FAQ rich results, since May 2026; the markup stays because the FAQ is real.)
- Shipping a COMING SOON route: remove it from `BETA_COMING_SOON` *and* from the noindex header in
  `vercel.json` (the hosting test fails until both agree), then add it to `SITEMAP_PATHS` with an
  entry in `seo.ts`.
- `VOLUME_BOT_UPDATED` (`src/features/volumeBot/content.ts`) changes whenever that page's content does.
- An app page's `<noscript>` summary names its own page in full and every other page by name only, so no two pages read alike without JavaScript.
- A token page is indexed only for a token NEARKITS lists: anyone can deploy a token and name it anything, and such a page must not become a page of this domain in search results.
- Copy says who signs: wallets you connect sign their own transactions; NEARKITS wallets are custodial (NEARKITS signs). Never "the bot never holds keys".

## Owner to-dos (can't be done in code)

- Google Search Console and Bing Webmaster Tools: verify nearkits.com, submit `sitemap.xml`.
- Real profiles for the organization's `sameAs` (X, GitHub, LinkedIn…): the Telegram bot is already
  named when the build sets `VITE_TELEGRAM_BOT`.
- After deploy: PageSpeed Insights / CrUX field data for `/` and `/volume-bot`.
