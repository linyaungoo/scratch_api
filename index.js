const fsSync = require('fs');
const path = require('path');
const fs = require('fs/promises');
const { chromium } = require('playwright');

/* =========================
   ENV LOADER
========================= */
function loadDotEnv(filePath) {
  try {
    if (!fsSync.existsSync(filePath)) return;
    const raw = fsSync.readFileSync(filePath, 'utf8');
    for (const line of raw.split(/\r?\n/)) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const i = t.indexOf('=');
      if (i <= 0) continue;
      const k = t.slice(0, i).trim();
      let v = t.slice(i + 1).trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
        v = v.slice(1, -1);
      }
      if (process.env[k] === undefined) process.env[k] = v;
    }
  } catch {}
}

loadDotEnv(path.join(__dirname, '.env'));

/* =========================
   CONFIG
========================= */
const CONFIG = {
  baseUrl: 'https://sportsxzone.com',
  username: process.env.SXZ_USERCODE || 'WAK1ly',
  password: process.env.SXZ_PASSWORD || 'Lin@123456789',
  timezoneId: 'Asia/Yangon',
  headless: true,
  outputFile: 'output.json',
  meta: {
    author: 'GGWP API',
    website: 'https://ggwp-api.render.com',
    country: 'Thailand',
    copyright:
      'Legal action will be taken if any unauthorized use of our API is found.',
  },
};

const MYANMAR_UTC_OFFSET_MINUTES = 6 * 60 + 30;

/* =========================
   HELPERS
========================= */
const log = (m) =>
  process.stdout.write(`[${new Date().toISOString()}] ${m}\n`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const normalize = (v) => String(v || '').replace(/\s+/g, ' ').trim();

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
   ODDS PARSER
========================= */
function parseMyanmarOdds(raw) {
  const s = normalize(raw);
  if (!s) return null;

  const m = s.match(/^(=|\d+(?:\.\d+)?)([+-])(\d{1,3})$/);
  if (!m) return null;

  const baseRaw = m[1];
  const sign = m[2] === '-' ? -1 : 1;
  const frac = parseInt(m[3], 10) / 100;
  const base = baseRaw === '=' ? 0 : parseFloat(baseRaw);

  return {
    value: baseRaw === '=' ? sign * frac : base + frac,
    gap: sign * frac,
    base,
  };
}

/* =========================
   TIME PARSER
========================= */
function parseStartTimeToIsoUtc(text) {
  const t = normalize(text).replace(/^Start Time\s*:/i, '');
  const m = t.match(/^(\d{1,2})\/(\d{1,2})\s*-\s*(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
  if (!m) return new Date().toISOString();

  let [_, d, mo, h, mi, ap] = m;
  d = +d;
  mo = +mo - 1;
  h = +h % 12 + (ap.toUpperCase() === 'PM' ? 12 : 0);
  mi = +mi;

  const offset = MYANMAR_UTC_OFFSET_MINUTES * 60000;
  const utc = Date.UTC(new Date().getUTCFullYear(), mo, d, h, mi) - offset;
  return new Date(utc).toISOString();
}

/* =========================
   LOGIN
========================= */
async function login(page) {
  log('Opening sign-in page');
  await page.goto(`${CONFIG.baseUrl}/sign-in`, {
    waitUntil: 'networkidle',
    timeout: 60000,
  });

  await page.fill('#usercode', CONFIG.username);
  await page.fill('#password', CONFIG.password);

  await Promise.all([
    page.click('button[type="submit"]'),
    page.waitForLoadState('networkidle'),
  ]);

  if (page.url().includes('sign-in')) {
    throw new Error('Login failed');
  }
  log('Login success');
}

/* =========================
   NAVIGATE BODY
========================= */
async function gotoBody(page) {
  log('Opening /body page');
  await page.goto(`${CONFIG.baseUrl}/body`, {
    waitUntil: 'networkidle',
    timeout: 90000,
  });

  await page.waitForSelector('time', { timeout: 90000 });
}

/* =========================
   SCRAPE
========================= */
async function collectMatches(page) {
  log('Scrolling & collecting matches');

  const seen = new Map();

  for (let i = 0; i < 30; i++) {
    const data = await page.evaluate(() => {
      const getText = (e) => e?.textContent?.replace(/\s+/g, ' ').trim() || '';

      const res = [];
      document.querySelectorAll('time').forEach((t) => {
        if (!getText(t).includes('Start Time')) return;

        let root = t;
        for (let i = 0; i < 8 && root; i++) root = root.parentElement;

        const text = getText(root);
        const odds = text.match(/(=|\d+)[+-]\d{1,3}/g) || [];

        res.push({
          league:
            root?.previousElementSibling?.textContent || 'Unknown League',
          time: getText(t),
          home: text.split('\n')[0],
          away: text.split('\n')[1],
          handicap: odds[0] || '',
          ou: odds[1] || '',
          finished: text.includes('ပွဲပြီး'),
        });
      });
      return res;
    });

    data.forEach((m) => {
      const k = JSON.stringify(m);
      if (!seen.has(k)) seen.set(k, m);
    });

    await page.mouse.wheel(0, 1000);
    await sleep(700);
  }

  return [...seen.values()];
}

/* =========================
   BUILD API
========================= */
function buildApi(matches) {
  const now = new Date();
  const api = {
    ...CONFIG.meta,
    id: Date.now(),
    date: now.toISOString(),
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
        name: normalize(m.home),
        engName: null,
        league: { id: leagueId, leagueId: null, name: normalize(m.league) },
      },
      away: {
        id: stableId(m.away),
        teamId: null,
        name: normalize(m.away),
        engName: null,
        league: { id: leagueId, leagueId: null, name: normalize(m.league) },
      },
      startTime: parseStartTimeToIsoUtc(m.time),
      closeTime: parseStartTimeToIsoUtc(m.time),
      odds: hdp?.value || 0,
      price: Math.abs((hdp?.value || 0) * 100),
      homeUpper: true,
      goalTotal: ou?.base || 0,
      goalTotalPrice: Math.abs((ou?.gap || 0) * 100),
      homeScore: 0,
      awayScore: 0,
      finished: m.finished,
      calculating: false,
      hdpFinished: false,
      ouFinished: false,
      canceled: false,
      bodyGap: (hdp?.value || 0) * 10,
      goalsGap: (ou?.gap || 0) * 10,
      homeNo: i * 2 + 1,
      awayNo: i * 2 + 2,
      fixtureId: null,
      league: { id: leagueId, leagueId: null, name: normalize(m.league) },
      location: { id: 68, locationId: 1, name: '' },
      singleBet: true,
      highTax: false,
      active: true,
      status: 1,
      autoUpdate: false,
    });
  });

  return api;
}

/* =========================
   MAIN
========================= */
async function main() {
  log('Launching browser');

  const browser = await chromium.launch({
  headless: true,
  channel: 'chromium',
  args: [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--disable-gpu',
  ],
});


  const context = await browser.newContext({ timezoneId: CONFIG.timezoneId });
  const page = await context.newPage();

  try {
    await login(page);
    await gotoBody(page);
    const raw = await collectMatches(page);
    log(`Collected ${raw.length} matches`);

    const api = buildApi(raw);
    const json = JSON.stringify(api, null, 2);

    await fs.writeFile(CONFIG.outputFile, json);
    process.stdout.write(json + '\n');
  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

process.on('SIGTERM', () => {
  log('SIGTERM received, exiting');
  process.exit(0);
});

main().catch((e) => {
  process.stderr.write(e.stack + '\n');
  process.exit(1);
});
