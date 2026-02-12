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

function fnv1a32(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

const stableId = (seed) => fnv1a32(String(seed || ''));

/* =========================
   MYANMAR ODDS PARSER
========================= */
function parseMyanmarOdds(raw) {
  const s = normalize(raw);
  const m = s.match(/^(=|\d+(?:\.\d+)?)([+-])(\d{1,3})$/);
  if (!m) return null;

  const base = m[1] === '=' ? 0 : parseFloat(m[1]);
  const sign = m[2] === '-' ? -1 : 1;
  const frac = parseInt(m[3], 10) / 100;

  return {
    value: m[1] === '=' ? sign * frac : base + frac,
    gap: sign * frac,
    base,
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
    await page.goto(`${CONFIG.baseUrl}/sign-in`, {
      waitUntil: 'networkidle',
    });
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
    await page.goto(`${CONFIG.baseUrl}/body`, {
      waitUntil: 'networkidle',
    });
    await page.waitForSelector('time');

    /* PARSE */
    const matches = await page.evaluate(() => {
      const norm = (v) =>
        v?.textContent?.replace(/\s+/g, ' ').trim() || '';

      function findLeague(el) {
        let cur = el;
        for (let i = 0; i < 12 && cur; i++) {
          const h = cur.querySelector?.('h3');
          if (h) return norm(h);
          cur = cur.parentElement;
        }
        return '';
      }

      function findOdds(container) {
        return [...container.querySelectorAll('span,div')]
          .map(norm)
          .find((t) => /^(=|\d+)[+-]\d{1,3}$/.test(t));
      }

      const results = [];

      document.querySelectorAll('time').forEach((timeEl) => {
        if (!norm(timeEl).includes('Start Time')) return;

        let card = timeEl;
        for (let i = 0; i < 10 && card; i++) {
          card = card.parentElement;
        }
        if (!card) return;

        const league = findLeague(card);
        const finished = card.textContent.includes('ပွဲပြီး');

        const hdpBox = card.querySelector('[class*="hdp"]');
        const ouBox = card.querySelector('[class*="ou"]');

        if (!hdpBox || !ouBox) return;

        const hdpOdd = findOdds(hdpBox);
        const ouOdd = findOdds(ouBox);

        const rows = [...hdpBox.children];
        const homeRow = rows[0];
        const awayRow = rows[1];

        const home = homeRow
          ? norm(homeRow).replace(hdpOdd || '', '').trim()
          : '';
        const away = awayRow ? norm(awayRow) : '';

        results.push({
          league,
          time: norm(timeEl),
          home,
          away,
          handicap: hdpOdd || '',
          ou: ouOdd || '',
          finished,
        });
      });

      return results;
    });

    log(`Parsed ${matches.length} matches`);

    /* BUILD API */
    const api = {
      author: 'GGWP API',
      website: 'https://ggwp-api.render.com',
      country: 'Thailand',
      id: Date.now(),
      date: new Date().toISOString(),
      completed: false,
      matches: [],
    };

    matches.forEach((m, i) => {
      const hdp = parseMyanmarOdds(m.handicap);
      const ou = parseMyanmarOdds(m.ou);
      const leagueId = stableId(m.league);

      api.matches.push({
        id: i + 1,
        matchId: stableId(`${m.league}|${m.home}|${m.away}|${m.time}`),
        home: {
          id: stableId(m.home),
          teamId: null,
          name: m.home,
          engName: null,
          league: { id: leagueId, leagueId: null, name: m.league },
        },
        away: {
          id: stableId(m.away),
          teamId: null,
          name: m.away,
          engName: null,
          league: { id: leagueId, leagueId: null, name: m.league },
        },
        startTime: m.time,
        closeTime: m.time,
        odds: hdp?.value || 0,
        price: Math.abs((hdp?.value || 0) * 100),
        homeUpper: true,
        goalTotal: ou?.base || 0,
        goalTotalPrice: Math.abs((ou?.gap || 0) * 100),
        finished: m.finished,
        active: true,
        status: 1,
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
let cache = null;
let running = false;

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
