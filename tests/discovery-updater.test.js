"use strict";

// End to end: updater.run() with discovery enabled against a mocked YouTube Data API and a mocked TMDB. These prove the
// owner's goal at the data layer: an anime nobody listed anywhere is found on the allow-listed channel, validated,
// added through the normal merge path, saved, and never duplicated by a rerun. No network, no real keys.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { record, seasonEntry, clone } = require("./helpers/harness");
const {
  CHANNEL, OTHER_CHANNEL, TEST_TMDB_KEY, vid, video, createYouTube, createTmdb, searchHit, tvDetails, seasonDetails,
  tempWorkspace, writeJson, readJson, emptyCatalog, emptyManifest, runDiscovery, idsOf, byId, withoutScan
} = require("./helpers/discovery-harness");

const demoTmdb = () =>
  createTmdb({
    search: { "demo show": [searchHit(777, "Demo Show")], "other show": [searchHit(888, "Other Show")] },
    series: { 777: tvDetails(777, "Demo Show", [12, 12]), 888: tvDetails(888, "Other Show", [24]) },
    seasons: { "777:1": seasonDetails(1, 12), "777:2": seasonDetails(2, 12), "888:1": seasonDetails(1, 24) }
  });

const ep = (n, title, extra = {}) => video(vid(n), title, { publishedAt: `2026-09-${String(10 + n).padStart(2, "0")}T10:00:00Z`, ...extra });
const s2 = (n, extra) => ep(n, `Tamil Dub | Demo Show Season 2 Episode ${n} | Muse India`, extra);

const run = (options) => runDiscovery({ tmdb: demoTmdb(), tmdbKey: TEST_TMDB_KEY, ...options });
const rerunOn = (previous, options) => run({ ws: previous.ws, manifest: null, writeFiles: false, ...options });

/* ------------------------------ the core promise ------------------------------ */

test("an anime that is in no manifest is discovered, added and saved with no manifest edit", async () => {
  const youtube = createYouTube({ uploads: [s2(2), s2(1)] });
  const ws = tempWorkspace();
  const manifest = emptyManifest();
  const result = await run({ ws, manifest, youtube });

  assert.equal(result.report.status, "added");
  assert.equal(result.report.added, 1);
  assert.deepEqual(idsOf(result.catalog), ["tmdb-777-s2"]);
  assert.equal(result.manifestText, `${JSON.stringify(manifest, null, 2)}\n`, "the manifest file is never rewritten");
  assert.equal(result.report.discovery.status, "complete");
  assert.equal(result.report.discovery.zeroAddReasonCode, null);
  assert.ok(result.state, "the checkpoint file was written");

  const saved = readJson(ws.catalogFile);
  assert.equal(saved.anime.length, 1, "saved to disk, not just returned");
});

test("the discovered record is a normal verified record with real, ID-built watch links", async () => {
  const youtube = createYouTube({ uploads: [s2(2), s2(1)] });
  const { catalog } = await run({ youtube });
  const item = byId(catalog, "tmdb-777-s2");

  assert.equal(item.tamilDubVerified, true);
  assert.equal(item.mediaType, "tv");
  assert.equal(item.tmdbId, 777);
  assert.equal(item.tmdbSeason, 2);
  assert.equal(item.inclusionSource, "youtube-official-channel-discovery");
  assert.equal(item.title, "Demo Show Season 2");

  const first = item.episodes.find((row) => row.number === "2-1");
  const second = item.episodes.find((row) => row.number === "2-2");
  assert.equal(first.url, `https://www.youtube.com/watch?v=${vid(1)}`);
  assert.equal(second.url, `https://www.youtube.com/watch?v=${vid(2)}`);
  assert.equal(item.episodes.find((row) => row.number === "2-3").url, null, "TMDB-only rows carry no watch link");

  // The exact shape the frontend trusts: platform YouTube + channelId + a video id that matches the URL.
  assert.equal(item.tamilDubEvidence.length, 2);

  for (const evidence of item.tamilDubEvidence) {
    assert.equal(evidence.platform, "YouTube");
    assert.equal(evidence.channelId, CHANNEL);
    assert.equal(evidence.url, `https://www.youtube.com/watch?v=${evidence.videoId}`);
    assert.equal(evidence.channelCheck, "api-confirmed");
  }
});

test("provenance keeps the raw title, video id, channel, language proof and evidence URL, next to verification", async () => {
  const youtube = createYouTube({ uploads: [s2(1, { description: "Official upload" })] });
  const { catalog } = await run({ youtube });
  const [row] = byId(catalog, "tmdb-777-s2").discoveryProvenance;

  assert.equal(row.videoId, vid(1));
  assert.equal(row.channelId, CHANNEL);
  assert.equal(row.rawTitle, "Tamil Dub | Demo Show Season 2 Episode 1 | Muse India");
  assert.equal(row.rawDescription, "Official upload");
  assert.equal(row.languageProof, 'title begins with "Tamil Dub"');
  assert.equal(row.evidenceUrl, `https://www.youtube.com/watch?v=${vid(1)}`);
  assert.equal(row.season, 2);
  assert.equal(row.seasonSource, "explicit-in-title");
  assert.equal(row.episode, 1);
  assert.equal(row.series.tmdbId, 777);
  assert.equal(row.availability, "public");
});

test("rerun is idempotent: nothing new, no duplicates, same catalog, precise 'all-known' reason", async () => {
  const youtube = createYouTube({ uploads: [s2(2), s2(1)] });
  const first = await run({ youtube });
  const second = await rerunOn(first, { youtube });

  assert.equal(second.report.added, 0);
  assert.equal(second.report.updatedExisting, 0);
  assert.equal(second.catalog.anime.length, 1);
  assert.deepEqual(withoutScan(second.catalog), withoutScan(first.catalog));
  assert.equal(second.report.discovery.zeroAddReasonCode, "all-known");
  assert.match(second.report.zeroAddReason, /Discovery: Every discovered Tamil Dub episode already belongs to a catalog record/);

  const third = await rerunOn(second, { youtube });
  assert.deepEqual(withoutScan(third.catalog), withoutScan(first.catalog));
  const stable = (state) => JSON.parse(JSON.stringify(state.channels, (key, value) => (key === "lastScanAt" || key === "lastCompleteScanAt" ? undefined : value)));
  assert.deepEqual(stable(third.state), stable(second.state), "cursors and marks are stable (only scan timestamps move)");
});

test("a new episode uploaded later is appended to the existing record, not added as a second title", async () => {
  const youtube = createYouTube({ uploads: [s2(2), s2(1)] });
  const first = await run({ youtube });
  const before = clone(byId(first.catalog, "tmdb-777-s2"));

  const fresh = s2(3);
  youtube.uploads.unshift(fresh);
  youtube.byId.set(fresh.id, fresh);

  const second = await rerunOn(first, { youtube });
  const after = byId(second.catalog, "tmdb-777-s2");

  assert.equal(second.catalog.anime.length, 1);
  assert.equal(second.report.added, 0);
  assert.equal(second.report.updatedExisting, 1);
  assert.equal(after.episodes.find((row) => row.number === "2-3").url, `https://www.youtube.com/watch?v=${vid(3)}`);

  for (const number of ["2-1", "2-2"]) {
    assert.deepEqual(after.episodes.find((row) => row.number === number), before.episodes.find((row) => row.number === number), `${number} unchanged`);
  }

  assert.deepEqual(after.discoveryProvenance.map((row) => row.videoId), [vid(1), vid(2), vid(3)]);
  assert.equal(after.title, before.title);
  assert.equal(after.description, before.description);
});

test("two seasons of one series found together become two records, and a rerun adds nothing", async () => {
  const s1 = (n) => ep(n + 20, `Tamil Dub | Demo Show Season 1 Episode ${n} | Muse India`);
  const youtube = createYouTube({ uploads: [s2(2), s2(1), s1(2), s1(1)] });
  const first = await run({ youtube });

  assert.equal(first.catalog.anime.length, 2);
  assert.deepEqual(first.catalog.anime.map((item) => item.tmdbSeason).sort(), [1, 2]);
  assert.equal(new Set(idsOf(first.catalog)).size, 2);

  const second = await rerunOn(first, { youtube });
  assert.equal(second.catalog.anime.length, 2);
  assert.equal(second.report.added, 0);
});

test("a single-season show with no season in the title resolves from TMDB's own season count", async () => {
  const youtube = createYouTube({ uploads: [ep(1, "Tamil Dub | Other Show Episode 3 | Muse India")] });
  const { catalog, report } = await run({ youtube });

  assert.equal(report.added, 1);
  const item = catalog.anime[0];
  assert.equal(item.tmdbId, 888);
  assert.equal(item.tmdbSeason, undefined, "series-level record");
  assert.equal(item.episodes.find((row) => row.number === "1-3").url, `https://www.youtube.com/watch?v=${vid(1)}`);
  assert.equal(item.discoveryProvenance[0].seasonSource, "tmdb-single-regular-season");
});

test("the series is found in the catalog without TMDB, but only with an explicit season", async () => {
  const known = record("tmdb-777-s2", { title: "Demo Show Season 2", mediaType: "tv", tmdbId: 777, tmdbSeason: 2, tmdbUrl: "https://www.themoviedb.org/tv/777", episodes: [{ number: "2-1", url: null }] });
  const youtube = createYouTube({ uploads: [s2(1)] });
  const withSeason = await runDiscovery({ youtube, catalog: { ...emptyCatalog(), anime: [known] }, tmdb: null, tmdbKey: "" });

  assert.equal(withSeason.report.added, 0);
  assert.equal(byId(withSeason.catalog, "tmdb-777-s2").episodes[0].url, `https://www.youtube.com/watch?v=${vid(1)}`);

  const noSeason = createYouTube({ uploads: [ep(1, "Tamil Dub | Demo Show Episode 1")] });
  const ambiguous = await runDiscovery({ youtube: noSeason, catalog: { ...emptyCatalog(), anime: [known] }, tmdb: null, tmdbKey: "" });

  assert.equal(ambiguous.report.discovery.review.length, 1);
  assert.match(ambiguous.report.discovery.review[0].reason, /no season and TMDB_API_KEY is not set/);
  assert.equal(byId(ambiguous.catalog, "tmdb-777-s2").episodes[0].url, null);
});

/* ------------------------------ the strict filter ------------------------------ */

test("only titles that start with Tamil Dub can add anything (end to end)", async () => {
  const youtube = createYouTube({
    uploads: [
      ep(1, "Tamil Dub | Demo Show Season 2 Episode 1 | Muse India"),
      ep(2, "Demo Show Season 2 Episode 2 Tamil Dub"),
      ep(3, "Demo Show Season 2 Episode 3", { description: "Tamil Dub by Muse India. Tamil Dub!" }),
      ep(4, "Tamil Dubbed | Demo Show Season 2 Episode 4"),
      ep(5, "Hindi Dub | Demo Show Season 2 Episode 5"),
      ep(6, "[Tamil Dub] Demo Show Season 2 Episode 6"),
      ep(7, "Tamil Dub | Demo Show Season 2 Official Trailer"),
      ep(8, "Tamil Dub | Demo Show Season 2 Announcement"),
      ep(9, "Tamil Subtitles | Demo Show Season 2 Episode 9")
    ]
  });
  const { catalog, report } = await run({ youtube });
  const links = byId(catalog, "tmdb-777-s2").episodes.filter((row) => row.url).map((row) => row.url);

  assert.deepEqual(links.sort(), [`https://www.youtube.com/watch?v=${vid(1)}`, `https://www.youtube.com/watch?v=${vid(6)}`].sort());
  assert.equal(report.discovery.counts.videosSeen, 9);
  assert.equal(report.discovery.counts.tamilDubPrefixed, 4);
  assert.equal(report.discovery.counts.excludedNotTamilDub, 5);
  assert.equal(report.discovery.counts.promos, 1);
  assert.equal(report.discovery.counts.announcements, 1);
  assert.equal(report.discovery.counts.accepted, 2);
  assert.deepEqual(report.discovery.announcements.map((item) => item.videoId), [vid(8)]);
  assert.ok(!JSON.stringify(catalog.anime).includes(vid(7)), "the trailer id appears in no anime record");
  assert.ok(!JSON.stringify(catalog.anime).includes(vid(8)), "the announcement id appears in no anime record (the scan report lists it as an announcement only)");
});

test("trailers and announcements alone never add a title", async () => {
  const youtube = createYouTube({ uploads: [ep(1, "Tamil Dub | Demo Show Season 2 Official Trailer"), ep(2, "Tamil Dub | Demo Show Dub Announcement")] });
  const { catalog, report } = await run({ youtube });

  assert.equal(catalog.anime.length, 0);
  assert.equal(report.added, 0);
  assert.equal(report.discovery.zeroAddReasonCode, "no-episode-evidence");
});

test("a video from another channel with a perfect title is ignored (ownership comes from the API, not the title)", async () => {
  const spoof = video(vid(9), "Tamil Dub | Demo Show Season 2 Episode 1 | Muse India", { channelId: OTHER_CHANNEL });
  const youtube = createYouTube({ uploads: [spoof] });
  const { catalog, report } = await run({ youtube });

  assert.equal(catalog.anime.length, 0);
  assert.equal(report.discovery.counts.foreignChannel, 1);
  assert.equal(report.discovery.zeroAddReasonCode, "no-tamil-evidence");
});

test("TMDB alone is never Tamil proof: with no Tamil Dub video nothing is added and TMDB is not even searched", async () => {
  const tmdb = demoTmdb();
  const youtube = createYouTube({ uploads: [ep(1, "Demo Show Season 2 Episode 1 Hindi"), ep(2, "Unrelated upload")] });
  const { catalog, report } = await runDiscovery({ youtube, tmdb, tmdbKey: TEST_TMDB_KEY });

  assert.equal(catalog.anime.length, 0);
  assert.equal(report.discovery.zeroAddReasonCode, "no-tamil-evidence");
  assert.equal(tmdb.requests.filter((url) => url.includes("/search/tv")).length, 0);
});

/* ------------------------------ ambiguity goes to review ------------------------------ */

test("a title with no season and several TMDB seasons is reviewed, queued, and added once the title is clear", async () => {
  const bare = ep(1, "Tamil Dub | Demo Show Episode 3 | Muse India");
  const youtube = createYouTube({ uploads: [bare] });
  const first = await run({ youtube });

  assert.equal(first.catalog.anime.length, 0);
  assert.equal(first.report.discovery.zeroAddReasonCode, "needs-review");
  assert.equal(first.report.discovery.review.length, 1);
  assert.match(first.report.discovery.review[0].reason, /season is not guessed/);
  assert.equal(first.state.queue.length, 1);
  assert.equal(first.state.queue[0].videoId, vid(1));
  assert.equal(first.state.queue[0].status, "review");

  // The channel fixes the title. The queued video is re-read through videos.list and now resolves.
  bare.snippet.title = "Tamil Dub | Demo Show Season 2 Episode 3 | Muse India";
  const second = await rerunOn(first, { youtube });

  assert.equal(second.report.added, 1);
  assert.equal(byId(second.catalog, "tmdb-777-s2").episodes.find((row) => row.number === "2-3").url, `https://www.youtube.com/watch?v=${vid(1)}`);
  assert.equal(second.state.queue.length, 0, "settled work leaves the queue");
});

test("fuzzy, wrong-kind and ambiguous TMDB matches are review items and never auto-added", async () => {
  const tmdb = createTmdb({
    search: {
      "obscure show": [searchHit(999, "Obscure Shows Of Doom")],
      "live show": [searchHit(555, "Live Show", { genre_ids: [18], origin_country: ["US"], original_language: "en" })],
      "twin show": [searchHit(301, "Twin Show", { first_air_date: "2001-04-01" }), searchHit(302, "Twin Show", { first_air_date: "2015-04-01" })]
    },
    series: { 999: tvDetails(999, "Obscure Shows Of Doom", [12]), 555: tvDetails(555, "Live Show", [12]), 301: tvDetails(301, "Twin Show", [12]), 302: tvDetails(302, "Twin Show", [12]) }
  });
  const youtube = createYouTube({
    uploads: [
      ep(1, "Tamil Dub | Obscure Show Season 1 Episode 1"),
      ep(2, "Tamil Dub | Live Show Season 1 Episode 1"),
      ep(3, "Tamil Dub | Twin Show Season 1 Episode 1")
    ]
  });
  const { catalog, report } = await runDiscovery({ youtube, tmdb, tmdbKey: TEST_TMDB_KEY });

  assert.equal(catalog.anime.length, 0);
  assert.equal(report.discovery.counts.review, 3);
  const reasons = report.discovery.review.map((item) => item.reason).join("\n");
  assert.match(reasons, /fuzzy suggestions only/);
  assert.match(reasons, /not as Japanese animation/);
  assert.match(reasons, /several TMDB series share the exact title/);
  assert.equal(report.discovery.zeroAddReasonCode, "needs-review");
});

test("a season TMDB does not list, or an episode beyond TMDB's count, is reviewed", async () => {
  const youtube = createYouTube({ uploads: [ep(1, "Tamil Dub | Demo Show Season 5 Episode 1"), ep(2, "Tamil Dub | Demo Show Season 2 Episode 99")] });
  const { catalog, report } = await run({ youtube });

  assert.equal(catalog.anime.length, 0);
  const reasons = report.discovery.review.map((item) => item.reason).join("\n");
  assert.match(reasons, /lists no season 5/);
  assert.match(reasons, /episode 99 is beyond TMDB's 12 episodes/);
});

test("without a TMDB key only series the catalog already knows can be matched; others are reviewed, nothing guessed", async () => {
  const youtube = createYouTube({ uploads: [ep(1, "Tamil Dub | Brand New Show Season 1 Episode 1")] });
  const { catalog, report } = await runDiscovery({ youtube, tmdb: null, tmdbKey: "" });

  assert.equal(catalog.anime.length, 0);
  assert.match(report.discovery.review[0].reason, /TMDB_API_KEY is not set/);
});

test("a TMDB outage defers the video (retried next run) instead of rejecting or guessing", async () => {
  const tmdb = createTmdb({ plan: { fail: () => ({ status: 503, body: {} }) } });
  const youtube = createYouTube({ uploads: [s2(1)] });
  const first = await runDiscovery({ youtube, tmdb, tmdbKey: TEST_TMDB_KEY });

  assert.equal(first.catalog.anime.length, 0);
  assert.equal(first.report.discovery.counts.deferred, 1);
  assert.equal(first.state.queue[0].status, "deferred");

  const second = await rerunOn(first, { youtube, tmdb: demoTmdb() });
  assert.equal(second.report.added, 1);
  assert.equal(second.state.queue.length, 0);
});

/* ------------------------------ duplicates ------------------------------ */

test("two uploads of the same episode produce one link (the earliest) and a duplicate count", async () => {
  const original = s2(1, { publishedAt: "2026-09-01T10:00:00Z" });
  const reupload = video(vid(5), "Tamil Dub | Demo Show Season 2 Episode 1 | Muse India (Re-upload)", { publishedAt: "2026-09-20T10:00:00Z" });
  const youtube = createYouTube({ uploads: [reupload, original] });
  const first = await run({ youtube });

  assert.equal(byId(first.catalog, "tmdb-777-s2").episodes.find((row) => row.number === "2-1").url, `https://www.youtube.com/watch?v=${vid(1)}`);
  assert.equal(first.report.discovery.counts.duplicateEpisodes, 1);

  const second = await rerunOn(first, { youtube });
  assert.deepEqual(withoutScan(second.catalog), withoutScan(first.catalog));
});

/* ------------------------------ existing data is never overwritten ------------------------------ */

test("a curated record is extended, never overwritten: its description, artwork and original evidence stay", async () => {
  const curated = record("curated-demo-s2", {
    title: "Demo Show Season 2",
    description: "Hand-written description",
    image: "https://img.example/hand.jpg",
    mediaType: "tv",
    tmdbId: 777,
    tmdbSeason: 2,
    tmdbUrl: "https://www.themoviedb.org/tv/777",
    episodes: [{ number: "2-1", url: null }]
  });
  const before = clone(curated);
  const youtube = createYouTube({ uploads: [s2(1)] });
  const { catalog } = await runDiscovery({ youtube, catalog: { ...emptyCatalog(), anime: [curated] }, tmdb: demoTmdb(), tmdbKey: TEST_TMDB_KEY });
  const after = byId(catalog, "curated-demo-s2");

  assert.equal(catalog.anime.length, 1, "no duplicate record");
  assert.equal(after.description, "Hand-written description");
  assert.equal(after.image, "https://img.example/hand.jpg");
  assert.equal(after.tamilDubVerificationUrl, before.tamilDubVerificationUrl);
  assert.equal(after.tamilDubVerificationSource, before.tamilDubVerificationSource);
  assert.equal(after.inclusionSource, before.inclusionSource);
  assert.deepEqual(after.tamilDubEvidence[0], before.tamilDubEvidence[0], "original evidence is first and unchanged");
  assert.ok(after.tamilDubEvidence.some((item) => item.platform === "YouTube" && item.videoId === vid(1)), "YouTube proof was appended");
  assert.equal(after.episodes.find((row) => row.number === "2-1").url, `https://www.youtube.com/watch?v=${vid(1)}`);
});

test("an existing episode link is never replaced by a discovered one", async () => {
  const curated = record("curated-demo-s2", { title: "Demo Show Season 2", mediaType: "tv", tmdbId: 777, tmdbSeason: 2, tmdbUrl: "https://www.themoviedb.org/tv/777", episodes: [{ number: "2-1", url: "https://www.youtube.com/watch?v=CuratedLink1" }] });
  const youtube = createYouTube({ uploads: [s2(1)] });
  const { catalog } = await runDiscovery({ youtube, catalog: { ...emptyCatalog(), anime: [curated] }, tmdb: demoTmdb(), tmdbKey: TEST_TMDB_KEY });

  assert.equal(byId(catalog, "curated-demo-s2").episodes.find((row) => row.number === "2-1").url, "https://www.youtube.com/watch?v=CuratedLink1");
});

test("a legacy record with a shared series but no season identity sends the episode to review instead of guessing", async () => {
  const legacy = record("demo-legacy", { title: "Demo Show", mediaType: "tv", tmdbId: 777, tmdbUrl: "https://www.themoviedb.org/tv/777" });
  const before = clone(legacy);
  const youtube = createYouTube({ uploads: [s2(1)] });
  const { catalog, report } = await runDiscovery({ youtube, catalog: { ...emptyCatalog(), anime: [legacy] }, tmdb: demoTmdb(), tmdbKey: TEST_TMDB_KEY });

  assert.equal(catalog.anime.length, 1);
  assert.equal(report.discovery.counts.review, 1);
  assert.match(report.discovery.review[0].reason, /no season identity/);
  assert.deepEqual(byId(catalog, "demo-legacy").episodes, before.episodes);
  assert.equal(byId(catalog, "demo-legacy").tmdbSeason, undefined, "legacy records are never stamped");
});

test("a manifest entry and the channel agree: one record, manifest proof first, both kinds of evidence kept", async () => {
  const manifest = emptyManifest(undefined, [seasonEntry(777, 2, { id: "show-777-season-2", title: "Demo Show Season 2" })]);
  const youtube = createYouTube({ uploads: [s2(1)] });
  const { catalog, report } = await run({ manifest, youtube });

  assert.equal(catalog.anime.length, 1);
  assert.equal(report.added, 1);
  assert.equal(catalog.anime[0].id, "show-777-season-2");
  assert.equal(catalog.anime[0].inclusionSource, "official-source-manifest");
  assert.equal(catalog.anime[0].tamilDubEvidence[0].platform, "Crunchyroll");
  assert.ok(catalog.anime[0].tamilDubEvidence.some((item) => item.platform === "YouTube" && item.videoId === vid(1)));
  assert.equal(catalog.anime[0].episodes.find((row) => row.number === "2-1").url, `https://www.youtube.com/watch?v=${vid(1)}`);
});

/* ------------------------------ atomicity and isolation ------------------------------ */

test("if the catalog changes while a run is in flight, nothing is written and the checkpoint does not move", async () => {
  const ws = tempWorkspace();
  const youtube = createYouTube({
    uploads: [s2(1)],
    plan: {
      fail: (url, info) => {
        if (info.endpoint === "videos") writeJson(ws.catalogFile, { ...emptyCatalog(), lastUpdated: "2099-01-01T00:00:00.000Z" }); // a concurrent writer
        return null;
      }
    }
  });

  await assert.rejects(run({ ws, manifest: emptyManifest(), youtube }), /changed|modified|concurrent|refus/i);
  assert.equal(fs.existsSync(ws.stateFile), false, "no checkpoint was written for a catalog that was not saved");
  assert.equal(readJson(ws.catalogFile).lastUpdated, "2099-01-01T00:00:00.000Z", "the concurrent writer's file is intact");
});

test("an unreadable checkpoint file cannot take the manifest path down", async () => {
  const ws = tempWorkspace();
  fs.mkdirSync(ws.stateFile); // reading a directory as a file fails
  const manifest = emptyManifest(undefined, [seasonEntry(777, 2)]);
  const youtube = createYouTube({ uploads: [s2(1)] });
  const { report, catalog } = await run({ ws, manifest, youtube });

  assert.equal(report.added, 1, "the manifest entry was still added");
  assert.equal(catalog.anime.length, 1);
  assert.equal(report.discovery.status, "error");
  assert.equal(report.discovery.zeroAddReasonCode, "api-error");
  assert.equal(youtube.requests.length, 0);
});

test("a corrupt checkpoint restarts discovery safely and says so", async () => {
  const ws = tempWorkspace();
  fs.writeFileSync(ws.stateFile, "{this is not json");
  const youtube = createYouTube({ uploads: [s2(1)] });
  const { report, catalog, state } = await run({ ws, manifest: emptyManifest(), youtube });

  assert.equal(report.added, 1);
  assert.equal(catalog.anime.length, 1);
  assert.ok(report.discovery.notes.some((note) => /not valid JSON/.test(note)));
  assert.equal(state.version, 1, "the checkpoint was rewritten in a valid form");
});

test("discovery is off unless DISCOVERY_ENABLED: a key alone makes no YouTube discovery calls", async () => {
  const youtube = createYouTube({ uploads: [s2(1)] });
  const result = await run({ youtube, discovery: { enabled: false } });

  assert.equal(youtube.requests.length, 0);
  assert.equal(result.report.discovery, undefined);
  assert.equal(result.catalog.anime.length, 0);
  assert.equal(result.state, null, "no checkpoint file when discovery is off");
  assert.doesNotMatch(result.catalog.updateInfo.note, /Discovery covers/);
});

test("a catalog with an existing manifest-only note keeps the original coverage text when discovery did not scan", async () => {
  const result = await run({ youtube: createYouTube({ uploads: [] }), discovery: { enabled: false } });
  assert.match(result.catalog.updateInfo.note, /Coverage is limited to titles listed in the official-source manifest/);
});

/* ------------------------------ resolving a review item by teaching the catalog ------------------------------ */

test("an unknown series is reviewed, then resolved on the run after the catalog learns the series (via the manifest)", async () => {
  const youtube = createYouTube({ uploads: [s2(1)] });
  const first = await runDiscovery({ youtube, tmdb: null, tmdbKey: "" });

  assert.equal(first.catalog.anime.length, 0);
  assert.equal(first.state.queue.length, 1);

  // The owner adds the series to the manifest. This run appends it; discovery already looked at the catalog before that.
  const manifest = emptyManifest(undefined, [seasonEntry(777, 1, { id: "demo-show-s1", title: "Demo Show Season 1", aliases: ["Demo Show"] })]);
  const second = await runDiscovery({ ws: first.ws, manifest, youtube, tmdb: null, tmdbKey: "" });
  assert.deepEqual(idsOf(second.catalog), ["demo-show-s1"]);
  assert.equal(second.state.queue.length, 1, "still queued: it was assessed against the catalog as it was at the start of the run");

  // Next run: the series is in the catalog, the queued video resolves, and season 2 is a new record that borrows nothing from season 1.
  const third = await runDiscovery({ ws: first.ws, manifest, youtube, tmdb: null, tmdbKey: "" });
  assert.equal(third.catalog.anime.length, 2);
  assert.equal(third.state.queue.length, 0);
  assert.equal(byId(third.catalog, "demo-show-s1").episodes.some((row) => row.url === `https://www.youtube.com/watch?v=${vid(1)}`), false, "season 2 video not linked to season 1");
  assert.equal(third.catalog.anime.find((item) => item.tmdbSeason === 2).episodes.find((row) => row.number === "2-1").url, `https://www.youtube.com/watch?v=${vid(1)}`);
});
