# World Trend Tracker

One page showing what's changing in the world: Brent oil, inflation, jobs, interest rates,
market mood, prediction-market odds, what people are reading, and world news.

Everything is free: data comes from free public sources, a GitHub Action refreshes it every hour,
and GitHub Pages hosts the site.

## What's on the page

- **Numbers** (FRED, CoinGecko): Brent oil, CPI and core inflation, gas, natural gas, world food prices,
  jobless claims, unemployment, copper, Fed rate, 10-year yield, yield curve, mortgage rate,
  dollar index, VIX, gold and bitcoin. Each tile shows the latest value, the change since the last
  reading and vs a year ago, a one-year chart, and what the number tells you.
- **Since your last visit**: the biggest moves since you last opened the page (stored in your browser).
- **What the crowd expects**: Polymarket odds on the economy and world events.
- **What the world is reading**: yesterday's most-read Wikipedia articles.
- **World news**: BBC, Al Jazeera, The Guardian and NPR headlines, filterable and searchable.

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
