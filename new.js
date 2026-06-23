const puppeteer = require("puppeteer");

// ── CONFIG ────────────────────────────────────────────────────────────────────
const SEARCH_TERM = "pokemon trading card game";
const POLL_BASE_MS = 5 * 60 * 1000;   // 5 min
const JITTER_MS   = 1 * 60 * 1000;    // ±1 min
const PAGE_TIMEOUT = 30000;

// ── HELPERS ───────────────────────────────────────────────────────────────────
const log = (tag, msg) =>
  console.log(`[${new Date().toISOString()}] [${tag}] ${msg}`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const jitteredDelay = () =>
  POLL_BASE_MS + Math.floor((Math.random() * 2 - 1) * JITTER_MS);

const seen = new Set();

// ── SCRAPERS ──────────────────────────────────────────────────────────────────

async function scrapeGameStop(page) {
  const tag = "gamestop";
  log(tag, "Checking for stock...");
  try {
    await page.goto(
      `https://www.gamestop.com/search/?q=${encodeURIComponent(SEARCH_TERM)}`,
      { waitUntil: "networkidle2", timeout: PAGE_TIMEOUT }
    );

    await page.waitForSelector('[name="product-tile"]', { timeout: PAGE_TIMEOUT });

    const items = await page.evaluate(() => {
      const tiles = document.querySelectorAll('[name="product-tile"]');
      const results = [];

      tiles.forEach((tile) => {
        try {
          const link = tile.querySelector("a.pdp-link, a.product-tile-link");
          if (!link) return;

          const gtmRaw = link.getAttribute("data-gtmdata");
          if (!gtmRaw) return;

          let gtm;
          try { gtm = JSON.parse(gtmRaw); } catch { return; }

          const avail = gtm.availability || {};
          const inStock = avail.available === true && avail.readyToOrder === true;
          if (!inStock) return;

          const name =
            tile.querySelector(".render-tile-name")?.innerText?.trim() ||
            link.getAttribute("aria-label") || "";

          const priceEl = tile.querySelector(".render-sale-price");
          const price = priceEl ? priceEl.innerText.trim() : "N/A";

          const href = link.getAttribute("href") || "";
          const url = href.startsWith("http") ? href : "https://www.gamestop.com" + href;

          if (name) results.push({ name, price, url, store: "GameStop" });
        } catch { }
      });

      return results;
    });

    log(tag, `Found ${items.length} in-stock item(s).`);
    return items;
  } catch (err) {
    log(tag, `❌ Scrape failed: ${err.message}`);
    return [];
  }
}

async function scrapeWalmart(page) {
  const tag = "walmart";
  log(tag, "Checking for stock...");
  try {
    await page.goto(
      `https://www.walmart.com/search?q=${encodeURIComponent(SEARCH_TERM)}`,
      { waitUntil: "domcontentloaded", timeout: PAGE_TIMEOUT }
    );

    const title = await page.title();
    if (
      title.toLowerCase().includes("robot") ||
      title.toLowerCase().includes("captcha") ||
      title.toLowerCase().includes("access denied")
    ) {
      log(tag, "⚠️  Hit bot-check interstitial. Skipping this cycle.");
      return [];
    }

    await page.waitForSelector('[data-item-id], [data-testid="list-view"]', {
      timeout: PAGE_TIMEOUT,
    });

    const items = await page.evaluate(() => {
      const tiles = document.querySelectorAll('[data-item-id], article[data-testid]');
      const results = [];
      tiles.forEach((tile) => {
        const outOfStock =
          tile.querySelector('[data-automation="out-of-stock"]') ||
          tile.innerText.toLowerCase().includes("out of stock");
        if (outOfStock) return;

        const nameEl = tile.querySelector('[data-automation="product-title"], .w_iUH7');
        const name = nameEl ? nameEl.innerText.trim() : "";
        if (!name) return;

        const priceEl = tile.querySelector('[itemprop="price"], .f2');
        const price = priceEl ? priceEl.innerText.trim() : "N/A";

        const linkEl = tile.querySelector("a");
        const href = linkEl ? linkEl.getAttribute("href") : "";
        const url = href.startsWith("http") ? href : "https://www.walmart.com" + href;

        results.push({ name, price, url, store: "Walmart" });
      });
      return results;
    });

    log(tag, `Found ${items.length} in-stock item(s).`);
    return items;
  } catch (err) {
    log(tag, `❌ Scrape failed: ${err.message}`);
    return [];
  }
}

// ── FIXED: TARGET ─────────────────────────────────────────────────────────────
// Updated selectors based on real Target HTML structure:
//   - Product title: a[data-test="@web/ProductCard/title"]
//   - Price:         [data-test="current-price"] span  (same, but wrapped in extra span)
//   - Out-of-stock:  card wrapper has empty inner div — detected by checking
//                    whether the title element is present at all
//   - Sponsored:     tile contains <p data-test="sponsoredText">
//   - "Check stores" button (not shippable) = online unavailable, skip those too
async function scrapeTarget(page) {
  const tag = "target";
  log(tag, "Checking for stock...");
  try {
    await page.goto(
      `https://www.target.com/s?searchTerm=${encodeURIComponent(SEARCH_TERM)}`,
      { waitUntil: "networkidle2", timeout: PAGE_TIMEOUT }
    );

    // Extra wait for Target's heavy React rendering
    await sleep(5000);

    await page.waitForSelector(
      '[data-test="@web/site-top-of-funnel/ProductCardWrapper"]',
      { timeout: PAGE_TIMEOUT }
    );

    // Additional wait to ensure product cards are fully populated
    await sleep(3000);

    const items = await page.evaluate(() => {
      const tiles = document.querySelectorAll(
        '[data-test="@web/site-top-of-funnel/ProductCardWrapper"]'
      );
      const results = [];

      tiles.forEach((tile) => {
        try {
          // Skip sponsored tiles
          const sponsored = tile.querySelector('[data-test="sponsoredText"]');
          if (sponsored) return;

          // A fully-loaded card has a title anchor; empty cards (lazy-not-yet-loaded
          // or truly out-of-stock skeletons) have only an empty inner div.
          const nameEl = tile.querySelector('a[data-test="@web/ProductCard/title"]');
          if (!nameEl) return;

          const name = nameEl.innerText.trim() || nameEl.getAttribute("aria-label")?.trim() || "";
          if (!name) return;

          // Skip if only "Check stores" is available (not orderable online)
          const checkStoresBtn = tile.querySelector('[data-test="checkStoresButton"]');
          const addToCartBtn   = tile.querySelector('[data-test="chooseOptionsButton"]');
          if (!addToCartBtn && checkStoresBtn) return;

          // Explicit out-of-stock messages
          const notAvail = tile.querySelector(
            '[data-test="outOfStockMessage"], [aria-label*="out of stock"]'
          );
          if (notAvail) return;

          // Price — real HTML: [data-test="current-price"] > span
          const priceEl = tile.querySelector('[data-test="current-price"] span');
          const price = priceEl ? priceEl.innerText.trim() : "N/A";

          // URL
          const linkEl = tile.querySelector("a[href]");
          const href = linkEl ? linkEl.getAttribute("href") : "";
          const url = href.startsWith("http") ? href : "https://www.target.com" + href;

          results.push({ name, price, url, store: "Target" });
        } catch { }
      });

      return results;
    });

    log(tag, `Found ${items.length} in-stock item(s).`);
    return items;
  } catch (err) {
    log(tag, `⚠️  ${err.message}`);
    return [];
  }
}

async function scrapeCostco(page) {
  const tag = "costco";
  log(tag, "Checking for stock...");
  try {
    await page.goto(
      `https://www.costco.com/CatalogSearch?dept=All&keyword=${encodeURIComponent(SEARCH_TERM)}`,
      { waitUntil: "domcontentloaded", timeout: PAGE_TIMEOUT }
    );

    await page.waitForSelector(".product-list-item, .product", { timeout: PAGE_TIMEOUT });

    const items = await page.evaluate(() => {
      const tiles = document.querySelectorAll(".product-list-item, .product");
      const results = [];
      tiles.forEach((tile) => {
        const oos = tile.querySelector(".out-of-stock, .stock-message");
        if (oos && oos.innerText.toLowerCase().includes("out of stock")) return;

        const nameEl = tile.querySelector(".description a, .product-title a");
        const name = nameEl ? nameEl.innerText.trim() : "";
        if (!name) return;

        const priceEl = tile.querySelector(".price, .product-price");
        const price = priceEl ? priceEl.innerText.trim() : "N/A";

        const linkEl = tile.querySelector("a");
        const href = linkEl ? linkEl.getAttribute("href") : "";
        const url = href.startsWith("http") ? href : "https://www.costco.com" + href;

        results.push({ name, price, url, store: "Costco" });
      });
      return results;
    });

    log(tag, `Found ${items.length} in-stock item(s).`);
    return items;
  } catch (err) {
    log(tag, `⚠️  ${err.message}`);
    return [];
  }
}

async function scrapeSamsClub(page) {
  const tag = "samsclub";
  log(tag, "Checking for stock...");
  try {
    await page.goto(
      `https://www.samsclub.com/s/${encodeURIComponent(SEARCH_TERM)}`,
      { waitUntil: "domcontentloaded", timeout: PAGE_TIMEOUT }
    );

    await page.waitForSelector(
      '[data-item-id], [data-dca-name="stickyATC"]',
      { timeout: PAGE_TIMEOUT }
    );

    await sleep(3000);

    const items = await page.evaluate(() => {
      const results = [];
      const tiles = document.querySelectorAll('[role="group"][data-item-id]');

      tiles.forEach((tile) => {
        try {
          const inventoryEl = tile.querySelector('[data-automation-id="inventory-status"]');
          if (inventoryEl && inventoryEl.innerText.toLowerCase().includes("out of stock")) return;

          const nameEl = tile.querySelector('[data-automation-id="product-title"]');
          const name = nameEl ? nameEl.innerText.trim() : "";
          if (!name) return;

          const nameLower = name.toLowerCase();
          if (!nameLower.includes("pokemon") && !nameLower.includes("pokémon")) return;

          const priceEl = tile.querySelector('[data-automation-id="product-price"] .b');
          const price = priceEl ? priceEl.innerText.trim() : "N/A";

          const linkEl = tile.querySelector("a[href*='/ip/']");
          if (!linkEl) return;
          const href = linkEl.getAttribute("href") || "";
          const url = href.startsWith("http") ? href : "https://www.samsclub.com" + href;

          results.push({ name, price, url, store: "Sam's Club" });
        } catch { }
      });

      return results;
    });

    log(tag, `Found ${items.length} in-stock item(s).`);
    return items;
  } catch (err) {
    log(tag, `⚠️  ${err.message}`);
    return [];
  }
}

async function scrapePokemonCenter(page) {
  const tag = "pokemoncenter";
  log(tag, "Checking for stock...");
  try {
    await page.goto(
      `https://www.pokemoncenter.com/search?q=${encodeURIComponent(SEARCH_TERM)}`,
      { waitUntil: "networkidle2", timeout: PAGE_TIMEOUT }
    );

    await page.waitForSelector(".product-grid .product-card, .search-results .product", {
      timeout: PAGE_TIMEOUT,
    });

    const items = await page.evaluate(() => {
      const tiles = document.querySelectorAll(
        ".product-grid .product-card, .search-results .product"
      );
      const results = [];
      tiles.forEach((tile) => {
        const soldOut = tile.querySelector(".sold-out, .out-of-stock");
        if (soldOut) return;

        const nameEl = tile.querySelector(".product-name, h3, h2");
        const name = nameEl ? nameEl.innerText.trim() : "";
        if (!name) return;

        const priceEl = tile.querySelector(".product-price, .price");
        const price = priceEl ? priceEl.innerText.trim() : "N/A";

        const linkEl = tile.querySelector("a");
        const href = linkEl ? linkEl.getAttribute("href") : "";
        const url = href.startsWith("http") ? href : "https://www.pokemoncenter.com" + href;

        results.push({ name, price, url, store: "Pokemon Center" });
      });
      return results;
    });

    log(tag, `Found ${items.length} in-stock item(s).`);
    return items;
  } catch (err) {
    log(tag, `❌ Scrape failed: ${err.message}`);
    return [];
  }
}

async function scrapeAmazon(page) {
  const tag = "amazon";
  log(tag, "Checking for stock...");
  try {
    await page.goto(
      `https://www.amazon.com/s?k=${encodeURIComponent(SEARCH_TERM)}`,
      { waitUntil: "domcontentloaded", timeout: PAGE_TIMEOUT }
    );

    await sleep(5000);

    const pageContent = await page.content();
    if (
      pageContent.includes("Type the characters you see") ||
      pageContent.includes("Enter the characters you see") ||
      pageContent.includes("robot")
    ) {
      log(tag, "⚠️  Hit CAPTCHA. Skipping this cycle.");
      return [];
    }

    await page.waitForSelector(
      '[data-component-type="s-search-result"]',
      { timeout: PAGE_TIMEOUT }
    );

    const items = await page.evaluate(() => {
      const tiles = document.querySelectorAll('[data-component-type="s-search-result"]');
      const results = [];

      tiles.forEach((tile) => {
        try {
          if (tile.getAttribute("data-sponsored-label")) return;
          if (tile.querySelector('.s-label-popover-default')) return;

          const oos = tile.querySelector('[aria-label*="out of stock"], .s-stock-status');
          if (oos) return;

          const nameEl =
            tile.querySelector('h2 a span') ||
            tile.querySelector('h2 span') ||
            tile.querySelector('[data-cy="title-recipe-title"]');
          const name = nameEl ? nameEl.innerText.trim() : "";
          if (!name) return;

          const nameLower = name.toLowerCase();
          if (!nameLower.includes("pokemon") && !nameLower.includes("pokémon")) return;

          const priceWhole = tile.querySelector(".a-price-whole");
          const priceFrac  = tile.querySelector(".a-price-fraction");
          const price = priceWhole
            ? "$" + priceWhole.innerText.replace(/[^0-9]/g, "") + "." + (priceFrac ? priceFrac.innerText.replace(/[^0-9]/g, "") : "00")
            : "N/A";

          const linkEl = tile.querySelector("h2 a");
          if (!linkEl) return;
          const href = linkEl.getAttribute("href") || "";
          const url = href.startsWith("http") ? href : "https://www.amazon.com" + href;

          results.push({ name, price, url, store: "Amazon" });
        } catch { }
      });

      return results;
    });

    log(tag, `Found ${items.length} in-stock item(s).`);
    return items;
  } catch (err) {
    log(tag, `❌ Scrape failed: ${err.message}`);
    return [];
  }
}

async function scrapeBarnesAndNoble(page) {
  const tag = "barnesandnoble";
  log(tag, "Checking for stock...");
  try {
    await page.goto(
      `https://www.barnesandnoble.com/s/${encodeURIComponent(SEARCH_TERM)}`,
      { waitUntil: "domcontentloaded", timeout: PAGE_TIMEOUT }
    );

    await page.waitForSelector(".product-shelf-tile, .result-item", { timeout: PAGE_TIMEOUT });

    const items = await page.evaluate(() => {
      const tiles = document.querySelectorAll(".product-shelf-tile, .result-item");
      const results = [];
      tiles.forEach((tile) => {
        const oos = tile.querySelector(".out-of-stock, .notavail");
        if (oos) return;

        const nameEl = tile.querySelector(".product-shelf-title a, .result-title a");
        const name = nameEl ? nameEl.innerText.trim() : "";
        if (!name) return;

        const priceEl = tile.querySelector(".product-shelf-pricing .current-price, .result-price");
        const price = priceEl ? priceEl.innerText.trim() : "N/A";

        const linkEl = tile.querySelector("a");
        const href = linkEl ? linkEl.getAttribute("href") : "";
        const url = href.startsWith("http") ? href : "https://www.barnesandnoble.com" + href;

        results.push({ name, price, url, store: "Barnes & Noble" });
      });
      return results;
    });

    log(tag, `Found ${items.length} in-stock item(s).`);
    return items;
  } catch (err) {
    log(tag, `⚠️  ${err.message}`);
    return [];
  }
}

// ── NOTIFICATION ──────────────────────────────────────────────────────────────
function notify(item) {
  console.log("\n" + "=".repeat(60));
  console.log(`🚨  NEW DROP DETECTED — ${item.store}`);
  console.log(`    Name  : ${item.name}`);
  console.log(`    Price : ${item.price}`);
  console.log(`    URL   : ${item.url}`);
  console.log("=".repeat(60) + "\n");
}

// ── MAIN LOOP ─────────────────────────────────────────────────────────────────
async function main() {
  const browser = await puppeteer.launch({
    headless: false,
    slowMo: 75,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--start-maximized'],
    defaultViewport: null,
  });

  const scrapers = [
  //  { name: "walmart",        fn: scrapeWalmart },
    { name: "target",         fn: scrapeTarget },
    { name: "costco",         fn: scrapeCostco },
    { name: "samsclub",       fn: scrapeSamsClub },
    { name: "gamestop",       fn: scrapeGameStop },
 //   { name: "pokemoncenter",  fn: scrapePokemonCenter },
  //  { name: "amazon",         fn: scrapeAmazon },
  //  { name: "barnesandnoble", fn: scrapeBarnesAndNoble },
  ];

  log("main", "Pokemon card drop scraper starting up.");
  log("main", `Polling every ~5 min (+/- 1 min jitter). Press Ctrl+C to stop.`);

  browser.on("targetcreated", async (target) => {
    const p = await target.page();
    if (p) {
      await p.setUserAgent(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
        "AppleWebKit/537.36 (KHTML, like Gecko) " +
        "Chrome/124.0.0.0 Safari/537.36"
      ).catch(() => {});
    }
  });

  while (true) {
    let totalNew = 0;

    for (const scraper of scrapers) {
      const page = await browser.newPage();
      await page.setUserAgent(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
        "AppleWebKit/537.36 (KHTML, like Gecko) " +
        "Chrome/124.0.0.0 Safari/537.36"
      );
      await page.evaluateOnNewDocument(() => {
        Object.defineProperty(navigator, "webdriver", { get: () => false });
      });

      const found = await scraper.fn(page);
      await page.close().catch(() => {});

      for (const item of found) {
        const key = `${item.store}::${item.url}`;
        if (!seen.has(key)) {
          seen.add(key);
          notify(item);
          totalNew++;
        }
      }

      await sleep(8000);
    }

    log("main", `Sweep complete. ${totalNew} new drop(s) found.`);
    const delay = jitteredDelay();
    log("main", `Sleeping ${Math.round(delay / 1000)}s until next sweep.`);
    await sleep(delay);
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});