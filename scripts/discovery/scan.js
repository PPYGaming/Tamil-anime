"use strict";

/*
 * Checkpointed scan of one official channel's uploads playlist.
 *
 * Two passes per run, newest upload first (the uploads playlist is reverse-chronological):
 *   A. incremental: from the newest page back to (highWaterMark - overlap). The overlap re-reads recent uploads so
 *      delayed additions and edits are caught. The high-water mark only moves when the pass really reached its
 *      boundary, so a failed or budget-limited pass is simply repeated next run.
 *   B. bootstrap: walks the whole history page by page. The cursor (nextPageToken) advances only AFTER a page's
 *      videos were fetched, verified and collected. A failure leaves the cursor on the failed page.
 *
 * Ownership: every candidate comes from videos.list and must carry snippet.channelId equal to the allow-listed
 * channel. Playlist membership or a title alone is never enough. Only titles that start with "Tamil Dub" are kept;
 * every other video is counted and dropped.
 */

const { startsWithTamilDub } = require("./title");
const { emptyChannelState } = require("./state");

const HOUR_MS = 3600 * 1000;

const STOP_BY_KIND = {
  quota: "quota-exhausted",
  auth: "auth-error",
  budget: "unit-budget-reached",
  "bad-page-token": "page-token-reset"
};

const toMs = (value) => {
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
};

function pageTimes(page) {
  const times = page.items.map((item) => toMs(item.publishedAt) ?? toMs(item.addedAt)).filter((value) => value !== null);
  return times.length ? { newest: Math.max(...times), oldest: Math.min(...times) } : { newest: null, oldest: null };
}

async function scanChannel({ client, channelId, chState, cfg, nowIso, nowMs }) {
  const result = {
    channelId,
    channelTitle: "",
    status: "failed",
    stopReason: null,
    fatal: false,
    pages: 0,
    videosSeen: 0,
    excludedNotTamilDub: 0,
    foreignChannel: 0,
    notReturned: 0, // listed in the playlist but not returned by videos.list: deleted, private or hidden
    candidates: new Map(),
    notReturnedRecent: [],
    notes: [],
    errors: [],
    incrementalComplete: false,
    bootstrapComplete: chState.bootstrap.complete
  };

  const stop = (reason, error) => {
    result.stopReason = reason;
    if (error) result.errors.push({ endpoint: error.endpoint || "", kind: error.kind || "unknown", status: error.status ?? null, reason: error.reason || "" });
    if (error && ["quota", "auth", "budget"].includes(error.kind)) result.fatal = true;
    result.status = result.pages > 0 ? "partial" : "failed";
    chState.lastScanAt = nowIso;
    return result;
  };

  const stopForError = (error) => stop(STOP_BY_KIND[error.kind] || "api-error", error);

  /* 1. The channel must really be the allow-listed one. */
  let channel;

  try {
    channel = await client.getChannel(channelId);
  } catch (error) {
    return stopForError(error);
  }

  if (!channel) return stop("channel-not-found");
  if (channel.id !== channelId) return stop("channel-mismatch");
  if (!channel.uploadsPlaylistId) return stop("no-uploads-playlist");

  result.channelTitle = channel.title;

  if ((chState.uploadsPlaylistId && chState.uploadsPlaylistId !== channel.uploadsPlaylistId) || cfg.fullRescan) {
    Object.assign(chState, emptyChannelState());
    result.bootstrapComplete = false;
    result.notes.push(cfg.fullRescan ? "full-rescan-requested" : "uploads-playlist-changed");
  }

  chState.uploadsPlaylistId = channel.uploadsPlaylistId;
  const playlistId = channel.uploadsPlaylistId;

  /* One page: fetch + verify + collect. Throws before touching anything if the API fails. */
  async function processPage(page) {
    const found = page.items.length ? await client.getVideos(page.items.map((item) => item.videoId)) : new Map();
    const seen = new Set();

    for (const item of page.items) {
      if (seen.has(item.videoId)) continue;
      seen.add(item.videoId);
      result.videosSeen++;

      const video = found.get(item.videoId);

      if (!video) {
        result.notReturned++;
        const added = toMs(item.addedAt);
        if (added !== null && nowMs - added <= cfg.unavailableRetryDays * 24 * HOUR_MS && result.notReturnedRecent.length < 200) {
          result.notReturnedRecent.push({ videoId: item.videoId, addedAt: item.addedAt });
        }
        continue;
      }

      if (video.channelId !== channelId) {
        result.foreignChannel++;
        continue;
      }

      if (!startsWithTamilDub(video.title)) {
        result.excludedNotTamilDub++;
        continue;
      }

      result.candidates.set(video.videoId, video);
    }
  }

  /* 2. Pass A: incremental, newest page first. */
  const markMs = toMs(chState.incremental.highWaterMark);
  const overlapMs = cfg.overlapHours * HOUR_MS;
  let token = null;
  let headNewest = null;
  let reachedBoundary = false;
  let pagesA = 0;

  while (pagesA < cfg.incrementalPageBudget) {
    let page;

    try {
      page = await client.listUploads(playlistId, token);
      await processPage(page);
    } catch (error) {
      return stopForError(error);
    }

    pagesA++;
    result.pages++;

    const times = pageTimes(page);
    if (times.newest !== null) headNewest = Math.max(headNewest ?? 0, times.newest);

    if (!chState.bootstrap.started) {
      // Very first scan: this newest page is done; the bootstrap pass continues right after it.
      chState.bootstrap.started = true;
      chState.bootstrap.startedAt = nowIso;
      chState.bootstrap.nextPageToken = page.nextPageToken;
      chState.bootstrap.pagesProcessed = 1;
      reachedBoundary = true;
      break;
    }

    if (!page.nextPageToken) {
      reachedBoundary = true; // reached the oldest upload
      break;
    }

    if (markMs === null) {
      reachedBoundary = true; // no mark yet: the bootstrap pass owns the history
      break;
    }

    if (times.oldest !== null && times.oldest < markMs - overlapMs) {
      reachedBoundary = true;
      break;
    }

    token = page.nextPageToken;
  }

  result.incrementalComplete = reachedBoundary;

  if (reachedBoundary && headNewest !== null) {
    chState.incremental.highWaterMark = new Date(Math.max(markMs ?? 0, headNewest)).toISOString();
  }

  /* 3. Pass B: bootstrap through history, resumable. */
  if (!chState.bootstrap.complete && chState.bootstrap.started) {
    let pagesB = 0;

    while (pagesB < cfg.bootstrapPageBudget) {
      const resume = chState.bootstrap.nextPageToken;

      if (!resume) {
        chState.bootstrap.complete = true;
        chState.bootstrap.completedAt = nowIso;
        break;
      }

      let page;

      try {
        page = await client.listUploads(playlistId, resume);
        await processPage(page);
      } catch (error) {
        if (error.kind === "bad-page-token") {
          // The saved cursor is no longer valid. Start the history walk over; merges are idempotent.
          Object.assign(chState.bootstrap, emptyChannelState().bootstrap);
          result.notes.push("bootstrap-cursor-reset");
        }
        result.bootstrapComplete = chState.bootstrap.complete;
        return stopForError(error);
      }

      chState.bootstrap.nextPageToken = page.nextPageToken;
      chState.bootstrap.pagesProcessed++;
      pagesB++;
      result.pages++;

      if (!page.nextPageToken) {
        chState.bootstrap.complete = true;
        chState.bootstrap.completedAt = nowIso;
        break;
      }
    }
  }

  result.bootstrapComplete = chState.bootstrap.complete;
  chState.lastScanAt = nowIso;

  if (result.bootstrapComplete && result.incrementalComplete) {
    result.status = "complete";
    chState.lastCompleteScanAt = nowIso;
  } else {
    result.status = "partial";
    result.stopReason = result.stopReason || "page-budget-reached";
  }

  return result;
}

module.exports = { scanChannel };
