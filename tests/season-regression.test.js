"use strict";

// Run: node --test tests/*.test.js   (Node 18+, no dependencies, no network)
//
// REAL regression: the 27-entry official manifest against a fresh copy of the 25-record catalog, no API keys.
// The fixtures are frozen copies of data/official-tamil-dub-manifest.json and data/anime.json taken BEFORE the
// season fix (data/anime.json itself legitimately grows once the updater adds the two missing records, so a
// live copy would stop being a regression fixture). Missing fixtures FAIL these tests; they are never skipped.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { FIXTURE_MANIFEST, FIXTURE_CATALOG, runUpdater, rerun, withNoNetwork, clone } = require("./helpers/harness");

const MISSING_IDS = ["verified-jujutsu-kaisen-season-2", "verified-spy-x-family-season-2"];

function loadFixtures() {
  for (const file of [FIXTURE_MANIFEST, FIXTURE_CATALOG]) {
    if (!fs.existsSync(file)) assert.fail(`regression fixture missing: ${path.relative(process.cwd(), file)} (tests did NOT run against real data)`);
  }

  return {
    manifest: JSON.parse(fs.readFileSync(FIXTURE_MANIFEST, "utf8")),
    catalog: JSON.parse(fs.readFileSync(FIXTURE_CATALOG, "utf8"))
  };
}

// Byte-level identity of a record: deepStrictEqual ignores key order, JSON.stringify does not.
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function assertOriginalsUntouched(afterAnime, originals) {
  assert.deepStrictEqual(afterAnime.slice(0, originals.length), originals, "original records deep-equal");
  originals.forEach((original, index) => {
    assert.ok(same(afterAnime[index], original), `record #${index} (${original.id}) is byte-identical, key order included`);
    assert.equal(afterAnime[index].id, original.id, "order preserved");
  });
}

test("fixtures are present and have the documented shape (27 manifest entries, 25 catalog records)", () => {
  const { manifest, catalog } = loadFixtures();

  assert.equal(manifest.entries.length, 27);
  assert.equal(catalog.anime.length, 25);

  const catalogIds = new Set(catalog.anime.map((item) => item.id));
  assert.deepEqual(manifest.entries.filter((entry) => !catalogIds.has(entry.id)).map((entry) => entry.id), MISSING_IDS);

  // The collision the bug is about: one tmdbId, two manifest entries, only the season tells them apart.
  const jjk = manifest.entries.filter((entry) => entry.tmdbId === 95479);
  const spy = manifest.entries.filter((entry) => entry.tmdbId === 120089);
  assert.deepEqual(jjk.map((entry) => entry.tmdbSeason), [1, 2]);
  assert.deepEqual(spy.map((entry) => entry.tmdbSeason), [1, 2]);
  assert.ok(catalog.anime.every((item) => item.tmdbSeason === undefined), "published records carry no tmdbSeason");
  assert.ok(manifest.entries.every((entry) => entry.platforms === undefined && entry.episodes === undefined), "real manifest has no optional platforms/episodes rows");
});

test("REAL no-key regression: exactly two season-2 records are appended and the 25 originals are untouched", async () => {
  const { manifest, catalog } = loadFixtures();
  const originals = clone(catalog.anime);

  const run = await withNoNetwork(() => runUpdater({ catalog: clone(catalog), manifest }));
  const after = run.catalog;

  assert.equal(run.report.added, 2);
  assert.deepEqual(run.report.addedIds, MISSING_IDS);
  assert.equal(run.report.alreadyInCatalog, 25);
  assert.equal(run.report.updatedExisting, 0, "no existing record is modified");
  assert.equal(run.report.rejected.length, 0);
  assert.equal(run.report.needsReview.length, 0, "nothing was ambiguous");
  assert.equal(run.report.catalogBefore, 25);
  assert.equal(run.report.catalogAfter, 27);
  assert.equal(after.anime.length, 27);
  assert.equal(run.manifestUntouched, true);

  for (const id of MISSING_IDS) assert.equal(after.anime.filter((item) => item.id === id).length, 1, `${id} present exactly once`);
  assert.deepEqual(after.anime.slice(25).map((item) => item.id), MISSING_IDS, "appended at the end, in manifest order");
  assertOriginalsUntouched(after.anime, originals);

  // Legacy season-1 records are matched through their manifest id in memory only: nothing is stamped on them.
  for (const id of ["verified-jujutsu-kaisen-season-1", "verified-spy-x-family-season-1"]) {
    assert.ok(!("tmdbSeason" in after.anime.find((item) => item.id === id)), `${id} was not rewritten to add tmdbSeason`);
  }

  // Top-level scan metadata may change; nothing top-level may be lost.
  for (const key of Object.keys(catalog)) assert.ok(key in after, `top-level "${key}" kept`);
  assert.equal(after.updateInfo.lastScan.added, 2);
  assert.match(after.updateInfo.lastScan.tmdb.note, /TMDB_API_KEY not set/, "unavailable enrichment is explained, not hidden");
  assert.equal(after.updateInfo.lastScan.tmdb.requests, 0);
});

test("REAL second no-key run: no duplicate additions and nothing destructive", async () => {
  const { manifest, catalog } = loadFixtures();
  const originals = clone(catalog.anime);

  const first = await withNoNetwork(() => runUpdater({ catalog: clone(catalog), manifest }));
  const second = await withNoNetwork(() => rerun(first, manifest));

  assert.equal(second.report.added, 0);
  assert.equal(second.report.status, "zero-add");
  assert.equal(second.report.alreadyInCatalog, 27);
  assert.equal(second.report.updatedExisting, 0);
  assert.equal(second.report.rejected.length, 0);
  assert.equal(second.report.needsReview.length, 0);
  assert.equal(second.catalog.anime.length, 27);
  assert.deepStrictEqual(second.catalog.anime, first.catalog.anime, "second run left every record exactly as the first run did");
  assertOriginalsUntouched(second.catalog.anime, originals);
  for (const id of MISSING_IDS) assert.equal(second.catalog.anime.filter((item) => item.id === id).length, 1);
  assert.equal(second.catalog.lastUpdated, first.catalog.lastUpdated, "lastUpdated only moves when something changed");
});

test("appended season-2 records carry their own season identity and only the proof the manifest gave", async () => {
  const { manifest, catalog } = loadFixtures();
  const run = await withNoNetwork(() => runUpdater({ catalog: clone(catalog), manifest }));

  for (const id of MISSING_IDS) {
    const entry = manifest.entries.find((item) => item.id === id);
    const item = run.catalog.anime.find((candidate) => candidate.id === id);

    assert.equal(item.tmdbId, entry.tmdbId);
    assert.equal(item.tmdbSeason, 2);
    assert.equal(item.mediaType, "tv");
    assert.equal(item.tmdbUrl, `https://www.themoviedb.org/tv/${entry.tmdbId}`);
    assert.equal(item.tmdbSeasonUrl, `https://www.themoviedb.org/tv/${entry.tmdbId}/season/2`);

    // The announcement is retained verbatim as Tamil proof; it is not turned into a watch page.
    assert.equal(item.tamilDubVerified, true);
    assert.equal(item.tamilDubVerificationUrl, entry.verification.url);
    assert.deepEqual(item.tamilDubEvidence.map((evidence) => evidence.url), [entry.verification.url]);
    assert.equal(item.tamilDubEvidence[0].platform, "Crunchyroll");

    const byName = Object.fromEntries(item.platforms.map((platform) => [platform.name, platform]));
    assert.equal(byName.Crunchyroll.tamilDubVerified, true);
    assert.deepEqual(byName.Netflix, { name: "Netflix", available: false, officialUrl: null, tamilDubVerified: false });
    assert.deepEqual(byName["Amazon Prime Video"], { name: "Amazon Prime Video", available: false, officialUrl: null, tamilDubVerified: false });

    // Nothing invented without a key: no episodes, no YouTube, no artwork, no streaming URLs.
    assert.deepEqual(item.episodes, []);
    assert.deepEqual(item.youtube, []);
    assert.equal(item.image, null);

    const urls = JSON.stringify(item).match(/https?:\/\/[^"]+/g) || [];
    assert.ok(urls.every((url) => /^https:\/\/(www\.crunchyroll\.com|www\.themoviedb\.org)\//.test(url)), `only crunchyroll proof and tmdb identity urls: ${urls.join(" ")}`);
  }

  // Season 1 and season 2 of the same series stay two records.
  const jjk = run.catalog.anime.filter((item) => item.tmdbId === 95479).map((item) => item.id).sort();
  assert.deepEqual(jjk, ["verified-jujutsu-kaisen-season-1", "verified-jujutsu-kaisen-season-2"]);
});

test("manifest order does not change the outcome (identity is decided before processing)", async () => {
  const { manifest, catalog } = loadFixtures();
  const originals = clone(catalog.anime);
  const reversed = { ...manifest, entries: [...manifest.entries].reverse() };

  const run = await withNoNetwork(() => runUpdater({ catalog: clone(catalog), manifest: reversed }));

  assert.equal(run.report.added, 2);
  assert.deepEqual([...run.report.addedIds].sort(), [...MISSING_IDS].sort());
  assert.equal(run.catalog.anime.length, 27);
  assertOriginalsUntouched(run.catalog.anime, originals);
});

test("with the season-1 records removed the two seasons still land as two separate records", async () => {
  const { manifest, catalog } = loadFixtures();
  const trimmed = clone(catalog);
  trimmed.anime = trimmed.anime.filter((item) => item.tmdbId !== 95479 && item.tmdbId !== 120089);

  const run = await withNoNetwork(() => runUpdater({ catalog: trimmed, manifest }));

  assert.equal(run.report.added, 4);
  for (const [tmdbId, ids] of [[95479, ["verified-jujutsu-kaisen-season-1", "verified-jujutsu-kaisen-season-2"]], [120089, ["verified-spy-x-family-season-1", "verified-spy-x-family-season-2"]]]) {
    const seasons = run.catalog.anime.filter((item) => item.tmdbId === tmdbId);
    assert.deepEqual(seasons.map((item) => item.id).sort(), ids);
    assert.deepEqual(seasons.map((item) => item.tmdbSeason).sort(), [1, 2]);
  }
});
