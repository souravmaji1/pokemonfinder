# Pokemon Card Drop Scraper

Polls Walmart, Target, Costco, Sam's Club, GameStop, Pokemon Center,
Amazon, and Barnes & Noble for in-stock Pokemon TCG products, logging
new drops to the console.

## Setup

```bash
npm install
npx playwright install chromium
node src/index.js
```

Leave it running in a terminal (or under `pm2`/`screen`/`tmux` so it
survives you closing the window). It logs everything to stdout; pipe to a
file if you want a persistent log: `node src/index.js >> drops.log 2>&1`.

## Configuration

Edit `src/config.js`:
- `pollIntervalMs` — how often to sweep all sites (default 5 min)
- `searchTerm` — what to search for on each site
- `enabledSites` — turn individual retailers on/off
- `reAlertAfterHours` — re-notify on the same item after N hours, or
  `null` to only ever alert once per item

## Honest limitations — please read before relying on this

**Most of these sites actively try to block scrapers like this one.**
Per-site confidence, from the comments in each `src/sites/*.js` file:

| Site | Confidence | Why |
|---|---|---|
| GameStop | Medium-High | Lighter bot protection, stock state in markup |
| Barnes & Noble | Medium-High | Lighter bot protection, not a common bot target |
| Costco | Medium | Lighter defenses, but Pokemon stock is genuinely rare there |
| Target | Low-Medium | Akamai protection, page structure changes often |
| Pokemon Center | Medium | Works normally, but shows a queue page during real drops that this can't bypass |
| Walmart | Low | PerimeterX bot detection, frequent CAPTCHAs |
| Sam's Club | Low | Same parent company/tech as Walmart |
| Amazon | Very Low | Heaviest bot defense + ToS explicitly forbids scraping |

Things that will eventually break this, because that's the nature of
scraping sites that don't want to be scraped:
- **CSS selectors will go stale.** Every site redesigns its product grid
  periodically. When a site starts returning 0 results, check
  `src/sites/<site>.js` and re-inspect the live page's HTML.
- **IP bans.** Running this from a single cloud/home IP for hours will
  likely get that IP rate-limited or blocked, especially by Walmart,
  Target, and Amazon. A residential proxy service reduces but doesn't
  eliminate this.
- **CAPTCHAs.** Several scrapers detect and log when they hit a CAPTCHA
  or bot-check page rather than crash, but they can't solve it — they
  just skip that cycle.
- **Terms of Service.** Amazon's and others' ToS prohibit automated
  scraping. This is provided for personal/educational use; using it
  against a site's ToS is a risk you're taking on, not something I can
  advise on.

## A more durable alternative

For something you actually want to depend on, consider:
- Community Pokemon-card restock trackers/Discord bots that already
  exist and are maintained against these exact sites
- Official retailer APIs where available (none of these 8 currently
  offer a public stock-check API)
- Browser extensions designed for restock alerts (e.g. various
  "stock alert" extensions), which run client-side in your own
  authenticated session and tend to survive bot-detection better than a
  headless server-side scraper

This project is a reasonable starting point and will work some of the
time on some of these sites — just go in with realistic expectations
about maintenance burden.
