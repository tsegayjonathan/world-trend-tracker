// Pure helpers used by update-data.mjs. No network access here, so they are easy to test.

const DAY = 864e5;

export const isoDaysAgo = (days, from = Date.now()) => new Date(from - days * DAY).toISOString().slice(0, 10);

export function yoy(obs) {
  const byMonth = new Map(obs.map(o => [o.date.slice(0, 7), o.value]));
  return obs.flatMap(o => {
    const [y, m] = o.date.split("-");
    const prev = byMonth.get(`${Number(y) - 1}-${m}`);
    return prev ? [{ date: o.date, value: (o.value / prev - 1) * 100 }] : [];
  });
}

// Inflation pace over the latest 3 months, expressed as a yearly rate. Catches turns that
// year-over-year only shows months later.
export function annualized3m(levels) {
  if (levels.length < 4) return null;
  const now = levels[levels.length - 1].value;
  const then = levels[levels.length - 4].value;
  return ((now / then) ** 4 - 1) * 100;
}

export function downsample(points, max) {
  if (points.length <= max) return points;
  const step = (points.length - 1) / (max - 1);
  return Array.from({ length: max }, (_, i) => points[Math.round(i * step)]);
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
const ord = (p) => `${Math.round(p)}%`;

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
    level = Math.abs(s.moveZ) >= 3 ? "alert" : level === "alert" ? "alert" : "watch";
    label = s.moveZ > 0 ? "Sharp rise" : "Sharp drop";
  }
  const span = s.baselineYears > 1 ? `${s.baselineYears} years` : "year";
  const where = p == null ? "" : `Higher than ${ord(p)} of readings in the last ${span}. `;
  return { level, label, text: `${where}${moveSentence(s)}`.trim() };
}

export const RULES = {
  CPIAUCSL: inflationRule("Prices"),
  CPILFESL: inflationRule("Prices excluding food and energy"),

  SAHMREALTIME(s) {
    const v = s.value;
    const level = v >= 0.5 ? "alert" : v >= 0.3 ? "watch" : "good";
    const label = v >= 0.5 ? "Triggered" : v >= 0.3 ? "Getting close" : "No signal";
    return {
      level, label,
      text: `Unemployment is ${v.toFixed(2)} pts above its recent low. At 0.5 this has flagged every US recession since 1970, plus one false alarm in 2024.`,
    };
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

function inflationRule(what) {
  return (s) => {
    const v = s.value;
    const level = v <= 2.5 ? "good" : v <= 4 ? "watch" : "alert";
    const label = v <= 2.5 ? "Near 2% goal" : v <= 4 ? "Above goal" : "High";
    let trend = "";
    if (s.momentum != null) {
      const m = s.momentum.toFixed(1);
      if (s.momentum > v + 0.5) trend = ` Speeding up: the last 3 months ran at a ${m}% yearly pace.`;
      else if (s.momentum < v - 0.5) trend = ` Cooling: the last 3 months ran at a ${m}% yearly pace.`;
      else trend = ` Steady: the last 3 months ran at a ${m}% yearly pace.`;
    }
    return { level, label, text: `${what} are up ${fmtPct(v)} from a year ago (the Fed aims for 2%).${trend}` };
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
    cards.push({ theme, level, label: lead.status.label, text, ids: parts.map(p => p.id) });
  };

  const cpi = g("CPIAUCSL");
  if (cpi) add("Prices", ["CPIAUCSL", "CPILFESL"], `Inflation is ${fmtPct(cpi.value)}${cpi.status.level === "good" ? ", close to the Fed's 2% goal" : ", above the Fed's 2% goal"}.${cpi.momentum != null ? ` Recent pace: ${fmtPct(cpi.momentum)} a year.` : ""}`);

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
      bits.push(`Mortgages cost ${fmtPct(mort.value, 2)}${mort.pctRank != null ? `, higher than ${ord(mort.pctRank)} of the last 10 years` : ""}${jump}.`);
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
  if (oil) add("Energy", ["DCOILBRENTEU", "GASREGW"], `Brent oil is $${oil.value.toFixed(0)}${oil.pctRank != null ? `, higher than ${ord(oil.pctRank)} of days in 10 years` : ""}. ${moveSentence(oil)}`);

  return cards;
}

// ---- News ----

const STOP = new Set("a an the and or of to in on at for from with by as is are was were be been it its this that after over into says say said amid new how why what who will can could would may more than about up out not no".split(" "));

export function keywords(title) {
  return new Set(
    title.toLowerCase().replace(/[‘’']/g, "").replace(/[^a-z0-9 ]+/g, " ").split(/\s+/)
      .filter(w => w.length > 2 && !STOP.has(w))
      .map(w => w.replace(/(ies|es|s)$/, ""))
  );
}

export function similar(a, b) {
  let shared = 0;
  for (const w of a) if (b.has(w)) shared++;
  const union = a.size + b.size - shared;
  return shared >= 3 || (shared >= 2 && union > 0 && shared / union >= 0.34);
}

const TOPICS = [
  ["Conflict", /\b(wars?|military|troops|airstrikes?|missiles?|drones?|attacks?|attacked|ceasefire|army|militants?|rebels?|rebellion|houthis?|siege|coalition forces|bomb\w*|shelling|invasion|hostages?|soldiers?|navy|defen[cs]e|nato|gaza|ukraine|russia|israel\w*|hamas|hezbollah|sudan|conflict|fighting)\b/i],
  ["Economy", /\b(econom\w*|inflation|interest rates?|the fed|federal reserve|central bank|tariffs?|trade|markets?|stocks?|shares|prices?|jobs|unemployment|gdp|recession|banks?|banking|debt|budget|tax\w*|dollar|currenc\w*|investors?|compan\w*|business\w*|imports?|exports?)\b/i],
  ["Energy & climate", /\b(climate|energy|oil|gas|opec|tankers?|deforestation|emissions?|heatwaves?|wildfires?|floods?|flooding|storms?|hurricanes?|typhoons?|cyclones?|drought|earthquakes?|solar|nuclear|weather|power cuts?)\b/i],
  ["Politics", /\b(elections?|votes?|voters?|president|prime minister|parliament|congress|senate|ministers?|government|courts?|judges?|laws?|protests?|protesters|polic(y|ies)|campaign|party|sanctions?|diplomat\w*|summit|white house)\b/i],
  ["Health", /\b(health|virus|outbreaks?|vaccines?|diseases?|hospitals?|cancer|covid|flu|measles|cholera|mpox|ebola|drugs?|medical|doctors?|patients?)\b/i],
  ["Tech & science", /\b(ai|artificial intelligence|tech|technology|apple|google|microsoft|nvidia|openai|chips?|semiconductors?|space|nasa|rockets?|satellites?|cyber\w*|hack\w*|scien\w*|research\w*|robots?)\b/i],
];

// Tags from the headline; the summary is only used when the headline alone gives nothing,
// because summaries mention side topics that would mislabel the story.
export function topicsFor(title, summary = "") {
  for (const text of [title, summary]) {
    const t = TOPICS.filter(([, re]) => re.test(text)).map(([name]) => name);
    if (t.length) return t.slice(0, 2);
  }
  return ["World"];
}

// Groups the same story across outlets. A story several outlets carry is usually a bigger one.
export function clusterNews(items) {
  const clusters = [];
  for (const item of items) {
    const kw = keywords(item.title);
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
