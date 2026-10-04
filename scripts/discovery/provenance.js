"use strict";

/*
 * Per-video provenance stored on a catalog record as `discoveryProvenance`: the raw title and description, exact video
 * ID, the channel the API reported, the language proof, the evidence URL and scan time. It sits NEXT TO the existing
 * verification fields and never replaces them.
 *
 * Merge rules: rows are appended by video ID; an existing row is only ever changed in `availability`/`checkedAt`, and
 * only when the observed availability actually changed. A video turning private, region-blocked, retitled or deleted
 * is recorded here and nowhere else: the anime record, its verification and its episode links stay as they were.
 */

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const clean = (value, max) => String(value === undefined || value === null ? "" : value).replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, max);
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const CHANNEL_ID = /^UC[A-Za-z0-9_-]{22}$/;
const AVAILABILITY = new Set(["public", "not-public", "region-blocked", "unavailable", "title-changed"]);
const MAX_ROWS = 500;

function sanitizeRow(raw) {
  if (!isObject(raw) || !VIDEO_ID.test(String(raw.videoId)) || !CHANNEL_ID.test(String(raw.channelId))) return null;

  const series = isObject(raw.series) ? raw.series : {};
  const number = (value, min, max) => (Number.isInteger(value) && value >= min && value <= max ? value : null);

  return {
    videoId: raw.videoId,
    channelId: raw.channelId,
    evidenceUrl: `https://www.youtube.com/watch?v=${raw.videoId}`, // always rebuilt from the video ID
    rawTitle: clean(raw.rawTitle, 300),
    rawDescription: clean(raw.rawDescription, 600),
    languageProof: clean(raw.languageProof, 120),
    publishedAt: clean(raw.publishedAt, 40),
    durationSeconds: Number.isFinite(raw.durationSeconds) ? raw.durationSeconds : null,
    kind: "episode",
    season: number(raw.season, 1, 99),
    seasonSource: clean(raw.seasonSource, 40),
    episode: number(raw.episode, 1, 9999),
    episodeNumber: clean(raw.episodeNumber, 20),
    series: { tmdbId: number(series.tmdbId, 1, 1e9), source: clean(series.source, 30), matchedName: clean(series.matchedName, 120) },
    availability: AVAILABILITY.has(raw.availability) ? raw.availability : "public",
    scannedAt: clean(raw.scannedAt, 40),
    checkedAt: clean(raw.checkedAt, 40)
  };
}

function sanitizeProvenance(list) {
  const seen = new Set();
  const rows = [];

  for (const item of Array.isArray(list) ? list : []) {
    const row = sanitizeRow(item);
    if (!row || seen.has(row.videoId)) continue;
    seen.add(row.videoId);
    rows.push(row);
    if (rows.length >= MAX_ROWS) break;
  }

  return rows;
}

function mergeProvenance(target, incoming) {
  if (!Array.isArray(incoming) || !incoming.length) return false;

  if (target.discoveryProvenance === undefined || target.discoveryProvenance === null) target.discoveryProvenance = [];
  else if (!Array.isArray(target.discoveryProvenance)) return false; // a foreign value is never clobbered

  let changed = false;

  for (const row of incoming) {
    const existing = target.discoveryProvenance.find((item) => isObject(item) && item.videoId === row.videoId);

    if (!existing) {
      if (target.discoveryProvenance.length >= MAX_ROWS) continue;
      target.discoveryProvenance.push(structuredClone(row));
      changed = true;
    } else if (row.availability && existing.availability !== row.availability) {
      existing.availability = row.availability;
      existing.checkedAt = row.checkedAt;
      changed = true;
    }
  }

  if (!changed && target.discoveryProvenance.length === 0) delete target.discoveryProvenance;
  return changed;
}

/* updates: Map(videoId -> { availability, checkedAt }). Returns true when any row changed. */
function applyAvailability(record, updates) {
  if (!isObject(record) || !Array.isArray(record.discoveryProvenance) || !updates || !updates.size) return false;

  let changed = false;

  for (const row of record.discoveryProvenance) {
    const update = isObject(row) ? updates.get(row.videoId) : null;

    if (update && AVAILABILITY.has(update.availability) && row.availability !== update.availability) {
      row.availability = update.availability;
      row.checkedAt = update.checkedAt;
      changed = true;
    }
  }

  return changed;
}

/* Rows the availability recheck can walk over. */
function provenanceRows(anime) {
  const rows = [];

  for (const record of anime) {
    if (!isObject(record) || !Array.isArray(record.discoveryProvenance)) continue;
    for (const row of record.discoveryProvenance) if (isObject(row) && VIDEO_ID.test(String(row.videoId))) rows.push({ videoId: row.videoId });
  }

  return rows;
}

module.exports = { sanitizeProvenance, mergeProvenance, applyAvailability, provenanceRows };
