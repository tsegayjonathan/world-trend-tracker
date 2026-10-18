// Fetches all dashboard data and writes data/latest.json.
// Runs hourly in GitHub Actions; also runnable locally with `node scripts/update-data.mjs`.
// FRED_API_KEY is optional locally: without it, FRED's public CSV download is used instead.

import { writeFile, mkdir } from "node:fs/promises";

const FRED_KEY = process.env.FRED_API_KEY || "";
const UA = "world-trend-tracker (personal dashboard; github.com)";

// direction: which way is "good news" for an ordinary person. "neutral" = no colour.
const INDICATORS = [
  // Energy and prices
  { id: "DCOILBRENTEU", name: "Brent crude oil", group: "Energy & prices", unit: "$/barrel", fmt: "money", dp: 2, direction: "down",
    about: "Global oil benchmark. Feeds into fuel, shipping and airline costs worldwide." },
  { id: "CPIAUCSL", name: "Inflation (CPI)", group: "Energy & prices", unit: "% vs a year ago", fmt: "pct", dp: 1, transform: "yoy", direction: "down",
    about: "How much prices rose over the past 12 months. The Fed aims for about 2%." },
  { id: "CPILFESL", name: "Core inflation", group: "Energy & prices", unit: "% vs a year ago", fmt: "pct", dp: 1, transform: "yoy", direction: "down",
    about: "Inflation without food and energy. Shows the underlying trend." },
  { id: "GASREGW", name: "US gas price", group: "Energy & prices", unit: "$/gallon, weekly", fmt: "money", dp: 2, direction: "down",
    about: "Average regular gasoline at the pump." },
  { id: "DHHNGSP", name: "Natural gas (US)", group: "Energy & prices", unit: "$/MMBtu", fmt: "money", dp: 2, direction: "down",
    about: "Henry Hub price. Drives heating and electricity costs." },
  { id: "PFOODINDEXM", name: "World food prices", group: "Energy & prices", unit: "index, monthly", fmt: "num", dp: 1, direction: "down",
    about: "IMF global food price index. Spikes hit poorer countries hardest." },

  // Jobs and growth
  { id: "ICSA", name: "Jobless claims", group: "Jobs & growth", unit: "new claims, weekly", fmt: "compact", dp: 0, direction: "down",
    about: "People filing for unemployment each week. The fastest layoff warning sign." },
  { id: "UNRATE", name: "Unemployment rate", group: "Jobs & growth", unit: "%, monthly", fmt: "pct", dp: 1, direction: "down",
    about: "Share of people looking for work. A 0.5 point rise from its low has signalled recessions." },
  { id: "PCOPPUSDM", name: "Copper price", group: "Jobs & growth", unit: "$/tonne, monthly", fmt: "money", dp: 0, direction: "up",
    about: "\"Dr. Copper\": used in building and factories, so it tracks global industrial demand." },

  // Money and rates
  { id: "DFF", name: "Fed interest rate", group: "Money & rates", unit: "%", fmt: "pct", dp: 2, direction: "neutral",
    about: "The Federal Reserve's policy rate. Sets the cost of borrowing across the economy." },
  { id: "DGS10", name: "10-year Treasury yield", group: "Money & rates", unit: "%", fmt: "pct", dp: 2, direction: "down",
    about: "Long-term US borrowing cost. Drives mortgage and business loan rates." },
  { id: "T10Y2Y", name: "Yield curve (10y minus 2y)", group: "Money & rates", unit: "percentage points", fmt: "pp", dp: 2, direction: "up",
    about: "Below zero (inverted) has come before most US recessions." },
  { id: "MORTGAGE30US", name: "30-year mortgage rate", group: "Money & rates", unit: "%, weekly", fmt: "pct", dp: 2, direction: "down",
    about: "Average rate on a new 30-year fixed mortgage." },
  { id: "DTWEXBGS", name: "US dollar index", group: "Money & rates", unit: "index", fmt: "num", dp: 1, direction: "neutral",
    about: "Dollar vs major currencies. A strong dollar makes imports cheap but squeezes other countries." },

  // Fear and risk
  { id: "VIXCLS", name: "VIX fear gauge", group: "Market mood", unit: "index", fmt: "num", dp: 1, direction: "down",
    about: "Expected stock market swings. Under 15 is calm, over 30 is fear." },
];

const COINS = [
  { id: "pax-gold", name: "Gold", group: "Market mood", unit: "$/oz (via PAXG)", fmt: "money", dp: 0, direction: "neutral",
    about: "Safe-haven asset. Tends to rise when people are worried. Priced via the PAX Gold token, which tracks one ounce." },
  { id: "bitcoin", name: "Bitcoin", group: "Market mood", unit: "$", fmt: "money", dp: 0, direction: "neutral",
    about: "A gauge of speculative risk appetite." },
];

const FEEDS = [
  { source: "BBC World", url: "https://feeds.bbci.co.uk/news/world/rss.xml" },
  { source: "BBC Business", url: "https://feeds.bbci.co.uk/news/business/rss.xml" },
  { source: "Al Jazeera", url: "https://www.aljazeera.com/xml/rss/all.xml" },
  { source: "The Guardian", url: "https://www.theguardian.com/world/rss" },
  { source: "NPR World", url: "https://feeds.npr.org/1004/rss.xml" },
];

const ODDS_TAGS = ["economy", "geopolitics"];

const errors = {};

async function get(url, as = "json") {
  const res = await fetch(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url.replace(/api_key=[^&]+/, "api_key=***")}`);
  return as === "json" ? res.json() : res.text();
}

function isoDaysAgo(days) {
  return new Date(Date.now() - days * 864e5).toISOString().slice(0, 10);
}

async function fredSeries(id) {
  const start = isoDaysAgo(3 * 365);
  if (FRED_KEY) {
    const d = await get(`https://api.stlouisfed.org/fred/series/observations?series_id=${id}&api_key=${FRED_KEY}&file_type=json&observation_start=${start}`);
    return d.observations.filter(o => o.value !== ".").map(o => ({ date: o.date, value: Number(o.value) }));
  }
  const csv = await get(`https://fred.stlouisfed.org/graph/fredgraph.csv?id=${id}&cosd=${start}`, "text");
  return csv.trim().split("\n").slice(1)
    .map(line => line.split(","))
    .filter(([, v]) => v && v !== ".")
    .map(([date, v]) => ({ date, value: Number(v) }))
    .filter(o => Number.isFinite(o.value));
}

function yoy(obs) {
  const byMonth = new Map(obs.map(o => [o.date.slice(0, 7), o.value]));
  return obs.flatMap(o => {
    const [y, m] = o.date.split("-");
    const prev = byMonth.get(`${Number(y) - 1}-${m}`);
    return prev ? [{ date: o.date, value: (o.value / prev - 1) * 100 }] : [];
  });
}

function downsample(points, max = 120) {
  if (points.length <= max) return points;
  const step = points.length / max;
  const out = [];
  for (let i = 0; i < max - 1; i++) out.push(points[Math.floor(i * step)]);
  out.push(points[points.length - 1]);
  return out;
}

function summarize(meta, obs) {
  if (obs.length < 2) throw new Error("not enough data");
  const latest = obs[obs.length - 1];
  const prev = obs[obs.length - 2];
  const yearAgoDate = new Date(new Date(latest.date).getTime() - 365 * 864e5).toISOString().slice(0, 10);
  const yearAgo = [...obs].reverse().find(o => o.date <= yearAgoDate);
  const lastYear = obs.filter(o => o.date > yearAgoDate);
  const values = lastYear.map(o => o.value);
  return {
    ...meta,
    date: latest.date,
    value: latest.value,
    prevDate: prev.date,
    prevValue: prev.value,
    yearAgoValue: yearAgo ? yearAgo.value : null,
    low52: Math.min(...values),
    high52: Math.max(...values),
    history: downsample(lastYear).map(o => [o.date, Number(o.value.toFixed(4))]),
  };
}

async function indicators() {
  const out = [];
  for (const meta of INDICATORS) {
    try {
      let obs = await fredSeries(meta.id);
      if (meta.transform === "yoy") obs = yoy(obs);
      out.push({ ...summarize(meta, obs), source: "FRED", link: `https://fred.stlouisfed.org/series/${meta.id}` });
    } catch (e) {
      errors[meta.id] = String(e.message || e);
    }
  }
  for (const meta of COINS) {
    try {
      const d = await get(`https://api.coingecko.com/api/v3/coins/${meta.id}/market_chart?vs_currency=usd&days=365&interval=daily`);
      // CoinGecko's last point is "now"; keep one point per calendar day, latest wins.
      const byDay = new Map(d.prices.map(([ms, v]) => [new Date(ms).toISOString().slice(0, 10), v]));
      const obs = [...byDay].map(([date, value]) => ({ date, value }));
      out.push({ ...summarize(meta, obs), source: "CoinGecko", link: `https://www.coingecko.com/en/coins/${meta.id}` });
    } catch (e) {
      errors[meta.id] = String(e.message || e);
    }
  }
  return out;
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
    .replace(/\s+/g, " ")
    .trim();
}

function tag(item, name) {
  const m = item.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, "i"));
  return m ? decode(m[1]) : "";
}

async function news() {
  const all = [];
  for (const feed of FEEDS) {
    try {
      const xml = await get(feed.url, "text");
      const items = xml.match(/<item[\s>][\s\S]*?<\/item>/gi) || [];
      for (const item of items.slice(0, 15)) {
        const title = tag(item, "title");
        const link = tag(item, "link") || tag(item, "guid");
        const time = Date.parse(tag(item, "pubDate") || tag(item, "dc:date"));
        if (title && link) {
          let summary = tag(item, "description");
          if (summary === title) summary = "";
          if (summary.length > 240) summary = summary.slice(0, 237).replace(/\s+\S*$/, "") + "…";
          all.push({ title, link, source: feed.source, summary, time: Number.isFinite(time) ? new Date(time).toISOString() : null });
        }
      }
    } catch (e) {
      errors[feed.source] = String(e.message || e);
    }
  }
  const seen = new Set();
  return all
    .filter(n => !seen.has(n.title.toLowerCase()) && seen.add(n.title.toLowerCase()))
    .sort((a, b) => (b.time || "").localeCompare(a.time || ""))
    .slice(0, 60);
}

async function odds() {
  const out = [];
  const seen = new Set();
  for (const t of ODDS_TAGS) {
    try {
      const events = await get(`https://gamma-api.polymarket.com/events?tag_slug=${t}&active=true&closed=false&order=volume24hr&ascending=false&limit=8`);
      for (const e of events) {
        if (seen.has(e.slug)) continue;
        seen.add(e.slug);
        const markets = (e.markets || []).filter(m => m.active && !m.closed && m.outcomePrices);
        if (!markets.length) continue;
        const scored = markets.map(m => ({ label: m.groupItemTitle || "Yes", p: Number(JSON.parse(m.outcomePrices)[0]) }))
          .filter(m => Number.isFinite(m.p))
          .sort((a, b) => b.p - a.p);
        if (!scored.length) continue;
        out.push({
          topic: t,
          title: e.title,
          leader: markets.length === 1 ? "Yes" : scored[0].label,
          probability: scored[0].p,
          runnerUp: markets.length > 1 && scored[1] ? { label: scored[1].label, probability: scored[1].p } : null,
          volume24h: Math.round(e.volume24hr || 0),
          link: `https://polymarket.com/event/${e.slug}`,
        });
      }
    } catch (e) {
      errors[`polymarket:${t}`] = String(e.message || e);
    }
  }
  return out.slice(0, 12);
}

async function trending() {
  for (const back of [1, 2, 3, 4]) {
    const d = new Date(Date.now() - back * 864e5);
    const path = `${d.getUTCFullYear()}/${String(d.getUTCMonth() + 1).padStart(2, "0")}/${String(d.getUTCDate()).padStart(2, "0")}`;
    try {
      const j = await get(`https://wikimedia.org/api/rest_v1/metrics/pageviews/top/en.wikipedia/all-access/${path}`);
      delete errors.wikipedia;
      const skip = /^(Main_Page|Special:|Wikipedia:|Portal:|File:|Help:|Talk:|Category:|Template:|-|Cleopatra|XXX)/;
      return {
        date: path.replace(/\//g, "-"),
        articles: j.items[0].articles
          .filter(a => !skip.test(a.article) && !/^(Pornhub|XHamster|Xvideos|Bible)$/i.test(a.article))
          .slice(0, 12)
          .map(a => ({ title: a.article.replace(/_/g, " "), views: a.views, link: `https://en.wikipedia.org/wiki/${encodeURIComponent(a.article)}` })),
      };
    } catch (e) {
      errors.wikipedia = String(e.message || e);
    }
  }
  return null;
}

const [ind, nws, odd, trd] = await Promise.all([indicators(), news(), odds(), trending()]);
const data = {
  updated: new Date().toISOString(),
  fredMode: FRED_KEY ? "api" : "csv",
  indicators: ind,
  news: nws,
  odds: odd,
  trending: trd,
  errors,
};

await mkdir(new URL("../data/", import.meta.url), { recursive: true });
await writeFile(new URL("../data/latest.json", import.meta.url), JSON.stringify(data, null, 1));
console.log(`indicators ${ind.length}/${INDICATORS.length + COINS.length}, news ${nws.length}, odds ${odd.length}, trending ${trd?.articles.length ?? 0}`);
if (Object.keys(errors).length) console.log("errors:", errors);
if (ind.length === 0) process.exit(1);
