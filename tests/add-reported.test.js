"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { validate, platformUrlOk } = require("../scripts/add-reported");

const good = {
  title: "Blue Box", mediaType: "tv", tmdbId: 207347, platform: "Netflix",
  officialUrl: "https://www.netflix.com/title/81663323",
  report: { source: "Anime Mirchi", url: "https://animemirchi.com/netflix-tamil-dubbed-anime-list/", checkedAt: "2026-10-04" }
};

function run(catalog, reports) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reported-"));
  const data = path.join(dir, "anime.json");
  const rep = path.join(dir, "reports.json");
  fs.writeFileSync(data, JSON.stringify(catalog));
  fs.writeFileSync(rep, JSON.stringify(reports));
  const { spawnSync } = require("child_process");
  const result = spawnSync(process.execPath, [path.join(__dirname, "..", "scripts", "add-reported.js")], {
    env: { ...process.env, ANIME_DATA_FILE: data, REPORTS_FILE: rep, TMDB_API_KEY: "" }, encoding: "utf8"
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(fs.readFileSync(data, "utf8"));
}

const verifiedRecord = () => ({
  id: "r1", title: "Verified Show", tmdbId: 207347, tmdbUrl: "https://www.themoviedb.org/tv/207347", mediaType: "tv", tamilDubVerified: true,
  platforms: [
    { name: "Crunchyroll", available: true, officialUrl: "https://www.crunchyroll.com/series/G1/x", tamilDubVerified: true },
    { name: "Netflix", available: false, officialUrl: null, tamilDubVerified: false },
    { name: "Amazon Prime Video", available: false, officialUrl: null, tamilDubVerified: false }
  ], episodes: []
});

test("platform links must be the platform's own title page", () => {
  assert.ok(platformUrlOk("Netflix", "https://www.netflix.com/title/81663323"));
  assert.ok(platformUrlOk("Amazon Prime Video", "https://www.primevideo.com/detail/0J3OTJAN6KC2NV157JXI5G0TCD"));
  assert.ok(platformUrlOk("Crunchyroll", "https://www.crunchyroll.com/series/GG5H5XQX4/frieren"));
  assert.ok(!platformUrlOk("Netflix", "https://www.netflix.com/tudum/articles/x"));
  assert.ok(!platformUrlOk("Netflix", "http://www.netflix.com/title/81663323"));
  assert.ok(!platformUrlOk("Netflix", "https://evil.example/title/81663323"));
  assert.ok(!platformUrlOk("Crunchyroll", "https://www.crunchyroll.com/news/announcements/2024/1/1/x"));
});

test("an entry needs a source and an https report URL", () => {
  assert.equal(validate(good), null);
  assert.ok(validate({ ...good, report: { source: "", url: good.report.url } }));
  assert.ok(validate({ ...good, report: { source: "Blog", url: "http://blog.example/x" } }));
  assert.ok(validate({ ...good, tmdbId: "abc" }));
});

test("a new reported title is never Tamil-verified and keeps its source", () => {
  const out = run({ anime: [] }, { entries: [good] });
  assert.equal(out.anime.length, 1);
  const record = out.anime[0];
  assert.equal(record.tamilDubVerified, false);
  assert.equal(record.inclusionSource, "third-party-report");
  assert.equal(record.tamilDubEvidence, undefined, "no official evidence is written");
  const row = record.platforms.find((p) => p.name === "Netflix");
  assert.equal(row.available, true);
  assert.equal(row.tamilDubVerified, false);
  assert.equal(row.tamilDubReported, true);
  assert.equal(row.tamilDubReportSource, "Anime Mirchi");
  assert.equal(row.tamilDubReportUrl, good.report.url);
  assert.equal(row.tamilDubVerificationUrl, undefined);
  assert.ok(record.platforms.filter((p) => p.name !== "Netflix").every((p) => p.available === false));
});

test("an existing record gains only a missing row; verified and available rows are untouched", () => {
  const out = run({ anime: [verifiedRecord()] }, { entries: [good, { ...good, platform: "Crunchyroll", officialUrl: "https://www.crunchyroll.com/series/G9/other" }] });
  assert.equal(out.anime.length, 1);
  const record = out.anime[0];
  assert.equal(record.tamilDubVerified, true);
  const crunchyroll = record.platforms.find((p) => p.name === "Crunchyroll");
  assert.equal(crunchyroll.tamilDubVerified, true);
  assert.equal(crunchyroll.officialUrl, "https://www.crunchyroll.com/series/G1/x");
  assert.equal(crunchyroll.tamilDubReported, undefined);
  const netflix = record.platforms.find((p) => p.name === "Netflix");
  assert.equal(netflix.tamilDubReported, true);
  assert.equal(netflix.tamilDubVerified, false);
});

test("running twice changes nothing and invalid entries are skipped", () => {
  const first = run({ anime: [] }, { entries: [good, { ...good, title: "Bad", officialUrl: "https://example.com/x" }] });
  assert.equal(first.anime.length, 1);
  const second = run(first, { entries: [good] });
  assert.equal(second.anime.length, 1);
  assert.deepEqual(second.anime[0].platforms, first.anime[0].platforms);
});

test("the checked-in reports file validates and never claims official proof", () => {
  const reports = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "data", "third-party-reports.json"), "utf8"));
  assert.ok(reports.entries.length > 0);
  for (const entry of reports.entries) {
    assert.equal(validate(entry), null, entry.title);
    assert.equal(entry.tamilDubVerified, undefined, `${entry.title}: no verified flag`);
    assert.equal(entry.verification, undefined, `${entry.title}: no verification block`);
  }
});
