const fsSync = require('fs');
const path = require('path');
const fs = require('fs/promises');
const { chromium } = require('playwright');

function loadDotEnv(filePath) {
  try {
    if (!fsSync.existsSync(filePath)) return;
    const raw = fsSync.readFileSync(filePath, 'utf8');
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const idx = trimmed.indexOf('=');
      if (idx <= 0) continue;
      const key = trimmed.slice(0, idx).trim();
      let val = trimmed.slice(idx + 1).trim();
      if (!key) continue;
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (process.env[key] === undefined) process.env[key] = val;
    }
  } catch {
    // ignore
  }
}

loadDotEnv(path.join(__dirname, '.env'));

const CONFIG = {
  baseUrl: 'https://sportsxzone.com',
  username: process.env.SXZ_USERCODE || process.env.SXZ_USERNAME || 'WAK1ly',
  password: process.env.SXZ_PASSWORD || process.env.SXZ_PASS || 'Lin@123456789',
  timezoneId: 'Asia/Yangon',
  headless: true,

  outputFile: 'output.json',

  scroll: {
    stepRatio: 0.9,
    minStepPx: 450,
    waitMs: 700,
    maxNoNewStreak: 8,
    maxNoScrollStreak: 6,
    maxIterations: 500,
  },

  meta: {
    author: 'GGWP API',
    website: 'https://ggwp-api.render.com',
    country: 'Thailand',
    copyright: 'Legal action will be taken if any unauthorized use of our API is found.',
  },
};

const MYANMAR_UTC_OFFSET_MINUTES = 6 * 60 + 30; // UTC+06:30

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeSpace(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function fnv1a32(input) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function stableId(seed) {
  return fnv1a32(String(seed || '')) || 0;
}

function parseMyanmarOdds(raw) {
  const str = normalizeSpace(raw);
  if (!str) return null;

  // Examples: "=+15", "=-30", "1+75", "2-45"
  const match = str.match(/^(=|\d+(?:\.\d+)?)([+-])(\d{1,3})$/);
  if (!match) return null;

  const baseRaw = match[1];
  const signChar = match[2];
  const digits = Number.parseInt(match[3], 10);

  if (!Number.isFinite(digits)) return null;

  const sign = signChar === '-' ? -1 : 1;
  const fraction = Math.abs(digits) / 100;

  const base = baseRaw === '=' ? 0 : Number.parseFloat(baseRaw);
  if (!Number.isFinite(base)) return null;

  // Normalization rules:
  // "=+15" -> +0.15, "=-30" -> -0.30
  // "1+75" -> 1.75, "2-45" -> 2.45 (sign ignored for base numbers)
  const value = baseRaw === '=' ? sign * fraction : base + fraction;

  // Signed gap is always driven by the +/- portion.
  const gap = sign * fraction;

  return {
    raw: str,
    baseRaw,
    base,
    sign,
    digits,
    fraction,
    value,
    gap,
  };
}

function cleanLeagueName(raw) {
  const s = normalizeSpace(raw);
  if (!s) return '';
  // Often the UI appends a match count at the end, e.g. "England Premier League1"
  return s.replace(/\s*\d+\s*$/, '').replace(/\s*\(\s*\d+\s*\)\s*$/, '').trim();
}

function parseStartTimeToIsoUtc(startTimeText, nowUtc = new Date()) {
  const text = normalizeSpace(startTimeText).replace(/^Start Time\s*:/i, '').trim();

  const match = text.match(/^(\d{1,2})\/(\d{1,2})\s*-\s*(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
  if (!match) return null;

  const day = Number.parseInt(match[1], 10);
  const month = Number.parseInt(match[2], 10);
  const hour12 = Number.parseInt(match[3], 10);
  const minute = Number.parseInt(match[4], 10);
  const ampm = match[5].toUpperCase();

  if (![day, month, hour12, minute].every(Number.isFinite)) return null;
  if (month < 1 || month > 12) return null;
  if (day < 1 || day > 31) return null;
  if (hour12 < 1 || hour12 > 12) return null;
  if (minute < 0 || minute > 59) return null;

  let hour24 = hour12 % 12;
  if (ampm === 'PM') hour24 += 12;

  const offsetMs = MYANMAR_UTC_OFFSET_MINUTES * 60 * 1000;
  const nowMyanmar = new Date(nowUtc.getTime() + offsetMs);
  const baseYear = nowMyanmar.getUTCFullYear();

  const makeUtcMs = (year) => Date.UTC(year, month - 1, day, hour24, minute) - offsetMs;

  let utcMs = makeUtcMs(baseYear);

  // Year inference (handles Jan/Dec boundary)
  const dayMs = 24 * 60 * 60 * 1000;
  if (utcMs < nowUtc.getTime() - 200 * dayMs) utcMs = makeUtcMs(baseYear + 1);
  if (utcMs > nowUtc.getTime() + 200 * dayMs) utcMs = makeUtcMs(baseYear - 1);

  return new Date(utcMs).toISOString();
}

async function login(page) {
  const signInUrl = `${CONFIG.baseUrl}/sign-in`;

  const tryOnce = async (username) => {
    await page.goto(signInUrl, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#usercode', { timeout: 30_000 });
    await page.fill('#usercode', username);
    await page.fill('#password', CONFIG.password);
    await page.click('button[type="submit"]');
    try {
      await page.waitForFunction(() => !location.pathname.includes('sign-in'), null, { timeout: 45_000 });
      return true;
    } catch {
      return false;
    }
  };

  const attempts = [CONFIG.username, 'WAk1ly'].filter((v, idx, arr) => v && arr.indexOf(v) === idx);
  for (const username of attempts) {
    if (await tryOnce(username)) return;
  }

  throw new Error('Login failed (did not leave /sign-in).');
}

async function gotoBody(page) {
  await page.goto(`${CONFIG.baseUrl}/body`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => {
    const times = Array.from(document.querySelectorAll('time'));
    return times.some((t) => (t.textContent || '').includes('Start Time'));
  }, null, { timeout: 90_000 });
}

async function collectAllRawMatches(page) {
  const byKey = new Map();
  let noNewStreak = 0;
  let noScrollStreak = 0;

  // Reset scroll to top (best-effort)
  await page.evaluate(() => {
    const scrollables = Array.from(document.querySelectorAll('*')).filter((el) => {
      const style = window.getComputedStyle(el);
      const oy = style.overflowY;
      return (oy === 'auto' || oy === 'scroll') && el.scrollHeight > el.clientHeight + 50;
    });
    scrollables.sort((a, b) => (b.scrollHeight - b.clientHeight) - (a.scrollHeight - a.clientHeight));
    const scroller = scrollables[0] || document.scrollingElement || document.documentElement;
    scroller.scrollTop = 0;
  });

  for (let i = 0; i < CONFIG.scroll.maxIterations; i += 1) {
    const step = await page.evaluate(({ stepRatio, minStepPx }) => {
      function text(el) {
        return (el && el.textContent ? el.textContent : '').replace(/\\s+/g, ' ').trim();
      }

      function looksLikeLeagueName(value) {
        const s = value.trim();
        if (!s) return false;
        if (s.length > 80) return false;
        if (s.includes('Start Time')) return false;
        if (s.includes('ဂိုးပေါ်') || s.includes('ဂိုးအောက်')) return false;
        if (/^[=+0-9./\s-]+$/.test(s)) return false;
        if (!/[A-Za-z]/.test(s)) return false;
        return true;
      }

      function findLeagueName(card) {
        let cur = card;
        for (let depth = 0; depth < 10 && cur; depth += 1) {
          let sib = cur.previousElementSibling;
          while (sib) {
            const st = text(sib);
            if (looksLikeLeagueName(st)) return st;
            sib = sib.previousElementSibling;
          }
          cur = cur.parentElement;
        }
        return '';
      }

      const oddsLeafPattern = /^(=|\\d+(?:\\.\\d+)?)([+-])(\\d{1,3})$/;

      function isOddsLeaf(el) {
        if (!el || el.children.length !== 0) return false;
        return oddsLeafPattern.test(text(el));
      }

      function isLikelyOuOddsLeaf(el) {
        const p = el.parentElement;
        const gp = p && p.parentElement;
        const t1 = p ? text(p) : '';
        const t2 = gp ? text(gp) : '';
        return (t1.includes('ဂိုးပေါ်') || t1.includes('ဂိုးအောက်') || t2.includes('ဂိုးပေါ်') || t2.includes('ဂိုးအောက်')) && !t1.includes('Start Time');
      }

      function findCardRoot(timeEl) {
        let cur = timeEl;
        for (let depth = 0; depth < 12 && cur; depth += 1) {
          const t = text(cur);
          if (t.includes('Start Time') && (t.includes('ဂိုးပေါ်') || t.includes('ဂိုးအောက်'))) return cur;
          cur = cur.parentElement;
        }
        return null;
      }

      const times = Array.from(document.querySelectorAll('time')).filter((t) => text(t).includes('Start Time'));
      const rawMatches = [];
      const seenInView = new Set();

      for (const timeEl of times) {
        const card = findCardRoot(timeEl);
        if (!card) continue;

        const cardText = text(card);
        const status = (cardText.split('Start Time')[0] || '').trim();
        const leagueName = findLeagueName(card);

        const leaves = Array.from(card.querySelectorAll('span,div')).filter(isOddsLeaf);
        let handicapEl = null;
        let ouEl = null;

        for (const el of leaves) {
          if (isLikelyOuOddsLeaf(el)) {
            if (!ouEl) ouEl = el;
          } else {
            if (!handicapEl) handicapEl = el;
          }
        }

        const handicapText = handicapEl ? text(handicapEl) : '';
        const ouText = ouEl ? text(ouEl) : '';

        let homeName = '';
        let awayName = '';

        if (handicapEl) {
          const homeLine = handicapEl.parentElement;
          const homeLineText = homeLine ? text(homeLine) : '';
          homeName = homeLineText.replace(handicapText, '').trim();

          const awayLine = homeLine ? homeLine.nextElementSibling : null;
          if (awayLine) awayName = text(awayLine);

          if (!awayName && homeLine && homeLine.parentElement) {
            const candidates = Array.from(homeLine.parentElement.children).filter((c) => c !== homeLine);
            if (candidates[0]) awayName = text(candidates[0]);
          }
        }

        const startTimeText = text(timeEl);

        const key = `${leagueName}|${startTimeText}|${homeName}|${awayName}|${handicapText}|${ouText}|${status}`;
        if (seenInView.has(key)) continue;
        seenInView.add(key);

        rawMatches.push({
          leagueName,
          startTimeText,
          status,
          homeName,
          awayName,
          handicapText,
          ouText,
        });
      }

      const scrollables = Array.from(document.querySelectorAll('*')).filter((el) => {
        const style = window.getComputedStyle(el);
        const oy = style.overflowY;
        return (oy === 'auto' || oy === 'scroll') && el.scrollHeight > el.clientHeight + 50;
      });
      scrollables.sort((a, b) => (b.scrollHeight - b.clientHeight) - (a.scrollHeight - a.clientHeight));
      const scroller = scrollables[0] || document.scrollingElement || document.documentElement;

      const before = scroller.scrollTop;
      const maxScrollTop = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
      const atBottomBefore = before >= maxScrollTop - 2;

      if (!atBottomBefore) {
        const stepPx = Math.max(minStepPx, Math.floor(scroller.clientHeight * stepRatio));
        scroller.scrollTop = Math.min(maxScrollTop, before + stepPx);
      }

      const after = scroller.scrollTop;
      const atBottomAfter = after >= maxScrollTop - 2;

      return {
        rawMatches,
        scroll: {
          before,
          after,
          maxScrollTop,
          atBottom: atBottomAfter,
        },
      };
    }, { stepRatio: CONFIG.scroll.stepRatio, minStepPx: CONFIG.scroll.minStepPx });

    let added = 0;
    for (const m of step.rawMatches) {
      const league = cleanLeagueName(m.leagueName);
      const key = `${league}|${m.startTimeText}|${m.homeName}|${m.awayName}|${m.handicapText}|${m.ouText}|${m.status}`;
      if (byKey.has(key)) continue;
      byKey.set(key, { ...m, leagueName: league });
      added += 1;
    }

    if (added === 0) noNewStreak += 1;
    else noNewStreak = 0;

    if (step.scroll.after === step.scroll.before) noScrollStreak += 1;
    else noScrollStreak = 0;

    if (step.scroll.atBottom && noNewStreak >= 2 && noScrollStreak >= 2) break;
    if (noNewStreak >= CONFIG.scroll.maxNoNewStreak) break;
    if (noScrollStreak >= CONFIG.scroll.maxNoScrollStreak) break;

    await sleep(CONFIG.scroll.waitMs);
  }

  return Array.from(byKey.values());
}

function buildApiResponse(rawMatches) {
  const now = new Date();

  const response = {
    author: CONFIG.meta.author,
    website: CONFIG.meta.website,
    country: CONFIG.meta.country,
    copyright: CONFIG.meta.copyright,
    id: Date.now(),
    date: now.toISOString(),
    completed: false,
    matches: [],
  };

  const sorted = rawMatches.slice().sort((a, b) => {
    const la = a.leagueName || '';
    const lb = b.leagueName || '';
    if (la !== lb) return la.localeCompare(lb);
    return (a.startTimeText || '').localeCompare(b.startTimeText || '');
  });

  for (let i = 0; i < sorted.length; i += 1) {
    const raw = sorted[i];

    const leagueName = cleanLeagueName(raw.leagueName || '');
    const leagueId = stableId(`league:${leagueName}`);
    const league = { id: leagueId, leagueId: null, name: leagueName };

    const startIso = parseStartTimeToIsoUtc(raw.startTimeText, now) || now.toISOString();

    const finished = normalizeSpace(raw.status) === 'ပွဲပြီး';

    const hdp = parseMyanmarOdds(raw.handicapText);
    const handicap = hdp ? hdp.value : 0;
    const price = Math.abs(Math.round(handicap * 100));

    const ou = parseMyanmarOdds(raw.ouText);
    const goalTotal = ou ? ou.base : 0;
    const goalGap = ou ? ou.gap : 0;
    const goalTotalPrice = Math.abs(goalGap);

    const homeName = normalizeSpace(raw.homeName);
    const awayName = normalizeSpace(raw.awayName);

    const homeId = stableId(`team:${leagueId}:${homeName}`);
    const awayId = stableId(`team:${leagueId}:${awayName}`);

    const matchSeed = `${leagueName}|${startIso}|${homeName}|${awayName}|${raw.handicapText}|${raw.ouText}`;
    const matchId = stableId(`match:${matchSeed}`);

    const match = {
      id: i + 1,
      matchId,
      home: {
        id: homeId,
        teamId: null,
        name: homeName,
        engName: null,
        league,
      },
      away: {
        id: awayId,
        teamId: null,
        name: awayName,
        engName: null,
        league,
      },
      startTime: startIso,
      closeTime: startIso,
      odds: handicap,
      price,
      homeUpper: true,
      goalTotal,
      goalTotalPrice,
      homeScore: 0,
      awayScore: 0,
      finished,
      calculating: false,
      hdpFinished: false,
      ouFinished: false,
      canceled: false,
      bodyGap: handicap * 10,
      goalsGap: goalGap * 10,
      homeNo: i * 2 + 1,
      awayNo: i * 2 + 2,
      fixtureId: null,
      league,
      location: {
        id: 68,
        locationId: 1,
        name: '',
      },
      singleBet: true,
      highTax: false,
      active: true,
      status: 1,
      autoUpdate: false,
    };

    response.matches.push(match);
  }

  return response;
}

async function main() {
  const browser = await chromium.launch({ headless: CONFIG.headless });
  const context = await browser.newContext({ timezoneId: CONFIG.timezoneId });
  const page = await context.newPage();

  try {
    await login(page);
    await gotoBody(page);

    const rawMatches = await collectAllRawMatches(page);
    const apiResponse = buildApiResponse(rawMatches);

    const json = JSON.stringify(apiResponse, null, 2);
    await fs.writeFile(CONFIG.outputFile, json, 'utf8');
    process.stdout.write(`${json}\\n`);
  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

main().catch((err) => {
  process.stderr.write(`${err?.stack || String(err)}\\n`);
  process.exit(1);
});
