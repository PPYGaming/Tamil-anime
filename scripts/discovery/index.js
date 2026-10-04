"use strict";

/*
 * Automatic Tamil-dub discovery from allow-listed official YouTube channels.
 *
 *   startDiscovery(ctx)  scans, assesses, resolves and returns entry GROUPS for the caller to push through the normal
 *                        validate/merge path, plus finalize(results) which settles the queue and the report once the
 *                        caller knows which groups the catalog actually accepted.
 *
 * Nothing here writes files. The caller writes the catalog first and the state second.
 *
 * Unfinished work is never skipped: a video that is Tamil-Dub-prefixed and channel-verified but not yet settled
 * (ambiguous, TMDB down, premiere pending, merge refused) stays in state.queue and is re-assessed on every run.
 */

const { createYouTubeClient, playableIn } = require("./youtube");
const { scanChannel } = require("./scan");
const { assessVideo } = require("./assess");
const { createSeriesResolver } = require("./resolve");
const { buildGroups } = require("./entries");
const { startsWithTamilDub } = require("./title");
const { emptyChannelState, normalizeSnapshot, MAX_QUEUE } = require("./state");

const MAX_REPORT_ITEMS = 50;
const DAY_MS = 24 * 3600 * 1000;

const DEFAULTS = Object.freeze({
  enabled: false,
  bootstrapPageBudget: 100, // 100 pages x 50 = 5,000 uploads per run (2 units per page: playlistItems + videos)
  incrementalPageBudget: 10,
  overlapHours: 72,
  unitBudget: 2000, // far below the default 10,000 units/day even at four runs a day
  minEpisodeSeconds: 600,
  queueRetryLimit: 100,
  recheckLimit: 150,
  unavailableRetryDays: 30,
  fullRescan: false,
  requestTimeoutMs: 20000,
  retries: 3,
  backoffBaseMs: 500,
  backoffMaxMs: 15000
});

// An unset or empty variable is "use the default". (Number("") is 0, which would silently switch a safety limit off.)
const int = (value, fallback, min, max) => {
  if (value === undefined || value === null || String(value).trim() === "") return fallback;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
};

const flag = (value) => /^(1|true|yes)$/i.test(String(value === undefined || value === null ? "" : value));

function readDiscoveryConfig(env = process.env) {
  return {
    enabled: flag(env.DISCOVERY_ENABLED),
    bootstrapPageBudget: int(env.DISCOVERY_BOOTSTRAP_PAGES, DEFAULTS.bootstrapPageBudget, 1, 1000),
    incrementalPageBudget: int(env.DISCOVERY_INCREMENTAL_PAGES, DEFAULTS.incrementalPageBudget, 1, 200),
    overlapHours: int(env.DISCOVERY_OVERLAP_HOURS, DEFAULTS.overlapHours, 0, 24 * 30),
    unitBudget: int(env.DISCOVERY_UNIT_BUDGET, DEFAULTS.unitBudget, 10, 9000),
    minEpisodeSeconds: int(env.DISCOVERY_MIN_EPISODE_SECONDS, DEFAULTS.minEpisodeSeconds, 0, 7200),
    queueRetryLimit: int(env.DISCOVERY_QUEUE_RETRY_LIMIT, DEFAULTS.queueRetryLimit, 0, 500),
    recheckLimit: int(env.DISCOVERY_RECHECK_LIMIT, DEFAULTS.recheckLimit, 0, 1000),
    unavailableRetryDays: int(env.DISCOVERY_UNAVAILABLE_RETRY_DAYS, DEFAULTS.unavailableRetryDays, 1, 365),
    fullRescan: flag(env.DISCOVERY_FULL_RESCAN),
    requestTimeoutMs: int(env.DISCOVERY_TIMEOUT_MS, DEFAULTS.requestTimeoutMs, 1000, 120000),
    retries: int(env.DISCOVERY_RETRIES, DEFAULTS.retries, 0, 8),
    backoffBaseMs: int(env.DISCOVERY_BACKOFF_BASE_MS, DEFAULTS.backoffBaseMs, 0, 60000),
    backoffMaxMs: int(env.DISCOVERY_BACKOFF_MAX_MS, DEFAULTS.backoffMaxMs, 0, 300000)
  };
}

const normalizeDiscoveryConfig = (input) => ({ ...DEFAULTS, ...(input && typeof input === "object" ? input : {}) });

const short = (value, max) => String(value === undefined || value === null ? "" : value).replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, max);
const cap = (list) => list.slice(0, MAX_REPORT_ITEMS);

const ZERO_ADD_TEXT = {
  "discovery-disabled": "Discovery is switched off (DISCOVERY_ENABLED is not set); only the manifest was processed.",
  "missing-youtube-key": "YOUTUBE_API_KEY is not set, so the official channel could not be scanned.",
  "missing-channel-allowlist": "No official YouTube channel ID is in the allow-list (manifest officialYouTubeChannels or OFFICIAL_YOUTUBE_CHANNEL_IDS); no unverified source was used.",
  "quota-exhausted": "The YouTube API reported its daily quota is used up; the scan stopped and resumes next run.",
  "auth-error": "The YouTube API rejected the key (invalid, restricted, or the API is not enabled for the project); nothing could be scanned.",
  "api-error": "The YouTube API failed repeatedly; the scan is incomplete and resumes next run.",
  "incomplete-scan": "The scan hit its page or unit budget before reaching the end of the channel history; it resumes next run.",
  "no-tamil-evidence": 'The scan completed and no video on the allow-listed channel has a title starting with "Tamil Dub".',
  "all-known": "Every discovered Tamil Dub episode already belongs to a catalog record; nothing new to add.",
  "needs-review": "Tamil Dub videos were found but none could be placed safely; see the review list.",
  "no-episode-evidence": 'Only trailers, announcements or clips were found with a "Tamil Dub" title; they never add a title by themselves.'
};

function emptyReport(cfg, nowIso) {
  return {
    status: "skipped",
    skipReason: null,
    scannedAt: nowIso,
    sources: { youtube: { configured: false, channels: [] }, tmdb: { configured: false } },
    completeness: { complete: false, bootstrapComplete: null, incrementalComplete: null, pagesProcessed: 0, hasMoreHistory: null, stopReason: null },
    counts: {
      videosSeen: 0,
      excludedNotTamilDub: 0,
      foreignChannel: 0,
      notReturnedByApi: 0,
      tamilDubPrefixed: 0,
      evidenceCandidates: 0,
      accepted: 0,
      rejected: 0,
      review: 0,
      deferred: 0,
      announcements: 0,
      promos: 0,
      regionBlocked: 0,
      notPublic: 0,
      duplicateEpisodes: 0,
      queueRetried: 0,
      queueDropped: 0
    },
    reasons: {},
    review: [],
    announcements: [],
    api: { unitsUsed: 0, requests: 0, unitBudget: cfg.unitBudget, failures: [] },
    queueSize: 0,
    notes: [],
    zeroAddReason: null,
    zeroAddReasonCode: null
  };
}

async function startDiscovery(ctx) {
  const { youtubeApiKey, channels, state, anime, claims, tmdb, helpers, nowIso, redact, sleep, random, catalogProvenance = [] } = ctx;
  const cfg = normalizeDiscoveryConfig(ctx.cfg);
  const nowMs = Date.parse(nowIso);
  const region = ctx.region || "IN";

  const report = emptyReport(cfg, nowIso);
  const next = structuredClone(state);
  report.sources.tmdb.configured = Boolean(tmdb && tmdb.enabled);
  report.sources.youtube.configured = Boolean(youtubeApiKey);

  const finishSkipped = (reason) => {
    report.status = reason === "discovery-disabled" ? "disabled" : "skipped";
    report.skipReason = reason;
    report.queueSize = next.queue.length;
    return { skipped: reason, groups: [], availabilityUpdates: new Map(), nextState: next, report, finalize: () => ({ state: next, report: settle(report, 0, reason) }) };
  };

  if (!cfg.enabled) return finishSkipped("discovery-disabled");
  if (!youtubeApiKey) return finishSkipped("missing-youtube-key");
  if (!channels || channels.size === 0) return finishSkipped("missing-channel-allowlist");

  const client = createYouTubeClient({
    apiKey: youtubeApiKey,
    sleep,
    random,
    retries: cfg.retries,
    backoffBaseMs: cfg.backoffBaseMs,
    backoffMaxMs: cfg.backoffMaxMs,
    timeoutMs: cfg.requestTimeoutMs,
    unitBudget: cfg.unitBudget,
    redact
  });

  const channelIds = [...channels.keys()].sort();
  const allowed = new Set(channelIds);

  /* ---- 1. scan every allow-listed channel ------------------------------------------------------------------ */
  const candidates = new Map(); // videoId -> verified snapshot (channelId matched, title starts with "Tamil Dub")
  const notReturned = [];
  let fatal = null;
  let pagesProcessed = 0;
  let allBootstrap = true;
  let allIncremental = true;
  let anyMore = false;
  let anyFailed = false;
  let stopReason = null;

  for (const channelId of channelIds) {
    if (fatal) {
      report.sources.youtube.channels.push({ channelId, name: channels.get(channelId).name, status: "not-scanned", stopReason: fatal });
      allBootstrap = allIncremental = false;
      continue;
    }

    if (!next.channels[channelId]) next.channels[channelId] = emptyChannelState();

    const scan = await scanChannel({ client, channelId, chState: next.channels[channelId], cfg, nowIso, nowMs });

    for (const [id, video] of scan.candidates) candidates.set(id, video);
    notReturned.push(...scan.notReturnedRecent.map((entry) => ({ ...entry, channelId })));

    pagesProcessed += scan.pages;
    report.counts.videosSeen += scan.videosSeen;
    report.counts.excludedNotTamilDub += scan.excludedNotTamilDub;
    report.counts.foreignChannel += scan.foreignChannel;
    report.counts.notReturnedByApi += scan.notReturned;
    for (const note of scan.notes) report.notes.push(`${channelId}: ${note}`);

    allBootstrap = allBootstrap && scan.bootstrapComplete;
    allIncremental = allIncremental && scan.incrementalComplete;
    anyMore = anyMore || !scan.bootstrapComplete;
    anyFailed = anyFailed || scan.status === "failed";
    if (scan.status !== "complete") stopReason = stopReason || scan.stopReason;
    if (scan.fatal) fatal = scan.stopReason;

    report.sources.youtube.channels.push({
      channelId,
      name: scan.channelTitle || channels.get(channelId).name,
      status: scan.status,
      stopReason: scan.stopReason,
      uploadsPlaylistFound: Boolean(next.channels[channelId].uploadsPlaylistId)
    });
  }

  /* ---- 2. queue: unfinished work from earlier runs --------------------------------------------------------- */
  const queue = new Map(next.queue.map((item) => [item.videoId, item]));
  const availability = new Map(); // videoId -> { availability, checkedAt }

  const queued = [...queue.values()].sort((a, b) => String(a.lastTriedAt).localeCompare(String(b.lastTriedAt))).slice(0, cfg.queueRetryLimit);

  if (queued.length && !fatal) {
    try {
      const refreshed = await client.getVideos(queued.map((item) => item.videoId));
      report.counts.queueRetried += queued.length;

      for (const item of queued) {
        const video = refreshed.get(item.videoId);

        if (!video) {
          const age = nowMs - Date.parse(item.firstSeenAt || nowIso);
          if (age > cfg.unavailableRetryDays * DAY_MS) {
            queue.delete(item.videoId);
            report.counts.queueDropped++;
          } else {
            queue.set(item.videoId, { ...item, status: "unavailable", reason: "not returned by the API (deleted, private or hidden); retried while recent", lastTriedAt: nowIso });
          }
          availability.set(item.videoId, { availability: "unavailable", checkedAt: nowIso });
          continue;
        }

        if (!allowed.has(video.channelId) || !startsWithTamilDub(video.title)) {
          queue.delete(item.videoId); // moved channel or retitled: no longer a Tamil Dub candidate
          report.counts.queueDropped++;
          availability.set(item.videoId, { availability: allowed.has(video.channelId) ? "title-changed" : "unavailable", checkedAt: nowIso });
          continue;
        }

        candidates.set(video.videoId, video);
      }
    } catch (error) {
      report.notes.push(`queue refresh failed (${error.kind || "error"}); stored snapshots were re-assessed instead`);
      if (["quota", "auth", "budget"].includes(error.kind)) fatal = fatal || (error.kind === "quota" ? "quota-exhausted" : error.kind === "auth" ? "auth-error" : "unit-budget-reached");
    }
  }

  // Queue items not refreshed this run keep their stored snapshot and are re-assessed offline.
  for (const item of queue.values()) {
    if (candidates.has(item.videoId) || item.status === "unavailable" || !allowed.has(item.channelId)) continue;
    candidates.set(item.videoId, { videoId: item.videoId, channelId: item.channelId, ...item.snapshot });
  }

  // Recently listed but invisible uploads (scheduled, private, processing) are retried while recent.
  for (const entry of notReturned) {
    if (!queue.has(entry.videoId) && queue.size < MAX_QUEUE) {
      queue.set(entry.videoId, { videoId: entry.videoId, channelId: entry.channelId, status: "unavailable", reason: "listed in the uploads playlist but not returned by the API; retried while recent", firstSeenAt: nowIso, lastTriedAt: nowIso, attempts: 1, snapshot: normalizeSnapshot({}) });
    }
    availability.set(entry.videoId, { availability: "unavailable", checkedAt: nowIso });
  }

  /* ---- 3. recheck availability of videos already in the catalog ------------------------------------------- */
  // A rolling window over the catalog's discovered videos (ordered by video ID, resumed from a saved cursor), so every
  // video is re-checked in turn without rewriting a timestamp on every record each run.
  if (cfg.recheckLimit > 0 && catalogProvenance.length && !fatal) {
    const ordered = [...new Set(catalogProvenance.map((row) => row.videoId))].sort();
    const after = ordered.filter((id) => id > (next.recheckCursor || ""));
    const window = [...after, ...ordered.filter((id) => id <= (next.recheckCursor || ""))].filter((id) => !candidates.has(id)).slice(0, cfg.recheckLimit);

    try {
      const found = await client.getVideos(window);

      for (const id of window) {
        const video = found.get(id);
        let verdict = "public";

        if (!video) verdict = "unavailable";
        else if (!allowed.has(video.channelId)) verdict = "unavailable";
        else if (video.privacyStatus && video.privacyStatus !== "public") verdict = "not-public";
        else if (!startsWithTamilDub(video.title)) verdict = "title-changed";
        else if (!playableIn(video, region)) verdict = "region-blocked";

        availability.set(id, { availability: verdict, checkedAt: nowIso });
      }

      if (window.length) next.recheckCursor = window[window.length - 1];
    } catch (error) {
      report.notes.push(`availability recheck skipped (${error.kind || "error"})`);
      if (["quota", "auth", "budget"].includes(error.kind)) fatal = fatal || (error.kind === "quota" ? "quota-exhausted" : error.kind === "auth" ? "auth-error" : "unit-budget-reached");
    }
  }

  /* ---- 4. assess each candidate and resolve its series ------------------------------------------------------ */
  const resolver = createSeriesResolver({ anime, tmdb, helpers });
  const unsettled = new Map(); // videoId -> { status: "review" | "deferred" | "unavailable", reason, video }
  const resolved = [];
  const reasonCounts = report.reasons;
  const bump = (key) => {
    reasonCounts[key] = (reasonCounts[key] || 0) + 1;
  };
  const reviewList = [];

  const unsettle = (video, status, reason) => {
    unsettled.set(video.videoId, { status, reason, video });
    reviewList.push({ videoId: video.videoId, title: short(video.title, 120), status, reason: short(reason, 300) });
  };

  for (const video of [...candidates.values()].sort((a, b) => a.videoId.localeCompare(b.videoId))) {
    const assessment = assessVideo(video, { region, minEpisodeSeconds: cfg.minEpisodeSeconds });
    report.counts.tamilDubPrefixed++;

    if (assessment.outcome === "excluded") {
      report.counts.excludedNotTamilDub++;
      queue.delete(video.videoId);
      continue;
    }

    const setAvailability = (value) => availability.set(video.videoId, { availability: value, checkedAt: nowIso });

    switch (assessment.outcome) {
      case "unavailable":
        report.counts.notPublic++;
        report.counts.rejected++;
        bump("not-public");
        setAvailability("not-public");
        unsettled.set(video.videoId, { status: "unavailable", reason: assessment.reason, video });
        continue;
      case "deferred":
        report.counts.deferred++;
        bump("not-finished");
        unsettle(video, "deferred", assessment.reason);
        continue;
      case "region-blocked":
        report.counts.regionBlocked++;
        report.counts.rejected++;
        bump("region-blocked");
        setAvailability("region-blocked");
        unsettled.set(video.videoId, { status: "review", reason: assessment.reason, video });
        continue;
      case "announcement":
        report.counts.announcements++;
        report.counts.rejected++;
        bump("announcement");
        queue.delete(video.videoId);
        report.announcements.push({ videoId: video.videoId, title: short(video.title, 120), publishedAt: video.publishedAt });
        continue;
      case "promo":
        report.counts.promos++;
        report.counts.rejected++;
        bump("promo-or-clip");
        queue.delete(video.videoId);
        continue;
      case "review":
        report.counts.review++;
        bump("needs-review");
        unsettle(video, "review", assessment.reason);
        continue;
      default:
        break;
    }

    report.counts.evidenceCandidates++;
    setAvailability("public");

    const resolution = await resolver.resolve(assessment.parsed);

    if (resolution.status === "resolved") resolved.push({ video, assessment, resolution });
    else if (resolution.status === "deferred") {
      report.counts.deferred++;
      bump("series-lookup-deferred");
      unsettle(video, "deferred", resolution.reason);
    } else {
      report.counts.review++;
      bump("series-needs-review");
      unsettle(video, "review", resolution.reason);
    }
  }

  /* ---- 5. group the resolved episodes ------------------------------------------------------------------------ */
  const built = buildGroups({ items: resolved, anime, claims, helpers, nowIso });

  for (const place of built.unplaced) {
    for (const id of place.videoIds) {
      const item = resolved.find((entry) => entry.video.videoId === id);
      report.counts.review++;
      bump("season-identity-needs-review");
      unsettle(item.video, "review", place.reason);
    }
  }

  report.counts.duplicateEpisodes = built.groups.reduce((sum, group) => sum + group.duplicateVideoIds.length, 0);

  /* ---- 6. completeness -------------------------------------------------------------------------------------- */
  const complete = !fatal && !anyFailed && allBootstrap && allIncremental && report.sources.youtube.channels.every((item) => item.status === "complete");

  report.status = complete ? "complete" : anyFailed && pagesProcessed === 0 ? "failed" : "partial";
  report.completeness = {
    complete,
    bootstrapComplete: allBootstrap,
    incrementalComplete: allIncremental,
    pagesProcessed,
    hasMoreHistory: anyMore,
    stopReason: complete ? null : fatal || stopReason || "incomplete"
  };

  function finalize(results = new Map(), { addedByDiscovery = 0 } = {}) {
    let acceptedGroups = 0;

    for (const group of built.groups) {
      const result = results.get(group.label) || { ok: false, reason: "entry was not processed" };

      if (result.ok) {
        acceptedGroups++;
        report.counts.accepted += group.videoIds.length;
        for (const id of group.videoIds) queue.delete(id);
        continue;
      }

      for (const id of group.videoIds) {
        const item = resolved.find((entry) => entry.video.videoId === id);
        report.counts[result.deferred ? "deferred" : "review"]++;
        bump(result.deferred ? "merge-deferred" : "merge-needs-review");
        unsettle(item.video, result.deferred ? "deferred" : "review", result.reason);
      }
    }

    // Persist everything unsettled; anything not unsettled and not accepted is final and leaves the queue.
    for (const [id, entry] of unsettled) {
      const previous = queue.get(id);

      queue.set(id, {
        videoId: id,
        channelId: entry.video.channelId || (previous && previous.channelId) || channelIds[0],
        status: entry.status,
        reason: short(entry.reason, 300),
        firstSeenAt: (previous && previous.firstSeenAt) || nowIso,
        lastTriedAt: nowIso,
        attempts: ((previous && previous.attempts) || 0) + 1,
        snapshot: normalizeSnapshot(entry.video)
      });
    }

    // Aged-out unavailable items stop being retried.
    for (const [id, item] of [...queue]) {
      if (item.status === "unavailable" && nowMs - Date.parse(item.firstSeenAt || nowIso) > cfg.unavailableRetryDays * DAY_MS) {
        queue.delete(id);
        report.counts.queueDropped++;
      }
    }

    let queueList = [...queue.values()];

    if (queueList.length > MAX_QUEUE) {
      queueList = queueList.sort((a, b) => String(b.firstSeenAt).localeCompare(String(a.firstSeenAt))).slice(0, MAX_QUEUE);
      report.notes.push(`queue exceeded ${MAX_QUEUE} items; the oldest were dropped, so this scan is not complete`);
      report.completeness.complete = false;
      report.completeness.stopReason = "queue-overflow";
      report.status = "partial";
    }

    next.queue = queueList;
    report.queueSize = queueList.length;
    report.review = cap(reviewList);
    report.announcements = cap(report.announcements);
    report.api.unitsUsed = client.usage.units;
    report.api.requests = client.usage.requests;
    report.api.failures = client.usage.failures.slice(0, 20).map((item) => ({ endpoint: item.endpoint, kind: item.kind, status: item.status, reason: short(item.reason, 80) }));

    return { state: next, report: settle(report, addedByDiscovery, null, acceptedGroups, fatal) };
  }

  return { skipped: null, groups: built.groups, availabilityUpdates: availability, nextState: next, report, finalize };
}

/* Precise zero-add reason for discovery's own additions. */
function settle(report, addedByDiscovery, skipReason, acceptedGroups = 0, fatal = null) {
  if (addedByDiscovery > 0) {
    report.zeroAddReasonCode = null;
    report.zeroAddReason = null;
    return report;
  }

  let code;

  if (skipReason) code = skipReason;
  else if (fatal === "quota-exhausted") code = "quota-exhausted";
  else if (fatal === "auth-error") code = "auth-error";
  else if (report.status === "failed") code = "api-error";
  else if (report.status === "partial") code = report.api.failures.length ? "api-error" : "incomplete-scan";
  else if (report.counts.tamilDubPrefixed === 0) code = "no-tamil-evidence";
  else if (acceptedGroups > 0) code = "all-known";
  else if (report.counts.review + report.counts.deferred > 0) code = "needs-review";
  else code = "no-episode-evidence";

  report.zeroAddReasonCode = code;
  report.zeroAddReason = ZERO_ADD_TEXT[code];
  return report;
}

module.exports = { startDiscovery, readDiscoveryConfig, normalizeDiscoveryConfig, ZERO_ADD_TEXT, DEFAULTS };
