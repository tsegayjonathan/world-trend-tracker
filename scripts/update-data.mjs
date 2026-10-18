// Fetches all dashboard data and writes data/latest.json.
// Runs hourly in GitHub Actions; also runnable locally with `node scripts/update-data.mjs`.
// FRED_API_KEY is optional locally: without it, FRED's public CSV download is used instead.
//
// Safety: if a source fails, the last good copy from the previous data/latest.json is kept
// and marked as delayed, so one bad refresh never blanks the page.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import {
  isoDaysAgo, yoy, annualized3m, downsample, percentileRank, valueAtOrBefore, frequencyOf,
  changeBetween, moveZScore, statusFor, buildSummary, topicsFor, clusterNews, oddsRow, chooseOdds,
} from "./lib.mjs";

const FRED_KEY = (process.env.FRED_API_KEY || "").trim();
let fredKeyProblem = null;
const UA = "Mozilla/5.0 (compatible; world-trend-tracker/1.0; personal dashboard)";
const DATA_FILE = new URL("../data/latest.json", import.meta.url);
const HISTORY_YEARS = 10;

// direction: which way is "good news" for an ordinary person. "neutral" = no colour.
// refs: reference lines drawn on the chart.
const INDICATORS = [
  // Energy and prices
  { id: "DCOILBRENTEU", name: "Brent crude oil", group: "Energy & prices", unit: "$ per barrel", fmt: "money", dp: 2, direction: "down",
    about: "The global oil benchmark. It feeds into fuel, shipping, airline and food costs worldwide, usually within weeks." },
  { id: "CPIAUCSL", name: "Inflation (CPI)", group: "Energy & prices", unit: "% vs a year ago", fmt: "pct", dp: 1, transform: "yoy", direction: "down",
    refs: [{ value: 2, label: "2%" }],
    about: "How much US consumer prices rose over the past 12 months: the inflation number in the news. The Fed's 2% goal is set on a related measure (PCE, see \"Core PCE inflation\"). Seasonally adjusted; the latest month can be revised." },
  { id: "CPILFESL", name: "Core inflation (CPI)", group: "Energy & prices", unit: "% vs a year ago", fmt: "pct", dp: 1, transform: "yoy", direction: "down",
    refs: [{ value: 2, label: "2%" }],
    about: "CPI without food and energy, which swing a lot, so it shows the underlying trend." },
  { id: "PCEPILFE", name: "Core PCE inflation", group: "Energy & prices", unit: "% vs a year ago, Fed's measure", fmt: "pct", dp: 1, transform: "yoy", direction: "down",
    refs: [{ value: 2, label: "Fed goal 2%" }],
    about: "The measure the Federal Reserve's 2% goal is set on: personal consumption prices without food and energy. It covers more spending than CPI and is published a few weeks later." },
  { id: "GASREGW", name: "US gas price", group: "Energy & prices", unit: "$ per gallon, weekly", fmt: "money", dp: 2, direction: "down",
    about: "Average price of regular gasoline at the pump across the US." },
  { id: "DHHNGSP", name: "Natural gas (US)", group: "Energy & prices", unit: "$ per MMBtu", fmt: "money", dp: 2, direction: "down",
    about: "Henry Hub spot price. Drives heating and electricity bills. Very spiky in cold snaps." },
  { id: "PFOODINDEXM", name: "World food prices", group: "Energy & prices", unit: "index, monthly", fmt: "num", dp: 1, direction: "down",
    about: "IMF index of global food commodity prices. Spikes hit poorer countries hardest and have triggered unrest." },

  // Jobs and growth
  { id: "SAHMREALTIME", name: "Recession signal (Sahm rule)", group: "Jobs & growth", unit: "pts vs past-year low", fmt: "pp", dp: 2, direction: "down",
    refs: [{ value: 0.5, label: "Trigger 0.5" }],
    about: "Compares the 3-month average unemployment rate with its lowest point in the past year. A rise of 0.5 has marked the start of every US recession since 1970. It fired falsely in 2024, so treat it as a warning light, not proof." },
  { id: "IC4WSA", name: "Jobless claims", group: "Jobs & growth", unit: "new claims per week, 4-week average", fmt: "compact", dp: 0, direction: "down",
    refs: [{ value: 250000, label: "250K" }],
    about: "People filing for unemployment each week. The fastest signal of layoffs. The 4-week average smooths out holiday noise." },
  { id: "UNRATE", name: "Unemployment rate", group: "Jobs & growth", unit: "%, monthly", fmt: "pct", dp: 1, direction: "down",
    about: "Share of people who want a job but can't find one." },
  { id: "PCOPPUSDM", name: "Copper price", group: "Jobs & growth", unit: "$ per tonne, monthly", fmt: "money", dp: 0, direction: "up",
    about: "\"Dr. Copper\": used in construction, cars and factories, so it tracks global industrial demand." },

  // Money and rates
  { id: "DFF", name: "Fed interest rate", group: "Money & rates", unit: "%", fmt: "pct", dp: 2, direction: "neutral",
    about: "The Federal Reserve's policy rate. Sets the cost of borrowing across the economy. See the odds panel for what markets expect next." },
  { id: "DGS10", name: "10-year Treasury yield", group: "Money & rates", unit: "%", fmt: "pct", dp: 2, direction: "down",
    about: "What the US government pays to borrow for 10 years. Drives mortgage and business loan rates." },
  { id: "T10Y2Y", name: "Yield curve (10y minus 2y)", group: "Money & rates", unit: "percentage points", fmt: "pp", dp: 2, direction: "up",
    refs: [{ value: 0, label: "Inverted below 0" }],
    about: "The gap between long and short-term rates. Below zero (inverted) has come before most US recessions, often by a year or more. It doesn't predict timing." },
  { id: "MORTGAGE30US", name: "30-year mortgage rate", group: "Money & rates", unit: "%, weekly", fmt: "pct", dp: 2, direction: "down",
    about: "Average rate on a new 30-year fixed mortgage in the US (Freddie Mac survey)." },
  { id: "DTWEXBGS", name: "US dollar index", group: "Money & rates", unit: "index", fmt: "num", dp: 1, direction: "neutral",
    about: "Dollar vs a basket of major currencies. A strong dollar makes imports cheaper for Americans but squeezes other countries that borrow in dollars." },

  // Fear and risk
  { id: "VIXCLS", name: "VIX fear gauge", group: "Market mood", unit: "index", fmt: "num", dp: 1, direction: "down",
    refs: [{ value: 20, label: "20" }, { value: 30, label: "Fear 30" }],
    about: "How big a swing investors expect in US stocks over the next month. Under 20 is normal, over 30 is fear." },
];

const COINS = [
  { id: "pax-gold", name: "Gold", group: "Market mood", unit: "$ per ounce (via PAXG)", fmt: "money", dp: 0, direction: "neutral",
    about: "Safe-haven asset that tends to rise when people are worried. Priced via the PAX Gold token, which is backed by one ounce." },
  { id: "bitcoin", name: "Bitcoin", group: "Market mood", unit: "$", fmt: "money", dp: 0, direction: "neutral",
    about: "A gauge of speculative risk appetite. Very volatile." },
];

const FEEDS = [
  { source: "BBC", url: "https://feeds.bbci.co.uk/news/world/rss.xml" },
  { source: "BBC", url: "https://feeds.bbci.co.uk/news/business/rss.xml" },
  { source: "Al Jazeera", url: "https://www.aljazeera.com/xml/rss/all.xml" },
  { source: "The Guardian", url: "https://www.theguardian.com/world/rss" },
  { source: "NPR", url: "https://feeds.npr.org/1004/rss.xml" },
];

const ODDS_TAGS = ["economy", "geopolitics"];

const errors = {};

async function get(url, as = "json") {
  const res = await fetch(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(30000) });
  if (!res.ok) {
    const body = (await res.text().catch(() => "")).slice(0, 300);
    const detail = body.match(/"error_message"\s*:\s*"([^"]+)"/)?.[1] || "";
    const msg = `HTTP ${res.status} for ${url.replace(/api_key=[^&]+/, "api_key=***")}${detail ? `: ${detail}` : ""}`;
    throw Object.assign(new Error(msg), { status: res.status, detail });
  }
  return as === "json" ? res.json() : res.text();
}

const fredUrl = (path, params) =>
  `https://api.stlouisfed.org/fred/${path}?${new URLSearchParams({ ...params, api_key: FRED_KEY, file_type: "json" })}`;

// Uses the official API when a key is set; falls back to the public CSV if the key is missing or rejected.
async function fredSeries(id) {
  const start = isoDaysAgo(HISTORY_YEARS * 365 + 400);
  if (FRED_KEY && !fredKeyProblem) {
    try {
      const d = await get(fredUrl("series/observations", { series_id: id, observation_start: start }));
      return d.observations.filter(o => o.value !== ".").map(o => ({ date: o.date, value: Number(o.value) })).filter(o => Number.isFinite(o.value));
    } catch (e) {
      // Only FRED's own "bad api_key" answer means the key is wrong. Anything else (a 500, a timeout)
      // is a one-off: use the CSV for this series and keep the API for the rest.
      if (e.status === 400 && /api_key/i.test(e.detail || "")) fredKeyProblem = e.message;
    }
  }
  const csv = await get(`https://fred.stlouisfed.org/graph/fredgraph.csv?id=${id}&cosd=${start}`, "text");
  return csv.trim().split("\n").slice(1)
    .map(line => line.split(","))
    .filter(([, v]) => v && v !== ".")
    .map(([date, v]) => ({ date, value: Number(v) }))
    .filter(o => Number.isFinite(o.value));
}

// Next scheduled release for a series (needs the API key). Cached per release.
const releaseCache = new Map();
async function nextRelease(id) {
  if (!FRED_KEY || fredKeyProblem) return null;
  try {
    const r = await get(fredUrl("series/release", { series_id: id }));
    const rel = r.releases?.[0];
    if (!rel) return null;
    if (!releaseCache.has(rel.id)) {
      const d = await get(fredUrl("release/dates", {
        release_id: rel.id, realtime_start: isoDaysAgo(0), include_release_dates_with_no_data: "true", sort_order: "asc", limit: "5",
      }));
      const today = isoDaysAgo(0);
      const next = d.release_dates?.map(x => x.date).find(dt => dt > today) || null;
      releaseCache.set(rel.id, next ? { date: next, release: rel.name } : null);
    }
    return releaseCache.get(rel.id);
  } catch (e) {
    errors[`release:${id}`] = String(e.message || e);
    return null;
  }
}

// Beyond normal publishing lag (some monthly series arrive ~3 months late, daily FX ~1 week late).
const STALE_AFTER_DAYS = { daily: 12, weekly: 16, monthly: 125, quarterly: 220, unknown: 30 };

// Turns raw observations into everything the page shows for one number.
function analyze(meta, rawObs, levels) {
  const obs = meta.transform === "yoy" ? yoy(rawObs) : rawObs;
  if (obs.length < 2) throw new Error("not enough data");
  const inPoints = meta.fmt === "pct" || meta.fmt === "pp";
  const freq = frequencyOf(obs);
  const latest = obs[obs.length - 1];
  const prev = obs[obs.length - 2];
  const at = (days) => valueAtOrBefore(obs, isoDaysAgo(days, Date.parse(latest.date)));
  const gapDays = (a, b) => (Date.parse(b.date) - Date.parse(a.date)) / 864e5;

  const baseline = obs.filter(o => o.date > isoDaysAgo(HISTORY_YEARS * 365, Date.parse(latest.date)));
  const baselineYears = Math.max(1, Math.round((Date.parse(latest.date) - Date.parse(baseline[0].date)) / (365 * 864e5)));
  const lastYear = obs.filter(o => o.date > isoDaysAgo(365, Date.parse(latest.date)));
  // "vs prior month" only when the prior release really is the month before (a skipped month isn't).
  const monthAgo = freq === "monthly" ? (gapDays(prev, latest) <= 35 ? prev : null) : freq === "quarterly" ? prev : at(30);
  // CoinGecko's free year starts a day short of 365 days back, so accept a first point within 3 days.
  const yearAgo = at(365) || (gapDays(obs[0], latest) >= 362 ? obs[0] : null);
  const twoYears = obs.filter(o => o.date > isoDaysAgo(730, Date.parse(latest.date)));

  const s = {
    ...meta,
    inPoints,
    freq,
    date: latest.date,
    value: latest.value,
    prevDate: prev.date,
    prevValue: prev.value,
    change1m: monthAgo ? changeBetween(monthAgo.value, latest.value, inPoints) : null,
    change1y: yearAgo ? changeBetween(yearAgo.value, latest.value, inPoints) : null,
    change90d: at(90) ? latest.value - at(90).value : null,
    yearAgoValue: yearAgo ? yearAgo.value : null,
    // Same month as the headline number, even when the raw levels run a month further.
    momentum: meta.transform === "yoy" && levels ? annualized3m(levels, latest.date) : null,
    pctRank: baseline.length > 20 ? percentileRank(baseline.map(o => o.value), latest.value) : null,
    isHigh: baseline.length > 20 && baseline.every(o => o.value <= latest.value),
    isLow: baseline.length > 20 && baseline.every(o => o.value >= latest.value),
    baselineYears,
    moveZ: moveZScore(baseline, freq, inPoints),
    minRecent: Math.min(...twoYears.map(o => o.value)),
    low52: Math.min(...lastYear.map(o => o.value)),
    high52: Math.max(...lastYear.map(o => o.value)),
    stale: (Date.now() - Date.parse(latest.date)) / 864e5 > STALE_AFTER_DAYS[freq],
    h1: downsample(lastYear, 260).map(o => [o.date, round(o.value)]),
    h10: downsample(baseline, 400).map(o => [o.date, round(o.value)]),
  };
  s.status = statusFor(meta, s);
  if (latest.estBase) {
    const missing = new Date(latest.estBase + "-15").toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
    s.status.text += ` ${missing} was never published (US government shutdown), so the year-ago level is estimated from the months either side.`;
  }
  return s;
}

const round = (v) => Number(v.toPrecision(6));
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function validate(ind) {
  const ok = Number.isFinite(ind.value) && ind.h1.length >= 2 && ind.date <= isoDaysAgo(-2);
  if (!ok) throw new Error(`failed sanity check (value ${ind.value}, date ${ind.date})`);
  return ind;
}

async function indicators(previous) {
  const out = [];
  const keepPrevious = (id, e) => {
    errors[id] = String(e.message || e);
    const old = previous.find(p => p.id === id && p.status); // only reuse entries in the current format
    if (old) out.push({ ...old, next: null, stale: true, fetchFailed: true });
  };
  for (const meta of INDICATORS) {
    try {
      const raw = await fredSeries(meta.id);
      const ind = validate(analyze(meta, raw, meta.transform === "yoy" ? raw : null));
      ind.next = ind.freq === "daily" ? null : await nextRelease(meta.id);
      out.push({ ...ind, source: "FRED", link: `https://fred.stlouisfed.org/series/${meta.id}` });
    } catch (e) {
      keepPrevious(meta.id, e);
    }
  }
  for (const meta of COINS) {
    try {
      // CoinGecko's keyless tier rate-limits bursts: space calls out and retry once.
      await sleep(2500);
      const url = `https://api.coingecko.com/api/v3/coins/${meta.id}/market_chart?vs_currency=usd&days=365&interval=daily`;
      const d = await get(url).catch(async (e) => { if (!/HTTP 429/.test(e.message)) throw e; await sleep(20000); return get(url); });
      // The free plan gives one year; the last point is "now". One point per day, latest wins.
      const byDay = new Map(d.prices.map(([ms, v]) => [new Date(ms).toISOString().slice(0, 10), v]));
      const obs = [...byDay].map(([date, value]) => ({ date, value }));
      out.push({ ...validate(analyze(meta, obs)), source: "CoinGecko", link: `https://www.coingecko.com/en/coins/${meta.id}` });
    } catch (e) {
      keepPrevious(meta.id, e);
    }
  }
  const order = [...INDICATORS, ...COINS].map(m => m.id);
  return out.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
}

function decode(s) {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/<[^>]+>/g, "")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(n))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/&quot;/g, '"').replace(/&apos;|&#39;/g, "'")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&")
    .replace(/<[^>]+>/g, " ") // feeds that entity-encode their HTML
    .replace(/[​-‍⁠﻿]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function tag(item, name) {
  const m = item.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, "i"));
  return m ? decode(m[1]) : "";
}

// Some feeds (The Guardian) put the standfirst, related links and the article body in one
// description as HTML. The first paragraph is the summary.
function summaryOf(item) {
  const raw = item.match(/<description[^>]*>([\s\S]*?)<\/description>/i)?.[1] || "";
  const html = raw.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
  return decode(html.match(/<p>([\s\S]*?)<\/p>/i)?.[1] ?? html);
}

async function news(previous) {
  const all = [];
  for (const feed of FEEDS) {
    try {
      const xml = await get(feed.url, "text");
      const items = xml.match(/<item[\s>][\s\S]*?<\/item>/gi) || [];
      const fromFeed = [];
      for (const item of items) {
        const title = tag(item, "title");
        const link = tag(item, "link") || tag(item, "guid");
        const time = Date.parse(tag(item, "pubDate") || tag(item, "dc:date"));
        // Only web links: a feed can't slip a "javascript:" link onto the page.
        if (!title || !/^https?:\/\//i.test(link)) continue;
        let summary = summaryOf(item);
        if (summary === title) summary = "";
        // Strip feed boilerplate ("Get our ... email, free app or daily news podcast", "Continue reading").
        summary = summary.replace(/\s*Get our [^.]*?(podcast|newsletter)\b\s*/gi, " ").replace(/\s*Continue reading.*$/i, "").trim();
        if (summary.length > 240) summary = summary.slice(0, 237).replace(/\s+\S*$/, "") + "…";
        fromFeed.push({ title, link, source: feed.source, summary, time: Number.isFinite(time) ? new Date(time).toISOString() : null });
      }
      // Feeds aren't always in time order (The Guardian's isn't), so take each feed's newest items.
      all.push(...fromFeed.sort((a, b) => (b.time || "").localeCompare(a.time || "")).slice(0, 25));
    } catch (e) {
      errors[`feed:${feed.url}`] = String(e.message || e);
    }
  }
  if (!all.length) return previous;

  const seen = new Set();
  const fresh = all
    .filter(n => !seen.has(n.link) && !seen.has(n.title.toLowerCase()) && seen.add(n.link) && seen.add(n.title.toLowerCase()))
    .filter(n => !n.time || Date.now() - Date.parse(n.time) < 3 * 864e5)
    .sort((a, b) => (b.time || "").localeCompare(a.time || ""));

  return clusterNews(fresh).slice(0, 70).map(c => {
    const lead = c.items[0];
    return {
      ...lead,
      topics: topicsFor(lead.title, lead.summary),
      coverage: c.sources.size,
      alsoIn: c.items.slice(1).map(i => ({ source: i.source, link: i.link, title: i.title })),
    };
  });
}

async function odds(previous) {
  const out = [];
  const seen = new Set();
  for (const t of ODDS_TAGS) {
    try {
      const events = await get(`https://gamma-api.polymarket.com/events?tag_slug=${t}&active=true&closed=false&order=volume24hr&ascending=false&limit=10`);
      for (const e of events) {
        if (seen.has(e.slug)) continue;
        seen.add(e.slug);
        const row = oddsRow(e, t);
        if (row) out.push(row);
      }
    } catch (e) {
      errors[`polymarket:${t}`] = String(e.message || e);
    }
  }
  const chosen = chooseOdds(out, ODDS_TAGS, 10);
  return chosen.length ? chosen : previous;
}

async function trending(previous) {
  const skip = /^(Main_Page|Special:|Wikipedia:|Portal:|File:|Help:|Talk:|Category:|Template:|User:|-$)/;
  const adult = /^(Pornhub|XHamster|Xvideos|XXX|OnlyFans|Cleopatra)$/i;
  for (const back of [1, 2, 3, 4]) {
    const d = new Date(Date.now() - back * 864e5);
    const path = `${d.getUTCFullYear()}/${String(d.getUTCMonth() + 1).padStart(2, "0")}/${String(d.getUTCDate()).padStart(2, "0")}`;
    try {
      const j = await get(`https://wikimedia.org/api/rest_v1/metrics/pageviews/top/en.wikipedia/all-access/${path}`);
      return {
        date: path.replace(/\//g, "-"),
        articles: j.items[0].articles
          .filter(a => !skip.test(a.article) && !adult.test(a.article))
          .slice(0, 12)
          .map(a => ({ title: a.article.replace(/_/g, " "), views: a.views, link: `https://en.wikipedia.org/wiki/${encodeURIComponent(a.article)}` })),
      };
    } catch {
      // Wikimedia publishes each day's list a day or two late; try the day before.
    }
  }
  errors.wikipedia = "no recent top-articles list";
  return previous;
}

let previous = {};
try { previous = JSON.parse(await readFile(DATA_FILE, "utf8")); } catch { /* first run */ }

const [ind, nws, odd, trd] = await Promise.all([
  indicators(previous.indicators || []),
  news(previous.news || []),
  odds(previous.odds || []),
  trending(previous.trending || null),
]);
const byId = Object.fromEntries(ind.map(i => [i.id, i]));

const data = {
  updated: new Date().toISOString(),
  fredMode: FRED_KEY && !fredKeyProblem ? "api" : "csv",
  fredKeyProblem,
  summary: buildSummary(byId),
  indicators: ind,
  news: nws,
  odds: odd,
  trending: trd,
  errors,
};

await mkdir(new URL("../data/", import.meta.url), { recursive: true });
await writeFile(DATA_FILE, JSON.stringify(data));
const failed = ind.filter(i => i.fetchFailed).length;
console.log(`indicators ${ind.length}/${INDICATORS.length + COINS.length} (${failed} kept from last run), news ${nws.length}, odds ${odd.length}, trending ${trd?.articles?.length ?? 0}`);
if (fredKeyProblem) console.log("::warning::FRED rejected the FRED_API_KEY secret, used public CSV instead. " + fredKeyProblem);
if (Object.keys(errors).length) console.log("errors:", errors);
if (ind.length === 0) process.exit(1);
