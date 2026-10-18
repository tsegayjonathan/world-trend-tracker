import { test } from "node:test";
import assert from "node:assert/strict";
import {
  yoy, annualized3m, percentileRank, frequencyOf, moveZScore, statusFor, buildSummary,
  topicsFor, clusterNews, downsample, changeBetween,
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

test("annualized3m turns a 1% rise over 3 months into about 4% a year", () => {
  const v = annualized3m(monthly([100, 100.3, 100.6, 101]));
  assert.ok(Math.abs(v - 4.06) < 0.01, `got ${v}`);
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

test("downsample keeps the first and last points", () => {
  const pts = Array.from({ length: 1000 }, (_, i) => i);
  const out = downsample(pts, 100);
  assert.equal(out.length, 100);
  assert.equal(out[0], 0);
  assert.equal(out[99], 999);
});

test("inflation status follows the Fed's 2% goal and flags acceleration", () => {
  const meta = { id: "CPIAUCSL" };
  assert.equal(statusFor(meta, { value: 2.2, momentum: 2.1 }).level, "good");
  const hot = statusFor(meta, { value: 3.7, momentum: 4.6 });
  assert.equal(hot.level, "watch");
  assert.match(hot.text, /Speeding up/);
  assert.equal(statusFor(meta, { value: 5.1, momentum: 5 }).level, "alert");
});

test("Sahm rule triggers at 0.5", () => {
  const meta = { id: "SAHMREALTIME" };
  assert.equal(statusFor(meta, { value: 0.1 }).level, "good");
  assert.equal(statusFor(meta, { value: 0.35 }).level, "watch");
  assert.equal(statusFor(meta, { value: 0.5 }).label, "Triggered");
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

test("summary agrees with tile statuses", () => {
  const cpi = { id: "CPIAUCSL", value: 3.7, momentum: 4.6, status: { level: "watch", label: "Above goal" } };
  const cards = buildSummary({ CPIAUCSL: cpi });
  assert.equal(cards.length, 1);
  assert.equal(cards[0].level, "watch");
  assert.match(cards[0].text, /3\.7%/);
});

test("topics come from the headline, not side mentions in the summary", () => {
  assert.deepEqual(topicsFor("Missile strike hits port", "Oil markets rose"), ["Conflict"]);
  assert.deepEqual(topicsFor("Mystery in the village", "Police say the election..."), ["Politics"]);
  assert.deepEqual(topicsFor("Kim's luxury boat spotted"), ["World"]);
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
