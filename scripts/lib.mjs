// Pure helpers used by update-data.mjs. No network access here, so they are easy to test.

const DAY = 864e5;

export const isoDaysAgo = (days, from = Date.now()) => new Date(from - days * DAY).toISOString().slice(0, 10);

const monthIndex = (date) => Number(date.slice(0, 4)) * 12 + Number(date.slice(5, 7)) - 1;
const monthKey = (i) => `${Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, "0")}`;

// Change vs the same month a year earlier. If that one month was never published (October 2025,
// during the US government shutdown) but the months either side exist, the base is estimated
// from them and the point is flagged estBase so the page can say so.
export function yoy(obs) {
  const byMonth = new Map(obs.map(o => [o.date.slice(0, 7), o.value]));
  return obs.flatMap(o => {
    const base = monthIndex(o.date) - 12;
    let prev = byMonth.get(monthKey(base)), estBase = false;
    if (!prev) {
      const a = byMonth.get(monthKey(base - 1)), b = byMonth.get(monthKey(base + 1));
      if (a && b) { prev = Math.sqrt(a * b); estBase = true; }
    }
    if (!prev) return [];
    const point = { date: o.date, value: (o.value / prev - 1) * 100 };
    return estBase ? [{ ...point, estBase: monthKey(base) }] : [point];
  });
}

// Inflation pace over the 3 months up to endDate, expressed as a yearly rate. Catches turns that
// year-over-year only shows months later. Returns null if the month 3 months back is missing,
// rather than passing off a longer stretch as 3 months.
export function annualized3m(levels, endDate = levels.at(-1)?.date) {
  const upTo = levels.filter(o => o.date <= endDate);
  const now = upTo.at(-1);
  if (!now) return null;
  const then = upTo.find(o => monthIndex(now.date) - monthIndex(o.date) === 3);
  return then ? ((now.value / then.value) ** 4 - 1) * 100 : null;
}

// Thins a long series for the charts while keeping each stretch's low and high, so spikes and
// record lows survive and the chart's "Low / High" stay true. Always keeps the latest point.
export function downsample(points, max, val = (p) => (typeof p === "number" ? p : p.value)) {
  if (points.length <= max) return points;
  const buckets = Math.floor((max - 1) / 2), size = (points.length - 1) / buckets, out = [];
  for (let b = 0; b < buckets; b++) {
    const start = Math.floor(b * size), end = Math.floor((b + 1) * size);
    let lo = start, hi = start;
    for (let k = start; k < end; k++) {
      if (val(points[k]) < val(points[lo])) lo = k;
      if (val(points[k]) > val(points[hi])) hi = k;
    }
    for (const k of lo === hi ? [lo] : [Math.min(lo, hi), Math.max(lo, hi)]) out.push(points[k]);
  }
  out.push(points[points.length - 1]);
  return out;
}

// Share of past readings at or below this one, 0-100. Ties count half so a flat series reads ~50.
export function percentileRank(values, v) {
  if (!values.length) return null;
  let below = 0, equal = 0;
  for (const x of values) {
    if (x < v) below++;
    else if (x === v) equal++;
  }
  return ((below + equal / 2) / values.length) * 100;
}

export function valueAtOrBefore(obs, isoDate) {
  for (let i = obs.length - 1; i >= 0; i--) if (obs[i].date <= isoDate) return obs[i];
  return null;
}

export function frequencyOf(obs) {
  if (obs.length < 3) return "unknown";
  const gaps = [];
  for (let i = Math.max(1, obs.length - 12); i < obs.length; i++) {
    gaps.push((Date.parse(obs[i].date) - Date.parse(obs[i - 1].date)) / DAY);
  }
  gaps.sort((a, b) => a - b);
  const median = gaps[Math.floor(gaps.length / 2)];
  if (median <= 3.5) return "daily";
  if (median <= 10) return "weekly";
  if (median <= 45) return "monthly";
  return "quarterly";
}

// "points" series (rates, percentages) change in percentage points; others in percent.
export function changeBetween(from, to, inPoints) {
  if (from == null || to == null) return null;
  return inPoints ? to - from : from === 0 ? null : (to / from - 1) * 100;
}

// How unusual is the latest one-period move, compared with this series' own history of moves?
// The period is one month for daily/weekly data and one release for monthly data.
export function moveZScore(obs, freq, inPoints) {
  const changes = [];
  if (freq === "monthly" || freq === "quarterly") {
    for (let i = 1; i < obs.length; i++) changes.push(changeBetween(obs[i - 1].value, obs[i].value, inPoints));
  } else {
    let j = 0;
    for (let i = 0; i < obs.length; i++) {
      const target = Date.parse(obs[i].date) - 30 * DAY;
      while (j < i && Date.parse(obs[j + 1].date) <= target) j++;
      if (Date.parse(obs[j].date) <= target) changes.push(changeBetween(obs[j].value, obs[i].value, inPoints));
    }
  }
  const clean = changes.filter(Number.isFinite);
  if (clean.length < 24) return null;
  const latest = clean[clean.length - 1];
  const mean = clean.reduce((a, b) => a + b, 0) / clean.length;
  const sd = Math.sqrt(clean.reduce((a, b) => a + (b - mean) ** 2, 0) / clean.length);
  return sd > 0 ? (latest - mean) / sd : null;
}

const SEVERITY = { good: 0, info: 0, watch: 1, alert: 2 };
export const worst = (levels) => levels.reduce((w, l) => (SEVERITY[l] > SEVERITY[w] ? l : w), "good");

const fmtPct = (v, dp = 1) => `${v.toFixed(dp)}%`;
const cap = (t) => t.charAt(0).toUpperCase() + t.slice(1);

// Where a reading sits in its own history. Records are worded from isHigh/isLow (exact), and
// percentages never say 0% or 100%, which can't be true when the reading is part of the history.
function rankPhrase(s, period, noun = "readings") {
  if (s.pctRank == null) return "";
  if (s.isHigh) return `the highest in ${period}`;
  if (s.isLow) return `the lowest in ${period}`;
  const above = s.pctRank >= 50;
  const p = Math.min(99, Math.max(1, Math.floor(above ? s.pctRank : 100 - s.pctRank)));
  return `${above ? "higher" : "lower"} than ${p}% of ${noun} in ${period}`;
}
const periodOf = (s) => (s.baselineYears > 1 ? `the last ${s.baselineYears} years` : "the last year");

function bandLabel(p, years) {
  const span = years >= 10 ? "10-yr" : `${years}-yr`;
  if (p >= 95) return `Near ${span} high`;
  if (p >= 75) return "High";
  if (p <= 5) return `Near ${span} low`;
  if (p <= 25) return "Low";
  return "Typical";
}

function moveSentence(s) {
  if (s.change1m == null) return "";
  const unit = s.inPoints ? `${Math.abs(s.change1m).toFixed(2)} pts` : fmtPct(Math.abs(s.change1m));
  const period = s.freq === "monthly" ? "since the previous month" : "over the past month";
  const dir = s.change1m > 0 ? "Up" : s.change1m < 0 ? "Down" : "Flat";
  const unusual = s.moveZ != null && Math.abs(s.moveZ) >= 2 ? ", a bigger move than usual" : "";
  return dir === "Flat" ? `Unchanged ${period}.` : `${dir} ${unit} ${period}${unusual}.`;
}

// Generic rule: where the value sits in its own history, which way is bad, and whether it just jumped.
function genericStatus(s, meta) {
  const p = s.pctRank;
  let level = "info";
  if (meta.direction === "down" && p >= 85) level = "watch";
  if (meta.direction === "up" && p <= 15) level = "watch";
  let label = p == null ? "Latest" : bandLabel(p, s.baselineYears);
  if (s.moveZ != null && Math.abs(s.moveZ) >= 2) {
    // Only a big move the bad way is a warning (oil falling fast is good news for most people).
    // Numbers with no good or bad direction get a "watch" at most.
    const neutral = meta.direction !== "up" && meta.direction !== "down";
    const bad = neutral || (meta.direction === "down") === (s.moveZ > 0);
    if (bad) {
      level = !neutral && Math.abs(s.moveZ) >= 3 ? "alert" : level === "alert" ? "alert" : "watch";
      label = s.moveZ > 0 ? "Sharp rise" : "Sharp drop";
    } else if (level === "info") {
      label = s.moveZ > 0 ? "Rising fast" : "Falling fast";
    }
  }
  const where = rankPhrase(s, periodOf(s));
  return { level, label, text: `${where ? cap(where) + ". " : ""}${moveSentence(s)}`.trim() };
}

export const RULES = {
  // The Fed's 2% goal is defined on PCE prices, so only the PCE tile is graded against "the goal".
  // CPI usually runs a little above PCE, but not always (in 2026 core PCE ran about 0.5 pts higher).
  CPIAUCSL: inflationRule("Prices", false),
  CPILFESL: inflationRule("Prices excluding food and energy", false),
  PCEPILFE: inflationRule("Prices excluding food and energy", true),

  SAHMREALTIME(s) {
    const v = Number(s.value.toFixed(2));
    const level = v >= 0.5 ? "alert" : v >= 0.3 ? "watch" : "good";
    const label = v >= 0.5 ? "Triggered" : v >= 0.3 ? "Getting close" : "No signal";
    const where = v <= 0
      ? "Unemployment (3-month average) is at its lowest level of the past year."
      : `Unemployment (3-month average) is ${v.toFixed(2)} pts above its low of the past year.`;
    return { level, label, text: `${where} At 0.5 this has flagged every US recession since 1970, plus one false alarm in 2024.` };
  },

  IC4WSA(s) {
    const v = s.value;
    const level = v >= 300000 ? "alert" : v >= 250000 ? "watch" : "good";
    const label = v >= 300000 ? "High" : v >= 250000 ? "Rising" : "Healthy";
    const k = Math.round(v / 1000);
    return { level, label, text: `About ${k}K new unemployment claims a week. Under 250K signals a healthy job market. ${moveSentence(s)}` };
  },

  UNRATE(s) {
    const d = s.change1y;
    const level = d != null && d >= 0.5 ? "alert" : d != null && d >= 0.2 ? "watch" : "good";
    const label = level === "alert" ? "Rising fast" : level === "watch" ? "Edging up" : "Steady";
    const yr = d == null ? "" : ` That's ${d > 0 ? "up" : d < 0 ? "down" : "unchanged"}${d ? ` ${Math.abs(d).toFixed(1)} pts` : ""} from a year ago.`;
    return { level, label, text: `${fmtPct(s.value)} of people who want a job can't find one.${yr}` };
  },

  T10Y2Y(s) {
    if (s.value < 0) {
      return { level: "watch", label: "Inverted", text: "Long-term rates are below short-term ones. This has come before most US recessions, but it says nothing about timing." };
    }
    if (s.minRecent != null && s.minRecent < 0) {
      return { level: "watch", label: "Recently un-inverted", text: "The curve turned positive after being inverted in the last 2 years. Past recessions often began around this point, though not always." };
    }
    return { level: "good", label: "Normal", text: "Long-term rates are above short-term ones, the normal healthy shape." };
  },

  VIXCLS(s) {
    const v = s.value;
    const [level, label] = v >= 30 ? ["alert", "Fear"] : v >= 20 ? ["watch", "Nervous"] : v >= 15 ? ["good", "Normal"] : ["good", "Calm"];
    return { level, label, text: `At ${v.toFixed(1)}. Under 20 is normal; over 30 means investors are scared. ${moveSentence(s)}` };
  },

  DFF(s) {
    const d = s.change90d;
    const label = d != null && d >= 0.2 ? "Recently raised" : d != null && d <= -0.2 ? "Recently cut" : "On hold";
    const how = d != null && Math.abs(d) >= 0.2 ? ` ${d > 0 ? "Up" : "Down"} ${Math.abs(d).toFixed(2)} pts in the last 3 months.` : " No change in the last 3 months.";
    return { level: "info", label, text: `The Fed's key rate is ${s.value.toFixed(2)}%.${how}` };
  },
};

// Bands around 2%. Too low is a warning too: falling prices usually mean a slump.
function inflationBand(v, fedMeasure) {
  if (v < 0) return ["watch", "Falling prices"];
  if (v < 1.5) return ["watch", fedMeasure ? "Below goal" : "Low"];
  if (v <= 2.5) return ["good", fedMeasure ? "Near 2% goal" : "Near 2%"];
  if (v <= 4) return ["watch", fedMeasure ? "Above goal" : "Above 2%"];
  return ["alert", "High"];
}
const goalWord = (v) => (v < 1.5 ? "below" : v <= 2.5 ? "close to" : "above");

function inflationRule(what, fedMeasure) {
  return (s) => {
    const v = s.value;
    const [level, label] = inflationBand(v, fedMeasure);
    let trend = "";
    if (s.momentum != null) {
      const m = s.momentum.toFixed(1);
      if (s.momentum > v + 0.5) trend = ` Speeding up: the last 3 months ran at a ${m}% yearly pace.`;
      else if (s.momentum < v - 0.5) trend = ` Cooling: the last 3 months ran at a ${m}% yearly pace.`;
      else trend = ` Steady: the last 3 months ran at a ${m}% yearly pace.`;
    }
    const goal = fedMeasure ? " (the Fed aims for 2%)" : "";
    return { level, label, text: `${what} are ${v < 0 ? "down" : "up"} ${fmtPct(Math.abs(v))} from a year ago${goal}.${trend}` };
  };
}

export function statusFor(meta, s) {
  return (RULES[meta.id] || genericStatus)(s, meta);
}

// One headline per theme, built from the tiles' own statuses so the top of the page and the tiles always agree.
export function buildSummary(byId) {
  const g = (id) => byId[id];
  const cards = [];
  const add = (theme, ids, text) => {
    const parts = ids.map(g).filter(Boolean);
    if (!parts.length || !text) return;
    const level = worst(parts.map(p => p.status.level));
    const lead = parts.find(p => p.status.level === level) || parts[0];
    // The lead tile comes first: the card links to the tile its label came from.
    cards.push({ theme, level, label: lead.status.label, text, ids: [lead, ...parts.filter(p => p !== lead)].map(p => p.id) });
  };

  const cpi = g("CPIAUCSL"), pce = g("PCEPILFE");
  if (cpi) {
    const pace = cpi.momentum != null ? `, at a ${fmtPct(cpi.momentum)} yearly pace over the last 3 months` : "";
    const goal = pce ? ` The Fed's own measure (core PCE) is ${fmtPct(pce.value)}, ${goalWord(pce.value)} its 2% goal.` : "";
    add("Prices", ["CPIAUCSL", "CPILFESL", "PCEPILFE"], `Prices are ${cpi.value < 0 ? "down" : "up"} ${fmtPct(Math.abs(cpi.value))} from a year ago${pace}.${goal}`);
  }

  const sahm = g("SAHMREALTIME"), claims = g("IC4WSA"), un = g("UNRATE");
  if (un) {
    const jobsLevel = worst([sahm, claims, un].filter(Boolean).map(x => x.status.level));
    const phrase = jobsLevel === "good" ? "The job market looks solid" : jobsLevel === "watch" ? "The job market is softening" : "The job market is flashing a recession warning";
    add("Jobs", ["SAHMREALTIME", "IC4WSA", "UNRATE"], `${phrase}: unemployment ${fmtPct(un.value)}${claims ? `, about ${Math.round(claims.value / 1000)}K weekly claims` : ""}.`);
  }

  const curve = g("T10Y2Y"), mort = g("MORTGAGE30US");
  if (curve || mort) {
    const bits = [];
    if (mort) {
      const jump = mort.moveZ != null && mort.moveZ >= 2 ? ", after an unusually sharp rise this month" : mort.moveZ != null && mort.moveZ <= -2 ? ", after an unusually sharp drop this month" : "";
      const rank = rankPhrase(mort, periodOf(mort), "weeks");
      bits.push(`Mortgages cost ${fmtPct(mort.value, 2)}${rank ? `, ${rank}` : ""}${jump}.`);
    }
    if (curve) bits.push(`Yield curve: ${curve.status.label.toLowerCase()}.`);
    add("Borrowing", ["T10Y2Y", "MORTGAGE30US", "DGS10"], bits.join(" "));
  }

  const vix = g("VIXCLS");
  if (vix) {
    const mood = { Calm: "Markets are calm", Normal: "Markets are steady", Nervous: "Investors are nervous", Fear: "Investors are fearful" }[vix.status.label] || "Markets";
    add("Markets", ["VIXCLS"], `${mood} (VIX fear gauge at ${vix.value.toFixed(1)}).`);
  }

  const oil = g("DCOILBRENTEU");
  if (oil) {
    const rank = rankPhrase(oil, periodOf(oil), "days");
    add("Energy", ["DCOILBRENTEU", "GASREGW"], `Brent oil is $${oil.value.toFixed(0)}${rank ? `, ${rank}` : ""}. ${moveSentence(oil)}`.trim());
  }

  return cards;
}

// ---- Prediction markets (Polymarket) ----

// One row per event. negRisk events are one question with competing answers ("Who will win?").
// Other multi-market events are ladders of separate yes/no questions ("below 4.45%?", "below 4.50%?";
// "by June?", "by December?") that overlap, so there is no leader or runner-up: show the rung nearest 50/50.
export function oddsRow(e, topic) {
  const scored = (e.markets || [])
    .filter(m => m.active && !m.closed && m.outcomePrices)
    .map(m => {
      let p = NaN;
      try { p = Number(JSON.parse(m.outcomePrices)[0]); } catch { /* malformed price list */ }
      return { label: m.groupItemTitle || "Yes", p };
    })
    .filter(m => Number.isFinite(m.p))
    .sort((a, b) => b.p - a.p);
  if (!scored.length) return null;
  const ladder = scored.length > 1 && e.negRisk !== true;
  const pick = ladder ? scored.reduce((a, b) => (Math.abs(b.p - 0.5) < Math.abs(a.p - 0.5) ? b : a)) : scored[0];
  return {
    topic,
    title: e.title,
    leader: scored.length === 1 ? "Yes" : pick.label,
    probability: pick.p,
    runnerUp: !ladder && scored[1] ? { label: scored[1].label, probability: scored[1].p } : null,
    volume24h: Math.round(e.volume24hr || 0),
    endDate: e.endDate || null,
    link: `https://polymarket.com/event/${encodeURIComponent(e.slug)}`,
  };
}

// Drops near-certain yes/no questions (99% or 1% "yes" tells you little; multi-answer ones stay),
// then alternates topics so world events show next to the economy. Each topic arrives most-traded first.
export function chooseOdds(rows, topics, max) {
  const useful = rows.filter(o => o.runnerUp || Math.max(o.probability, 1 - o.probability) < 0.97);
  const byTopic = topics.map(t => useful.filter(o => o.topic === t));
  const mixed = [];
  for (let i = 0; byTopic.some(list => i < list.length); i++) for (const list of byTopic) if (list[i]) mixed.push(list[i]);
  return mixed.slice(0, max);
}

// ---- News ----

const STOP = new Set("a an the and or of to in on at for from with by as is are was were be been it its this that after over into says say said amid new how why what who will can could would may more than about up out not no".split(" "));

const words = (title) => title.replace(/[‘’']/g, "").replace(/[^A-Za-z0-9 ]+/g, " ").split(/\s+/).filter(Boolean);
// Plural to singular so "strike" and "strikes", "price" and "prices" match ("across" stays).
const stem = (w) => w.toLowerCase().replace(/ies$/, "y").replace(/(?<!s)s$/, "");

export function keywords(title) {
  return new Set(words(title).map(w => w.toLowerCase()).filter(w => w.length > 2 && !STOP.has(w)).map(stem));
}

// Capitalised words after the first: usually names and places ("France", "Kolkata", "Zelensky").
export function names(title) {
  return new Set(words(title).slice(1).filter(w => /^[A-Z][a-z]/.test(w)).map(stem));
}

// Same story? Two headlines match when they share enough words relative to their length, or share
// three words including a name or place. Three generic words alone ("police", "clash",
// "protesters") don't make France's protests and Albania's the same story.
export function similar(a, b) {
  let shared = 0, sharedName = false;
  for (const w of a.kw) if (b.kw.has(w)) { shared++; if (a.names.has(w) && b.names.has(w)) sharedName = true; }
  const union = a.kw.size + b.kw.size - shared;
  if (!union) return false;
  return (shared >= 3 && (sharedName || shared / union > 0.2)) || (shared >= 2 && shared / union >= 0.34);
}

const TOPICS = [
  ["Conflict", /\b(wars?|military|troops|airstrikes?|missiles?|drones?|attacks?|attacked|ceasefire|army|militants?|rebels?|rebellion|houthis?|siege|coalition forces|(?<!water )bomb\w*|shelling|invasion|hostages?|soldiers?|navy|defen[cs]e|nato|gaza|west bank|ukraine|russia|israel\w*|hamas|hezbollah|sudan|conflict|fighting(?! for\b))\b/i],
  ["Economy", /\b(econom\w*|inflation|interest rates?|the fed|federal reserve|central bank|tariffs?|trade|markets?|stocks?|shares|prices?|jobs|unemployment|gdp|recession|(?<!west )banks?|banking|debt|budget|tax\w*|dollar|currenc\w*|investors?|compan\w*|business\w*|imports?|exports?)\b/i],
  ["Energy & climate", /\b(climate|energy|oil|gas|opec|tankers?|deforestation|emissions?|heatwaves?|wildfires?|bushfires?|floods?|flooding|storms?|hurricanes?|typhoons?|cyclones?|drought|earthquakes?|solar|nuclear|weather|power cuts?)\b/i],
  ["Politics", /\b(elections?|votes?|voters?|president|prime minister|parliament|congress|senate|ministers?|government|courts?|judges?|laws?|protests?|protesters|polic(y|ies)|campaign|party|sanctions?|diplomat\w*|summit|white house)\b/i],
  ["Health", /\b(health|virus|outbreaks?|vaccines?|diseases?|hospitals?|cancer|covid|flu|measles|cholera|mpox|ebola|drugs?|medical|doctors?|patients?)\b/i],
  ["Tech & science", /\b(ai|artificial intelligence|tech|technology|apple|google|microsoft|nvidia|openai|chips?|semiconductors?|space|nasa|rockets?|satellites?|cyber\w*|hack\w*|scien\w*|research\w*|robots?)\b/i],
];

// Tags from the headline; the summary is only used when the headline alone gives nothing,
// because summaries mention side topics that would mislabel the story. In a summary, words like
// "research", "satellite" or "medical" are usually incidental, so only the broad topics count there.
export function topicsFor(title, summary = "") {
  const t = TOPICS.filter(([, re]) => re.test(title)).map(([name]) => name);
  if (t.length) return t.slice(0, 2);
  const s = TOPICS.filter(([name, re]) => name !== "Tech & science" && name !== "Health" && re.test(summary)).map(([name]) => name);
  return s.length ? s.slice(0, 1) : ["World"];
}

// Groups the same story across outlets. A story several outlets carry is usually a bigger one.
export function clusterNews(items) {
  const clusters = [];
  for (const item of items) {
    const kw = { kw: keywords(item.title), names: names(item.title) };
    // Compare against each member (not a merged word bag) so one loose match can't snowball.
    const hit = clusters.find(c => !c.sources.has(item.source) && c.kws.some(k => similar(k, kw)));
    if (hit) {
      hit.items.push(item);
      hit.sources.add(item.source);
      hit.kws.push(kw);
    } else {
      clusters.push({ kws: [kw], items: [item], sources: new Set([item.source]) });
    }
  }
  return clusters;
}
