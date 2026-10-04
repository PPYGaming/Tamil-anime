"use strict";

/*
 * Discovery checkpoint state (data/discovery-state.json). Public-safe: channel IDs, playlist IDs, page cursors,
 * and a bounded queue of video snapshots that still need a decision. No keys, no credentials.
 *
 * The state is written together with the catalog, AFTER the catalog write succeeds (see update-anime.js). A page
 * checkpoint therefore never gets ahead of the records that came from it; a crash in between only means the next
 * run repeats some pages, and every merge is idempotent.
 */

const STATE_VERSION = 1;
const MAX_QUEUE = 1000;

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const text = (value, max = 300) => String(value === undefined || value === null ? "" : value).replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, max);

function emptyChannelState() {
  return {
    uploadsPlaylistId: "",
    bootstrap: { complete: false, started: false, nextPageToken: null, pagesProcessed: 0, startedAt: null, completedAt: null },
    incremental: { highWaterMark: null },
    lastScanAt: null,
    lastCompleteScanAt: null
  };
}

function emptyState() {
  return { version: STATE_VERSION, channels: {}, queue: [], recheckCursor: "" };
}

function normalizeSnapshot(raw) {
  const snapshot = isObject(raw) ? raw : {};
  const restriction = isObject(snapshot.regionRestriction) ? snapshot.regionRestriction : null;

  return {
    title: text(snapshot.title),
    description: text(snapshot.description, 600),
    publishedAt: text(snapshot.publishedAt, 40),
    durationSeconds: Number.isFinite(snapshot.durationSeconds) ? snapshot.durationSeconds : null,
    privacyStatus: text(snapshot.privacyStatus, 20),
    uploadStatus: text(snapshot.uploadStatus, 20),
    liveBroadcastContent: text(snapshot.liveBroadcastContent, 20) || "none",
    defaultLanguage: text(snapshot.defaultLanguage, 20),
    defaultAudioLanguage: text(snapshot.defaultAudioLanguage, 20),
    regionRestriction: restriction
      ? {
          ...(Array.isArray(restriction.allowed) ? { allowed: restriction.allowed.filter((code) => /^[A-Z]{2}$/.test(code)) } : {}),
          ...(Array.isArray(restriction.blocked) ? { blocked: restriction.blocked.filter((code) => /^[A-Z]{2}$/.test(code)) } : {})
        }
      : null
  };
}

function normalizeQueueItem(raw) {
  if (!isObject(raw) || !/^[A-Za-z0-9_-]{11}$/.test(String(raw.videoId))) return null;

  const status = ["review", "deferred", "unavailable"].includes(raw.status) ? raw.status : "review";

  return {
    videoId: raw.videoId,
    channelId: text(raw.channelId, 40),
    status,
    reason: text(raw.reason, 300),
    firstSeenAt: text(raw.firstSeenAt, 40),
    lastTriedAt: text(raw.lastTriedAt, 40),
    attempts: Number.isInteger(raw.attempts) && raw.attempts >= 0 ? raw.attempts : 0,
    snapshot: normalizeSnapshot(raw.snapshot)
  };
}

function normalizeChannelState(raw) {
  const base = emptyChannelState();
  if (!isObject(raw)) return base;

  const boot = isObject(raw.bootstrap) ? raw.bootstrap : {};
  const incremental = isObject(raw.incremental) ? raw.incremental : {};

  return {
    uploadsPlaylistId: /^[A-Za-z0-9_-]{10,64}$/.test(String(raw.uploadsPlaylistId || "")) ? raw.uploadsPlaylistId : "",
    bootstrap: {
      complete: boot.complete === true,
      started: boot.started === true,
      nextPageToken: typeof boot.nextPageToken === "string" && boot.nextPageToken.length <= 512 ? boot.nextPageToken : null,
      pagesProcessed: Number.isInteger(boot.pagesProcessed) && boot.pagesProcessed >= 0 ? boot.pagesProcessed : 0,
      startedAt: text(boot.startedAt, 40) || null,
      completedAt: text(boot.completedAt, 40) || null
    },
    incremental: { highWaterMark: Number.isNaN(Date.parse(incremental.highWaterMark)) ? null : text(incremental.highWaterMark, 40) },
    lastScanAt: text(raw.lastScanAt, 40) || null,
    lastCompleteScanAt: text(raw.lastCompleteScanAt, 40) || null
  };
}

/* Never throws: unreadable state means "start over", which is safe because every merge is idempotent. */
function parseState(rawText) {
  if (rawText === null || rawText === undefined) return { state: emptyState(), problem: null, existed: false };

  let parsed;

  try {
    parsed = JSON.parse(String(rawText).replace(/^﻿/, ""));
  } catch {
    return { state: emptyState(), problem: "state file is not valid JSON; discovery restarts from the newest upload", existed: true };
  }

  if (!isObject(parsed) || parsed.version !== STATE_VERSION) {
    return { state: emptyState(), problem: "state file has an unknown version; discovery restarts from the newest upload", existed: true };
  }

  const recheckCursor = /^[A-Za-z0-9_-]{11}$/.test(String(parsed.recheckCursor || "")) ? parsed.recheckCursor : "";

  const channels = {};

  if (isObject(parsed.channels)) {
    for (const [channelId, value] of Object.entries(parsed.channels)) {
      if (/^UC[A-Za-z0-9_-]{22}$/.test(channelId)) channels[channelId] = normalizeChannelState(value);
    }
  }

  const queue = (Array.isArray(parsed.queue) ? parsed.queue : []).map(normalizeQueueItem).filter(Boolean).slice(0, MAX_QUEUE);

  return { state: { version: STATE_VERSION, channels, queue, recheckCursor }, problem: null, existed: true };
}

const serializeState = (state) => ({
  version: STATE_VERSION,
  channels: Object.fromEntries(Object.entries(state.channels).sort(([a], [b]) => a.localeCompare(b))),
  queue: [...state.queue].sort((a, b) => a.videoId.localeCompare(b.videoId)),
  recheckCursor: state.recheckCursor || ""
});

module.exports = { STATE_VERSION, MAX_QUEUE, emptyState, emptyChannelState, parseState, serializeState, normalizeQueueItem, normalizeSnapshot };
