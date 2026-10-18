import { test } from "node:test";
import assert from "node:assert/strict";
import {
  yoy, annualized3m, percentileRank, frequencyOf, moveZScore, statusFor, buildSummary,
  topicsFor, clusterNews, downsample, changeBetween, oddsRow, chooseOdds,
} from "../scripts/lib.mjs";

const monthly = (values, start = 2020) =>
  values.map((value, i) => ({ date: `${start + Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, "0")}-01`, value }));

test("yoy compares each month with the same month a year earlier", () => {
  const obs = monthly([100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 103, 104]);
  const out = yoy(obs);
  assert.equal(out.length, 2);
  assert.equal(out[0].date, "2021-01-01");
  assert.ok(Math.abs(out[0].value - 3) < 1e-9);
  assert.ok(Math.abs(out[1].value - 4) < 1e-9);
});

test("yoy estimates a single missing year-ago month from the months either side, and says so", () => {
  const obs = monthly([100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 103])
    .filter(o => o.date !== "2020-10-01");
  const last = yoy(obs).at(-1);
  assert.equal(last.date, "2021-10-01");
  assert.equal(last.estBase, "2020-10");
  assert.ok(Math.abs(last.value - 3) < 1e-9);
  assert.equal(yoy(obs).filter(o => o.estBase).length, 1);
});

test("annualized3m turns a 1% rise over 3 months into about 4% a year", () => {
  const v = annualized3m(monthly([100, 100.3, 100.6, 101]));
  assert.ok(Math.abs(v - 4.06) < 0.01, `got ${v}`);
});

test("annualized3m ends at the headline month and won't pass a 4-month gap off as 3 months", () => {
  const levels = monthly([100, 100.3, 100.6, 101, 105]);
  assert.ok(Math.abs(annualized3m(levels, "2020-04-01") - 4.06) < 0.01);
  const gap = monthly([100, 100.3, 100.6, 101, 101.2]).filter(o => o.date !== "2020-02-01");
  assert.equal(annualized3m(gap), null, "Feb missing, so there is no point exactly 3 months before May");
});

test("percentileRank counts ties as half", () => {
  assert.equal(percentileRank([1, 2, 3, 4], 4), 87.5);
  assert.equal(percentileRank([5, 5, 5, 5], 5), 50);
  assert.equal(percentileRank([1, 2, 3, 4], 0), 0);
});

test("frequencyOf recognises daily, weekly and monthly data", () => {
  const days = (step, n) => Array.from({ length: n }, (_, i) => ({ date: new Date(Date.UTC(2026, 0, 1) + i * step * 864e5).toISOString().slice(0, 10), value: i }));
  assert.equal(frequencyOf(days(1, 30)), "daily");
  assert.equal(frequencyOf(days(7, 30)), "weekly");
  assert.equal(frequencyOf(monthly(Array(24).fill(1))), "monthly");
});

test("moveZScore flags a jump that is large for this series", () => {
  const values = Array.from({ length: 60 }, (_, i) => 100 + (i % 2 ? 0.5 : -0.5));
  values.push(110);
  const z = moveZScore(monthly(values), "monthly", false);
  assert.ok(z > 3, `expected a big z-score, got ${z}`);
});

test("changeBetween uses points for rates and percent for prices", () => {
  assert.equal(changeBetween(4, 4.5, true), 0.5);
  assert.equal(changeBetween(100, 110, false).toFixed(6), "10.000000");
});

test("downsample keeps the first and last points and stays within the limit", () => {
  const pts = Array.from({ length: 1000 }, (_, i) => i);
  const out = downsample(pts, 100, (x) => x);
  assert.ok(out.length <= 100 && out.length >= 90, `got ${out.length}`);
  assert.equal(out[0], 0);
  assert.equal(out.at(-1), 999);
});

test("downsample keeps one-day spikes and dips, so the chart's low and high stay true", () => {
  const pts = Array.from({ length: 2500 }, (_, i) => ({ date: String(i).padStart(5, "0"), value: 50 + Math.sin(i / 40) }));
  pts[1234].value = 140;
  pts[777].value = 9;
  const out = downsample(pts, 260);
  assert.ok(out.length <= 260);
  assert.equal(Math.max(...out.map(p => p.value)), 140);
  assert.equal(Math.min(...out.map(p => p.value)), 9);
  assert.deepEqual(out.map(p => p.date), [...out.map(p => p.date)].sort(), "points stay in date order");
});

test("inflation status bands around 2% and flags acceleration", () => {
  const meta = { id: "CPIAUCSL" };
  assert.equal(statusFor(meta, { value: 2.2, momentum: 2.1 }).level, "good");
  const hot = statusFor(meta, { value: 3.7, momentum: 4.6 });
  assert.equal(hot.level, "watch");
  assert.match(hot.text, /Speeding up/);
  assert.equal(statusFor(meta, { value: 5.1, momentum: 5 }).level, "alert");
});

test("only core PCE is graded against the Fed's goal; CPI tiles never claim it", () => {
  const core = statusFor({ id: "CPILFESL" }, { value: 2.45 });
  assert.doesNotMatch(`${core.label} ${core.text}`, /goal|Fed/);
  const pce = statusFor({ id: "PCEPILFE" }, { value: 3.0 });
  assert.equal(pce.label, "Above goal");
  assert.match(pce.text, /Fed aims for 2%/);
  const byId = {
    CPIAUCSL: { id: "CPIAUCSL", value: 2.45, momentum: 2.4, status: statusFor({ id: "CPIAUCSL" }, { value: 2.45 }) },
    PCEPILFE: { id: "PCEPILFE", value: 3.0, status: pce },
  };
  const [card] = buildSummary(byId);
  assert.match(card.text, /core PCE\) is 3\.0%, above its 2% goal/);
  assert.equal(card.level, "watch");
  assert.equal(card.ids[0], "PCEPILFE", "the card links to the tile its label came from");
});

test("low and falling inflation is not 'near the goal'", () => {
  const neg = statusFor({ id: "CPIAUCSL" }, { value: -0.1, momentum: -1 });
  assert.equal(neg.label, "Falling prices");
  assert.match(neg.text, /down 0\.1%/);
  assert.equal(statusFor({ id: "PCEPILFE" }, { value: 1.0 }).label, "Below goal");
  const [card] = buildSummary({
    CPIAUCSL: { id: "CPIAUCSL", value: 0.2, momentum: -5.2, status: statusFor({ id: "CPIAUCSL" }, { value: 0.2 }) },
    PCEPILFE: { id: "PCEPILFE", value: 1.0, status: statusFor({ id: "PCEPILFE" }, { value: 1.0 }) },
  });
  assert.match(card.text, /below its 2% goal/);
});

test("Sahm rule triggers at 0.5 and reads sensibly below zero", () => {
  const meta = { id: "SAHMREALTIME" };
  assert.equal(statusFor(meta, { value: 0.1 }).level, "good");
  assert.equal(statusFor(meta, { value: 0.35 }).level, "watch");
  assert.equal(statusFor(meta, { value: 0.5 }).label, "Triggered");
  assert.doesNotMatch(statusFor(meta, { value: -0.07 }).text, /-0\.07|above/);
});

test("yield curve: inverted, recently un-inverted, normal", () => {
  const meta = { id: "T10Y2Y" };
  assert.equal(statusFor(meta, { value: -0.2, minRecent: -0.5 }).label, "Inverted");
  assert.equal(statusFor(meta, { value: 0.3, minRecent: -0.4 }).label, "Recently un-inverted");
  assert.equal(statusFor(meta, { value: 0.3, minRecent: 0.1 }).label, "Normal");
});

test("generic status warns when a 'lower is better' number sits near a 10-year high", () => {
  const meta = { id: "X", direction: "down" };
  const s = statusFor(meta, { pctRank: 97, baselineYears: 10, moveZ: 0.2, change1m: 2, freq: "daily", inPoints: false });
  assert.equal(s.level, "watch");
  assert.equal(s.label, "Near 10-yr high");
  const sharp = statusFor(meta, { pctRank: 50, baselineYears: 10, moveZ: 3.4, change1m: 12, freq: "daily", inPoints: false });
  assert.equal(sharp.level, "alert");
  assert.equal(sharp.label, "Sharp rise");
});

test("a big move the good way is not a warning", () => {
  const oil = statusFor({ id: "X", direction: "down" }, { pctRank: 40, baselineYears: 10, moveZ: -3.2, change1m: -25, freq: "daily", inPoints: false });
  assert.equal(oil.level, "info");
  assert.equal(oil.label, "Falling fast");
  const coin = statusFor({ id: "Y", direction: "neutral" }, { pctRank: 40, baselineYears: 1, moveZ: -3.5, change1m: -30, freq: "daily", inPoints: false });
  assert.equal(coin.level, "watch", "no good or bad direction: worth a look, not an alarm");
});

test("history wording never says 100% and names real records", () => {
  const near = statusFor({ id: "X", direction: "down" }, { pctRank: 99.8, baselineYears: 10, freq: "daily" });
  assert.match(near.text, /Higher than 99% of readings in the last 10 years/);
  const top = statusFor({ id: "X", direction: "down" }, { pctRank: 99.98, isHigh: true, baselineYears: 10, freq: "daily" });
  assert.match(top.text, /The highest in the last 10 years/);
  const low = statusFor({ id: "X", direction: "down" }, { pctRank: 8, baselineYears: 10, freq: "daily" });
  assert.match(low.text, /Lower than 92% of readings/);
});

test("summary agrees with tile statuses", () => {
  const cpi = { id: "CPIAUCSL", value: 3.7, momentum: 4.6, status: { level: "watch", label: "Above goal" } };
  const cards = buildSummary({ CPIAUCSL: cpi });
  assert.equal(cards.length, 1);
  assert.equal(cards[0].level, "watch");
  assert.match(cards[0].text, /3\.7%/);
});

test("odds: ladders of separate yes/no questions get no leader or runner-up", () => {
  const m = (label, p) => ({ active: true, closed: false, groupItemTitle: label, outcomePrices: JSON.stringify([String(p), String(1 - p)]) });
  const ladder = oddsRow({ title: "How low will the 5-year yield get?", slug: "x", negRisk: false, markets: [m("Below 4.50%", 0.29), m("Below 4.45%", 0.2), m("Below 4.00%", 0.02)] }, "economy");
  assert.equal(ladder.runnerUp, null);
  assert.equal(ladder.leader, "Below 4.50%");
  const race = oddsRow({ title: "Fed decision?", slug: "y", negRisk: true, markets: [m("Hold", 0.7), m("Cut", 0.25)] }, "economy");
  assert.equal(race.leader, "Hold");
  assert.equal(race.runnerUp.label, "Cut");
});

test("odds: near-certain yes/no questions are dropped and topics alternate", () => {
  const row = (topic, p, runnerUp = null) => ({ topic, probability: p, runnerUp });
  const rows = [row("economy", 0.6), row("economy", 0.99), row("economy", 0.01), row("economy", 0.4), row("geopolitics", 0.5), row("geopolitics", 0.98, { label: "b", probability: 0.01 })];
  const out = chooseOdds(rows, ["economy", "geopolitics"], 10);
  assert.deepEqual(out.map(o => o.topic), ["economy", "geopolitics", "economy", "geopolitics"]);
});

test("topics come from the headline, not side mentions in the summary", () => {
  assert.deepEqual(topicsFor("Missile strike hits port", "Oil markets rose"), ["Conflict"]);
  assert.deepEqual(topicsFor("Mystery in the village", "Police say the election..."), ["Politics"]);
  assert.deepEqual(topicsFor("Kim's luxury boat spotted"), ["World"]);
  assert.deepEqual(topicsFor("Rare pink diamond goes on display", "It was found hidden in an apple after a theft"), ["World"]);
  assert.deepEqual(topicsFor("South Africans seek justice", "Families are still fighting for justice"), ["World"]);
  assert.deepEqual(topicsFor("Heavy fighting in eastern Congo as rebels advance"), ["Conflict"]);
  assert.deepEqual(topicsFor("Most homes lost in black summer bushfires were near bush"), ["Energy & climate"]);
});

test("the same story from two outlets is grouped; different stories are not", () => {
  const items = [
    { title: "Pope Leo XIV leaves hospital days after lung cancer surgery", source: "Al Jazeera" },
    { title: "Pope discharged from hospital days after lung cancer surgery", source: "BBC" },
    { title: "Hospital strike enters third day in Paris", source: "BBC" },
  ];
  const c = clusterNews(items);
  assert.equal(c.length, 2);
  assert.equal(c[0].sources.size, 2);
});

test("'West Bank' is not about banks", () => {
  assert.deepEqual(topicsFor("Israeli settlers attack European diplomats in the occupied West Bank"), ["Conflict", "Politics"]);
  assert.deepEqual(topicsFor("World Bank cuts growth forecast"), ["Economy"]);
  assert.deepEqual(topicsFor("Palestinian killed in West Bank raid"), ["Conflict"]);
});

test("singular and plural headlines of one story match; generic shared words don't", () => {
  const same = (a, b, source2 = "BBC") => clusterNews([{ title: a, source: "NPR" }, { title: b, source: source2 }]).length === 1;
  assert.ok(same("Nurses strike over pay in New Zealand", "New Zealand nurse strikes over pay begin"));
  assert.ok(same("Fuel prices rise across Nigeria", "Nigeria fuel price rises again"));
  assert.ok(!same(
    "Buildings set ablaze and more than 1,200 arrested as police clash with protesters across France",
    "Protesters allege police brutality as violent clashes rage on in Albania",
  ));
  // Few shared words relative to length, but one of them is the place: same story.
  assert.ok(same(
    "Buildings set ablaze and more than 1,200 arrested as police clash with protesters across France",
    "Scuffles and fires break out as protesters rally across France, joining students",
  ));
});
