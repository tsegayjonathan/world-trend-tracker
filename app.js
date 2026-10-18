const GROUP_ORDER = ["Energy & prices", "Jobs & growth", "Money & rates", "Market mood"];
const SEEN_KEY = "wtt:lastSeen";
const $ = (sel) => document.querySelector(sel);

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
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

// Rates and percentages change in points; everything else in percent.
function change(ind, from, to) {
  if (from == null || to == null) return null;
  const diff = to - from;
  const points = ind.fmt === "pct" || ind.fmt === "pp";
  const size = points ? diff : from !== 0 ? (diff / Math.abs(from)) * 100 : 0;
  const text = points
    ? `${Math.abs(diff).toFixed(ind.dp >= 2 ? 2 : 1)} pts`
    : `${Math.abs(size).toFixed(Math.abs(size) < 10 ? 1 : 0)}%`;
  let tone = "";
  const eps = points ? 0.005 : 0.05;
  if (Math.abs(size) >= eps && ind.direction !== "neutral") {
    tone = (diff > 0) === (ind.direction === "up") ? "good" : "bad";
  }
  const dir = Math.abs(size) < eps ? 0 : diff > 0 ? 1 : -1;
  return { dir, text, tone, size };
}

function isMonthly(ind) {
  const h = ind.history;
  if (!h || h.length < 3) return false;
  return (Date.parse(h[h.length - 1][0]) - Date.parse(h[h.length - 2][0])) / 864e5 > 25;
}

function fmtDate(ind, iso) {
  const d = new Date(iso + "T12:00:00Z");
  return isMonthly(ind)
    ? d.toLocaleDateString("en-US", { month: "short", year: "numeric", timeZone: "UTC" })
    : d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

function ago(iso) {
  const mins = Math.round((Date.now() - Date.parse(iso)) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const h = Math.round(mins / 60);
  if (h < 48) return `${h} hour${h === 1 ? "" : "s"} ago`;
  return `${Math.round(h / 24)} days ago`;
}

function deltaHtml(c, when) {
  if (!c) return "";
  const arrow = c.dir > 0 ? "▲" : c.dir < 0 ? "▼" : "■";
  const word = c.dir > 0 ? "up" : c.dir < 0 ? "down" : "flat";
  return `<span class="delta ${c.tone}" title="${word} ${c.text} ${when}"><span class="arrow" aria-hidden="true">${arrow}</span><span class="sr">${word}</span> ${c.dir === 0 ? "unchanged" : c.text} <span class="when">${when}</span></span>`;
}

function sparkSvg(ind, i) {
  const pts = ind.history;
  if (!pts || pts.length < 2) return "";
  const W = 240, H = 56, pad = 4;
  const xs = pts.map((p) => Date.parse(p[0]));
  const ys = pts.map((p) => p[1]);
  const x0 = xs[0], x1 = xs[xs.length - 1];
  let lo = Math.min(...ys), hi = Math.max(...ys);
  if (hi === lo) { hi += 1; lo -= 1; }
  const X = (x) => pad + ((x - x0) / (x1 - x0 || 1)) * (W - pad * 2);
  const Y = (y) => pad + (1 - (y - lo) / (hi - lo)) * (H - pad * 2);
  const d = pts.map((p, k) => `${k ? "L" : "M"}${X(xs[k]).toFixed(1)},${Y(p[1]).toFixed(1)}`).join("");
  const area = `${d}L${X(x1).toFixed(1)},${H}L${X(x0).toFixed(1)},${H}Z`;
  return `<svg class="spark" data-i="${i}" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="${esc(ind.name)}, past year, from ${esc(fmtValue(ind, ys[0]))} to ${esc(fmtValue(ind, ys[ys.length - 1]))}">
    <path class="area" d="${area}"/>
    <path class="line" d="${d}" vector-effect="non-scaling-stroke"/>
    <line class="cross" x1="0" x2="0" y1="0" y2="${H}" vector-effect="non-scaling-stroke" visibility="hidden"/>
    <circle class="end" cx="${X(x1).toFixed(1)}" cy="${Y(ys[ys.length - 1]).toFixed(1)}" r="3.5" vector-effect="non-scaling-stroke"/>
    <circle class="hoverdot" r="3.5" visibility="hidden" vector-effect="non-scaling-stroke"/>
  </svg>`;
}

function tileHtml(ind, i) {
  const c1 = change(ind, ind.prevValue, ind.value);
  const c2 = change(ind, ind.yearAgoValue, ind.value);
  const prevWhen = isMonthly(ind) ? "vs prior month" : `since ${fmtDate(ind, ind.prevDate)}`;
  return `<article class="tile" id="t-${esc(ind.id)}">
    <div class="tile-head"><h3 class="tile-name">${esc(ind.name)}</h3><span class="tile-date">${esc(fmtDate(ind, ind.date))}</span></div>
    <div class="tile-value">${esc(fmtValue(ind, ind.value))}</div>
    <div class="tile-unit">${esc(ind.unit)}</div>
    <div class="deltas">${deltaHtml(c1, prevWhen)}${deltaHtml(c2, "vs 1 yr")}</div>
    ${sparkSvg(ind, i)}
    <div class="range"><span>1 yr low ${esc(fmtValue(ind, ind.low52))}</span><span>high ${esc(fmtValue(ind, ind.high52))}</span></div>
    <p class="about">${esc(ind.about)} <a href="${esc(ind.link)}" target="_blank" rel="noopener">Source</a></p>
  </article>`;
}

function wireSparks(indicators) {
  const tip = $("#tip");
  document.querySelectorAll(".spark").forEach((svg) => {
    const ind = indicators[Number(svg.dataset.i)];
    const pts = ind.history;
    const W = 240, H = 56, pad = 4;
    const xs = pts.map((p) => Date.parse(p[0]));
    const ys = pts.map((p) => p[1]);
    let lo = Math.min(...ys), hi = Math.max(...ys);
    if (hi === lo) { hi += 1; lo -= 1; }
    const cross = svg.querySelector(".cross"), dot = svg.querySelector(".hoverdot");
    const move = (ev) => {
      const r = svg.getBoundingClientRect();
      const fx = Math.min(Math.max((ev.clientX - r.left) / r.width, 0), 1);
      const tx = xs[0] + fx * (xs[xs.length - 1] - xs[0]);
      let k = 0;
      for (let j = 1; j < xs.length; j++) if (Math.abs(xs[j] - tx) < Math.abs(xs[k] - tx)) k = j;
      const sx = pad + ((xs[k] - xs[0]) / (xs[xs.length - 1] - xs[0] || 1)) * (W - pad * 2);
      const sy = pad + (1 - (ys[k] - lo) / (hi - lo)) * (H - pad * 2);
      cross.setAttribute("x1", sx); cross.setAttribute("x2", sx); cross.setAttribute("visibility", "visible");
      dot.setAttribute("cx", sx); dot.setAttribute("cy", sy); dot.setAttribute("visibility", "visible");
      tip.innerHTML = `<b>${esc(fmtValue(ind, ys[k]))}</b> <span class="d">${esc(fmtDate(ind, pts[k][0]))}${isMonthly(ind) ? "" : ", " + pts[k][0].slice(0, 4)}</span>`;
      tip.hidden = false;
      const px = r.left + (sx / W) * r.width;
      const tw = tip.offsetWidth;
      tip.style.left = Math.min(Math.max(px - tw / 2, 8), innerWidth - tw - 8) + "px";
      tip.style.top = r.top - 34 + "px";
    };
    const leave = () => { tip.hidden = true; cross.setAttribute("visibility", "hidden"); dot.setAttribute("visibility", "hidden"); };
    svg.addEventListener("pointermove", move);
    svg.addEventListener("pointerdown", move);
    svg.addEventListener("pointerleave", leave);
  });
  addEventListener("scroll", () => { tip.hidden = true; }, { passive: true });
}

function renderIndicators(indicators) {
  const groups = GROUP_ORDER.map((g) => ({ g, items: indicators.map((ind, i) => [ind, i]).filter(([ind]) => ind.group === g) }))
    .filter((x) => x.items.length);
  $("#groups").innerHTML = groups.map(({ g, items }) =>
    `<div class="group"><h2>${esc(g)}</h2><div class="grid">${items.map(([ind, i]) => tileHtml(ind, i)).join("")}</div></div>`
  ).join("");
  wireSparks(indicators);
}

function readSeen() {
  try { return JSON.parse(localStorage.getItem(SEEN_KEY) || "null"); } catch { return null; }
}
function writeSeen(v) {
  try { localStorage.setItem(SEEN_KEY, JSON.stringify(v)); } catch { /* private mode: banner just won't persist */ }
}

function renderChanges(data, seen) {
  const box = $("#changes");
  if (!seen || !seen.values) return;
  const moves = [];
  for (const ind of data.indicators) {
    const old = seen.values[ind.id];
    if (!old || (old.value === ind.value && old.date === ind.date)) continue;
    const c = change(ind, old.value, ind.value);
    const isNewRelease = old.date !== ind.date && isMonthly(ind);
    // Weight: percent-point moves are already small numbers, so scale them up to compare fairly.
    const weight = Math.abs(c.size) * (ind.fmt === "pct" || ind.fmt === "pp" ? 10 : 1) + (isNewRelease ? 100 : 0);
    if (weight < 0.5) continue;
    moves.push({ ind, c, isNewRelease, weight });
  }
  moves.sort((a, b) => b.weight - a.weight);
  const newNews = data.news.filter((n) => n.time && seen.at && n.time > seen.at).length;
  if (!moves.length && !newNews) return;
  const items = moves.slice(0, 8).map(({ ind, c, isNewRelease }) => {
    const arrow = c.dir > 0 ? "▲" : c.dir < 0 ? "▼" : "";
    const cls = c.tone ? ` class="delta ${c.tone}"` : ' class="delta"';
    return `<li><a href="#t-${esc(ind.id)}">${esc(ind.name)}</a> <b>${esc(fmtValue(ind, ind.value))}</b> <span${cls}>${arrow} ${c.dir ? c.text : "unchanged"}</span>${isNewRelease ? " · new release" : ""}</li>`;
  });
  if (newNews) items.push(`<li><a href="#news">${newNews} new headline${newNews === 1 ? "" : "s"}</a></li>`);
  box.innerHTML = `<h2>Since your last visit (${esc(ago(seen.at))})</h2><ul>${items.join("")}</ul>`;
  box.hidden = false;
}

function renderOdds(odds) {
  const list = $("#odds-list");
  if (!odds || !odds.length) { list.innerHTML = `<li class="hint">No odds available right now.</li>`; return; }
  list.innerHTML = odds.slice(0, 8).map((o) => {
    const p = Math.round(o.probability * 100);
    const runner = o.runnerUp && o.runnerUp.probability >= 0.03
      ? `<div class="runner">Next: ${esc(o.runnerUp.label)} ${Math.round(o.runnerUp.probability * 100)}%</div>` : "";
    return `<li>
      <a class="q" href="${esc(o.link)}" target="_blank" rel="noopener">${esc(o.title)}</a>
      <div class="ans"><span>${esc(o.leader)}</span><span class="meter" role="meter" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${p}" aria-label="${esc(o.leader)} ${p}%"><span style="width:${p}%"></span></span><span class="pct">${p}%</span></div>
      ${runner}
    </li>`;
  }).join("");
}

function renderTrending(t) {
  const list = $("#trending-list");
  if (!t || !t.articles) { list.innerHTML = `<li class="hint">Not available right now.</li>`; return; }
  const day = new Date(t.date + "T12:00:00Z").toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric", timeZone: "UTC" });
  $("#trending-hint").textContent = `Most-read English Wikipedia articles on ${day}. Spikes often mean news.`;
  list.innerHTML = t.articles.map((a) =>
    `<li><a href="${esc(a.link)}" target="_blank" rel="noopener">${esc(a.title)}</a><span class="views">${Intl.NumberFormat("en-US", { notation: "compact" }).format(a.views)} views</span></li>`
  ).join("");
}

function renderNews(news, seenAt) {
  const sources = [...new Set(news.map((n) => n.source))];
  let active = "All";
  let q = "";
  let limit = 20;
  const filters = $("#news-filters");
  filters.innerHTML = ["All", ...sources].map((s) => `<button class="chip" type="button" aria-pressed="${s === "All"}" data-s="${esc(s)}">${esc(s)}</button>`).join("");
  const draw = () => {
    const items = news.filter((n) => (active === "All" || n.source === active) && (!q || (n.title + " " + n.summary).toLowerCase().includes(q)));
    const shown = items.slice(0, limit);
    $("#news-list").innerHTML = (items.length ? shown.map((n) => `<li>
        <a class="title" href="${esc(n.link)}" target="_blank" rel="noopener">${esc(n.title)}</a>
        <div class="meta">${seenAt && n.time && n.time > seenAt ? '<span class="new">New</span> · ' : ""}${esc(n.source)}${n.time ? " · " + esc(ago(n.time)) : ""}</div>
        ${n.summary ? `<p class="summary">${esc(n.summary)}</p>` : ""}
      </li>`).join("") : `<li class="hint">No headlines match.</li>`)
      + (items.length > limit ? `<li><button class="chip more" type="button">Show ${items.length - limit} more</button></li>` : "");
  };
  $("#news-list").addEventListener("click", (e) => {
    if (e.target.closest(".more")) { limit = Infinity; draw(); }
  });
  filters.addEventListener("click", (e) => {
    const b = e.target.closest(".chip");
    if (!b) return;
    active = b.dataset.s;
    limit = 20;
    filters.querySelectorAll(".chip").forEach((c) => c.setAttribute("aria-pressed", String(c === b)));
    draw();
  });
  $("#news-search").addEventListener("input", (e) => { q = e.target.value.trim().toLowerCase(); draw(); });
  draw();
}

async function main() {
  let data;
  try {
    const res = await fetch("data/latest.json?t=" + Math.floor(Date.now() / 600000), { cache: "no-cache" });
    data = await res.json();
  } catch (e) {
    $("#updated").innerHTML = `<span class="error">Couldn't load data. Try refreshing.</span>`;
    return;
  }
  $("#updated").textContent = `Updated ${ago(data.updated)} · refreshes hourly`;
  $("#updated").title = new Date(data.updated).toLocaleString();

  const seen = readSeen();
  renderChanges(data, seen);
  renderIndicators(data.indicators);
  renderOdds(data.odds);
  renderTrending(data.trending);
  renderNews(data.news, seen && seen.at);

  // Only move the "last visit" marker forward when there's new data, so a quick reload keeps the banner.
  if (!seen || seen.dataUpdated !== data.updated) {
    writeSeen({
      at: new Date().toISOString(),
      dataUpdated: data.updated,
      values: Object.fromEntries(data.indicators.map((i) => [i.id, { value: i.value, date: i.date }])),
    });
  }
}

main();
