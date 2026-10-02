"use strict";

// Run: node --test tests/*.test.js
// Season identity: several manifest entries can share one tmdbId; only exact id or tmdbId + tmdbSeason may
// pick a record for an explicit season entry. Ambiguity is reported for review, never guessed.
const test = require("node:test");
const assert = require("node:assert/strict");
const {
  updater, CHANNEL, CR_NEWS, clone, manifestOf, seasonEntry, record, recordFor, runUpdater, rerun, reviewText, withNoNetwork
} = require("./helpers/harness");

const SHOW = 95479;
const channels = new Map([[CHANNEL, { name: "Muse India" }]]);

const catalogOf = (...anime) => ({ lastUpdated: "2026-09-01T00:00:00.000Z", region: "IN", anime });
const S1 = seasonEntry(SHOW, 1);
const S2 = seasonEntry(SHOW, 2);

/* ------------------------------------------------------------------ */
/* Shared TMDB ids                                                     */
/* ------------------------------------------------------------------ */

test("two seasons of one tmdbId become two records, each with its own season, and a re-run changes nothing", async () => {
  const first = await withNoNetwork(() => runUpdater({ manifest: manifestOf(S1, S2) }));

  assert.equal(first.report.added, 2);
  assert.deepEqual(first.catalog.anime.map((item) => [item.id, item.tmdbId, item.tmdbSeason]), [
    [S1.id, SHOW, 1],
    [S2.id, SHOW, 2]
  ]);

  const second = await withNoNetwork(() => rerun(first, manifestOf(S1, S2)));
  assert.equal(second.report.added, 0);
  assert.deepStrictEqual(second.catalog.anime, first.catalog.anime);
});

test("a shared tv:<id> is not the same title across explicit seasons (series-only recordTmdbKey is unchanged)", () => {
  const s1 = recordFor(S1, { tmdbSeason: 1 });
  const s2 = recordFor(S2, { tmdbSeason: 2 });

  assert.equal(updater.recordTmdbKey(s1), `tv:${SHOW}`, "recordTmdbKey stays series-only");
  assert.equal(updater.recordTmdbKey(s2), `tv:${SHOW}`);
  assert.equal(updater.recordTmdbKey({ tmdbId: SHOW, mediaType: "tv", tmdbSeason: 2 }), `tv:${SHOW}`, "tmdbSeason does not leak into the series key");

  assert.equal(updater.recordSeasonKey(s1), `tv:${SHOW}:s1`);
  assert.equal(updater.recordSeasonKey(s2), `tv:${SHOW}:s2`);
  assert.equal(updater.recordSeasonKey(recordFor(S1)), null, "a record without tmdbSeason has no season identity of its own");
  assert.equal(updater.recordSeasonKey({ tmdbId: SHOW, mediaType: "movie", tmdbSeason: 1 }), null, "movies have no season identity");
  assert.equal(updater.tmdbSeasonKey("tv", SHOW, 2), `tv:${SHOW}:s2`);
  assert.equal(updater.tmdbSeasonKey("movie", SHOW, 2), null);
  assert.equal(updater.tmdbSeasonKey("tv", SHOW, 0), null);

  const claims = new Map();
  assert.equal(updater.matchIdentity([s1], { ...S2, aliases: [] }, claims).action, "none", "S2 does not match the S1 record through the shared tmdbId");
  assert.equal(updater.matchIdentity([s1, s2], { ...S2 }, claims).record, s2, "S2 matches only the S2 record");
});

test("generated ids differ per season, and an entry without tmdbSeason never gets one", () => {
  const base = { title: "Demo Show", mediaType: "tv", tmdbId: SHOW, tamilDubVerified: true, verification: { url: CR_NEWS } };

  const ids = [1, 2].map((tmdbSeason) => updater.validateEntry({ ...base, tmdbSeason }, channels).entry.id);
  assert.deepEqual(ids, [`tmdb-${SHOW}-s1`, `tmdb-${SHOW}-s2`], "no id collision between seasons");

  const legacy = updater.validateEntry(base, channels);
  assert.equal(legacy.entry.id, `tmdb-${SHOW}`, "legacy generated id is unchanged");
  assert.ok(!("tmdbSeason" in legacy.entry), "a missing season is not inferred as season 1");
});

/* ------------------------------------------------------------------ */
/* Shared aliases / titles                                             */
/* ------------------------------------------------------------------ */

test("a series alias shared by two seasons never collapses them (alias, original title and year all overlap)", async () => {
  const s1 = recordFor(S1, { title: "Demo Show", originalTitle: "Demo Show", tmdbSeason: 1, firstAirDate: "2021-01-01" });
  const before = clone(s1);
  const entry = seasonEntry(SHOW, 2, { title: "Demo Show", originalTitle: "Demo Show", aliases: ["Demo Show"], year: 2021 });

  const run = await withNoNetwork(() => runUpdater({ catalog: catalogOf(s1), manifest: manifestOf(entry) }));

  assert.equal(run.report.added, 1);
  assert.equal(run.catalog.anime.length, 2);
  assert.deepStrictEqual(run.catalog.anime[0], before, "the season-1 record is untouched");
  assert.equal(run.catalog.anime[1].tmdbSeason, 2);
  assert.equal(run.report.needsReview.length, 0);
});

test("a season entry never merges by title or alias, even when the year agrees: it goes to review", async () => {
  const manual = record("manual-demo", { title: "Demo Show", aliases: ["Demo Show"], firstAirDate: "2021-04-01" });
  delete manual.tmdbId; delete manual.tmdbUrl; delete manual.mediaType;
  const before = clone(manual);

  const run = await withNoNetwork(() => runUpdater({ catalog: catalogOf(manual), manifest: manifestOf(seasonEntry(SHOW, 2, { year: 2021 })) }));

  assert.equal(run.report.added, 0);
  assert.equal(run.catalog.anime.length, 1);
  assert.deepStrictEqual(run.catalog.anime[0], before, "the title match was not merged");
  assert.match(reviewText(run.report), /season entry merges only by exact id or tmdbId \+ tmdbSeason/);
});

test("a season entry whose only title overlap is years apart is a new record (title fallback still protects real remakes)", async () => {
  const manual = record("manual-demo", { title: "Demo Show", aliases: ["Demo Show"], firstAirDate: "1999-04-01" });
  delete manual.tmdbId; delete manual.tmdbUrl; delete manual.mediaType;

  const run = await withNoNetwork(() => runUpdater({ catalog: catalogOf(manual), manifest: manifestOf(seasonEntry(SHOW, 2, { year: 2021 })) }));

  assert.equal(run.report.added, 1);
  assert.equal(run.report.needsReview.length, 0);
});

/* ------------------------------------------------------------------ */
/* Old records with no tmdbSeason                                      */
/* ------------------------------------------------------------------ */

test("old records with no tmdbSeason are owned by their manifest id: season 2 appends, season 1 is left byte-identical", async () => {
  for (const order of [[S1, S2], [S2, S1]]) {
    const legacy = recordFor(S1); // no tmdbSeason, same tmdbId as season 2
    const before = clone(legacy);

    const run = await withNoNetwork(() => runUpdater({ catalog: catalogOf(legacy), manifest: manifestOf(...order) }));

    assert.equal(run.report.added, 1, `order ${order.map((e) => e.tmdbSeason)}`);
    assert.deepEqual(run.report.addedIds, [S2.id]);
    assert.equal(run.report.alreadyInCatalog, 1);
    assert.equal(JSON.stringify(run.catalog.anime[0]), JSON.stringify(before), "legacy record not rewritten");
    assert.ok(!("tmdbSeason" in run.catalog.anime[0]), "tmdbSeason is not stamped onto the old record");
    assert.equal(run.report.needsReview.length, 0);
  }
});

test("an old record nobody claims that shares the tmdbId makes the season ambiguous: reported, nothing appended or changed", async () => {
  const unclaimed = recordFor(S1, { id: "tmdb-95479", title: "Demo Show (auto)" });
  const before = clone(unclaimed);

  const run = await withNoNetwork(() => runUpdater({ catalog: catalogOf(unclaimed), manifest: manifestOf(S2) }));

  assert.equal(run.report.added, 0);
  assert.equal(run.catalog.anime.length, 1);
  assert.deepStrictEqual(run.catalog.anime[0], before);
  assert.match(reviewText(run.report), /no usable tmdbSeason and no manifest entry claims them/);
});

test("an old record with an unusable tmdbSeason is ambiguous too (string, zero, out of range)", async () => {
  for (const bad of ["2", 0, -1, 1.5, 100, true, {}]) {
    const odd = recordFor(S1, { id: "odd-record", tmdbSeason: bad });
    const run = await withNoNetwork(() => runUpdater({ catalog: catalogOf(odd), manifest: manifestOf(S2) }));

    assert.equal(run.report.added, 0, `tmdbSeason ${JSON.stringify(bad)}`);
    assert.match(reviewText(run.report), /no usable tmdbSeason/);
    assert.deepStrictEqual(run.catalog.anime[0], odd);
  }
});

/* ------------------------------------------------------------------ */
/* Exact id                                                            */
/* ------------------------------------------------------------------ */

test("exact stable id is considered first and merges into the right record without duplicating it", async () => {
  const s2 = recordFor(S2, { tmdbSeason: 2 });
  const s1 = recordFor(S1, { tmdbSeason: 1 });
  const run = await withNoNetwork(() => runUpdater({ catalog: catalogOf(s1, s2), manifest: manifestOf(S2) }));

  assert.equal(run.report.added, 0);
  assert.equal(run.report.alreadyInCatalog, 1);
  assert.equal(run.catalog.anime.length, 2);
  assert.deepStrictEqual(run.catalog.anime, [s1, s2]);
});

test("exact id wins over a different record that shares the tmdbId and season only when it is consistent", async () => {
  const exact = recordFor(S2, { tmdbSeason: 2 });
  const duplicate = recordFor(S2, { id: "dup-s2", tmdbSeason: 2 });

  const run = await withNoNetwork(() => runUpdater({ catalog: catalogOf(exact, duplicate), manifest: manifestOf(S2) }));

  assert.equal(run.report.added, 0);
  assert.equal(run.catalog.anime.length, 2, "the exact record was chosen; the other was neither merged nor removed");
  assert.deepStrictEqual(run.catalog.anime, [exact, duplicate]);
});

test("two records with one id is reported, not merged", async () => {
  const a = recordFor(S2, { tmdbSeason: 2 });
  const run = await withNoNetwork(() => runUpdater({ catalog: catalogOf(a, clone(a)), manifest: manifestOf(S2) }));

  assert.equal(run.report.added, 0);
  assert.match(reviewText(run.report), /identity matches several existing records/);
  assert.equal(run.catalog.anime.length, 2);
});

/* ------------------------------------------------------------------ */
/* Same-season duplicates                                              */
/* ------------------------------------------------------------------ */

test("two catalog records for the same season are reported for review instead of picking one", async () => {
  const a = recordFor(S2, { id: "dup-a", tmdbSeason: 2 });
  const b = recordFor(S2, { id: "dup-b", tmdbSeason: 2 });

  const run = await withNoNetwork(() => runUpdater({ catalog: catalogOf(a, b), manifest: manifestOf(S2) }));

  assert.equal(run.report.added, 0);
  assert.match(reviewText(run.report), /several existing records are tv:95479 season 2/);
  assert.deepStrictEqual(run.catalog.anime, [a, b]);
});

test("two manifest entries with different ids for the same season are both reported and neither is added", async () => {
  const a = seasonEntry(SHOW, 2, { id: "season-two-a" });
  const b = seasonEntry(SHOW, 2, { id: "season-two-b", verification: { url: "https://www.crunchyroll.com/news/announcements/2024/1/1/other", checkedAt: "2026-10-01" } });

  const run = await withNoNetwork(() => runUpdater({ manifest: manifestOf(a, b) }));

  assert.equal(run.report.added, 0, "neither entry is added");
  assert.equal(run.catalog.anime.length, 0);

  // The existing review() de-duplicates on title + reason, and these two entries share a title, so they
  // surface as one line. That line names both ids, which is what a curator needs to fix the manifest.
  const text = reviewText(run.report);
  assert.match(text, /keep one entry per season/);
  assert.match(text, /season-two-a/);
  assert.match(text, /season-two-b/);
});

test("the same entry listed twice (same id, same identity) still just adds evidence to one record", async () => {
  const again = seasonEntry(SHOW, 2, { verification: { url: "https://www.crunchyroll.com/news/announcements/2024/2/2/second-source", checkedAt: "2026-10-01" } });
  const run = await withNoNetwork(() => runUpdater({ manifest: manifestOf(S2, again) }));

  assert.equal(run.report.added, 1);
  assert.equal(run.catalog.anime.length, 1);
  assert.equal(run.catalog.anime[0].tamilDubEvidence.length, 2);
  assert.equal(run.report.needsReview.length, 0);
});

/* ------------------------------------------------------------------ */
/* Conflicting ids / seasons                                           */
/* ------------------------------------------------------------------ */

test("an exact id whose record is another season is a conflict: reported, nothing merged, nothing appended", async () => {
  const wrongSeason = recordFor(S2, { tmdbSeason: 1 }); // id says season 2, field says season 1
  const run = await withNoNetwork(() => runUpdater({ catalog: catalogOf(wrongSeason), manifest: manifestOf(S2) }));

  assert.equal(run.report.added, 0);
  assert.match(reviewText(run.report), /is season 1 but this manifest entry is season 2; seasons are never merged/);
  assert.deepStrictEqual(run.catalog.anime, [wrongSeason]);
});

test("an exact id whose record has another tmdbId is a conflict", async () => {
  const other = recordFor(S2, { tmdbId: 111, tmdbUrl: "https://www.themoviedb.org/tv/111" });
  const run = await withNoNetwork(() => runUpdater({ catalog: catalogOf(other), manifest: manifestOf(S2) }));

  assert.equal(run.report.added, 0);
  assert.match(reviewText(run.report), /is tv:111 but this manifest entry is tv:95479; the ids conflict/);
  assert.deepStrictEqual(run.catalog.anime, [other]);
});

test("an exact id whose record has an unusable tmdbSeason is a conflict", async () => {
  const odd = recordFor(S2, { tmdbSeason: "2" });
  const run = await withNoNetwork(() => runUpdater({ catalog: catalogOf(odd), manifest: manifestOf(S2) }));

  assert.equal(run.report.added, 0);
  assert.match(reviewText(run.report), /unusable tmdbSeason/);
  assert.deepStrictEqual(run.catalog.anime, [odd]);
});

test("one manifest id used with different seasons is reported for both entries and adds nothing", async () => {
  const a = seasonEntry(SHOW, 1, { id: "same-id" });
  const b = seasonEntry(SHOW, 2, { id: "same-id" });
  const run = await withNoNetwork(() => runUpdater({ manifest: manifestOf(a, b) }));

  assert.equal(run.report.added, 0);
  assert.equal(run.report.needsReview.filter((item) => /different tmdbId\/tmdbSeason\/mediaType/.test(item.reason)).length, 2);
});

/* ------------------------------------------------------------------ */
/* Movie versus TV                                                     */
/* ------------------------------------------------------------------ */

test("a TV season never matches a movie that shares the tmdbId, and vice versa", async () => {
  const movie = record("tmdb-movie-95479", { title: "Demo Show Movie", mediaType: "movie", tmdbId: SHOW, tmdbUrl: `https://www.themoviedb.org/movie/${SHOW}`, episodes: [] });
  const movieBefore = clone(movie);

  const tv = await withNoNetwork(() => runUpdater({ catalog: catalogOf(movie), manifest: manifestOf(S2) }));
  assert.equal(tv.report.added, 1, "the TV season was not swallowed by the movie");
  assert.deepStrictEqual(tv.catalog.anime[0], movieBefore);

  const season = recordFor(S2, { tmdbSeason: 2 });
  const seasonBefore = clone(season);
  const movieEntry = { id: "show-movie", title: "Demo Show Movie", mediaType: "movie", year: 2021, tmdbId: SHOW, tamilDubVerified: true, verification: { url: CR_NEWS, checkedAt: "2026-10-01" } };

  const reverse = await withNoNetwork(() => runUpdater({ catalog: catalogOf(season), manifest: manifestOf(movieEntry) }));
  assert.equal(reverse.report.added, 1, "the movie was not swallowed by the TV season");
  assert.deepStrictEqual(reverse.catalog.anime[0], seasonBefore);
});

/* ------------------------------------------------------------------ */
/* Invalid season values                                               */
/* ------------------------------------------------------------------ */

const base = { id: "x", title: "X", mediaType: "tv", tmdbId: 5, tamilDubVerified: true, verification: { url: CR_NEWS, checkedAt: "2026-10-01" } };

test("tmdbSeason must be an integer from 1 to 99: everything else is rejected with a clear reason", () => {
  for (const bad of [0, -1, 1.5, 100, 1e9, "2", "abc", " 2 ", true, false, [], [2], {}, NaN, Infinity]) {
    const result = updater.validateEntry({ ...base, tmdbSeason: bad }, channels);

    assert.equal(result.ok, false, `tmdbSeason ${JSON.stringify(bad)} must be rejected`);
    assert.match(result.reason, /tmdbSeason must be an integer from 1 to 99/);
  }

  for (const good of [1, 2, 12, 99]) {
    const result = updater.validateEntry({ ...base, tmdbSeason: good }, channels);
    assert.equal(result.ok, true, `tmdbSeason ${good}`);
    assert.equal(result.entry.tmdbSeason, good);
  }
});

test("tmdbSeason is TV only and needs a tmdbId", () => {
  assert.match(updater.validateEntry({ ...base, mediaType: "movie", tmdbSeason: 1 }, channels).reason, /only valid for TV entries/);

  const noId = { ...base, tmdbSeason: 2 };
  delete noId.tmdbId;
  assert.match(updater.validateEntry(noId, channels).reason, /needs a tmdbId/);

  // Absent is fine: undefined, null and "" all mean "no season", and the key does not appear.
  for (const absent of [undefined, null, ""]) {
    const result = updater.validateEntry({ ...base, tmdbSeason: absent }, channels);
    assert.equal(result.ok, true);
    assert.ok(!("tmdbSeason" in result.entry));
  }
});

test("entries with invalid seasons are rejected in a run and add nothing", async () => {
  const bad = [
    { ...base, id: "bad-zero", tmdbSeason: 0 },
    { ...base, id: "bad-string", tmdbSeason: "2" },
    { ...base, id: "bad-movie", mediaType: "movie", tmdbSeason: 1 }
  ];

  const run = await withNoNetwork(() => runUpdater({ manifest: manifestOf(...bad) }));

  assert.equal(run.report.added, 0);
  assert.equal(run.report.rejected.length, 3);
  assert.equal(run.catalog.anime.length, 0);
});

test("episode rows numbered for another season are dropped from a season entry, with a note", () => {
  const result = updater.validateEntry(
    {
      ...base,
      tmdbSeason: 2,
      episodes: [{ number: "1-3", title: "Season one episode" }, { number: "2-1", title: "Season two episode" }, { number: "4", title: "Plain number" }]
    },
    channels
  );

  assert.equal(result.ok, true);
  assert.deepEqual(result.entry.episodes.map((item) => item.number), ["2-1", "4"]);
  assert.match(result.warnings.join(" "), /1 row\(s\) numbered for another season dropped \(this entry is season 2\)/);
});

/* ------------------------------------------------------------------ */
/* Legacy unseasoned series keep working                               */
/* ------------------------------------------------------------------ */

test("legacy unseasoned entries still match legacy records by tmdbId and by exact id (no season involved)", async () => {
  const legacyRecord = record("legacy-show", { title: "Legacy Show", tmdbId: 777, tmdbUrl: "https://www.themoviedb.org/tv/777" });
  const entry = { id: "differently-named", title: "Legacy Show (manifest)", mediaType: "tv", tmdbId: 777, year: 2020, tamilDubVerified: true, verification: { url: CR_NEWS, checkedAt: "2026-10-01" } };

  const run = await withNoNetwork(() => runUpdater({ catalog: catalogOf(legacyRecord), manifest: manifestOf(entry) }));

  assert.equal(run.report.added, 0, "matched by tv:777, not duplicated");
  assert.equal(run.catalog.anime.length, 1);
  assert.equal(run.catalog.anime[0].id, "legacy-show");
  assert.ok(!("tmdbSeason" in run.catalog.anime[0]));
});

test("an unseasoned entry never silently joins a season-specific record it only shares a tmdbId with", async () => {
  const s2 = recordFor(S2, { tmdbSeason: 2 });
  const unseasoned = { id: "show-series", title: "Demo Show", mediaType: "tv", tmdbId: SHOW, year: 2020, tamilDubVerified: true, verification: { url: CR_NEWS, checkedAt: "2026-10-01" } };

  const run = await withNoNetwork(() => runUpdater({ catalog: catalogOf(s2), manifest: manifestOf(unseasoned) }));

  assert.equal(run.report.added, 0);
  assert.deepStrictEqual(run.catalog.anime, [s2]);
  assert.match(reviewText(run.report), /has no tmdbSeason but existing record\(s\) .* are season-specific/);
});

test("an unseasoned entry does not join an old record that a season entry owns by id", async () => {
  const s1 = recordFor(S1); // old record, no tmdbSeason, owned by the S1 manifest entry
  const unseasoned = { id: "show-series", title: "Demo Show", mediaType: "tv", tmdbId: SHOW, year: 2020, tamilDubVerified: true, verification: { url: CR_NEWS, checkedAt: "2026-10-01" } };
  const before = clone(s1);

  const run = await withNoNetwork(() => runUpdater({ catalog: catalogOf(s1), manifest: manifestOf(S1, unseasoned) }));

  assert.equal(run.report.added, 0);
  assert.equal(JSON.stringify(run.catalog.anime[0]), JSON.stringify(before));
  assert.match(reviewText(run.report), /show-series|Demo Show/);
});

test("a manual record with no tmdbId and an unseasoned entry still match by title + year as before", async () => {
  const manual = record("manual-show", { title: "Manual Show", aliases: ["Manual Show"], firstAirDate: "2005-04-01" });
  delete manual.tmdbId; delete manual.tmdbUrl; delete manual.mediaType;
  const entry = { id: "official-manual-show", title: "Manual Show", mediaType: "tv", year: 2005, tamilDubVerified: true, verification: { url: CR_NEWS, checkedAt: "2026-10-01" } };

  const run = await withNoNetwork(() => runUpdater({ catalog: catalogOf(manual), manifest: manifestOf(entry) }));

  assert.equal(run.report.added, 0, "same title, same year: merged");
  assert.equal(run.catalog.anime.length, 1);
});

/* ------------------------------------------------------------------ */
/* analyzeManifestIdentities                                           */
/* ------------------------------------------------------------------ */

test("analyzeManifestIdentities claims ids with their season and flags contradictions", () => {
  const entries = (list) => list.map((entry) => ({ label: entry.title, entry: updater.validateEntry(entry, channels).entry }));

  const clean = updater.analyzeManifestIdentities(entries([S1, S2]));
  assert.deepEqual(clean.claims.get(S1.id), { key: `tv:${SHOW}`, season: 1, conflict: false });
  assert.deepEqual(clean.claims.get(S2.id), { key: `tv:${SHOW}`, season: 2, conflict: false });
  assert.equal(clean.conflicts.size, 0);

  const legacy = updater.analyzeManifestIdentities(entries([{ ...base, id: "plain" }]));
  assert.deepEqual(legacy.claims.get("plain"), { key: "tv:5", season: null, conflict: false });

  const clash = updater.analyzeManifestIdentities(entries([seasonEntry(SHOW, 1, { id: "dup" }), seasonEntry(SHOW, 2, { id: "dup" })]));
  assert.equal(clash.claims.get("dup").conflict, true);
  assert.equal(clash.conflicts.size, 2);
});
