"use strict";

// Run: node --test tests/*.test.js
// Backfill on EXISTING records, tested on its own: genuinely missing platform / episode / youtube fields gain
// only what explicit trusted input supports; nonempty values and ALL verification data stay as they were.
const test = require("node:test");
const assert = require("node:assert/strict");
const {
  updater, CHANNEL, CR_NEWS, NF_TITLE, PRIME_TITLE, VIDEO, VERIFICATION_KEYS,
  clone, manifestOf, record, pick, runUpdater, rerun, withNoNetwork
} = require("./helpers/harness");

const CR_WATCH = "https://www.crunchyroll.com/watch/GEP1/the-start";
const NF_WATCH = "https://www.netflix.com/watch/81000002";
const KEEP_URL = "https://www.crunchyroll.com/watch/GKEEP/curated-link";
const channels = new Map([[CHANNEL, { name: "Muse India" }]]);

const catalogOf = (...anime) => ({ lastUpdated: "2026-09-01T00:00:00.000Z", region: "IN", anime });
const byName = (item) => Object.fromEntries(item.platforms.map((platform) => [platform.name, platform]));

const entry = (extra = {}) => ({
  id: "backfill-show",
  title: "Backfill Show",
  mediaType: "tv",
  year: 2020,
  tamilDubVerified: true,
  verification: { url: CR_NEWS, checkedAt: "2026-10-01", note: "Tamil dub" },
  ...extra
});

// Hand-curated verification values that a backfill must never overwrite.
const curatedVerification = {
  tamilDubVerificationSource: "Curated by hand",
  tamilDubVerifiedAt: "2025-05-05",
  tamilDubEvidence: [{ platform: "Crunchyroll", url: CR_NEWS, source: "Crunchyroll official listing/announcement", checkedAt: "2025-05-05", note: "Hand-written note" }]
};

const existing = (extra = {}) => record("backfill-show", { title: "Backfill Show", ...curatedVerification, ...extra });

/* ------------------------------------------------------------------ */
/* Existing records gain only what the entry supports                  */
/* ------------------------------------------------------------------ */

test("existing record: missing platform fields, episode titles and urls are filled from explicit input only", async () => {
  const stored = existing();
  const before = clone(stored);

  const manifest = manifestOf(entry({
    platforms: [{ name: "Netflix", available: true, officialUrl: NF_TITLE }],
    episodes: [
      { number: "1-1", title: "The Start", url: CR_WATCH },
      { number: "1-2", title: "The Second", url: NF_WATCH },
      { number: "1-3", title: "Announcement as link", url: CR_NEWS },
      { number: "1-4", title: "Bare video", url: VIDEO },
      { number: "1-5", url: "https://www.youtube.com/results?search_query=backfill+show" },
      { number: "1-6", url: "https://www.youtube.com/@MuseIndia" }
    ]
  }));

  const run = await withNoNetwork(() => runUpdater({ catalog: catalogOf(stored), manifest }));
  const after = run.catalog.anime[0];

  assert.equal(run.report.added, 0);
  assert.equal(run.catalog.anime.length, 1);

  assert.deepStrictEqual(after.episodes, [
    { number: "1-1", url: CR_WATCH, title: "The Start", platform: "Crunchyroll" }, // Crunchyroll proof exists: link kept
    { number: "1-2", url: null, title: "The Second" }, // Netflix has no Tamil proof: title kept, link dropped
    { number: "1-3", title: "Announcement as link", url: null }, // an announcement is proof, not a watch page
    { number: "1-4", title: "Bare video", url: null }, // a bare YouTube video is not evidence
    { number: "1-5", url: null }, // search URL
    { number: "1-6", url: null } // channel home
  ], "existing rows keep their positions; new rows are appended in manifest order; no unconfirmed link");

  const platforms = byName(after);
  assert.equal(platforms.Netflix.available, true);
  assert.equal(platforms.Netflix.officialUrl, NF_TITLE);
  assert.equal(platforms.Netflix.tamilDubVerified, false, "a title listing is availability, not Tamil audio");
  assert.deepStrictEqual(platforms.Crunchyroll, before.platforms[0], "the verified Crunchyroll row is unchanged");
  assert.deepStrictEqual(platforms["Amazon Prime Video"], before.platforms[2]);

  assert.deepStrictEqual(pick(after, VERIFICATION_KEYS), pick(before, VERIFICATION_KEYS), "ALL verification data unchanged, including hand-written values");
  assert.deepStrictEqual(after.youtube, [], "no YouTube link appears from a bare video");
});

test("existing record with the platforms and episodes arrays missing altogether gets them back from the entry", async () => {
  const stored = existing();
  delete stored.platforms;
  delete stored.episodes;
  const before = clone(stored);

  const manifest = manifestOf(entry({
    platforms: [{ name: "Netflix", available: true, officialUrl: NF_TITLE }],
    episodes: [{ number: "1-1", title: "The Start", url: CR_WATCH }]
  }));

  const run = await withNoNetwork(() => runUpdater({ catalog: catalogOf(stored), manifest }));
  const after = run.catalog.anime[0];
  const platforms = byName(after);

  assert.deepStrictEqual(after.episodes, [{ number: "1-1", url: CR_WATCH, title: "The Start", platform: "Crunchyroll" }]);
  assert.equal(platforms.Netflix.officialUrl, NF_TITLE);
  assert.equal(platforms.Netflix.tamilDubVerified, false);
  assert.equal(platforms.Crunchyroll.tamilDubVerified, true);
  assert.equal(platforms.Crunchyroll.tamilDubVerificationUrl, CR_NEWS, "the Crunchyroll row points at the record's own proof");
  assert.deepStrictEqual(pick(after, VERIFICATION_KEYS), pick(before, VERIFICATION_KEYS));
});

test("nonempty existing values are never replaced: titles, urls, platform urls and unknown fields all survive", async () => {
  const stored = existing({
    platforms: [
      { name: "Crunchyroll", available: true, officialUrl: CR_NEWS, tamilDubVerified: true, tamilDubVerificationUrl: CR_NEWS },
      { name: "Netflix", available: true, officialUrl: "https://www.netflix.com/title/111", tamilDubVerified: false, curatorNote: "keep" },
      { name: "Amazon Prime Video", available: false, officialUrl: null, tamilDubVerified: false }
    ],
    episodes: [
      { number: "1-1", title: "Curated One", url: KEEP_URL, platform: "Crunchyroll", reviewedBy: "curator" },
      { number: "1-2", url: null }
    ]
  });
  const before = clone(stored);

  const manifest = manifestOf(entry({
    platforms: [{ name: "Netflix", available: true, officialUrl: NF_TITLE }],
    episodes: [
      { number: "1-1", title: "Different Title", url: CR_WATCH },
      { number: "1-2", title: "Filled Title" }
    ]
  }));

  const run = await withNoNetwork(() => runUpdater({ catalog: catalogOf(stored), manifest }));
  const after = run.catalog.anime[0];

  assert.deepStrictEqual(after.episodes[0], before.episodes[0], "row with a title and a url is untouched, unknown field kept");
  assert.deepStrictEqual(after.episodes[1], { number: "1-2", url: null, title: "Filled Title" }, "only the empty title was filled");
  assert.deepStrictEqual(byName(after).Netflix, before.platforms[1], "an existing platform url is preserved");
  assert.equal(after.episodes.length, 2, "nothing deleted");
});

test("a platform title listing never becomes Tamil proof, and Crunchyroll proof never verifies Netflix or Prime", async () => {
  const stored = existing();

  const manifest = manifestOf(entry({
    platforms: [
      { name: "Netflix", available: true, officialUrl: NF_TITLE, tamilDubVerified: true, tamilDubVerificationUrl: NF_TITLE },
      { name: "Amazon Prime Video", available: true, officialUrl: PRIME_TITLE, tamilDubVerified: true, tamilDubVerificationUrl: PRIME_TITLE }
    ]
  }));

  const run = await withNoNetwork(() => runUpdater({ catalog: catalogOf(stored), manifest }));
  const platforms = byName(run.catalog.anime[0]);

  for (const name of ["Netflix", "Amazon Prime Video"]) {
    assert.equal(platforms[name].available, true, `${name} availability from the curated title page`);
    assert.equal(platforms[name].tamilDubVerified, false, `${name} is not Tamil-verified`);
    assert.ok(!platforms[name].tamilDubVerificationUrl, `${name} has no proof url`);
  }

  assert.equal(run.catalog.anime[0].tamilDubEvidence.length, 1, "no evidence was added for a title listing");
  assert.equal(run.catalog.anime[0].tamilDubEvidence[0].platform, "Crunchyroll");
});

test("an announcement is accepted as proof but rejected as a platform title page", () => {
  const result = updater.validateEntry(
    entry({
      platforms: [
        { name: "Crunchyroll", available: true, officialUrl: "https://www.crunchyroll.com/news/2024/1/1/other-article" },
        { name: "Netflix", available: true, officialUrl: "https://www.netflix.com/tudum/articles/some-article" }
      ]
    }),
    channels
  );

  assert.equal(result.ok, true, "the entry is valid: its Tamil proof is the announcement");
  assert.equal(result.entry.evidence[0].url, CR_NEWS, "the exact announcement url is retained as proof");
  assert.deepEqual(result.entry.curatedPlatforms || [], [], "neither announcement was accepted as a title page");
  assert.match(result.warnings.join("\n"), /Crunchyroll row ignored \(Crunchyroll URL must be a title page\)/);
  assert.match(result.warnings.join("\n"), /Netflix row ignored \(Netflix URL must be a title page\)/);
});

/* ------------------------------------------------------------------ */
/* YouTube                                                             */
/* ------------------------------------------------------------------ */

test("YouTube: a video from the allow-listed channel is evidence; the same video is not 'verified' without it", async () => {
  // No YouTube evidence: nothing fabricated.
  const bare = entry({ episodes: [{ number: "1", url: VIDEO }] });
  const none = await withNoNetwork(() => runUpdater({ manifest: manifestOf(bare) }));
  assert.deepEqual(none.catalog.anime[0].youtube, []);
  assert.deepStrictEqual(none.catalog.anime[0].episodes, [{ number: "1", url: null }]);
  assert.ok(!none.catalog.anime[0].platforms.some((platform) => platform.name === "YouTube"));

  // With official-channel evidence for that exact video the link is kept.
  const proven = entry({
    verification: [{ url: CR_NEWS, checkedAt: "2026-10-01" }, { url: VIDEO, checkedAt: "2026-10-01", channelId: CHANNEL }],
    episodes: [{ number: "1", url: VIDEO }, { number: "2", url: "https://www.youtube.com/watch?v=AAAAAAAAAAA" }]
  });
  const run = await withNoNetwork(() => runUpdater({ manifest: manifestOf(proven) }));

  assert.deepStrictEqual(run.catalog.anime[0].youtube, [{ title: "Backfill Show", url: VIDEO }]);
  assert.equal(run.catalog.anime[0].episodes[0].url, VIDEO);
  assert.equal(run.catalog.anime[0].episodes[1].url, null, "a different video is not covered by the evidence");
});

test("YouTube backfill: a stored record that lost its youtube array regains it only from its own evidence", async () => {
  const proven = entry({
    verification: [{ url: CR_NEWS, checkedAt: "2026-10-01" }, { url: VIDEO, checkedAt: "2026-10-01", channelId: CHANNEL }],
    episodes: [{ number: "1", title: "Pilot", url: VIDEO }]
  });
  const manifest = manifestOf(proven);

  const first = await withNoNetwork(() => runUpdater({ manifest }));
  const baseline = clone(first.catalog.anime[0]);

  // Simulate an older record that has the evidence but is missing the derived metadata.
  const damaged = clone(first.catalog);
  damaged.anime[0].youtube = [];
  damaged.anime[0].episodes = [{ number: "1", url: null }];
  require("node:fs").writeFileSync(first.catalogFile, `${JSON.stringify(damaged, null, 2)}\n`);

  const second = await withNoNetwork(() => rerun(first, manifest));
  const after = second.catalog.anime[0];

  assert.deepStrictEqual(after.youtube, baseline.youtube);
  assert.deepStrictEqual(after.episodes, baseline.episodes);
  assert.deepStrictEqual(pick(after, VERIFICATION_KEYS), pick(baseline, VERIFICATION_KEYS), "verification untouched by the backfill");
});

/* ------------------------------------------------------------------ */
/* Nothing invented, and it settles                                    */
/* ------------------------------------------------------------------ */

test("with no optional rows in the entry and no TMDB key, nothing is manufactured: existing records stay exactly as they are", async () => {
  const stored = existing({ episodes: [], youtube: [] });
  const before = clone(stored);

  const run = await withNoNetwork(() => runUpdater({ catalog: catalogOf(stored), manifest: manifestOf(entry()) }));

  assert.deepStrictEqual(run.catalog.anime[0], before);
  assert.equal(run.report.updatedExisting, 0);
});

test("backfill settles: a second identical run changes nothing", async () => {
  const manifest = manifestOf(entry({
    platforms: [{ name: "Netflix", available: true, officialUrl: NF_TITLE }],
    episodes: [{ number: "1-1", title: "The Start", url: CR_WATCH }, { number: "1-3", title: "Extra" }]
  }));

  const first = await withNoNetwork(() => runUpdater({ catalog: catalogOf(existing()), manifest }));
  const second = await withNoNetwork(() => rerun(first, manifest));

  assert.equal(second.report.updatedExisting, 0);
  assert.deepStrictEqual(second.catalog.anime, first.catalog.anime);
});

test("every new url in a backfilled record traces to explicit input (no slug, number or TMDB-id guessing)", async () => {
  const stored = existing({ episodes: [] });
  const manifest = manifestOf(entry({
    tmdbId: 4242,
    platforms: [{ name: "Netflix", available: true, officialUrl: NF_TITLE }],
    episodes: [{ number: "1-1", title: "The Start", url: CR_WATCH }, { number: "1-2", title: "No link supplied" }]
  }));

  const run = await withNoNetwork(() => runUpdater({ catalog: catalogOf(stored), manifest }));
  const urls = new Set((JSON.stringify(run.catalog.anime[0]).match(/https?:\/\/[^"]+/g) || []));

  const allowed = new Set([
    CR_NEWS, CR_WATCH, NF_TITLE,
    "https://www.themoviedb.org/tv/4242", // identity link built from the supplied tmdbId
    "https://img.example/p.jpg", "https://img.example/b.jpg"
  ]);

  for (const url of urls) assert.ok(allowed.has(url), `unexpected url ${url}`);
  assert.equal(run.catalog.anime[0].episodes.find((row) => row.number === "1-2").url, null);
});
