# World Trend Tracker

One page showing what's changing in the world: Brent oil, inflation, jobs, interest rates,
market mood, prediction-market odds, what people are reading, and world news.

Everything is free: data comes from free public sources, a GitHub Action refreshes it every hour,
and GitHub Pages hosts the site.

## What's on the page

- **The world right now**: one plain-English line per theme (prices, jobs, borrowing, markets, energy)
  with an OK / watch / alert status.
- **Numbers** (FRED, CoinGecko): Brent oil, CPI and core inflation, gas, natural gas, world food prices,
  the Sahm-rule recession signal, jobless claims, unemployment, copper, Fed rate, 10-year yield,
  yield curve, mortgage rate, dollar index, VIX, gold and bitcoin. Each tile shows a status, the
  change over the past month and year, a 1/5/10-year chart with reference lines, where the value
  sits in its 10-year history, when it was released and when the next release is due.
- **Since your last visit**: the biggest moves and status changes since you last opened the page
  (stored in your browser).
- **World news**: BBC, Al Jazeera, The Guardian and NPR. Stories covered by several outlets are
  grouped as top stories; everything is tagged by topic and searchable.
- **What the crowd expects**: Polymarket odds on the economy and world events.
- **What the world is reading**: the most-read Wikipedia articles.

## How the logic works

The rules live in `scripts/lib.mjs` and are covered by `tests/lib.test.mjs` (run with
`node --test tests/*.test.mjs`; the hourly job runs them first).

- Known thresholds where they exist: Fed 2% inflation goal, Sahm rule 0.5, yield curve below 0,
  VIX 20/30, jobless claims 250K.
- Otherwise each number is compared with its own last 10 years (percentile rank).
- "Sharp rise/drop" = the latest one-month move is over 2 standard deviations from that number's
  usual monthly moves.
- Inflation momentum = last 3 months annualized, next to year-over-year.
- If a source fails, the previous good value is kept and marked "Delayed".

Background research: see the project's evaluation notes.

## Setup

1. Add your FRED key: **Settings > Secrets and variables > Actions > New repository secret**,
   name `FRED_API_KEY`. (Without it the job falls back to FRED's public CSV downloads.)
2. Turn on the site: **Settings > Pages**, Source "Deploy from a branch", branch `main`, folder `/ (root)`.
3. Run the data job once: **Actions > Update data > Run workflow**. After that it runs every hour.

The site will be at `https://<your-username>.github.io/world-trend-tracker/`.

## Changing what's tracked

Edit the `INDICATORS` list in `scripts/update-data.mjs`. Any FRED series ID works
(search at https://fred.stlouisfed.org). News feeds are in `FEEDS`.

## Run locally

```sh
node scripts/update-data.mjs   # writes data/latest.json
python3 -m http.server         # then open http://localhost:8000
```
