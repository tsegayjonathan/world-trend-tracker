const GROUP_ORDER = ["Energy & prices", "Jobs & growth", "Money & rates", "Market mood"];
const SEEN_KEY = "wtt:lastSeen";
const RANGE_KEY = "wtt:range";
const ICONS = { good: "✓", watch: "!", alert: "!!", info: "i" };
const $ = (sel) => document.querySelector(sel);

let DATA = null;
let range = 1;

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function store(key, value) {
  try { value === undefined ? localStorage.getItem(key) : localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage blocked: features just don't persist */ }
}
function load(key) {
  try { return JSON.parse(localStorage.getItem(key) || "null"); } catch { return null; }
}

function fmtValue(ind, v) {
  const dp = ind.dp ?? 2;
  if (v == null || !Number.isFinite(v)) return "–";
  switch (ind.fmt) {
    case "money": return "$" + v.toLocaleString("en-US", { minimumFractionDigits: dp, maximumFractionDigits: dp });
    case "pct": return v.toFixed(dp) + "%";
    case "pp": return (v > 0 ? "+" : "") + v.toFixed(dp);
    case "compact": return Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(v);
    default: return v.toLocaleString("en-US", { minimumFractionDigits: dp, maximumFractionDigits: dp });
  }
}

function fmtChange(ind, c) {
  const a = Math.abs(c);
  return ind.inPoints ? `${a.toFixed(ind.dp >= 2 ? 2 : 1)} pts` : `${a.toFixed(a < 10 ? 1 : 0)}%`;
}

function tone(ind, c) {
  if (!c || ind.direction === "neutral") return "";
  return (c > 0) === (ind.direction === "up") ? "good" : "bad";
}

function fmtDate(iso, monthly) {
  const d = new Date(iso + "T12:00:00Z");
  return monthly
    ? d.toLocaleDateString("en-US", { month: "short", year: "numeric", timeZone: "UTC" })
    : d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}
const isMonthly = (ind) => ind.freq === "monthly" || ind.freq === "quarterly";

function ago(iso) {
  const mins = Math.round((Date.now() - Date.parse(iso)) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const h = Math.round(mins / 60);
  if (h < 48) return `${h} hour${h === 1 ? "" : "s"} ago`;
  return `${Math.round(h / 24)} days ago`;
}

// Whole days from the visitor's own today to a release date, by calendar date (not UTC).
function daysUntil(iso) {
  const t = new Date();
  return Math.round((Date.parse(iso) - Date.UTC(t.getFullYear(), t.getMonth(), t.getDate())) / 864e5);
}

function untilText(iso) {
  const days = daysUntil(iso);
  const when = fmtDate(iso, false);
  return days === 0 ? "today" : days === 1 ? "tomorrow" : days < 7 ? `${when} (in ${days} days)` : when;
}

function statusHtml(st) {
  if (!st) return "";
  return `<span class="status ${esc(st.level)}"><span class="ico" aria-hidden="true">${ICONS[st.level] || "i"}</span>${esc(st.label)}</span>`;
}

function deltaHtml(ind, c, when) {
  if (c == null || !Number.isFinite(c)) return "";
  const flat = Math.abs(c) < (ind.inPoints ? 0.005 : 0.05);
  const arrow = flat ? "■" : c > 0 ? "▲" : "▼";
  const word = flat ? "unchanged" : c > 0 ? "up" : "down";
  return `<span class="delta ${flat ? "" : tone(ind, c)}"><span class="arrow" aria-hidden="true">${arrow}</span><span class="sr">${word}</span>${flat ? "flat" : fmtChange(ind, c)} <span class="when">${when}</span></span>`;
}

// ---- Charts ----

function seriesFor(ind) {
  if (range === 1 || !ind.h10) return ind.h1;
  const cutoff = new Date(Date.now() - range * 365 * 864e5).toISOString().slice(0, 10);
  return ind.h10.filter((p) => p[0] >= cutoff);
}

function geometry(ind, pts) {
  const W = 260, H = 64, pad = 4;
  const xs = pts.map((p) => Date.parse(p[0]));
  const ys = pts.map((p) => p[1]);
  const refs = (ind.refs || []).map((r) => r.value);
  let lo = Math.min(...ys, ...refs), hi = Math.max(...ys, ...refs);
  if (hi === lo) { hi += 1; lo -= 1; }
  const span = hi - lo; lo -= span * 0.04; hi += span * 0.04;
  const x0 = xs[0], x1 = xs[xs.length - 1];
  return {
    W, H, xs, ys,
    X: (x) => pad + ((x - x0) / (x1 - x0 || 1)) * (W - pad * 2),
    Y: (y) => (1 - (y - lo) / (hi - lo)) * H,
  };
}

function chartHtml(ind, i) {
  const pts = seriesFor(ind);
  if (!pts || pts.length < 2) return "";
  const g = geometry(ind, pts);
  const d = pts.map((p, k) => `${k ? "L" : "M"}${g.X(g.xs[k]).toFixed(1)},${g.Y(p[1]).toFixed(1)}`).join("");
  const last = pts.length - 1;
  const area = `${d}L${g.X(g.xs[last]).toFixed(1)},${g.H}L${g.X(g.xs[0]).toFixed(1)},${g.H}Z`;
  const refs = (ind.refs || []).map((r) => `<line class="ref" x1="0" x2="${g.W}" y1="${g.Y(r.value).toFixed(1)}" y2="${g.Y(r.value).toFixed(1)}" vector-effect="non-scaling-stroke"/>`).join("");
  const refLabels = (ind.refs || []).map((r) => `<span class="ref-label" style="top:${((g.Y(r.value) / g.H) * 100).toFixed(1)}%">${esc(r.label)}</span>`).join("");
  const lo = Math.min(...g.ys), hi = Math.max(...g.ys);
  const shortRange = range > 1 && ind.baselineYears < range ? ` (only ${ind.baselineYears} yr available)` : "";
  return `<div class="chart">
      <svg class="spark" data-i="${i}" viewBox="0 0 ${g.W} ${g.H}" preserveAspectRatio="none" role="img"
        aria-label="${esc(ind.name)} chart from ${esc(fmtDate(pts[0][0], true))}: low ${esc(fmtValue(ind, lo))}, high ${esc(fmtValue(ind, hi))}, now ${esc(fmtValue(ind, ind.value))}">
        <path class="area" d="${area}"/>
        ${refs}
        <path class="line" d="${d}" vector-effect="non-scaling-stroke"/>
        <line class="cross" x1="0" x2="0" y1="0" y2="${g.H}" vector-effect="non-scaling-stroke" visibility="hidden"/>
        <circle class="end" cx="${g.X(g.xs[last]).toFixed(1)}" cy="${g.Y(g.ys[last]).toFixed(1)}" r="3.5" vector-effect="non-scaling-stroke"/>
        <circle class="hoverdot" r="3.5" visibility="hidden" vector-effect="non-scaling-stroke"/>
      </svg>${refLabels}
    </div>
    <div class="range"><span>Since ${esc(fmtDate(pts[0][0], true))}${shortRange}</span><span>Low ${esc(fmtValue(ind, lo))} · High ${esc(fmtValue(ind, hi))}</span></div>`;
}

function wireCharts() {
  const tip = $("#tip");
  document.querySelectorAll(".spark").forEach((svg) => {
    const ind = DATA.indicators[Number(svg.dataset.i)];
    const pts = seriesFor(ind);
    const g = geometry(ind, pts);
    const cross = svg.querySelector(".cross"), dot = svg.querySelector(".hoverdot");
    const move = (ev) => {
      const r = svg.getBoundingClientRect();
      const fx = Math.min(Math.max((ev.clientX - r.left) / r.width, 0), 1);
      const tx = g.xs[0] + fx * (g.xs[g.xs.length - 1] - g.xs[0]);
      let k = 0;
      for (let j = 1; j < g.xs.length; j++) if (Math.abs(g.xs[j] - tx) < Math.abs(g.xs[k] - tx)) k = j;
      const sx = g.X(g.xs[k]), sy = g.Y(g.ys[k]);
      cross.setAttribute("x1", sx); cross.setAttribute("x2", sx); cross.setAttribute("visibility", "visible");
      dot.setAttribute("cx", sx); dot.setAttribute("cy", sy); dot.setAttribute("visibility", "visible");
      const d = new Date(pts[k][0] + "T12:00:00Z").toLocaleDateString("en-US", isMonthly(ind) ? { month: "short", year: "numeric", timeZone: "UTC" } : { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
      tip.innerHTML = `<b>${esc(fmtValue(ind, g.ys[k]))}</b> <span class="d">${esc(d)}</span>`;
      tip.hidden = false;
      const px = r.left + (sx / g.W) * r.width;
      const tw = tip.offsetWidth;
      tip.style.left = Math.min(Math.max(px - tw / 2, 8), innerWidth - tw - 8) + "px";
      tip.style.top = Math.max(r.top - 34, 4) + "px";
    };
    const leave = () => { tip.hidden = true; cross.setAttribute("visibility", "hidden"); dot.setAttribute("visibility", "hidden"); };
    svg.addEventListener("pointermove", move);
    svg.addEventListener("pointerdown", move);
    svg.addEventListener("pointerleave", leave);
  });
}

// ---- Tiles ----

function tileHtml(ind, i) {
  const m = isMonthly(ind);
  // A past date means the data is behind (a carried-over value, or the hourly job stopped): don't promise it.
  const next = ind.next?.date && !ind.fetchFailed && daysUntil(ind.next.date) >= 0 ? `Next update ${esc(untilText(ind.next.date))}` : "";
  const delayed = ind.fetchFailed ? `<span class="delayed">Delayed: couldn't refresh</span>` : ind.stale ? `<span class="delayed">Delayed at source</span>` : "";
  return `<article class="tile" id="t-${esc(ind.id)}">
    <div class="tile-head"><h4 class="tile-name">${esc(ind.name)}</h4>${statusHtml(ind.status)}</div>
    <div class="tile-value">${esc(fmtValue(ind, ind.value))}</div>
    <div class="tile-unit">${esc(ind.unit)}</div>
    <div class="deltas">${deltaHtml(ind, ind.change1m, m ? "vs prior month" : "past month")}${deltaHtml(ind, ind.change1y, "vs 1 yr ago")}</div>
    ${chartHtml(ind, i)}
    <p class="reading">${esc(ind.status?.text || "")}</p>
    <div class="tile-foot"><span>Data for ${esc(fmtDate(ind.date, m))}${delayed ? " · " : ""}${delayed}</span><span>${next}</span></div>
    <details><summary>What it means</summary><p class="about">${esc(ind.about)} <a href="${esc(ind.link)}" target="_blank" rel="noopener">Source</a></p></details>
  </article>`;
}

function renderIndicators() {
  const items = DATA.indicators.map((ind, i) => [ind, i]);
  $("#groups").innerHTML = GROUP_ORDER.map((g) => {
    const list = items.filter(([ind]) => ind.group === g);
    return list.length ? `<div class="group"><h3>${esc(g)}</h3><div class="grid">${list.map(([ind, i]) => tileHtml(ind, i)).join("")}</div></div>` : "";
  }).join("");
  wireCharts();
}

function setupRange() {
  const saved = load(RANGE_KEY);
  if ([1, 5, 10].includes(saved)) range = saved;
  const buttons = document.querySelectorAll(".seg button");
  const sync = () => buttons.forEach((b) => b.setAttribute("aria-pressed", String(Number(b.dataset.range) === range)));
  sync();
  buttons.forEach((b) => b.addEventListener("click", () => {
    range = Number(b.dataset.range);
    store(RANGE_KEY, range);
    sync();
    renderIndicators();
  }));
}

// ---- Summary and "since last visit" ----

function renderPulse() {
  const cards = DATA.summary || [];
  $("#pulse").hidden = !cards.length;
  $("#pulse-cards").innerHTML = cards.map((c) => `<a class="pulse-card ${esc(c.level)}" href="#t-${esc(c.ids[0])}">
      <div class="pulse-head"><span class="pulse-theme">${esc(c.theme)}</span>${statusHtml(c)}</div>
      <p class="pulse-text">${esc(c.text)}</p>
    </a>`).join("");
}

function renderChanges(seen) {
  const box = $("#changes");
  if (!seen || !seen.values) return;
  const items = [];
  for (const ind of DATA.indicators) {
    const old = seen.values[ind.id];
    if (!old) continue;
    const statusChanged = old.label && ind.status && old.label !== ind.status.label;
    const newRelease = old.date !== ind.date && isMonthly(ind);
    const c = ind.inPoints ? ind.value - old.value : old.value ? (ind.value / old.value - 1) * 100 : 0;
    // Weight moves by how unusual they are for this number, so the dollar moving 2% outranks oil moving 2%.
    const typical = ind.inPoints ? 0.15 : ind.id === "bitcoin" ? 8 : 3;
    const weight = Math.abs(c) / typical + (statusChanged ? 3 : 0) + (newRelease ? 2 : 0);
    if (weight < 0.6 && !statusChanged && !newRelease) continue;
    items.push({ ind, c, statusChanged, newRelease, weight, oldLabel: old.label });
  }
  items.sort((a, b) => b.weight - a.weight);
  const newNews = DATA.news.filter((n) => n.time && seen.at && n.time > seen.at).length;
  if (!items.length && !newNews) return;
  const lis = items.slice(0, 8).map(({ ind, c, statusChanged, newRelease, oldLabel }) => {
    const flat = Math.abs(c) < (ind.inPoints ? 0.005 : 0.05);
    const move = flat ? "unchanged" : `${c > 0 ? "▲" : "▼"} ${fmtChange(ind, c)}`;
    const extra = statusChanged ? ` · now <b>${esc(ind.status.label)}</b> (was ${esc(oldLabel)})` : newRelease ? " · new release" : "";
    return `<li><a href="#t-${esc(ind.id)}">${esc(ind.name)}</a> <b>${esc(fmtValue(ind, ind.value))}</b> <span class="delta ${flat ? "" : tone(ind, c)}">${move}</span>${extra}</li>`;
  });
  if (newNews) lis.push(`<li><a href="#news">${newNews} new headline${newNews === 1 ? "" : "s"}</a></li>`);
  box.innerHTML = `<h2>Since your last visit (${esc(ago(seen.at))})</h2><ul>${lis.join("")}</ul>`;
  box.hidden = false;
}

// ---- Side panels ----

function renderOdds() {
  const odds = DATA.odds || [];
  const list = $("#odds-list");
  if (!odds.length) { list.innerHTML = `<li class="hint">No odds available right now.</li>`; return; }
  list.innerHTML = odds.slice(0, 8).map((o) => {
    const p = Math.round(o.probability * 100);
    const runner = o.runnerUp && o.runnerUp.probability >= 0.03
      ? `<div class="runner">Next most likely: ${esc(o.runnerUp.label)} ${Math.round(o.runnerUp.probability * 100)}%</div>` : "";
    return `<li>
      <a class="q" href="${esc(o.link)}" target="_blank" rel="noopener">${esc(o.title)}</a>
      <div class="ans"><span title="${esc(o.leader)}">${esc(o.leader)}</span><span class="meter" role="meter" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${p}" aria-label="${esc(o.leader)} ${p}%"><span style="width:${p}%"></span></span><span class="pct">${p}%</span></div>
      ${runner}
    </li>`;
  }).join("");
}

function renderTrending() {
  const t = DATA.trending;
  const list = $("#trending-list");
  if (!t || !t.articles) { list.innerHTML = `<li class="hint">Not available right now.</li>`; return; }
  const day = new Date(t.date + "T12:00:00Z").toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric", timeZone: "UTC" });
  $("#trending-hint").textContent = `Most-read English Wikipedia articles on ${day}. A sudden spike often means news.`;
  list.innerHTML = t.articles.map((a) =>
    `<li><a href="${esc(a.link)}" target="_blank" rel="noopener">${esc(a.title)}</a><span class="views">${Intl.NumberFormat("en-US", { notation: "compact" }).format(a.views)} views</span></li>`
  ).join("");
}

// ---- News ----

function alsoHtml(n) {
  if (!n.alsoIn?.length) return "";
  return `Also: ${n.alsoIn.map((a) => `<a href="${esc(a.link)}" target="_blank" rel="noopener" title="${esc(a.title)}">${esc(a.source)}</a>`).join(", ")}`;
}

function renderNews(seenAt) {
  const news = DATA.news || [];
  const top = news.filter((n) => n.coverage > 1).sort((a, b) => b.coverage - a.coverage || (b.time || "").localeCompare(a.time || "")).slice(0, 6);
  $("#top-stories").innerHTML = top.length ? `<h3 class="list-h">Top stories <span class="hint">covered by several outlets</span></h3><div class="top-stories">${top.map((n) => `<article class="story">
      <span class="coverage">${n.coverage} outlets</span><br>
      <a class="title" href="${esc(n.link)}" target="_blank" rel="noopener">${esc(n.title)}</a>
      <div class="meta">${esc(n.source)}${n.time ? " · " + esc(ago(n.time)) : ""} · ${esc(n.topics.join(", "))}</div>
      <div class="also">${alsoHtml(n)}</div>
    </article>`).join("")}</div>` : "";

  const counts = {};
  news.forEach((n) => n.topics.forEach((t) => { counts[t] = (counts[t] || 0) + 1; }));
  const topics = Object.keys(counts).sort((a, b) => counts[b] - counts[a]);
  let active = "All", q = "", limit = 15;
  const filters = $("#news-filters");
  filters.innerHTML = ["All", ...topics].map((t) =>
    `<button class="chip" type="button" aria-pressed="${t === "All"}" data-t="${esc(t)}">${esc(t)} <span class="n">${t === "All" ? news.length : counts[t]}</span></button>`
  ).join("");

  const draw = () => {
    const items = news.filter((n) => (active === "All" || n.topics.includes(active)) && (!q || `${n.title} ${n.summary}`.toLowerCase().includes(q)));
    const shown = items.slice(0, limit);
    $("#news-list").innerHTML = (items.length ? shown.map((n) => `<li>
        <a class="title" href="${esc(n.link)}" target="_blank" rel="noopener">${esc(n.title)}</a>
        <div class="meta">${seenAt && n.time && n.time > seenAt ? '<span class="new">New</span> · ' : ""}${esc(n.source)}${n.time ? " · " + esc(ago(n.time)) : ""} · <span class="tag">${esc(n.topics.join(", "))}</span>${n.alsoIn?.length ? " · " + alsoHtml(n) : ""}</div>
        ${n.summary ? `<p class="summary">${esc(n.summary)}</p>` : ""}
      </li>`).join("") : `<li class="hint">No headlines match.</li>`)
      + (items.length > limit ? `<li><button class="chip more" type="button">Show ${items.length - limit} more</button></li>` : "");
  };
  filters.addEventListener("click", (e) => {
    const b = e.target.closest(".chip");
    if (!b) return;
    active = b.dataset.t;
    limit = 15;
    filters.querySelectorAll(".chip").forEach((c) => c.setAttribute("aria-pressed", String(c === b)));
    draw();
  });
  $("#news-list").addEventListener("click", (e) => { if (e.target.closest(".more")) { limit = Infinity; draw(); } });
  $("#news-search").addEventListener("input", (e) => { q = e.target.value.trim().toLowerCase(); limit = 15; draw(); });
  draw();
}

// ---- Boot ----

async function main() {
  try {
    const res = await fetch("data/latest.json?t=" + Math.floor(Date.now() / 600000), { cache: "no-cache" });
    DATA = await res.json();
  } catch {
    $("#updated").innerHTML = `<span class="error">Couldn't load data. Try refreshing.</span>`;
    return;
  }
  // Data written by an older version of the hourly job (only seen for a minute after an upgrade).
  DATA.indicators.forEach((i) => { i.h1 = i.h1 || i.history || []; });
  DATA.news.forEach((n) => { n.topics = n.topics || ["World"]; });
  const delayed = DATA.indicators.filter((i) => i.fetchFailed).length;
  $("#updated").innerHTML = `Updated ${esc(ago(DATA.updated))} · refreshes hourly${delayed ? ` · <span class="warn">${delayed} number${delayed === 1 ? "" : "s"} delayed</span>` : ""}`;
  $("#updated").title = new Date(DATA.updated).toLocaleString();

  const seen = load(SEEN_KEY);
  setupRange();
  renderPulse();
  renderChanges(seen);
  renderIndicators();
  renderNews(seen && seen.at);
  renderOdds();
  renderTrending();
  addEventListener("scroll", () => { $("#tip").hidden = true; }, { passive: true });

  // Move the "last visit" marker forward only when there's new data, so a quick reload keeps the banner.
  if (!seen || seen.dataUpdated !== DATA.updated) {
    store(SEEN_KEY, {
      at: new Date().toISOString(),
      dataUpdated: DATA.updated,
      values: Object.fromEntries(DATA.indicators.map((i) => [i.id, { value: i.value, date: i.date, label: i.status?.label }])),
    });
  }
}

main();
