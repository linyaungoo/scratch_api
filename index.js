const fs = require('fs/promises');
const express = require('express');
const { chromium } = require('playwright');

/* =========================
   CONFIG
========================= */
const CONFIG = {
  baseUrl: 'https://sportsxzone.com',
  username: process.env.SXZ_USERCODE || 'WAK1ly',
  password: process.env.SXZ_PASSWORD || 'Lin@123456789',
  timezoneId: 'Asia/Yangon',
};

/* =========================
   HELPERS
========================= */
const log = (m) =>
  console.log(`[${new Date().toISOString()}] ${m}`);

const normalize = (v) =>
  String(v || '').replace(/\s+/g, ' ').trim();

/* =========================
   ODDS PARSERS (FINAL RULES)
========================= */
function parseBodyOdds(raw, isHome) {
  const s = normalize(raw);
  const m = s.match(/(=|\d+)([+-])(\d{1,3})/);
  if (!m) return null;

  return {
    home: isHome,
    goal: m[1] === '=' ? 0 : Number(m[1]),
    price: `${m[2]}${m[3]}` // KEEP SIGN
  };
}

function parseOuOdds(raw) {
  const s = normalize(raw);
  const m = s.match(/(\d+)([+-])(\d{1,3})/);
  if (!m) return null;

  return {
    goal: Number(m[1]),
    price: `${m[2]}${m[3]}`
  };
}

/* =========================
   SCRAPER
========================= */
async function scrapeBody() {
  log('Launching browser');

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });

  const context = await browser.newContext({
    timezoneId: CONFIG.timezoneId,
  });

  const page = await context.newPage();

  try {
    /* LOGIN */
    log('Logging in');
    await page.goto(`${CONFIG.baseUrl}/sign-in`, { waitUntil: 'networkidle' });
    await page.fill('#usercode', CONFIG.username);
    await page.fill('#password', CONFIG.password);

    await Promise.all([
      page.click('button[type="submit"]'),
      page.waitForNavigation({ waitUntil: 'networkidle' }),
    ]);

    if (page.url().includes('sign-in')) {
      throw new Error('Login failed');
    }

    /* BODY PAGE */
    log('Opening /body');
    await page.goto(`${CONFIG.baseUrl}/body`, { waitUntil: 'networkidle' });
    await page.waitForSelector('time');

    /* SCROLL TO LOAD ALL LEAGUES */
    log('Scrolling page to load all matches');
    for (let i = 0; i < 25; i++) {
      await page.mouse.wheel(0, 1200);
      await page.waitForTimeout(400);
    }

    /* PARSE DOM */
    const rawMatches = await page.evaluate(() => {
      const norm = (v) =>
        v?.textContent?.replace(/\s+/g, ' ').trim() || '';

      function findLeague(card) {
        let cur = card;
        for (let i = 0; i < 12 && cur; i++) {
          const h = cur.querySelector('h3');
          if (h) return norm(h);
          cur = cur.parentElement;
        }
        return '';
      }

      const seen = new Set();
      const results = [];

      document.querySelectorAll('time').forEach((timeEl) => {
        if (!norm(timeEl).includes('Start Time')) return;

        let card = timeEl;
        for (let i = 0; i < 10 && card; i++) {
          card = card.parentElement;
        }
        if (!card) return;

        const league = findLeague(card);

        const hdpBox = card.querySelector('[class*="hdp"]');
        const ouBox = card.querySelector('[class*="ou"]');
        if (!hdpBox || !ouBox) return;

        const homeRow = hdpBox.children[0];
        const awayRow = hdpBox.children[1];

        const homeTeam = norm(homeRow);
        const awayTeam = norm(awayRow.childNodes[0]);

        const oddsSpan =
          awayRow.querySelector('span') ||
          homeRow.querySelector('span');
        if (!oddsSpan) return;

        const bodyRaw = norm(oddsSpan);
        const isHome = oddsSpan.className.includes('home');

        const ouRaw = norm(
          ouBox.querySelector('[class*="odds"]')
        );

        const key = `${league}|${homeTeam}|${awayTeam}|${bodyRaw}|${ouRaw}`;
        if (seen.has(key)) return;
        seen.add(key);

        results.push({
          league,
          homeTeam,
          awayTeam,
          bodyRaw,
          bodyHome: isHome,
          ouRaw,
        });
      });

      return results;
    });

    log(`Parsed ${rawMatches.length} unique matches`);

    /* BUILD API */
    const api = {
      author: 'GGWP API',
      website: 'https://ggwp-api.render.com',
      country: 'Thailand',
      date: new Date().toISOString(),
      matches: [],
    };

    rawMatches.forEach((m) => {
      const body = parseBodyOdds(m.bodyRaw, m.bodyHome);
      const ou = parseOuOdds(m.ouRaw);
      if (!body || !ou) return;

      api.matches.push({
        league: m.league,
        home_team: m.homeTeam,
        away_team: m.awayTeam,
        body,
        over_under: ou,
      });
    });

    await fs.writeFile('output.json', JSON.stringify(api, null, 2));
    return api;

  } finally {
    await context.close();
    await browser.close();
  }
}

/* =========================
   EXPRESS API
========================= */
const app = express();
let running = false;
let cache = null;

app.get('/health', (_, res) => {
  res.json({ status: 'ok', running });
});

app.get('/body', async (_, res) => {
  if (running) return res.json({ status: 'running' });

  try {
    running = true;
    cache = await scrapeBody();
    res.json(cache);
  } catch (e) {
    res.status(500).json({ error: e.message });
  } finally {
    running = false;
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => log(`API running on port ${PORT}`));
