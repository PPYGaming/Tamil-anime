"use strict";

// Checkpointed scan of an uploads playlist (pagination, bootstrap budget and resume, incremental overlap, failures that
// must not move a checkpoint, channel ownership) and the per-video assessment. Mocked YouTube only.
const test = require("node:test");
const assert = require("node:assert/strict");
const { createYouTubeClient, normalizeVideo } = require("../scripts/discovery/youtube");
const { scanChannel } = require("../scripts/discovery/scan");
const { assessVideo } = require("../scripts/discovery/assess");
const { emptyChannelState } = require("../scripts/discovery/state");
const { CHANNEL, OTHER_CHANNEL, TEST_KEY, vid, video, createYouTube } = require("./helpers/discovery-harness");

const DAY = 24 * 3600 * 1000;
const T0 = Date.parse("2026-01-01T00:00:00Z");
const iso = (ms) => new Date(ms).toISOString();

// n uploads, newest first, 10 days apart (so the 72 h overlap window never swallows a neighbouring page by accident).
const tamil = (i, extra = {}) => video(vid(i), `Tamil Dub | Demo Show Season 1 Episode ${i} | Muse India`, { publishedAt: iso(T0 + i * 10 * DAY), ...extra });
const uploadsOf = (numbers) => numbers.map((n) => tamil(n));

function clientFor(youtube, options = {}) {
  const fetchImpl = async (url) => {
    const { status = 200, body = {} } = await youtube.handler(String(url));
    return { ok: status >= 200 && status < 300, status, headers: { get: () => null }, text: async () => JSON.stringify(body) };
  };

  return createYouTubeClient({ apiKey: TEST_KEY, fetchImpl, sleep: async () => {}, retries: 0, ...options });
}

const CFG = { overlapHours: 72, incrementalPageBudget: 10, bootstrapPageBudget: 100, unavailableRetryDays: 30, fullRescan: false };

async function scan(youtube, chState, cfg = {}, nowMs = Date.parse("2026-09-01T00:00:00Z"), channelId = CHANNEL) {
  const client = clientFor(youtube);
  const result = await scanChannel({ client, channelId, chState, cfg: { ...CFG, ...cfg }, nowIso: iso(nowMs), nowMs });
  return { result, client };
}

const ids = (result) => [...result.candidates.keys()].sort();
const calls = (youtube, endpoint) => youtube.requests.filter((request) => request.endpoint === endpoint);

test("bootstrap walks every page of a multi-page history and reports completeness", async () => {
  const youtube = createYouTube({ uploads: uploadsOf([7, 6, 5, 4, 3, 2, 1]), pageSize: 2 });
  const chState = emptyChannelState();
  const { result } = await scan(youtube, chState);

  assert.equal(result.status, "complete");
  assert.deepEqual(ids(result), [1, 2, 3, 4, 5, 6, 7].map(vid).sort());
  assert.equal(result.pages, 4);
  assert.equal(result.bootstrapComplete, true);
  assert.equal(chState.bootstrap.complete, true);
  assert.equal(chState.bootstrap.nextPageToken, null);
  assert.equal(chState.uploadsPlaylistId.length > 0, true);
  assert.equal(chState.incremental.highWaterMark, iso(T0 + 70 * DAY));
  assert.ok(chState.lastCompleteScanAt);
});

test("an empty channel completes with nothing, not an error", async () => {
  const youtube = createYouTube({ uploads: [] });
  const { result } = await scan(youtube, emptyChannelState());

  assert.equal(result.status, "complete");
  assert.equal(result.candidates.size, 0);
});

test("page budget: the scan stops partial, checkpoints the cursor, and resumes where it stopped", async () => {
  const youtube = createYouTube({ uploads: uploadsOf([8, 7, 6, 5, 4, 3, 2, 1]), pageSize: 2 });
  const chState = emptyChannelState();
  const seen = new Set();

  const first = await scan(youtube, chState, { bootstrapPageBudget: 1 });
  assert.equal(first.result.status, "partial");
  assert.equal(first.result.stopReason, "page-budget-reached");
  assert.equal(first.result.bootstrapComplete, false);
  assert.equal(chState.bootstrap.complete, false);
  assert.ok(chState.bootstrap.nextPageToken);
  for (const id of ids(first.result)) seen.add(id);

  let guard = 0;
  while (!chState.bootstrap.complete && guard++ < 10) {
    const next = await scan(youtube, chState, { bootstrapPageBudget: 1 });
    for (const id of ids(next.result)) seen.add(id);
  }

  assert.equal(chState.bootstrap.complete, true);
  assert.deepEqual([...seen].sort(), [1, 2, 3, 4, 5, 6, 7, 8].map(vid).sort());
});

test("resume starts at the saved cursor, not from the beginning of history", async () => {
  const youtube = createYouTube({ uploads: uploadsOf([8, 7, 6, 5, 4, 3, 2, 1]), pageSize: 2 });
  const chState = emptyChannelState();

  await scan(youtube, chState, { bootstrapPageBudget: 1 });
  const saved = chState.bootstrap.nextPageToken;
  youtube.requests.length = 0;

  await scan(youtube, chState, { bootstrapPageBudget: 1, incrementalPageBudget: 1 });
  const tokens = calls(youtube, "playlistItems").map((request) => request.params.pageToken || null);

  assert.ok(tokens.includes(saved), "the saved cursor was requested");
  assert.equal(tokens.filter((token) => token === null).length, 1, "history is not restarted: only the incremental head page is re-read");
});

test("a failed page leaves the cursor on that page and never reports a successful scan", async () => {
  const uploads = uploadsOf([6, 5, 4, 3, 2, 1]);
  let failNow = false;
  const youtube = createYouTube({ uploads, pageSize: 2, plan: { fail: (url, info) => (failNow && info.endpoint === "playlistItems" && info.params.pageToken ? { status: 503, body: {} } : null) } });
  const chState = emptyChannelState();

  await scan(youtube, chState, { bootstrapPageBudget: 1 });
  const cursorBefore = chState.bootstrap.nextPageToken;
  const pagesBefore = chState.bootstrap.pagesProcessed;

  failNow = true;
  const failed = await scan(youtube, chState, { bootstrapPageBudget: 5 });

  assert.notEqual(failed.result.status, "complete");
  assert.equal(failed.result.stopReason, "api-error");
  assert.equal(chState.bootstrap.complete, false);
  assert.equal(chState.bootstrap.nextPageToken, cursorBefore, "cursor did not move past the failed page");
  assert.equal(chState.bootstrap.pagesProcessed, pagesBefore);

  failNow = false;
  const recovered = await scan(youtube, chState, { bootstrapPageBudget: 5 });
  assert.equal(recovered.result.status, "complete");
  assert.equal(chState.bootstrap.complete, true);
});

test("a failed videos.list for a page also keeps the cursor on that page", async () => {
  const youtube = createYouTube({ uploads: uploadsOf([4, 3, 2, 1]), pageSize: 2, plan: { fail: (url, info) => (info.endpoint === "videos" ? { status: 500, body: {} } : null) } });
  const chState = emptyChannelState();
  const { result } = await scan(youtube, chState);

  assert.equal(result.status, "failed");
  assert.equal(chState.bootstrap.started, false, "nothing was checkpointed");
  assert.equal(chState.incremental.highWaterMark, null);
});

test("quota exhaustion is fatal, named, and does not advance any checkpoint", async () => {
  const youtube = createYouTube({
    uploads: uploadsOf([4, 3, 2, 1]),
    pageSize: 2,
    plan: { fail: (url, info) => (info.endpoint === "videos" ? { status: 403, body: { error: { code: 403, message: "quota", errors: [{ reason: "quotaExceeded" }] } } } : null) }
  });
  const chState = emptyChannelState();
  const { result } = await scan(youtube, chState);

  assert.equal(result.fatal, true);
  assert.equal(result.stopReason, "quota-exhausted");
  assert.equal(result.status, "failed");
  assert.equal(chState.bootstrap.started, false);
  assert.equal(chState.incremental.highWaterMark, null);
});

test("an invalid key is fatal and reported as an auth error", async () => {
  const youtube = createYouTube({ uploads: uploadsOf([1]), plan: { fail: () => ({ status: 400, body: { error: { code: 400, message: "API key not valid. Please pass a valid API key.", errors: [{ reason: "badRequest" }] } } }) } });
  const { result } = await scan(youtube, emptyChannelState());

  assert.equal(result.fatal, true);
  assert.equal(result.stopReason, "auth-error");
});

test("the per-run unit budget ends the scan as partial", async () => {
  const youtube = createYouTube({ uploads: uploadsOf([8, 7, 6, 5, 4, 3, 2, 1]), pageSize: 2 });
  const client = clientFor(youtube, { unitBudget: 4 }); // channels + playlist page + videos + one more
  const chState = emptyChannelState();
  const result = await scanChannel({ client, channelId: CHANNEL, chState, cfg: CFG, nowIso: iso(Date.parse("2026-09-01")), nowMs: Date.parse("2026-09-01") });

  assert.equal(result.stopReason, "unit-budget-reached");
  assert.notEqual(result.status, "complete");
  assert.equal(chState.bootstrap.complete, false);
});

test("incremental scan: new uploads are found without re-walking history", async () => {
  const uploads = uploadsOf([6, 5, 4, 3, 2, 1]);
  const youtube = createYouTube({ uploads, pageSize: 2 });
  const chState = emptyChannelState();

  await scan(youtube, chState);
  assert.equal(chState.bootstrap.complete, true);

  // Two new uploads appear at the top.
  const fresh = [tamil(8), tamil(7)];
  youtube.uploads.unshift(...fresh);
  for (const item of fresh) youtube.byId.set(item.id, item);
  youtube.requests.length = 0;

  const second = await scan(youtube, chState);

  assert.deepEqual(ids(second.result).filter((id) => [vid(7), vid(8)].includes(id)), [vid(7), vid(8)]);
  assert.equal(second.result.status, "complete");
  assert.ok(calls(youtube, "playlistItems").length <= 2, `history was not re-walked (${calls(youtube, "playlistItems").length} page requests)`);
  assert.equal(chState.incremental.highWaterMark, iso(T0 + 80 * DAY));
});

test("incremental overlap: a video published BEFORE the high-water mark but added late is still caught", async () => {
  const uploads = uploadsOf([6, 5, 4, 3, 2, 1]);
  const youtube = createYouTube({ uploads, pageSize: 2 });
  const chState = emptyChannelState();

  await scan(youtube, chState);
  const mark = Date.parse(chState.incremental.highWaterMark);

  // Published 2 days before the mark (inside the 72 h overlap) but only added to the playlist now, so it sits at the top.
  const late = video(vid(50), "Tamil Dub | Demo Show Season 1 Episode 50 | Muse India", { publishedAt: iso(mark - 2 * DAY) });
  youtube.uploads.unshift(late);
  youtube.byId.set(late.id, late);

  const { result } = await scan(youtube, chState);
  assert.ok(result.candidates.has(vid(50)));
});

test("incremental pass stops at the overlap boundary instead of reading everything", async () => {
  const youtube = createYouTube({ uploads: uploadsOf(Array.from({ length: 20 }, (_, i) => 20 - i)), pageSize: 2 });
  const chState = emptyChannelState();
  await scan(youtube, chState);
  youtube.requests.length = 0;

  const { result } = await scan(youtube, chState);

  assert.equal(result.status, "complete");
  assert.ok(calls(youtube, "playlistItems").length <= 2);
});

test("the high-water mark does not move when the incremental pass hit its page budget", async () => {
  const youtube = createYouTube({ uploads: uploadsOf(Array.from({ length: 6 }, (_, i) => 6 - i)), pageSize: 2 });
  const chState = emptyChannelState();
  await scan(youtube, chState);
  const mark = chState.incremental.highWaterMark;

  // 12 new uploads, newer than anything seen, with only a 1-page incremental budget.
  const fresh = Array.from({ length: 12 }, (_, i) => tamil(40 - i));
  youtube.uploads.unshift(...fresh);
  for (const item of fresh) youtube.byId.set(item.id, item);

  const { result } = await scan(youtube, chState, { incrementalPageBudget: 1 });

  assert.equal(result.incrementalComplete, false);
  assert.equal(chState.incremental.highWaterMark, mark, "the mark stays so the next run keeps looking");
  assert.notEqual(result.status, "complete");
});

test("spoofed channel: a video in the playlist whose snippet.channelId is not the allow-listed channel is dropped", async () => {
  const spoof = video(vid(9), "Tamil Dub | Demo Show Season 1 Episode 9 | Muse India", { channelId: OTHER_CHANNEL });
  const youtube = createYouTube({ uploads: [spoof, tamil(2), tamil(1)] });
  const { result } = await scan(youtube, emptyChannelState());

  assert.equal(result.candidates.has(vid(9)), false);
  assert.equal(result.foreignChannel, 1);
  assert.deepEqual(ids(result), [vid(1), vid(2)]);
});

test("a title that names the official channel is not proof of ownership", async () => {
  const lookalike = video(vid(9), "Tamil Dub | Demo Show Episode 9 | Muse India Official", { channelId: OTHER_CHANNEL });
  const youtube = createYouTube({ uploads: [lookalike] });
  const { result } = await scan(youtube, emptyChannelState());

  assert.equal(result.candidates.size, 0);
  assert.equal(result.foreignChannel, 1);
});

test("channels.list returning a different channel id stops the scan before any playlist is read", async () => {
  const youtube = createYouTube({ uploads: uploadsOf([2, 1]), returnedChannelId: OTHER_CHANNEL });
  const { result } = await scan(youtube, emptyChannelState());

  assert.equal(result.status, "failed");
  assert.equal(result.stopReason, "channel-mismatch");
  assert.equal(result.candidates.size, 0);
  assert.equal(calls(youtube, "playlistItems").length, 0);
});

test("an allow-listed channel that does not exist fails with a precise reason", async () => {
  const youtube = createYouTube({ uploads: uploadsOf([1]), plan: { noChannel: true } });
  const { result } = await scan(youtube, emptyChannelState());

  assert.equal(result.status, "failed");
  assert.equal(result.stopReason, "channel-not-found");
});

test("only titles that start with Tamil Dub are collected; everything else is counted and dropped", async () => {
  const mixed = [
    video(vid(1), "Demo Show Episode 1 Tamil Dub"),
    video(vid(2), "Tamil Dub | Demo Show Episode 2"),
    video(vid(3), "Tamil Dubbed Demo Show Episode 3"),
    video(vid(4), "Hindi Dub | Demo Show Episode 4"),
    video(vid(5), "Tamil Subtitles | Demo Show Episode 5"),
    video(vid(6), "[Tamil Dub] Demo Show Episode 6")
  ];
  const youtube = createYouTube({ uploads: mixed });
  const { result } = await scan(youtube, emptyChannelState());

  assert.deepEqual(ids(result), [vid(2), vid(6)]);
  assert.equal(result.excludedNotTamilDub, 4);
  assert.equal(result.videosSeen, 6);
});

test("deleted or private playlist entries are counted as not returned, and recent ones are remembered for retry", async () => {
  const hiddenRecent = { id: vid(30), hidden: true, addedAt: "2026-08-25T00:00:00Z" };
  const hiddenOld = { id: vid(31), hidden: true, addedAt: "2025-01-01T00:00:00Z" };
  const youtube = createYouTube({ uploads: [hiddenRecent, tamil(2), hiddenOld, tamil(1)] });
  const { result } = await scan(youtube, emptyChannelState(), {}, Date.parse("2026-09-01T00:00:00Z"));

  assert.equal(result.notReturned, 2);
  assert.deepEqual(result.notReturnedRecent.map((item) => item.videoId), [vid(30)]);
  assert.deepEqual(ids(result), [vid(1), vid(2)]);
  assert.equal(result.status, "complete", "a hidden video is not a failed scan");
});

test("a stale page token resets the bootstrap walk instead of looping on it", async () => {
  const youtube = createYouTube({ uploads: uploadsOf([6, 5, 4, 3, 2, 1]), pageSize: 2 });
  const chState = emptyChannelState();
  await scan(youtube, chState, { bootstrapPageBudget: 1 });
  chState.bootstrap.nextPageToken = "STALE-TOKEN"; // createYouTube rejects tokens that are not PAGE<n>

  const broken = await scan(youtube, chState, { bootstrapPageBudget: 5 });
  assert.notEqual(broken.result.status, "complete");
  assert.ok(broken.result.notes.includes("bootstrap-cursor-reset"));
  assert.equal(chState.bootstrap.started, false);

  const rebuilt = await scan(youtube, chState, { bootstrapPageBudget: 5 });
  assert.equal(rebuilt.result.status, "complete");
});

test("a changed uploads playlist or an explicit full rescan restarts the history walk", async () => {
  const youtube = createYouTube({ uploads: uploadsOf([3, 2, 1]), pageSize: 2 });
  const chState = emptyChannelState();
  await scan(youtube, chState);
  assert.equal(chState.bootstrap.complete, true);

  const rescan = await scan(youtube, chState, { fullRescan: true, bootstrapPageBudget: 1 });
  assert.ok(rescan.result.notes.includes("full-rescan-requested"));
  assert.equal(rescan.result.bootstrapComplete, rescan.result.status === "complete");

  chState.uploadsPlaylistId = "UUotherplaylist00000000";
  const changed = await scan(youtube, chState);
  assert.ok(changed.result.notes.includes("uploads-playlist-changed"));
});

test("the same video appearing twice in the playlist is processed once", async () => {
  const youtube = createYouTube({ uploads: [tamil(1), tamil(1)] });
  const { result } = await scan(youtube, emptyChannelState());

  assert.equal(result.videosSeen, 1);
  assert.deepEqual(ids(result), [vid(1)]);
});

/* ------------------------------ assessVideo ------------------------------ */

const assess = (title, extra = {}, options) => assessVideo(normalizeVideo(video(vid(1), title, extra)), options);

test("assess: a full episode with an explicit number is a candidate", () => {
  const verdict = assess("Tamil Dub | Demo Show Season 2 Episode 3 | Muse India");
  assert.equal(verdict.outcome, "candidate");
  assert.equal(verdict.parsed.episode, 3);
});

test("assess: titles without the prefix are excluded before anything else", () => {
  assert.equal(assess("Demo Show Episode 3 Tamil Dub").outcome, "excluded");
});

test("assess: trailers and clips never become episode evidence; announcements are kept apart", () => {
  assert.equal(assess("Tamil Dub | Demo Show Official Trailer").outcome, "promo");
  assert.equal(assess("Tamil Dub | Demo Show Episode 3 Best Scene").outcome, "promo");
  assert.equal(assess("Tamil Dub | Demo Show Dub Announcement").outcome, "announcement");
});

test("assess: private, unlisted-processing, live and upcoming videos are not evidence", () => {
  assert.equal(assess("Tamil Dub | Demo Show Episode 3", { privacyStatus: "private" }).outcome, "unavailable");
  assert.equal(assess("Tamil Dub | Demo Show Episode 3", { uploadStatus: "uploaded" }).outcome, "deferred");
  assert.equal(assess("Tamil Dub | Demo Show Episode 3", { liveBroadcastContent: "upcoming" }).outcome, "deferred");
  assert.equal(assess("Tamil Dub | Demo Show Episode 3", { liveBroadcastContent: "live" }).outcome, "deferred");
});

test("assess: regional blocking in India is not accepted as a watch link", () => {
  assert.equal(assess("Tamil Dub | Demo Show Episode 3", { regionRestriction: { blocked: ["IN"] } }).outcome, "region-blocked");
  assert.equal(assess("Tamil Dub | Demo Show Episode 3", { regionRestriction: { allowed: ["US"] } }).outcome, "region-blocked");
  assert.equal(assess("Tamil Dub | Demo Show Episode 3", { regionRestriction: { blocked: ["US"] } }).outcome, "candidate");
  assert.equal(assess("Tamil Dub | Demo Show Episode 3", { regionRestriction: { blocked: ["IN"] } }, { region: "US" }).outcome, "candidate");
});

test("assess: ambiguity goes to review with the reason", () => {
  for (const title of [
    "Tamil Dub | Demo Show Episode 3-4",
    "Tamil Dub | Demo Show Season 1 Season 2 Episode 3",
    "Tamil Dub | Demo Show Episode 3 Hindi",
    "Tamil Dub | Demo Show Episode 3 English Subtitles",
    "Tamil Dub | Demo Show The Movie",
    "Tamil Dub | Demo Show",
    "Tamil Dub | Demo Show Part 2 Episode 3"
  ]) {
    const verdict = assess(title);
    assert.equal(verdict.outcome, "review", title);
    assert.ok(verdict.reason.length > 5, title);
  }
});

test("assess: non-Tamil audio metadata blocks auto-add, Tamil metadata does not", () => {
  assert.equal(assess("Tamil Dub | Demo Show Episode 3", { defaultAudioLanguage: "hi" }).outcome, "review");
  assert.equal(assess("Tamil Dub | Demo Show Episode 3", { defaultAudioLanguage: "ta" }).outcome, "candidate");
  assert.equal(assess("Tamil Dub | Demo Show Episode 3", { defaultAudioLanguage: "ta-IN" }).outcome, "candidate");
});

test("assess: short videos and unknown durations are reviewed as possible clips", () => {
  assert.equal(assess("Tamil Dub | Demo Show Episode 3", { duration: "PT3M" }).outcome, "review");
  assert.equal(assess("Tamil Dub | Demo Show Episode 3", { duration: "PT3M" }, { minEpisodeSeconds: 0 }).outcome, "candidate");
  assert.equal(assess("Tamil Dub | Demo Show Episode 3", { duration: "garbage" }).outcome, "review");
});
