"use strict";

// Checkpoint state and per-video provenance: parsing never throws, nothing foreign survives, and merges only append.
const test = require("node:test");
const assert = require("node:assert/strict");
const { STATE_VERSION, MAX_QUEUE, emptyState, parseState, serializeState, normalizeQueueItem } = require("../scripts/discovery/state");
const { sanitizeProvenance, mergeProvenance, applyAvailability, provenanceRows } = require("../scripts/discovery/provenance");
const { buildGroups, findExistingIdentity, watchUrl } = require("../scripts/discovery/entries");
const { CHANNEL, TEST_KEY, vid } = require("./helpers/discovery-harness");
const { normalizeTitle, recordTmdbKey } = require("../scripts/update-anime");

const helpers = { normalizeTitle, recordTmdbKey };

/* -------------------------------- state -------------------------------- */

test("state: no file means a fresh state, flagged as not existing", () => {
  const parsed = parseState(null);
  assert.equal(parsed.existed, false);
  assert.equal(parsed.problem, null);
  assert.deepEqual(parsed.state, emptyState());
});

test("state: corrupt or foreign-version files restart safely instead of throwing", () => {
  for (const text of ["{not json", "[]", '{"version":99}', "null", "", '"string"']) {
    const parsed = parseState(text);
    assert.deepEqual(parsed.state, emptyState(), text);
    assert.ok(parsed.problem, `${text} reports a problem`);
  }
});

test("state: a round trip preserves cursors and queue, and output is deterministic", () => {
  const state = emptyState();
  state.channels[CHANNEL] = {
    uploadsPlaylistId: "UUaaaaaaaaaaaaaaaaaaaaaa",
    bootstrap: { complete: false, started: true, nextPageToken: "CAUQAA", pagesProcessed: 7, startedAt: "2026-10-01T00:00:00.000Z", completedAt: null },
    incremental: { highWaterMark: "2026-09-30T10:00:00.000Z" },
    lastScanAt: "2026-10-03T00:00:00.000Z",
    lastCompleteScanAt: null
  };
  state.queue = [normalizeQueueItem({ videoId: vid(2), channelId: CHANNEL, status: "review", reason: "x", snapshot: { title: "Tamil Dub | X" } }), normalizeQueueItem({ videoId: vid(1), channelId: CHANNEL, status: "deferred", reason: "y" })];
  state.recheckCursor = vid(1);

  const text = JSON.stringify(serializeState(state));
  const again = parseState(text);

  assert.equal(again.problem, null);
  assert.equal(again.state.channels[CHANNEL].bootstrap.nextPageToken, "CAUQAA");
  assert.equal(again.state.channels[CHANNEL].incremental.highWaterMark, "2026-09-30T10:00:00.000Z");
  assert.deepEqual(again.state.queue.map((item) => item.videoId), [vid(1), vid(2)], "queue is sorted by video id");
  assert.equal(JSON.stringify(serializeState(again.state)), text, "serialising twice gives identical bytes");
});

test("state: unknown fields, secrets and malformed identifiers never survive a load", () => {
  const text = JSON.stringify({
    version: STATE_VERSION,
    apiKey: TEST_KEY,
    token: "ghp_should_not_be_here",
    channels: {
      [CHANNEL]: { uploadsPlaylistId: "UUaaaaaaaaaaaaaaaaaaaaaa", secret: TEST_KEY, bootstrap: { complete: "yes", nextPageToken: "x".repeat(2000) }, incremental: { highWaterMark: "not a date" } },
      "not-a-channel-id": { uploadsPlaylistId: "x" }
    },
    queue: [{ videoId: "short" }, { videoId: vid(1), channelId: CHANNEL, status: "weird", reason: "r", snapshot: { title: "t", evil: TEST_KEY } }, "junk", null],
    recheckCursor: "bad cursor!"
  });

  const parsed = parseState(text);
  const out = JSON.stringify(serializeState(parsed.state));

  assert.ok(!out.includes(TEST_KEY));
  assert.ok(!out.includes("ghp_"));
  assert.deepEqual(Object.keys(parsed.state.channels), [CHANNEL]);
  assert.equal(parsed.state.channels[CHANNEL].bootstrap.complete, false);
  assert.equal(parsed.state.channels[CHANNEL].bootstrap.nextPageToken, null);
  assert.equal(parsed.state.channels[CHANNEL].incremental.highWaterMark, null);
  assert.equal(parsed.state.queue.length, 1);
  assert.equal(parsed.state.queue[0].status, "review");
  assert.equal(parsed.state.recheckCursor, "");
});

test("state: the queue is bounded", () => {
  const queue = Array.from({ length: MAX_QUEUE + 50 }, (_, i) => ({ videoId: vid(i + 1), channelId: CHANNEL, status: "review", reason: "r" }));
  const parsed = parseState(JSON.stringify({ version: STATE_VERSION, channels: {}, queue, recheckCursor: "" }));
  assert.equal(parsed.state.queue.length, MAX_QUEUE);
});

/* ------------------------------ provenance ------------------------------ */

const row = (n, extra = {}) => ({
  videoId: vid(n),
  channelId: CHANNEL,
  evidenceUrl: watchUrl(vid(n)),
  rawTitle: `Tamil Dub | Demo Show Season 2 Episode ${n}`,
  rawDescription: "desc",
  languageProof: 'title begins with "Tamil Dub"',
  publishedAt: "2026-09-01T00:00:00Z",
  durationSeconds: 1450,
  kind: "episode",
  season: 2,
  seasonSource: "explicit-in-title",
  episode: n,
  episodeNumber: `2-${n}`,
  series: { tmdbId: 777, source: "tmdb-search", matchedName: "Demo Show" },
  availability: "public",
  scannedAt: "2026-10-03T00:00:00.000Z",
  checkedAt: "2026-10-03T00:00:00.000Z",
  ...extra
});

test("provenance: the evidence URL is always rebuilt from the real video id", () => {
  const [clean] = sanitizeProvenance([row(1, { evidenceUrl: "https://evil.example/phish?x=1" })]);
  assert.equal(clean.evidenceUrl, `https://www.youtube.com/watch?v=${vid(1)}`);
});

test("provenance: malformed rows, bad ids and duplicates are dropped, control characters stripped", () => {
  const rows = sanitizeProvenance([row(1), row(1), { ...row(2), videoId: "short" }, { ...row(3), channelId: "UCnope" }, null, "x", row(4, { rawTitle: "a\u0000b\nc" })]);

  assert.deepEqual(rows.map((item) => item.videoId), [vid(1), vid(4)]);
  assert.ok(!/[\u0000-\u001f]/.test(rows[1].rawTitle));
});

test("provenance: merge appends by video id and leaves existing rows untouched", () => {
  const record = { discoveryProvenance: [row(1, { rawTitle: "Original title" })] };

  assert.equal(mergeProvenance(record, [row(1, { rawTitle: "Changed title", durationSeconds: 5 }), row(2)]), true);
  assert.deepEqual(record.discoveryProvenance.map((item) => item.videoId), [vid(1), vid(2)]);
  assert.equal(record.discoveryProvenance[0].rawTitle, "Original title");
  assert.equal(record.discoveryProvenance[0].durationSeconds, 1450);

  assert.equal(mergeProvenance(record, [row(1), row(2)]), false, "re-merging the same rows is a no-op");
});

test("provenance: the only in-place change to a row is availability (and its check time)", () => {
  const record = { discoveryProvenance: [row(1)] };

  assert.equal(mergeProvenance(record, [row(1, { availability: "region-blocked", checkedAt: "2026-11-01T00:00:00.000Z" })]), true);
  assert.equal(record.discoveryProvenance[0].availability, "region-blocked");
  assert.equal(record.discoveryProvenance[0].checkedAt, "2026-11-01T00:00:00.000Z");
  assert.equal(record.discoveryProvenance[0].rawTitle, row(1).rawTitle);
});

test("provenance: a foreign discoveryProvenance value is never clobbered", () => {
  const record = { discoveryProvenance: "hand written" };
  assert.equal(mergeProvenance(record, [row(1)]), false);
  assert.equal(record.discoveryProvenance, "hand written");
});

test("provenance: applyAvailability records a video going away without removing the row", () => {
  const record = { discoveryProvenance: [row(1), row(2)] };
  const updates = new Map([[vid(1), { availability: "unavailable", checkedAt: "2026-11-01T00:00:00.000Z" }], [vid(9), { availability: "unavailable", checkedAt: "x" }]]);

  assert.equal(applyAvailability(record, updates), true);
  assert.equal(record.discoveryProvenance.length, 2);
  assert.equal(record.discoveryProvenance[0].availability, "unavailable");
  assert.equal(record.discoveryProvenance[1].availability, "public");
  assert.equal(applyAvailability(record, updates), false, "idempotent");
  assert.equal(applyAvailability(record, new Map([[vid(1), { availability: "made-up", checkedAt: "x" }]])), false, "unknown availability values are ignored");
});

test("provenance: rows for the availability recheck come from the catalog only", () => {
  const rows = provenanceRows([{ discoveryProvenance: [row(1), row(2)] }, { id: "no provenance" }, null, { discoveryProvenance: [{ videoId: "short" }] }]);
  assert.deepEqual(rows.map((item) => item.videoId), [vid(1), vid(2)]);
});

/* ------------------------------ entries.js ------------------------------ */

const resolution = (season, extra = {}) => ({
  status: "resolved",
  series: { key: "tv:777", tmdbId: 777, title: "Demo Show", originalTitle: "Demo Show", year: 2024, source: "tmdb-search", matchedName: "Demo Show" },
  season,
  numberingSeason: season === null ? 1 : season,
  seasonSource: season === null ? "tmdb-single-regular-season" : "explicit-in-title",
  ...extra
});

const item = (n, season, extra = {}) => ({
  video: { videoId: vid(n), channelId: CHANNEL, title: `Tamil Dub | Demo Show Season ${season} Episode ${n}`, description: "", publishedAt: `2026-09-0${Math.min(n, 9)}T10:00:00Z`, durationSeconds: 1450, ...extra },
  assessment: { outcome: "candidate", parsed: { episode: n, languageProof: "Tamil Dub" } },
  resolution: resolution(season)
});

test("entries: episodes of one series+season form one group with watch URLs built only from the video id", () => {
  const { groups, unplaced } = buildGroups({ items: [item(2, 2), item(1, 2)], anime: [], claims: new Map(), helpers, nowIso: "2026-10-03T00:00:00.000Z" });

  assert.equal(unplaced.length, 0);
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].raw.episodes, [{ number: "2-1", url: watchUrl(vid(1)) }, { number: "2-2", url: watchUrl(vid(2)) }]);
  assert.equal(groups[0].raw.tmdbSeason, 2);
  assert.equal(groups[0].raw.origin, "discovery");
  assert.ok(groups[0].raw.verification.every((entry) => entry.url === watchUrl(entry.url.split("v=")[1])));
});

test("entries: two seasons of one series are two groups", () => {
  const { groups } = buildGroups({ items: [item(1, 1), item(1, 2)], anime: [], claims: new Map(), helpers, nowIso: "2026-10-03T00:00:00.000Z" });
  assert.deepEqual(groups.map((group) => group.raw.tmdbSeason).sort(), [1, 2]);
});

test("entries: duplicate uploads of one episode keep one deterministic winner and record the rest", () => {
  const early = item(1, 2, { videoId: vid(11), publishedAt: "2026-09-01T00:00:00Z" });
  const late = item(1, 2, { videoId: vid(10), publishedAt: "2026-09-05T00:00:00Z" });
  const forward = buildGroups({ items: [early, late], anime: [], claims: new Map(), helpers, nowIso: "x".repeat(10) });
  const reverse = buildGroups({ items: [late, early], anime: [], claims: new Map(), helpers, nowIso: "x".repeat(10) });

  assert.equal(forward.groups[0].raw.episodes.length, 1);
  assert.equal(forward.groups[0].raw.episodes[0].url, watchUrl(vid(11)), "the earliest upload wins");
  assert.deepEqual(forward.groups[0].duplicateVideoIds, [vid(10)]);
  assert.equal(reverse.groups[0].raw.episodes[0].url, forward.groups[0].raw.episodes[0].url, "input order does not change the winner");
});

test("entries: a group reuses the id of the existing record for that series and season", () => {
  const anime = [{ id: "demo-show-s2", title: "Demo Show Season 2", mediaType: "tv", tmdbId: 777, tmdbSeason: 2 }];
  const { groups } = buildGroups({ items: [item(3, 2)], anime, claims: new Map(), helpers, nowIso: "2026-10-03T00:00:00.000Z" });

  assert.equal(groups[0].raw.id, "demo-show-s2");
});

test("entries: a legacy season-1 record (no tmdbSeason) is reused only when a manifest claim says it is season 1", () => {
  const anime = [{ id: "demo-show", title: "Demo Show", mediaType: "tv", tmdbId: 777 }];

  const claimed = buildGroups({ items: [item(3, 1)], anime, claims: new Map([["demo-show", { season: 1 }]]), helpers, nowIso: "2026-10-03T00:00:00.000Z" });
  assert.equal(claimed.groups[0].raw.id, "demo-show");

  const unclaimed = buildGroups({ items: [item(3, 2)], anime, claims: new Map(), helpers, nowIso: "2026-10-03T00:00:00.000Z" });
  assert.equal(unclaimed.groups.length, 0);
  assert.match(unclaimed.unplaced[0].reason, /no season identity/);
});

test("entries: several records for one season are a problem to review, never a guess", () => {
  const anime = [
    { id: "a", mediaType: "tv", tmdbId: 777, tmdbSeason: 2 },
    { id: "b", mediaType: "tv", tmdbId: 777, tmdbSeason: 2 }
  ];
  const found = findExistingIdentity({ anime, claims: new Map(), key: "tv:777", season: 2, helpers });
  assert.match(found.problem, /several catalog records/);
});

test("entries: a different season of the same series gets a new id, not a merge into the other season", () => {
  const anime = [{ id: "demo-show-s1", mediaType: "tv", tmdbId: 777, tmdbSeason: 1 }];
  const found = findExistingIdentity({ anime, claims: new Map(), key: "tv:777", season: 2, helpers });

  assert.deepEqual(found, { id: null, season: 2 });
});

test("entries: a manifest entry that is not in the catalog yet donates its id, so discovery can never collide with it", () => {
  const claims = new Map([["show-777-season-2", { key: "tv:777", season: 2, conflict: false }]]);
  const found = findExistingIdentity({ anime: [], claims, key: "tv:777", season: 2, helpers });

  assert.deepEqual(found, { id: "show-777-season-2", season: 2 });

  const { groups } = buildGroups({ items: [item(3, 2)], anime: [], claims, helpers, nowIso: "2026-10-03T00:00:00.000Z" });
  assert.equal(groups[0].raw.id, "show-777-season-2");
});

test("entries: a manifest claim for a different season or a conflicting claim is not borrowed", () => {
  const claims = new Map([
    ["show-777-season-1", { key: "tv:777", season: 1, conflict: false }],
    ["bad", { key: "tv:777", season: 2, conflict: true }]
  ]);

  assert.deepEqual(findExistingIdentity({ anime: [], claims, key: "tv:777", season: 2, helpers }), { id: null, season: 2 });
});
