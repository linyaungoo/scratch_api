# SportsXZone odds -> HTAY-compatible API (Body/Goal)

This service:

1. Logs into `https://sportsxzone.com`
2. Opens `https://sportsxzone.com/body`
3. Captures the JSON payload used to render the odds
4. Transforms it into the same JSON *shape* as `https://htayapi.com/mmk-autokyay/body-goalboung`
5. Exposes it as a local/server API endpoint

## Requirements

- Node.js 18+
- Playwright Chromium (installed via `npm run install:browsers`)

## Setup (local)

```powershell
npm install
npm run install:browsers
Copy-Item .env.example .env
```

Edit `.env` and set at least:

- `SXZ_USERCODE` (or `SXZ_USERNAME`)
- `SXZ_PASSWORD` (or `SXZ_PASS`)

## Run (local)

```powershell
npm start
```

The server listens on `http://localhost:3000` by default (set `PORT` in `.env` to change it).

## Endpoints

- `GET /health` (shows scraper status)
- `GET /mmk-autokyay/body-goalboung` (HTAY-compatible response)

If the service has not scraped anything yet, the first request to `/mmk-autokyay/body-goalboung` may take a few seconds while it logs in and fetches data.

## Test with CMD / PowerShell

```powershell
curl.exe http://localhost:3000/health
curl.exe http://localhost:3000/mmk-autokyay/body-goalboung
```

PowerShell alternative:

```powershell
Invoke-RestMethod http://localhost:3000/health
Invoke-RestMethod http://localhost:3000/mmk-autokyay/body-goalboung
```

## Test with Postman

1. Create a new request
2. Method: `GET`
3. URL: `http://localhost:3000/mmk-autokyay/body-goalboung`
4. Send -> you should receive JSON with top keys: `author`, `website`, `country`, `id`, `date`, `matches`

## How to confirm scraping is working

### Option A: check `/health`

`GET /health` returns:

- `scraper.lastOk` -> `true` means the latest refresh worked
- `scraper.lastUpdatedAt` -> last refresh time
- `scraper.lastError` -> last error message (if any)

### Option B: run a one-off scrape

```powershell
npm run scrape:once
```

This prints:

- which payload was captured (GraphQL `operationName`)
- how many `matches` were found
- a preview of the HTAY-compatible output keys

## What payload is required (mapping notes)

The transformer expects the captured payload to contain:

- `data.matches[]`
- Each match should include:
  - `host_team_data.name_en` / `name_mm`
  - `guest_team_data.name_en` / `name_mm`
  - `league_data.name_en` / `name_mm`
  - `fixture_start_time` (ISO string)
  - `odds.full_time.hdp_mm_odds` (example: `1+80`)
  - `odds.full_time.ou_mm_odds` (example: `2+40`)
  - `odds.full_time.odds_team` (`home` / `away`)
  - `odds.full_time.is_published_mm_odds` (boolean)

If SportsXZone changes the payload shape, run `npm run discover` and update your filter settings.

## Troubleshooting / discovery

To list the network calls made after login + opening `/body`:

```powershell
npm run discover
```

Useful `.env` settings:

- `HEADLESS=false` (watch the browser while debugging)
- `POLL_INTERVAL_MS=10000` (how often it refreshes)
- `CAPTURE_WINDOW_MS=5000` (how long to listen for JSON responses after reload)
- `ODDS_URL_REGEX=...` / `ODDS_OPERATION_REGEX=...` (capture filters)

If login gets stuck, delete `data/storageState.json` and restart so it logs in again.

## Deploy on a server

Because this uses Playwright/Chromium, Docker is the easiest way to deploy reliably.

### Option A (recommended): Docker

1. Build:

```bash
docker build -t ggwp-api .
```

2. Run:

```bash
docker run --rm -p 3000:3000 --env-file .env ggwp-api
```

### Option B: Node process (Linux VPS)

On many Linux servers you'll need Playwright dependencies:

```bash
npm ci --omit=dev
npx playwright install --with-deps chromium
npm start
```

Then put it behind a process manager (pm2/systemd) and a reverse proxy (nginx) if needed.

