"use strict";

// Run: node --test tests/*.test.js
// Season-filtered TMDB enrichment with MOCKED TMDB responses (no network, no real key).
// A season entry gets only that season's rows; links are never generated; failures and a missing key
// leave existing data alone and are explained in the report.
const test = require("node:test");
const assert = require("node:assert/strict");
const {
  updater, VERIFICATION_KEYS, clone, manifestOf, seasonEntry, record, recordFor, pick, runUpdater, rerun, reviewText,
  withFetch, withNoNetwork, tmdbMock, requested
} = require("./helpers/harness");

const SHOW = 120089;
const KEY = "test-key-not-real";
const WATCH = "https://www.crunchyroll.com/watch/GABC123/demo-episode-two";

const SERIES = {
  id: SHOW,
  name: "Demo Show",
  original_name: "デモ",
  overview: "Series overview.",
  poster_path: "/series-poster.jpg",
  backdrop_path: "/series-backdrop.jpg",
  vote_average: 8.64,
  first_air_date: "2022-04-09",
  status: "Returning Series",
  genres: [{ name: "Animation" }, { name: "Comedy" }],
  seasons: [
    { season_number: 0, episode_count: 3 },
    { season_number: 1, episode_count: 25 },
    { season_number: 2, episode_count: 3 }
  ]
};

const SEASON_2 = {
  id: 5002,
  season_number: 2,
  air_date: "2023-10-07",
  overview: "Season two overview.",
  episodes: [
    { season_number: 2, episode_number: 1, name: "Episode 1", air_date: "2023-10-07" },
    { season_number: 2, episode_number: 2, name: "The Real Second", air_date: "2023-10-14" },
    { season_number: 2, episode_number: 3, name: "Third Title", air_date: "2023-10-21" }
  ]
};

// If the updater ever asks for season 1 or specials it would receive this and the tests would catch it.
const SEASON_1_TRAP = { id: 5001, season_number: 1, air_date: "2022-04-09", overview: "Season one.", episodes: [{ season_number: 1, episode_number: 1, name: "S1 trap" }] };
const SPECIALS_TRAP = { id: 5000, season_number: 0, air_date: "2022-01-01", episodes: [{ season_number: 0, episode_number: 1, name: "Special trap" }] };

const mock = (overrides = {}) =>
  tmdbMock({ series: { [SHOW]: SERIES }, seasons: { [`${SHOW}:2`]: SEASON_2, [`${SHOW}:1`]: SEASON_1_TRAP, [`${SHOW}:0`]: SPECIALS_TRAP }, ...overrides });

const S2 = seasonEntry(SHOW, 2, { id: "demo-s2", title: "Demo Show Season 2", aliases: ["Demo Show"] });
const catalogOf = (...anime) => ({ lastUpdated: "2026-09-01T00:00:00.000Z", region: "IN", anime });

const EXPECTED_S2_ROWS = [
  { number: "2-1", airDate: "2023-10-07", url: null }, // TMDB's "Episode 1" placeholder is not stored as a title
  { number: "2-2", title: "The Real Second", airDate: "2023-10-14", url: null },
  { number: "2-3", title: "Third Title", airDate: "2023-10-21", url: null }
];

/* ------------------------------------------------------------------ */
/* New season record                                                   */
/* ------------------------------------------------------------------ */

test("a season-2 entry gets only season-2 rows: never season 1, never specials, never a link", async () => {
  const { run, calls } = await withFetch(mock(), async (fetched) => ({
    run: await runUpdater({ manifest: manifestOf(S2), tmdbApiKey: KEY }),
    calls: fetched
  }));

  const item = run.catalog.anime[0];

  assert.equal(run.report.added, 1);
  assert.deepStrictEqual(item.episodes, EXPECTED_S2_ROWS);
  assert.ok(item.episodes.every((row) => row.url === null), "every generated link is null");
  assert.ok(item.episodes.every((row) => row.number.startsWith("2-")), "only season 2 numbering");

  assert.ok(requested(calls, `/tv/${SHOW}/season/2`), "the selected season was requested");
  assert.ok(!requested(calls, "/season/1"), "season 1 was never requested");
  assert.ok(!requested(calls, "/season/0"), "specials were never requested");
  assert.equal(run.report.tmdb.requests, 2, "one series lookup + one season lookup");
  assert.equal(run.report.tmdb.failures, 0);
  assert.deepEqual(run.report.tmdb.unavailable, []);
});

test("season metadata is the season's own; series metadata is limited to poster/rating/tags and is not the release date", async () => {
  const run = await withFetch(mock(), () => runUpdater({ manifest: manifestOf(S2), tmdbApiKey: KEY }));
  const item = run.catalog.anime[0];

  // Season's own provenance.
  assert.equal(item.tmdbSeason, 2);
  assert.equal(item.tmdbSeasonUrl, `https://www.themoviedb.org/tv/${SHOW}/season/2`);
  assert.equal(item.firstAirDate, "2023-10-07", "season air date, not the series first_air_date (2022-04-09)");
  assert.equal(item.createdAt, "2023-10-07T00:00:00Z");
  assert.equal(item.description, "Season two overview.");

  // Series-level metadata is still usable.
  assert.match(item.image, /series-poster\.jpg$/);
  assert.match(item.backdrop, /series-backdrop\.jpg$/);
  assert.equal(item.rating, 8.6);
  assert.deepEqual(item.tags, ["Anime", "Animation", "Comedy"]);

  // The series' ongoing status is not this season's status.
  assert.equal(item.status, null);
  assert.equal(item.availability, "Available");

  // TMDB is metadata, not proof of Tamil audio: the proof is still only the manifest's announcement.
  assert.equal(item.tamilDubVerificationUrl, S2.verification.url);
  assert.equal(item.tamilDubEvidence.length, 1);
  assert.deepEqual(item.youtube, []);
  assert.ok(item.platforms.filter((platform) => platform.name !== "Crunchyroll").every((platform) => platform.available === false && platform.tamilDubVerified === false));
});

test("without a season payload the series date is never borrowed as the season's release date", async () => {
  const noAirDate = { ...SEASON_2, air_date: null };
  const run = await withFetch(mock({ seasons: { [`${SHOW}:2`]: noAirDate } }), () => runUpdater({ manifest: manifestOf(S2), tmdbApiKey: KEY }));

  assert.equal(run.catalog.anime[0].firstAirDate, null);
  assert.equal(run.catalog.anime[0].createdAt === "2022-04-09T00:00:00Z", false);
});

test("TMDB episode objects that carry urls still produce null links", async () => {
  const withLinks = {
    ...SEASON_2,
    episodes: SEASON_2.episodes.map((episode) => ({ ...episode, url: WATCH, homepage: WATCH, link: "https://www.netflix.com/watch/81234567" }))
  };
  const run = await withFetch(mock({ seasons: { [`${SHOW}:2`]: withLinks } }), () => runUpdater({ manifest: manifestOf(S2), tmdbApiKey: KEY }));

  assert.ok(run.catalog.anime[0].episodes.every((row) => row.url === null));
  assert.ok(!JSON.stringify(run.catalog.anime[0].episodes).includes("watch"));
});

test("an explicit official watch link supplied by the manifest is kept on top of TMDB rows; everything else stays null", async () => {
  const entry = { ...S2, episodes: [{ number: "2-2", title: "Curated Two", url: WATCH }] };
  const run = await withFetch(mock(), () => runUpdater({ manifest: manifestOf(entry), tmdbApiKey: KEY }));
  const rows = Object.fromEntries(run.catalog.anime[0].episodes.map((row) => [row.number, row]));

  assert.equal(rows["2-2"].url, WATCH, "exact official watch url from the manifest, Crunchyroll proof exists");
  assert.equal(rows["2-2"].title, "Curated Two", "curated title wins over TMDB");
  assert.equal(rows["2-2"].airDate, "2023-10-14", "TMDB still fills the missing air date");
  assert.equal(rows["2-1"].url, null);
  assert.equal(rows["2-3"].url, null);
  assert.deepEqual(Object.keys(rows).sort(), ["2-1", "2-2", "2-3"], "no duplicate row for 2-2");
});

test("a season that TMDB does not list is reported for review and nothing is appended", async () => {
  const noSeasonTwo = { ...SERIES, seasons: [{ season_number: 0, episode_count: 3 }, { season_number: 1, episode_count: 25 }] };
  const { run, calls } = await withFetch(mock({ series: { [SHOW]: noSeasonTwo } }), async (fetched) => ({
    run: await runUpdater({ manifest: manifestOf(S2), tmdbApiKey: KEY }),
    calls: fetched
  }));

  assert.equal(run.report.added, 0);
  assert.match(reviewText(run.report), /TMDB lists no season 2 for tv 120089/);
  assert.ok(!requested(calls, "/season/"), "no season endpoint is called for a season TMDB does not list");
});

/* ------------------------------------------------------------------ */
/* createSeasonEpisodes                                                */
/* ------------------------------------------------------------------ */

test("createSeasonEpisodes drops other seasons, specials, bad numbers, duplicates and placeholder titles", () => {
  const rows = updater.createSeasonEpisodes(
    {
      season_number: 2,
      episodes: [
        { season_number: 2, episode_number: 3, name: "Third", air_date: "2023-10-21" },
        { season_number: 2, episode_number: 1, name: "Episode 1" },
        { season_number: 1, episode_number: 9, name: "Leaked season one" },
        { season_number: 0, episode_number: 1, name: "Leaked special" },
        { season_number: 2, episode_number: 0, name: "Zero" },
        { season_number: 2, episode_number: "4", name: "String number" },
        { season_number: 2, episode_number: 3, name: "Duplicate third" },
        null,
        "junk",
        { episode_number: 5, name: "  Fifth  ", air_date: "not-a-date" }
      ]
    },
    2
  );

  assert.deepStrictEqual(rows, [
    { number: "2-1", url: null },
    { number: "2-3", title: "Third", airDate: "2023-10-21", url: null },
    { number: "2-5", title: "Fifth", url: null }
  ]);
  assert.deepStrictEqual(updater.createSeasonEpisodes({ episodes: "nope" }, 2), []);
  assert.deepStrictEqual(updater.createSeasonEpisodes(null, 2), []);
});

/* ------------------------------------------------------------------ */
/* Failures and no key                                                 */
/* ------------------------------------------------------------------ */

test("season fetch failure: the record is still added with series-level data, no rows, and the gap is explained", async () => {
  for (const status of [401, 404]) {
    const run = await withFetch(mock({ failSeasonWith: status }), () => runUpdater({ manifest: manifestOf(S2), tmdbApiKey: KEY }));
    const item = run.catalog.anime[0];

    assert.equal(run.report.added, 1, `HTTP ${status}`);
    assert.deepEqual(item.episodes, [], "no rows invented when the season could not be fetched");
    assert.equal(item.firstAirDate, null, "and the series date is not substituted");
    assert.match(item.image, /series-poster\.jpg$/, "series-level metadata still applies");
    assert.equal(run.report.tmdb.unavailable.length, 1);
    assert.match(run.report.tmdb.unavailable[0].reason, /season 2 of tv 120089 (could not be fetched|was not found); season date and episode rows skipped/);
    assert.equal(run.report.needsReview.length, 0, "an unavailable enrichment is not a review item");
  }
});

test("after a failed season fetch the next healthy run fills the season rows in without duplicating the record", async () => {
  const failed = await withFetch(mock({ failSeasonWith: 401 }), () => runUpdater({ manifest: manifestOf(S2), tmdbApiKey: KEY }));
  assert.deepEqual(failed.catalog.anime[0].episodes, []);

  const healthy = await withFetch(mock(), () => rerun(failed, manifestOf(S2), { tmdbApiKey: KEY }));

  assert.equal(healthy.report.added, 0);
  assert.equal(healthy.catalog.anime.length, 1);
  assert.deepStrictEqual(healthy.catalog.anime[0].episodes, EXPECTED_S2_ROWS);
  assert.equal(healthy.catalog.anime[0].firstAirDate, "2023-10-07");
});

test("series fetch failure: record added without TMDB data, season endpoint never called, explanation reported", async () => {
  const { run, calls } = await withFetch(mock({ failSeriesWith: 401 }), async (fetched) => ({
    run: await runUpdater({ manifest: manifestOf(S2), tmdbApiKey: KEY }),
    calls: fetched
  }));

  assert.equal(run.report.added, 1);
  assert.deepEqual(run.catalog.anime[0].episodes, []);
  assert.equal(run.catalog.anime[0].image, null);
  assert.ok(!requested(calls, "/season/"));
  assert.ok(run.report.tmdb.unavailable.some((item) => /could not be fetched; existing data kept/.test(item.reason)));
});

test("a season payload for the wrong season is not accepted", async () => {
  const wrong = { ...SEASON_1_TRAP, season_number: 1 };
  const run = await withFetch(mock({ seasons: { [`${SHOW}:2`]: wrong } }), () => runUpdater({ manifest: manifestOf(S2), tmdbApiKey: KEY }));

  assert.deepEqual(run.catalog.anime[0].episodes, []);
  assert.ok(!JSON.stringify(run.catalog.anime[0]).includes("S1 trap"));
  assert.equal(run.report.tmdb.unavailable.length, 1);
});

test("no API key: offline, nothing fetched, existing season rows untouched, and the report says enrichment was unavailable", async () => {
  const existing = recordFor(S2, { tmdbSeason: 2, episodes: [{ number: "2-1", url: null }], description: "" });
  const before = clone(existing);

  const run = await withNoNetwork(() => runUpdater({ catalog: catalogOf(existing), manifest: manifestOf(S2) }));

  assert.deepStrictEqual(run.catalog.anime[0], before);
  assert.equal(run.report.tmdb.enabled, false);
  assert.equal(run.report.tmdb.requests, 0);
  assert.match(run.report.tmdb.note, /TMDB_API_KEY not set: no TMDB metadata, season dates or season episode rows were fetched/);
});

/* ------------------------------------------------------------------ */
/* Existing records                                                    */
/* ------------------------------------------------------------------ */

const KEEP = "https://www.crunchyroll.com/watch/GKEEP/curated-link";

function curatedExisting() {
  return recordFor(S2, {
    tmdbSeason: 2,
    tmdbSeasonUrl: `https://www.themoviedb.org/tv/${SHOW}/season/2`,
    description: "Curated description",
    firstAirDate: "2023-10-07",
    episodes: [
      { number: "2-1", url: KEEP, platform: "Crunchyroll", note: "curated" },
      { number: "1-1", title: "S1 stays", url: null },
      { number: "2-2", title: "Curated Title", url: null }
    ]
  });
}

test("existing episode rows are merged by number: nothing deleted or reordered, curated values and urls kept", async () => {
  const existing = curatedExisting();
  const before = clone(existing);

  const run = await withFetch(mock(), () => runUpdater({ catalog: catalogOf(existing), manifest: manifestOf(S2), tmdbApiKey: KEY }));
  const after = run.catalog.anime[0];

  assert.deepStrictEqual(after.episodes, [
    { number: "2-1", url: KEEP, platform: "Crunchyroll", note: "curated", airDate: "2023-10-07" },
    { number: "1-1", title: "S1 stays", url: null },
    { number: "2-2", title: "Curated Title", url: null, airDate: "2023-10-14" },
    { number: "2-3", title: "Third Title", airDate: "2023-10-21", url: null }
  ]);
  assert.ok(before.episodes.every((row, index) => after.episodes[index].number === row.number), "existing rows keep their positions");
  assert.equal(run.catalog.anime.length, 1);
});

test("TMDB enrichment never touches verification data, platforms or nonempty record fields", async () => {
  const existing = curatedExisting();
  const before = clone(existing);

  const run = await withFetch(mock(), () => runUpdater({ catalog: catalogOf(existing), manifest: manifestOf(S2), tmdbApiKey: KEY }));
  const after = run.catalog.anime[0];

  assert.deepStrictEqual(pick(after, VERIFICATION_KEYS), pick(before, VERIFICATION_KEYS));
  assert.deepStrictEqual(after.platforms, before.platforms);
  for (const key of ["title", "originalTitle", "description", "image", "backdrop", "rating", "status", "availability", "firstAirDate", "createdAt", "tags", "youtube", "tmdbId", "tmdbSeason", "id"]) {
    assert.deepStrictEqual(after[key], before[key], `${key} unchanged`);
  }
});

test("a verified record that is not in the manifest is enriched for ITS season too (explicit tmdbSeason)", async () => {
  const other = seasonEntry(777, 1, { id: "other-s1", title: "Other Show Season 1", aliases: ["Other Show"] });
  const otherSeries = { id: 777, name: "Other Show", original_name: "Other", overview: "Other.", poster_path: "/o.jpg", vote_average: 7, first_air_date: "2020-01-01", status: "Ended", genres: [], seasons: [{ season_number: 1, episode_count: 1 }] };
  const otherSeason = { season_number: 1, air_date: "2020-01-01", overview: "Other season.", episodes: [{ season_number: 1, episode_number: 1, name: "Pilot", air_date: "2020-01-01" }] };

  const stray = recordFor(S2, { title: "Demo Show", tmdbSeason: 2, episodes: [{ number: "2-1", url: null }], description: "" });
  const handler = mock({ series: { [SHOW]: SERIES, 777: otherSeries }, seasons: { [`${SHOW}:2`]: SEASON_2, [`${SHOW}:1`]: SEASON_1_TRAP, "777:1": otherSeason } });

  const { run, calls } = await withFetch(handler, async (fetched) => ({
    run: await runUpdater({ catalog: catalogOf(stray), manifest: manifestOf(other), tmdbApiKey: KEY }),
    calls: fetched
  }));

  const after = run.catalog.anime.find((item) => item.id === S2.id);
  assert.deepStrictEqual(after.episodes.map((row) => row.number), ["2-1", "2-2", "2-3"]);
  assert.ok(!requested(calls, `/tv/${SHOW}/season/1`));
  assert.equal(after.tmdbSeason, 2);
});

/* ------------------------------------------------------------------ */
/* Older records that have no tmdbSeason (owned by a manifest id)      */
/* ------------------------------------------------------------------ */

test("an old record with its own flat rows and nothing missing triggers no TMDB request at all", async () => {
  const old = recordFor(S2, { episodes: [{ number: "1-1", url: null }, { number: "1-2", url: null }] });
  const before = clone(old);

  const { run, calls } = await withFetch(mock(), async (fetched) => ({
    run: await runUpdater({ catalog: catalogOf(old), manifest: manifestOf(S2), tmdbApiKey: KEY }),
    calls: fetched
  }));

  assert.deepStrictEqual(calls, []);
  assert.equal(JSON.stringify(run.catalog.anime[0]), JSON.stringify(before));
});

test("an old record missing a field gets series-level metadata but keeps its own episode rows and date, and is not stamped with a season", async () => {
  const old = recordFor(S2, { description: "", episodes: [{ number: "1-1", url: null }, { number: "1-2", url: null }] });
  const before = clone(old);

  const run = await withFetch(mock(), () => runUpdater({ catalog: catalogOf(old), manifest: manifestOf(S2), tmdbApiKey: KEY }));
  const after = run.catalog.anime[0];

  assert.equal(after.description, "Season two overview.", "the missing description was filled");
  assert.deepStrictEqual(after.episodes, before.episodes, "its own numbering is never mixed with season rows");
  assert.equal(after.firstAirDate, before.firstAirDate);
  assert.ok(!("tmdbSeason" in after), "the season is not written onto an old record");
  assert.deepStrictEqual(pick(after, VERIFICATION_KEYS), pick(before, VERIFICATION_KEYS));
});

test("an old record with no episode rows at all receives season rows only", async () => {
  const old = recordFor(S2, { episodes: [] });
  const run = await withFetch(mock(), () => runUpdater({ catalog: catalogOf(old), manifest: manifestOf(S2), tmdbApiKey: KEY }));

  assert.deepStrictEqual(run.catalog.anime[0].episodes, EXPECTED_S2_ROWS);
  assert.ok(!("tmdbSeason" in run.catalog.anime[0]));
});

/* ------------------------------------------------------------------ */
/* Series-level (legacy) behaviour is unchanged                        */
/* ------------------------------------------------------------------ */

test("contrast: an entry WITHOUT tmdbSeason keeps the old series-level behaviour, an entry WITH it is season-filtered", async () => {
  const legacyEntry = { id: "demo-series", title: "Demo Show", mediaType: "tv", year: 2022, tmdbId: SHOW, tamilDubVerified: true, verification: { url: S2.verification.url, checkedAt: "2026-10-01" } };

  const legacy = await withFetch(mock(), () => runUpdater({ manifest: manifestOf(legacyEntry), tmdbApiKey: KEY }));
  const rows = legacy.catalog.anime[0].episodes;

  assert.equal(rows.length, 25 + 3, "series-level numbering from every non-special season, as before");
  assert.ok(rows.every((row) => row.url === null && row.title === undefined));
  assert.equal(legacy.catalog.anime[0].firstAirDate, "2022-04-09", "series date for a series-level entry");
  assert.ok(!("tmdbSeason" in legacy.catalog.anime[0]));

  const season = await withFetch(mock(), () => runUpdater({ manifest: manifestOf(S2), tmdbApiKey: KEY }));
  assert.equal(season.catalog.anime[0].episodes.length, 3);
});
