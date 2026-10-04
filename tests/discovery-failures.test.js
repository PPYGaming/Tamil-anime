"use strict";

// Discovery under failure and over time: zero-add reason codes, quota/auth/API errors, resumable bootstrap, videos that
// later disappear, key redaction, and the real 25-record / 27-entry fixture. Mocked APIs only; nothing here is live.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { clone, FIXTURE_CATALOG, FIXTURE_MANIFEST } = require("./helpers/harness");
const {
  CHANNEL, TEST_KEY, TEST_TMDB_KEY, vid, video, createYouTube, createTmdb, searchHit, tvDetails, seasonDetails,
  tempWorkspace, readJson, emptyCatalog, emptyManifest, runDiscovery, idsOf, byId, withoutScan
} = require("./helpers/discovery-harness");

const demoTmdb = () =>
  createTmdb({
    search: { "demo show": [searchHit(777, "Demo Show")] },
    series: { 777: tvDetails(777, "Demo Show", [12, 12]) },
    seasons: { "777:1": seasonDetails(1, 12), "777:2": seasonDetails(2, 12) }
  });

const ep = (n, title, extra = {}) => video(vid(n), title, { publishedAt: `2026-09-${String(10 + n).padStart(2, "0")}T10:00:00Z`, ...extra });
const s2 = (n, extra) => ep(n, `Tamil Dub | Demo Show Season 2 Episode ${n} | Muse India`, extra);
const run = (options) => runDiscovery({ tmdb: demoTmdb(), tmdbKey: TEST_TMDB_KEY, ...options });
const again = (previous, options) => run({ ws: previous.ws, manifest: null, writeFiles: false, ...options });
const url = (n) => `https://www.youtube.com/watch?v=${vid(n)}`;
const linkOf = (catalog, id, number) => byId(catalog, id).episodes.find((row) => row.number === number).url;

const quotaError = () => ({ status: 403, body: { error: { code: 403, message: "The request cannot be completed because you have exceeded your quota.", errors: [{ reason: "quotaExceeded" }] } } });

/* ------------------------------ zero-add reason codes ------------------------------ */

test("reason code missing-youtube-key: discovery is on but no key; the manifest path still ran, no Google call was made", async () => {
  const youtube = createYouTube({ uploads: [s2(1)] });
  const result = await run({ youtube, youtubeKey: "" });

  assert.equal(youtube.requests.length, 0);
  assert.equal(result.report.discovery.status, "skipped");
  assert.equal(result.report.discovery.skipReason, "missing-youtube-key");
  assert.equal(result.report.discovery.zeroAddReasonCode, "missing-youtube-key");
  assert.match(result.report.zeroAddReason, /YOUTUBE_API_KEY is not set/);
  assert.equal(result.state, null, "nothing was scanned, so no checkpoint is written");
});

test("reason code missing-channel-allowlist: a key alone never lets an unverified channel be scanned", async () => {
  const youtube = createYouTube({ uploads: [s2(1)] });
  const result = await run({ youtube, manifest: emptyManifest([]) });

  assert.equal(youtube.requests.length, 0);
  assert.equal(result.report.discovery.skipReason, "missing-channel-allowlist");
  assert.equal(result.report.discovery.zeroAddReasonCode, "missing-channel-allowlist");
  assert.match(result.report.zeroAddReason, /allow-list/);
  assert.equal(result.catalog.anime.length, 0);
});

test("the allow-list can come from OFFICIAL_YOUTUBE_CHANNEL_IDS as well as the manifest", async () => {
  const youtube = createYouTube({ uploads: [s2(1)] });
  const result = await run({ youtube, manifest: emptyManifest([]), extraChannelIds: [CHANNEL] });

  assert.equal(result.report.added, 1);
});

test("reason code quota-exhausted: named as such, nothing deleted, the cursor has not moved", async () => {
  const youtube = createYouTube({ uploads: [s2(1)], plan: { fail: (u, info) => (info.endpoint === "videos" ? quotaError() : null) } });
  const result = await run({ youtube });

  assert.equal(result.report.discovery.zeroAddReasonCode, "quota-exhausted");
  assert.equal(result.report.discovery.status, "failed");
  assert.equal(result.report.discovery.completeness.complete, false);
  assert.equal(result.report.discovery.completeness.stopReason, "quota-exhausted");
  assert.match(result.report.zeroAddReason, /daily quota/);
  assert.equal(result.state.channels[CHANNEL].bootstrap.started, false);
  assert.equal(result.state.channels[CHANNEL].incremental.highWaterMark, null);
  assert.equal(result.report.discovery.api.failures[0].kind, "quota");
});

test("reason code auth-error: an invalid or restricted key is named, and nothing is retried in a loop", async () => {
  const youtube = createYouTube({ uploads: [s2(1)], plan: { fail: () => ({ status: 400, body: { error: { code: 400, message: "API key not valid. Please pass a valid API key.", errors: [{ reason: "badRequest" }] } } }) } });
  const result = await run({ youtube });

  assert.equal(result.report.discovery.zeroAddReasonCode, "auth-error");
  assert.equal(youtube.requests.length, 1, "an auth failure is not retried");
});

test("reason code api-error: persistent 5xx errors are an incomplete scan, never an empty successful one", async () => {
  const youtube = createYouTube({ uploads: [s2(1)], plan: { fail: () => ({ status: 503, body: {} }) } });
  const result = await run({ youtube });

  assert.equal(result.report.discovery.zeroAddReasonCode, "api-error");
  assert.notEqual(result.report.discovery.status, "complete");
  assert.equal(result.report.discovery.completeness.complete, false);
  assert.equal(youtube.requests.length, 3, "retries=2 means 3 attempts, then it stops");
  assert.equal(result.report.discovery.api.unitsUsed, 3);
});

test("reason code incomplete-scan: a page budget reached with nothing found is not 'no Tamil evidence'", async () => {
  const filler = Array.from({ length: 8 }, (_, i) => ep(i + 1, `Unrelated upload ${i + 1}`));
  const youtube = createYouTube({ uploads: filler, pageSize: 2 });
  const result = await run({ youtube, discovery: { bootstrapPageBudget: 1, incrementalPageBudget: 1 } });

  assert.equal(result.report.discovery.zeroAddReasonCode, "incomplete-scan");
  assert.equal(result.report.discovery.completeness.complete, false);
  assert.equal(result.report.discovery.completeness.hasMoreHistory, true);
  assert.equal(result.report.discovery.completeness.stopReason, "page-budget-reached");
});

test("reason code no-tamil-evidence only appears after a COMPLETE scan", async () => {
  const youtube = createYouTube({ uploads: [ep(1, "Unrelated upload"), ep(2, "Hindi Dub | Demo Show Episode 1")], pageSize: 2 });
  const result = await run({ youtube });

  assert.equal(result.report.discovery.completeness.complete, true);
  assert.equal(result.report.discovery.zeroAddReasonCode, "no-tamil-evidence");
});

test("the unit budget caps a run and is reported as a budget stop", async () => {
  const youtube = createYouTube({ uploads: Array.from({ length: 10 }, (_, i) => ep(i + 1, `Unrelated upload ${i + 1}`)), pageSize: 2 });
  const result = await run({ youtube, discovery: { unitBudget: 10 } });

  assert.ok(result.report.discovery.api.unitsUsed <= 10);
  assert.equal(result.report.discovery.completeness.complete, false);
  assert.equal(result.report.discovery.completeness.stopReason, "unit-budget-reached");
});

/* ------------------------------ bootstrap, budgets, resume ------------------------------ */

test("history older than the newest page is discovered across several budgeted runs, with completeness reported", async () => {
  const uploads = Array.from({ length: 10 }, (_, i) => s2(10 - i)); // 10 episodes, newest first
  const youtube = createYouTube({ uploads, pageSize: 2 });
  const budgets = { bootstrapPageBudget: 1, incrementalPageBudget: 5 }; // one history page per run; the head pass covers the 72 h overlap
  const first = await run({ youtube, discovery: budgets });

  assert.equal(first.report.discovery.completeness.complete, false);
  assert.equal(first.report.discovery.completeness.bootstrapComplete, false);
  assert.equal(first.report.discovery.completeness.hasMoreHistory, true);
  assert.equal(first.report.added, 1, "what was reached is saved immediately");

  let latest = first;
  let guard = 0;

  while (!latest.report.discovery.completeness.complete && guard++ < 20) {
    latest = await again(latest, { youtube, discovery: budgets });
  }

  assert.equal(latest.report.discovery.completeness.complete, true);
  assert.equal(latest.report.discovery.completeness.hasMoreHistory, false);
  assert.equal(latest.catalog.anime.length, 1, "still one record");
  assert.equal(byId(latest.catalog, "tmdb-777-s2").episodes.filter((row) => row.url).length, 10);
  assert.equal(latest.state.channels[CHANNEL].bootstrap.complete, true);
});

test("an incremental budget too small to cover the overlap window never claims a complete scan", async () => {
  const youtube = createYouTube({ uploads: [4, 3, 2, 1].map((n) => s2(n)), pageSize: 1 });
  let latest = await run({ youtube, discovery: { incrementalPageBudget: 1, bootstrapPageBudget: 50 } });

  for (let i = 0; i < 3; i++) latest = await again(latest, { youtube, discovery: { incrementalPageBudget: 1, bootstrapPageBudget: 50 } });

  assert.equal(latest.report.discovery.completeness.bootstrapComplete, true);
  assert.equal(latest.report.discovery.completeness.incrementalComplete, false);
  assert.equal(latest.report.discovery.completeness.complete, false, "reported honestly as incomplete, not silently complete");
});

test("a quota stop mid-history keeps what was found and resumes at the saved cursor", async () => {
  const uploads = [6, 5, 4, 3, 2, 1].map((n) => s2(n));
  let exhausted = true;
  const youtube = createYouTube({ uploads, pageSize: 2, plan: { fail: (u, info) => (exhausted && info.endpoint === "videos" && info.params.id !== uploads.slice(0, 2).map((x) => x.id).join(",") ? quotaError() : null) } });
  const first = await run({ youtube });

  assert.equal(first.report.discovery.status, "partial");
  assert.equal(first.report.discovery.completeness.stopReason, "quota-exhausted");
  assert.equal(first.report.added, 1);
  assert.equal(linkOf(first.catalog, "tmdb-777-s2", "2-6"), url(6));
  assert.equal(linkOf(first.catalog, "tmdb-777-s2", "2-1"), null);
  assert.equal(first.state.channels[CHANNEL].bootstrap.complete, false);
  assert.ok(first.state.channels[CHANNEL].bootstrap.nextPageToken, "the cursor is saved, on the page that failed");

  exhausted = false; // quota reset
  const second = await again(first, { youtube });

  assert.equal(second.report.discovery.completeness.complete, true);
  assert.equal(second.catalog.anime.length, 1);
  assert.equal(second.report.added, 0);

  for (let n = 1; n <= 6; n++) assert.equal(linkOf(second.catalog, "tmdb-777-s2", `2-${n}`), url(n), `episode ${n}`);
});

test("an API failure on a later run never deletes anime, verification or links", async () => {
  const youtube = createYouTube({ uploads: [s2(2), s2(1)] });
  const first = await run({ youtube });

  const failing = createYouTube({ uploads: [s2(2), s2(1)], plan: { fail: () => ({ status: 503, body: {} }) } });
  const second = await again(first, { youtube: failing });

  assert.deepEqual(second.catalog.anime, first.catalog.anime, "every record is byte-for-byte unchanged");
  assert.equal(second.report.discovery.zeroAddReasonCode, "api-error");
  assert.deepEqual(second.state.channels[CHANNEL].bootstrap, first.state.channels[CHANNEL].bootstrap, "checkpoints did not move");
});

/* ------------------------------ videos that change after they were added ------------------------------ */

test("a deleted video is recorded as unavailable on its provenance row; the record, evidence and link stay", async () => {
  const youtube = createYouTube({ uploads: [s2(2), s2(1)] });
  const first = await run({ youtube });

  youtube.byId.delete(vid(2));
  youtube.uploads[0] = { id: vid(2), hidden: true };
  const second = await again(first, { youtube });
  const item = byId(second.catalog, "tmdb-777-s2");
  const row = item.discoveryProvenance.find((entry) => entry.videoId === vid(2));

  assert.equal(second.catalog.anime.length, 1);
  assert.equal(item.tamilDubVerified, true);
  assert.equal(row.availability, "unavailable");
  assert.equal(row.rawTitle, "Tamil Dub | Demo Show Season 2 Episode 2 | Muse India", "provenance is kept");
  assert.equal(linkOf(second.catalog, "tmdb-777-s2", "2-2"), url(2), "the link is kept for the owner to judge");
  assert.deepEqual(item.tamilDubEvidence, byId(first.catalog, "tmdb-777-s2").tamilDubEvidence, "verification untouched");
  assert.equal(item.discoveryProvenance.find((entry) => entry.videoId === vid(1)).availability, "public");

  // It comes back (restored): the row follows.
  youtube.byId.set(vid(2), s2(2));
  youtube.uploads[0] = s2(2);
  const third = await again(second, { youtube });
  assert.equal(byId(third.catalog, "tmdb-777-s2").discoveryProvenance.find((entry) => entry.videoId === vid(2)).availability, "public");
});

test("a video turning private, retitled or region-blocked in India is recorded, never removed", async () => {
  const cases = [
    ["not-public", (item) => { item.status.privacyStatus = "private"; }],
    ["title-changed", (item) => { item.snippet.title = "Renamed upload"; }],
    ["region-blocked", (item) => { item.contentDetails.regionRestriction = { blocked: ["IN"] }; }]
  ];

  for (const [expected, mutate] of cases) {
    const youtube = createYouTube({ uploads: [s2(2), s2(1)] });
    const first = await run({ youtube });
    mutate(youtube.byId.get(vid(2)));
    const second = await again(first, { youtube });
    const item = byId(second.catalog, "tmdb-777-s2");

    assert.equal(item.discoveryProvenance.find((entry) => entry.videoId === vid(2)).availability, expected, expected);
    assert.equal(second.catalog.anime.length, 1, expected);
    assert.equal(item.tamilDubVerified, true, expected);
    assert.equal(linkOf(second.catalog, "tmdb-777-s2", "2-2"), url(2), `${expected}: link kept`);
  }
});

test("the availability recheck rolls through the catalog in windows instead of rewriting every record every run", async () => {
  const youtube = createYouTube({ uploads: [4, 3, 2, 1].map((n) => s2(n)) });
  const first = await run({ youtube });
  const second = await again(first, { youtube, discovery: { recheckLimit: 2 } });

  assert.equal(second.report.updatedExisting, 0, "nothing changed, so nothing was rewritten");
  assert.ok(second.state.recheckCursor === "" || /^vid\d{8}$/.test(second.state.recheckCursor));
});

test("a region-blocked upload is not linked, is reported, and is added once the block is lifted", async () => {
  const blocked = s2(1, { regionRestriction: { blocked: ["IN"] } });
  const youtube = createYouTube({ uploads: [blocked] });
  const first = await run({ youtube });

  assert.equal(first.catalog.anime.length, 0);
  assert.equal(first.report.discovery.counts.regionBlocked, 1);

  delete blocked.contentDetails.regionRestriction;
  const second = await again(first, { youtube });

  assert.equal(second.report.added, 1);
  assert.equal(linkOf(second.catalog, "tmdb-777-s2", "2-1"), url(1));
  assert.equal(second.state.queue.length, 0);
});

test("a scheduled premiere is deferred and added after it goes live", async () => {
  const premiere = s2(1, { liveBroadcastContent: "upcoming" });
  const youtube = createYouTube({ uploads: [premiere] });
  const first = await run({ youtube });

  assert.equal(first.catalog.anime.length, 0);
  assert.equal(first.report.discovery.counts.deferred, 1);
  assert.equal(first.state.queue[0].status, "deferred");

  premiere.snippet.liveBroadcastContent = "none";
  const second = await again(first, { youtube });
  assert.equal(second.report.added, 1);
});

test("a private upload that becomes public later is added (listed but not returned at first)", async () => {
  const hidden = { id: vid(1), hidden: true };
  const youtube = createYouTube({ uploads: [hidden] });
  const first = await run({ youtube });

  assert.equal(first.catalog.anime.length, 0);
  assert.equal(first.state.queue[0].status, "unavailable");

  const live = s2(1);
  youtube.uploads[0] = live;
  youtube.byId.set(vid(1), live);
  const second = await again(first, { youtube });

  assert.equal(second.report.added, 1);
  assert.equal(second.state.queue.length, 0);
});

/* ------------------------------ report size and safety ------------------------------ */

test("the scan report stays compact and public-safe however many items need review", async () => {
  const uploads = Array.from({ length: 120 }, (_, i) => ep(i + 1, `Tamil Dub | Mystery Series ${i + 1} Episode 1`, { description: "x".repeat(2000) }));
  const youtube = createYouTube({ uploads });
  const result = await run({ youtube });
  const size = JSON.stringify(result.report.discovery).length;

  assert.ok(result.report.discovery.review.length <= 50);
  assert.ok(size < 60000, `report is ${size} bytes`);
  assert.ok(result.report.discovery.review.every((item) => item.title.length <= 120 && item.reason.length <= 300));
  assert.ok(result.state.queue.length <= 1000);
  assert.ok(result.state.queue.every((item) => item.snapshot.description.length <= 600));
});

test("API keys never reach the catalog, the checkpoint, the report or the logs - even when the API echoes them", async () => {
  const echo = (message) => ({ status: 400, body: { error: { code: 400, message, errors: [{ reason: "badRequest" }] } } });
  const scenarios = [
    createYouTube({ uploads: [s2(1)] }),
    createYouTube({ uploads: [s2(1)], plan: { fail: () => echo(`API key not valid: ${TEST_KEY}`) } }),
    createYouTube({ uploads: [s2(1)], plan: { fail: () => { throw new Error(`fetch failed: https://www.googleapis.com/youtube/v3/channels?part=snippet&key=${TEST_KEY}`); } } })
  ];

  for (const youtube of scenarios) {
    const tmdb = createTmdb({ plan: { fail: (u) => { throw new Error(`tmdb fetch failed for ${u} api_key=${TEST_TMDB_KEY}`); } } });
    const result = await runDiscovery({ youtube, tmdb, tmdbKey: TEST_TMDB_KEY });
    const everything = [JSON.stringify(result.catalog), JSON.stringify(result.state), JSON.stringify(result.report), result.logs.join("\n"), fs.readFileSync(result.ws.catalogFile, "utf8"), fs.existsSync(result.ws.stateFile) ? fs.readFileSync(result.ws.stateFile, "utf8") : ""].join("\n");

    assert.ok(!everything.includes(TEST_KEY), "YouTube key leaked");
    assert.ok(!everything.includes(TEST_TMDB_KEY), "TMDB key leaked");
    assert.ok(!/[?&]key=/.test(everything), "a key= query string leaked");
  }
});

/* ------------------------------ the real fixture (25 records, 27 manifest entries) ------------------------------ */

const FIXTURES_PRESENT = fs.existsSync(FIXTURE_CATALOG) && fs.existsSync(FIXTURE_MANIFEST);
const S2_IDS = ["verified-jujutsu-kaisen-season-2", "verified-spy-x-family-season-2"];
const fixture = () => ({ catalog: readJson(FIXTURE_CATALOG), manifest: readJson(FIXTURE_MANIFEST) });

test("real fixture, discovery on but no YouTube key: exactly 27 records, the two season-2 entries appended, originals unchanged, rerun adds none", { skip: !FIXTURES_PRESENT }, async () => {
  const { catalog, manifest } = fixture();
  const originals = clone(catalog.anime);
  const youtube = createYouTube({ uploads: [] });
  const first = await runDiscovery({ catalog: clone(catalog), manifest, youtube, tmdb: null, youtubeKey: "" });

  assert.equal(youtube.requests.length, 0);
  assert.equal(first.catalog.anime.length, 27);
  assert.equal(first.report.added, 2);
  assert.deepEqual(first.report.addedIds.sort(), [...S2_IDS].sort());
  assert.deepEqual(first.catalog.anime.slice(0, 25), originals, "the 25 originals are deep-equal and in the same order");
  assert.equal(first.report.discovery.skipReason, "missing-youtube-key");

  const second = await again(first, { youtube, tmdb: null, youtubeKey: "" });
  assert.equal(second.catalog.anime.length, 27);
  assert.equal(second.report.added, 0);
  assert.deepEqual(second.catalog.anime, first.catalog.anime);
  assert.equal(new Set(idsOf(second.catalog)).size, 27);
  assert.match(second.report.zeroAddReason, /Discovery: YOUTUBE_API_KEY is not set/);
});

test("real fixture with a live-style channel: discovery reuses legacy season-1 ids, never blocks the manifest's season-2 entries, and adds only what is new", { skip: !FIXTURES_PRESENT }, async () => {
  const { catalog, manifest } = fixture();
  const originals = clone(catalog.anime);
  const youtube = createYouTube({
    uploads: [
      ep(1, "Tamil Dub | SPY x FAMILY Season 1 Episode 5 | Muse India"),
      ep(2, "Tamil Dub | SPY x FAMILY Season 2 Episode 1 | Muse India"),
      ep(3, "Tamil Dub | JUJUTSU KAISEN Season 2 Episode 3 | Muse India"),
      ep(4, "Tamil Dub | Dr. STONE Season 1 Episode 2 | Muse India"),
      ep(5, "Tamil Dub | Brand New Show Season 1 Episode 1 | Muse India")
    ]
  });
  const first = await runDiscovery({ catalog: clone(catalog), manifest, youtube, tmdb: null, extraChannelIds: [CHANNEL] });

  assert.equal(first.catalog.anime.length, 27, "the count is exactly 27: nothing duplicated, the unlisted show was not guessed");
  assert.equal(new Set(idsOf(first.catalog)).size, 27);
  assert.deepEqual(first.report.addedIds.sort(), [...S2_IDS].sort(), "both season-2 manifest entries were appended despite discovery");
  assert.equal(first.report.needsReview.length, 0, "discovery created no identity conflict with the manifest");

  // Season-2 records got their channel links through the manifest id.
  assert.equal(linkOf(first.catalog, "verified-spy-x-family-season-2", "2-1"), url(2));
  assert.equal(linkOf(first.catalog, "verified-jujutsu-kaisen-season-2", "2-3"), url(3));

  // Legacy season-1 records were reused (no new id), not stamped with a season, and kept their curated fields.
  const spy = byId(first.catalog, "verified-spy-x-family-season-1");
  const originalSpy = originals.find((item) => item.id === "verified-spy-x-family-season-1");
  assert.equal(spy.tmdbSeason, undefined);
  assert.equal(spy.title, originalSpy.title);
  assert.equal(spy.tamilDubVerificationUrl, originalSpy.tamilDubVerificationUrl);
  assert.deepEqual(spy.tamilDubEvidence.slice(0, originalSpy.tamilDubEvidence.length), originalSpy.tamilDubEvidence);
  assert.ok(spy.tamilDubEvidence.some((item) => item.videoId === vid(1)));
  assert.equal(first.catalog.anime.filter((item) => item.tmdbSeason !== undefined && !S2_IDS.includes(item.id)).length, originals.filter((item) => item.tmdbSeason !== undefined).length, "no legacy record gained a tmdbSeason");

  // Records no video touched are deep-equal to the originals.
  const touched = new Set(["verified-spy-x-family-season-1", "verified-dr--stone-season-1"]);
  for (const original of originals) {
    if (!touched.has(original.id)) assert.deepEqual(byId(first.catalog, original.id), original, original.id);
  }

  // The unlisted show is a review item, not a record.
  assert.equal(first.report.discovery.counts.review, 1);
  assert.match(first.report.discovery.review[0].reason, /not a series the catalog already knows and TMDB_API_KEY is not set/);

  // Rerun: idempotent.
  const second = await again(first, { youtube, tmdb: null, extraChannelIds: [CHANNEL] });
  assert.equal(second.catalog.anime.length, 27);
  assert.equal(second.report.added, 0);
  assert.deepEqual(withoutScan(second.catalog), withoutScan(first.catalog));
});
