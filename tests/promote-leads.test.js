"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const { run, cleanTitle, normalize } = require("../scripts/promote-leads");
const { validate } = require("../scripts/add-reported");

const resp = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const KEYS = { TMDB_API_KEY: "tmdb-secret-123", TAVILY_API_KEY: "tvly-secret-456" };
const NOW = "2026-10-05T12:00:00Z";
const URL_OK = "https://www.crunchyroll.com/series/GG5H5XQ35/black-clover";
const lead = (o = {}) => ({ title: "Black Clover", platform: "Crunchyroll", pageUrl: URL_OK, snippet: "x", foundAt: "2026-09-30", status: "needsReview", ...o });
const hit = (o = {}) => ({ id: 73223, name: "Black Clover", original_name: "ブラッククローバー", original_language: "ja", genre_ids: [16, 10759], first_air_date: "2015-10-03", ...o });
const news = (content = "Black Clover Tamil dub announced", url = "https://animemirchi.com/black-clover-tamil") => ({ results: [{ url, content }] });
const read = (f) => JSON.parse(fs.readFileSync(f, "utf8"));

function setup(leads) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "promote-"));
  const s = { dir, leadsFile: path.join(dir, "leads.json"), outFile: path.join(dir, "auto.json") };
  fs.writeFileSync(s.leadsFile, JSON.stringify({ version: 1, leads }));
  return s;
}
function fake({ tv = [hit()], movie = [], tavily = news(), status } = {}) {
  const calls = [];
  const f = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    if (status) return resp(status, {});
    if (url.includes("/search/tv")) return resp(200, { results: tv });
    if (url.includes("/search/movie")) return resp(200, { results: movie });

    if (url.includes("api.tavily.com")) return resp(200, tavily);
    return resp(404, {});
  };
  f.calls = calls;
  return f;
}
async function go(s, fetchImpl, extra = {}) {
  const logs = [];
  const result = await run({ leadsFile: s.leadsFile, outFile: s.outFile, env: KEYS, fetchImpl, log: (m) => logs.push(String(m)), now: NOW, ...extra });
  return { result, logs };
}

test("missing keys skip with no request", async () => {
  for (const env of [{}, { TMDB_API_KEY: "a" }, { TAVILY_API_KEY: "b" }]) {
    const s = setup([lead()]);
    const before = fs.readFileSync(s.leadsFile, "utf8");
    const f = fake();
    const { logs } = await go(s, f, { env });
    assert.equal(f.calls.length, 0);
    assert.ok(logs.some((l) => l.includes("promote skipped")));
    assert.equal(fs.readFileSync(s.leadsFile, "utf8"), before);
    assert.ok(!fs.existsSync(s.outFile));
  }
});

test("happy path writes one entry and marks lead promoted", async () => {
  const s = setup([lead()]);
  const f = fake();
  await go(s, f);
  const out = read(s.outFile);
  assert.equal(out.version, 1);
  assert.equal(out.updatedAt, "2026-10-05");

  assert.deepEqual(out.entries, [{
    title: "Black Clover", mediaType: "tv", tmdbId: 73223, year: 2015, platform: "Crunchyroll", officialUrl: URL_OK,
    report: { source: "Anime Mirchi", url: "https://animemirchi.com/black-clover-tamil", checkedAt: "2026-10-05" },
    autoPromoted: true,
  }]);
  const l = read(s.leadsFile).leads[0];
  assert.equal(l.status, "promoted");
  assert.equal(l.checkedAt, "2026-10-05");
  const tav = f.calls.find((c) => c.url.includes("tavily"));
  assert.equal(tav.init.headers.Authorization, `Bearer ${KEYS.TAVILY_API_KEY}`);
  const body = JSON.parse(tav.init.body);
  assert.equal(body.query, "Black Clover Tamil dub");
  assert.deepEqual(body.include_domains, ["animemirchi.com"]);
  assert.ok(f.calls[0].url.includes("query=Black%20Clover"));
  assert.ok(f.calls.every((c) => c.init.signal));
});

test("movie fallback when tv has no acceptable hit", async () => {
  const s = setup([lead({ title: "Your Name" })]);
  const f = fake({
    tv: [], movie: [hit({ id: 372058, name: undefined, first_air_date: undefined, title: "Your Name", original_title: "君の名は。", release_date: "2016-08-26" })],
    tavily: news("Your Name Tamil dub", "https://www.animemirchi.com/your-name"),
  });
  await go(s, f);
  const e = read(s.outFile).entries[0];
  assert.equal(e.mediaType, "movie");
  assert.equal(e.tmdbId, 372058);
  assert.equal(e.year, 2016);
});

test("non-anime hit => notConfirmed not-anime, no news request", async () => {
  const s = setup([lead()]);

  const f = fake({ tv: [hit({ original_language: "en" })] });
  await go(s, f);
  const l = read(s.leadsFile).leads[0];
  assert.equal(l.status, "notConfirmed");
  assert.equal(l.reason, "not-anime");
  assert.equal(l.checkedAt, "2026-10-05");
  assert.ok(!f.calls.some((c) => c.url.includes("tavily")));
  assert.ok(!fs.existsSync(s.outFile));
});

test("no Tamil in news (or wrong host) => notConfirmed no-news-mention", async () => {
  for (const tavily of [
    news("Black Clover English dub announced"),
    news("Black Clover Tamil dub", "https://example.com/black-clover"),
    news("Black Clover Tamil dub", "http://animemirchi.com/black-clover"),
    news("Black Clover Tamil dub", "https://notanimemirchi.com/x"),
    news("Some other show Tamil dub"),
  ]) {
    const s = setup([lead()]);
    await go(s, fake({ tavily }));
    const l = read(s.leadsFile).leads[0];
    assert.equal(l.status, "notConfirmed");
    assert.equal(l.reason, "no-news-mention");
    assert.ok(!fs.existsSync(s.outFile));
  }
});

test("ambiguous TMDB => ambiguous-title", async () => {
  const s = setup([lead()]);
  const f = fake({ tv: [hit(), hit({ id: 999 })] });
  await go(s, f);
  assert.equal(read(s.leadsFile).leads[0].reason, "ambiguous-title");

  assert.ok(!f.calls.some((c) => c.url.includes("tavily")));
});

test("non-official lead URL is never promoted and makes no request", async () => {
  const s = setup([lead({ pageUrl: "https://example.com/series/1/black-clover" }), lead({ title: "Naruto", pageUrl: "https://www.netflix.com/title/1" })]);
  const before = fs.readFileSync(s.leadsFile, "utf8");
  const f = fake();
  await go(s, f);
  // second lead (Netflix URL on Crunchyroll platform) is also not official
  assert.equal(f.calls.length, 0);
  assert.equal(fs.readFileSync(s.leadsFile, "utf8"), before);
  assert.ok(!fs.existsSync(s.outFile));
});

test("excluded titles are skipped", async () => {
  const s = setup([lead({ title: "Jujutsu Kaisen" }), lead({ title: "Marriagetoxin (Tamil)" })]);
  const before = fs.readFileSync(s.leadsFile, "utf8");
  const f = fake();
  await go(s, f);
  assert.equal(f.calls.length, 0);
  assert.equal(fs.readFileSync(s.leadsFile, "utf8"), before);
});

test("429 stops at once and writes nothing", async () => {
  const s = setup([lead(), lead({ title: "Bleach", foundAt: "2026-10-01" })]);
  const before = fs.readFileSync(s.leadsFile, "utf8");
  const f = fake({ status: 429 });
  const { logs } = await go(s, f);
  assert.equal(f.calls.length, 1);
  assert.equal(fs.readFileSync(s.leadsFile, "utf8"), before);
  assert.ok(!fs.existsSync(s.outFile));
  assert.ok(logs.some((l) => l.includes("promote failed (no changes)")));

});

test("network error leaves the lead unchanged and does not leak secrets", async () => {
  const s = setup([lead()]);
  const before = fs.readFileSync(s.leadsFile, "utf8");
  const f = async (url) => { throw new Error("boom " + url); };
  const { logs } = await go(s, f);
  assert.equal(fs.readFileSync(s.leadsFile, "utf8"), before);
  assert.ok(!fs.existsSync(s.outFile));
  assert.ok(!logs.join("\n").includes(KEYS.TMDB_API_KEY));
});

test("at most 10 leads per run, oldest foundAt first", async () => {
  const leads = [];
  for (let i = 0; i < 12; i++) leads.push(lead({ title: `Show ${String.fromCharCode(65 + i)}`, foundAt: `2026-09-${10 + i}` }));
  const s = setup(leads.reverse());
  const f = fake({ tv: [] });
  await go(s, f);
  const after = read(s.leadsFile).leads;
  assert.equal(after.filter((l) => l.status === "notConfirmed").length, 10);
  assert.deepEqual(after.filter((l) => l.status === "needsReview").map((l) => l.foundAt).sort(), ["2026-09-20", "2026-09-21"]);
  assert.ok(f.calls.length <= 20);
});

test("notConfirmed leads are rechecked only after 7 days", async () => {
  const s = setup([
    lead({ title: "Old One", status: "notConfirmed", reason: "not-anime", checkedAt: "2026-09-20" }),
    lead({ title: "Recent One", status: "notConfirmed", reason: "not-anime", checkedAt: "2026-10-02" }),
  ]);
  await go(s, fake({ tv: [] }));
  const [a, b] = read(s.leadsFile).leads;
  assert.equal(a.checkedAt, "2026-10-05");

  assert.equal(b.checkedAt, "2026-10-02");
});

test("merges and dedupes by platform|mediaType|tmdbId", async () => {
  const s = setup([lead()]);
  const old = { title: "Black Clover", mediaType: "tv", tmdbId: 73223, year: 2015, platform: "Crunchyroll", officialUrl: URL_OK, report: { source: "Old", url: "https://x.test", checkedAt: "2026-01-01" } };
  fs.writeFileSync(s.outFile, JSON.stringify({ version: 1, updatedAt: "2026-01-01", entries: [old] }));
  await go(s, fake());
  const out = read(s.outFile);
  assert.equal(out.entries.length, 1);
  assert.equal(out.entries[0].report.source, "Old");
  assert.equal(read(s.leadsFile).leads[0].status, "promoted");
});

test("cleanTitle and normalize", () => {
  assert.equal(cleanTitle("Prime Video: Sailor Moon (English Dub), Season 1"), "Sailor Moon");
  assert.equal(cleanTitle("Naruto (Tamil) - Watch Full Movie Online in HD on Sony LIV"), "Naruto");
  assert.equal(cleanTitle("Bleach - Season 2"), "Bleach");
  assert.equal(cleanTitle("One Piece Season 3"), "One Piece");
  assert.equal(cleanTitle("Attack on Titan (Dub)"), "Attack on Titan");
  assert.equal(cleanTitle("Black Clover"), "Black Clover");
  assert.equal(normalize("  Black-Clover!! "), "black clover");
  assert.equal(normalize("Café"), "cafe");
});

test("output never contains verified and entries pass validate()", async () => {
  const s = setup([lead()]);
  await go(s, fake());
  const raw = fs.readFileSync(s.outFile, "utf8");
  assert.ok(!/verified/i.test(raw));
  for (const e of JSON.parse(raw).entries) {
    assert.notEqual(e.tamilDubVerified, true);

    assert.ok(!validate(e), String(validate(e)));
  }
});

test("secrets never appear in log lines", async () => {
  const logs = [];
  for (const f of [fake(), fake({ status: 429 }), fake({ tv: [] }), async (u) => { throw new Error(u); }]) {
    const s = setup([lead()]);
    logs.push(...(await go(s, f)).logs);
  }
  const all = logs.join("\n");
  assert.ok(logs.length > 0);
  for (const k of Object.values(KEYS)) assert.ok(!all.includes(k));
});

// ---- add-reported.js edit ----
const find = (o, f, out = []) => { if (o && typeof o === "object") { if (f(o)) out.push(o); Object.values(o).forEach((v) => find(v, f, out)); } return out; };
const autoEntry = { title: "Black Clover", mediaType: "tv", tmdbId: 73223, year: 2015, platform: "Crunchyroll", officialUrl: URL_OK, report: { source: "Anime Mirchi", url: "https://animemirchi.com/black-clover-tamil", checkedAt: "2026-10-05" }, autoPromoted: true };

function runAddReported(manual, autoRaw) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "addrep-"));
  const f = { catalog: path.join(dir, "anime.json"), reports: path.join(dir, "reports.json"), auto: path.join(dir, "auto.json") };
  fs.writeFileSync(f.catalog, JSON.stringify({ version: 1, anime: [] }));
  fs.writeFileSync(f.reports, JSON.stringify({ version: 1, entries: manual }));
  if (autoRaw !== undefined) fs.writeFileSync(f.auto, autoRaw);
  execFileSync(process.execPath, [path.join(__dirname, "..", "scripts", "add-reported.js")], {
    env: { ...process.env, REPORTS_FILE: f.reports, ANIME_DATA_FILE: f.catalog, AUTO_REPORTED_FILE: f.auto }, stdio: "pipe",
  });
  return fs.readFileSync(f.catalog, "utf8");
}

test("add-reported: auto entry creates a reported row", () => {

  const raw = runAddReported([], JSON.stringify({ version: 1, updatedAt: "2026-10-05", entries: [autoEntry] }));
  const rows = find(JSON.parse(raw), (o) => o.tamilDubReported === true);
  assert.ok(rows.length >= 1);
  assert.ok(rows.every((r) => r.tamilDubVerified === false));
  assert.ok(raw.includes("Black Clover"));
});

test("add-reported: manual entry wins over auto for the same key", () => {
  const manual = { ...autoEntry, report: { source: "Anime Mirchi", url: "https://animemirchi.com/manual-report", checkedAt: "2026-10-01" } };
  delete manual.autoPromoted;
  const raw = runAddReported([manual], JSON.stringify({ version: 1, entries: [autoEntry] }));
  assert.ok(raw.includes("manual-report"));
  assert.ok(!raw.includes("black-clover-tamil"));
});

test("add-reported: missing or invalid auto file is ignored", () => {
  assert.doesNotThrow(() => runAddReported([], undefined));
  assert.doesNotThrow(() => runAddReported([], "{not json"));
});
