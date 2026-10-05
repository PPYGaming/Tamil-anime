"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const L = require("../scripts/free-site-listings.js");
const A = require("../scripts/attach-free-sites.js");

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "fsl-"));
const card = (t) => `<article class="bs" itemscope><div class="bsx"><a href="/series/x/" title="${t}" class="tip" rel="3"><h2 class="entry-title">${t}</h2></a></div></article>`;
const page = (ts) => `<html><body>${ts.map(card).join("")}</body></html>`;
const resp = (status, html = "") => ({ ok: status >= 200 && status < 300, status, text: async () => html });
const NOW = () => new Date("2026-10-05T10:00:00Z");
const names = (n, s = "") => Array.from({ length: n }, (_, i) => `Title ${i}${s}`);
const CFG = [{ name: "Animesalt", bases: ["https://a.test", "https://b.test"], listPath: "/l/", pagePath: (n) => `/l/p/${n}/`, maxPages: 5 }];
const PREV_AT = "2026-10-01T00:00:00Z";
const mk = (extra = {}) => ({ outFile: path.join(tmp(), "o.json"), now: NOW, log() {}, sleep: async () => {}, config: CFG, ...extra });
const fx = (map) => {
  const f = async (url) => { f.calls.push(url); const v = map[url]; if (v instanceof Error) throw v; return v ? resp(200, v) : resp(404); };
  f.calls = [];
  return f;
};
const read = (o) => JSON.parse(fs.readFileSync(o.outFile, "utf8")).sites[0];
const seed = (o, n) => fs.writeFileSync(o.outFile, JSON.stringify({ version: 1, sites: [{ name: "Animesalt", checkedAt: PREV_AT, ok: true, base: "https://a.test", titles: names(n) }] }));

test("parseTitles decodes entities, dedupes, reads h2-only cards", () => {
  const html = card("Tom &amp; Jerry") + card("Kid&#8217;s Show") + card("It&#039;s Fine") + card("Tom &amp; Jerry") +
    `<article class="post"><a title="Ignore Me" href="/x"></a></article><article class="bs"><div class="bsx"><h2>  Only H2  </h2></div></article>`;
  assert.deepEqual(L.parseTitles(html), ["Tom & Jerry", "Kid\u2019s Show", "It's Fine", "Only H2"]);
  assert.deepEqual(L.parseTitles(""), []);

});

test("paging stops on 404", async () => {
  const f = fx({ "https://a.test/l/": page(names(20)), "https://a.test/l/p/2/": page(names(20, "b")) });
  const o = mk({ fetchImpl: f });
  await L.run(o);
  const s = read(o);
  assert.equal(s.ok, true);
  assert.equal(s.titles.length, 40);
  assert.equal(s.base, undefined);
  assert.equal(s.checkedAt, "2026-10-05T10:00:00Z");
  assert.equal(f.calls.length, 3);
});

test("paging stops on repeated page", async () => {
  const same = page(names(20));
  const f = fx({ "https://a.test/l/": same, "https://a.test/l/p/2/": same, "https://a.test/l/p/3/": same });
  const o = mk({ fetchImpl: f });
  await L.run(o);
  assert.equal(read(o).titles.length, 20);
  assert.equal(f.calls.length, 2);
});

test("first base failing, second base works", async () => {
  const f = fx({ "https://a.test/l/": new Error("down"), "https://b.test/l/": page(names(25)) });
  const o = mk({ fetchImpl: f });
  await L.run(o);
  assert.equal(read(o).base, undefined);
  assert.equal(read(o).titles.length, 25);
});

test("403 or challenge body keeps previous entry and sets lastError", async () => {

  for (const r of [resp(403), resp(200, "<title>Just a moment...</title>")]) {
    const o = mk({ fetchImpl: async () => r });
    seed(o, 100);
    await L.run(o);
    const s = read(o);
    assert.equal(s.titles.length, 100);
    assert.equal(s.checkedAt, PREV_AT);
    assert.equal(s.ok, true);
    assert.ok(s.lastError);
  }
});

test("partial-page guard keeps previous (3 vs 100)", async () => {
  const o = mk({ fetchImpl: fx({ "https://a.test/l/": page(names(3)) }) });
  seed(o, 100);
  await L.run(o);
  const s = read(o);
  assert.equal(s.titles.length, 100);
  assert.equal(s.checkedAt, PREV_AT);
  assert.ok(s.lastError);
});

test("never writes a URL into titles or lastError", async () => {
  const o1 = mk({ fetchImpl: fx({ "https://a.test/l/": page(["https://evil.test/x", ...names(25)]) }) });
  await L.run(o1);
  assert.ok(read(o1).titles.every((t) => !/https?:|www\./i.test(t)));
  const o2 = mk({ fetchImpl: async () => { throw new Error("boom https://secret.test/x"); } });
  await L.run(o2);
  assert.ok(read(o2).lastError);
  assert.ok(!/http/i.test(read(o2).lastError));
});


// ---- attach ----
const recs = () => [{ id: 1, title: "Naruto", originalTitle: "NARUTO" }, { id: 2, title: "Black Clover", originalTitle: "Black Clover" }, { id: 3, title: "Attack on Titan", originalTitle: "Shingeki no Kyojin" }];
const site = (name, titles, o = {}) => ({ name, checkedAt: "2026-10-04T00:00:00Z", ok: true, base: "https://x.test", titles, ...o });
function setup(sites, anime = recs()) {
  const d = tmp();
  const o = { animeFile: path.join(d, "anime.json"), listingsFile: path.join(d, "l.json"), leadsFile: path.join(d, "leads.json"), now: NOW };
  fs.writeFileSync(o.animeFile, JSON.stringify({ anime }));
  fs.writeFileSync(o.listingsFile, JSON.stringify({ version: 1, sites }));
  return o;
}
const animeOf = (o) => JSON.parse(fs.readFileSync(o.animeFile, "utf8")).anime;

test("attach: exact, non-match, season suffix, leads unmatched only", () => {
  const o = setup([site("Animesalt", ["Naruto", "Attack on Titan Season 2", "Black Clover: Sword of the Wizard King", "Unknown Show"])]);
  A.run(o);
  const a = animeOf(o);
  assert.deepEqual(a[0].freeSites, [{ name: "Animesalt", available: true }]);
  assert.equal(a[1].freeSites[0].available, false);
  assert.equal(a[2].freeSites[0].available, true);
  assert.equal(a[0].freeSitesCheckedAt, "2026-10-04");
  const leads = JSON.parse(fs.readFileSync(o.leadsFile, "utf8"));
  assert.equal(leads.version, 1);
  assert.deepEqual(leads.leads, [{ title: "Black Clover: Sword of the Wizard King", site: "Animesalt" }, { title: "Unknown Show", site: "Animesalt" }]);
});

test("attach: stale site omitted", () => {
  const o = setup([site("Animesalt", ["Naruto"], { checkedAt: "2026-09-01T00:00:00Z" }), site("Toon Stream", ["Naruto"])]);
  A.run(o);
  assert.deepEqual(animeOf(o)[0].freeSites, [{ name: "Toon Stream", available: true }]);
});

test("attach: failed or empty site omitted", () => {

  const o = setup([site("Animesalt", ["Naruto"], { ok: false }), site("Toon Stream", ["Naruto"])]);
  A.run(o);
  assert.deepEqual(animeOf(o)[0].freeSites.map((s) => s.name), ["Toon Stream"]);
  const o2 = setup([site("Animesalt", [])]);
  A.run(o2);
  assert.ok(!("freeSites" in animeOf(o2)[0]));
});

test("attach: no usable site removes the fields", () => {
  const stale = recs().map((r) => ({ ...r, freeSites: [{ name: "x", available: true }], freeSitesCheckedAt: "2020-01-01" }));
  const o = setup([site("Animesalt", ["Naruto"], { checkedAt: "2026-01-01T00:00:00Z" })], stale);
  A.run(o);
  for (const r of animeOf(o)) { assert.ok(!("freeSites" in r)); assert.ok(!("freeSitesCheckedAt" in r)); }
});

test("matching is conservative (Black Clover vs movie)", () => {
  assert.equal(A.matchTitle("Black Clover", { title: "Black Clover: Sword of the Wizard King" }), false);
  assert.equal(A.matchTitle("Black Clover: Sword of the Wizard King", { title: "Black Clover" }), false);
  assert.equal(A.matchTitle("Black Clover (Tamil)", { title: "Black Clover" }), true);
  assert.equal(A.normalize("  Pok\u00e9mon: The  Series! "), "pokemon the series");
});

test("attach: idempotent", () => {
  const o = setup([site("Animesalt", ["Naruto", "Unknown Show"]), site("Toon Stream", ["Black Clover"])]);
  A.run(o);
  const r1 = [fs.readFileSync(o.animeFile, "utf8"), fs.readFileSync(o.leadsFile, "utf8")];
  A.run(o);
  assert.deepEqual([fs.readFileSync(o.animeFile, "utf8"), fs.readFileSync(o.leadsFile, "utf8")], r1);
});
