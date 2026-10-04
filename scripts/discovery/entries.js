"use strict";

/*
 * Turns resolved episode candidates into manifest-shaped entries that go through the SAME validation and merge path
 * as hand-written manifest records (validateEntry -> processEntry -> mergeRecord). Nothing here writes the manifest.
 *
 * Identity rules
 *   - Episodes are grouped by resolved TMDB series + season (series-level entries have season null).
 *   - A group reuses the id of the catalog record that already is that series/season, so a discovered episode
 *     backfills the existing record instead of creating a duplicate. That includes "legacy season 1" records that
 *     have no tmdbSeason of their own but are claimed by a manifest entry with an exact id and a season.
 *   - If an existing record shares the series but its season cannot be told, the group goes to review. Nothing is
 *     merged by guesswork.
 *   - Watch URLs are built only from the real video ID returned by the API.
 */

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const validSeason = (value) => (Number.isInteger(value) && value >= 1 && value <= 99 ? value : null);

const watchUrl = (videoId) => `https://www.youtube.com/watch?v=${videoId}`;
const seasonSuffix = (season) => (season === null ? "" : ` Season ${season}`);

/*
 * Which existing record (if any) is this series/season? "Existing" covers two places:
 *   - a catalog record, and
 *   - a manifest entry that has not been added to the catalog yet (its id is already claimed by the curator).
 * The second matters: a discovered episode of a series the manifest is about to append must reuse the manifest id.
 * Giving it a second id would make two entries describe one season, and the identity check would then hold back
 * BOTH of them, including the curated one.
 */
function findExistingIdentity({ anime, claims, key, season, helpers }) {
  const { recordTmdbKey } = helpers;
  const exact = [];
  const seriesLevel = [];
  const seasonOne = [];
  const unknownSeason = [];
  const seen = new Set();

  const place = ({ id, explicit, claim }) => {
    const claimed = claim && !claim.conflict ? claim.season : undefined; // undefined: no manifest claim; null: claimed as series-level
    const known = explicit !== null ? explicit : claimed;
    const item = { id: String(id) };

    if (season !== null) {
      if (known === season) exact.push(item);
      else if (known === undefined || known === null) unknownSeason.push(item); // shares the series, season cannot be told
    } else if (known === undefined || known === null) {
      seriesLevel.push(item);
    } else if (known === 1) {
      seasonOne.push(item);
    }
  };

  for (const record of anime) {
    if (!isObject(record) || recordTmdbKey(record) !== key) continue;

    seen.add(String(record.id));
    place({ id: record.id, explicit: validSeason(record.tmdbSeason), claim: claims ? claims.get(String(record.id)) : undefined });
  }

  if (claims) {
    for (const [id, claim] of claims) {
      if (seen.has(String(id)) || !claim || claim.conflict || claim.key !== key) continue;
      place({ id, explicit: null, claim });
    }
  }

  const ids = (list) => list.map((item) => item.id).join(", ");

  if (season !== null) {
    if (exact.length === 1) return { id: exact[0].id, season };
    if (exact.length > 1) return { problem: `several catalog records are this series' season ${season} (${ids(exact)}); resolve the duplicates manually` };

    if (unknownSeason.length) {
      return {
        problem:
          `existing record(s) ${ids(unknownSeason)} share this series but have no season identity, so season ${season} cannot be told apart from them; ` +
          "give the record a tmdbSeason (or a manifest entry with its id and tmdbSeason) and the episodes will be matched on the next run"
      };
    }

    return { id: null, season };
  }

  // Series-level group (the series has exactly one regular season on TMDB).
  if (seriesLevel.length === 1) return { id: seriesLevel[0].id, season: null };
  if (seriesLevel.length > 1) return { problem: `several series-level catalog records share this series (${ids(seriesLevel)}); resolve the duplicates manually` };
  if (seasonOne.length === 1) return { id: seasonOne[0].id, season: 1 };
  if (seasonOne.length > 1) return { problem: `several catalog records are this series' season 1 (${ids(seasonOne)}); resolve the duplicates manually` };

  return { id: null, season: null };
}

const earliest = (a, b) => {
  const left = Date.parse(a.video.publishedAt);
  const right = Date.parse(b.video.publishedAt);

  if (!Number.isNaN(left) && !Number.isNaN(right) && left !== right) return left - right;
  return a.video.videoId.localeCompare(b.video.videoId);
};

function provenanceRow(item, nowIso, episodeNumber) {
  const { video, assessment, resolution } = item;

  return {
    videoId: video.videoId,
    channelId: video.channelId,
    evidenceUrl: watchUrl(video.videoId),
    rawTitle: video.title,
    rawDescription: video.description,
    languageProof: `title begins with "${assessment.parsed.languageProof}"`,
    publishedAt: video.publishedAt,
    durationSeconds: video.durationSeconds,
    kind: "episode",
    season: resolution.season,
    seasonSource: resolution.seasonSource,
    episode: assessment.parsed.episode,
    episodeNumber,
    series: { tmdbId: resolution.series.tmdbId, source: resolution.series.source, matchedName: resolution.series.matchedName },
    availability: "public",
    scannedAt: nowIso,
    checkedAt: nowIso
  };
}

/*
 * items: [{ video, assessment, resolution }] with resolution.status === "resolved".
 * Returns { groups, unplaced } where each group is { label, raw, videoIds, duplicateVideoIds } and each unplaced item
 * is { videoIds, reason } (identity could not be settled safely).
 */
function buildGroups({ items, anime, claims, helpers, nowIso }) {
  const buckets = new Map();

  for (const item of items) {
    const bucketKey = `${item.resolution.series.key}|${item.resolution.season === null ? "series" : item.resolution.season}`;
    if (!buckets.has(bucketKey)) buckets.set(bucketKey, []);
    buckets.get(bucketKey).push(item);
  }

  const groups = [];
  const unplaced = [];
  const checkedAt = nowIso.slice(0, 10);

  for (const bucketKey of [...buckets.keys()].sort()) {
    const members = buckets.get(bucketKey);
    const { series, season: requestedSeason } = members[0].resolution;

    const existing = findExistingIdentity({ anime, claims, key: series.key, season: requestedSeason, helpers });

    if (existing.problem) {
      unplaced.push({ videoIds: members.map((item) => item.video.videoId), reason: existing.problem });
      continue;
    }

    const season = existing.season;

    // One winner per episode number: the earliest upload, ties broken by video ID, so reruns pick the same video.
    const byEpisode = new Map();

    for (const item of members) {
      const number = `${item.resolution.numberingSeason}-${item.assessment.parsed.episode}`;
      if (!byEpisode.has(number)) byEpisode.set(number, []);
      byEpisode.get(number).push(item);
    }

    const winners = [];
    const duplicates = [];

    for (const [number, list] of byEpisode) {
      const sorted = [...list].sort(earliest);
      winners.push({ number, item: sorted[0] });
      duplicates.push(...sorted.slice(1).map((item) => item.video.videoId));
    }

    winners.sort((a, b) => {
      const [as, ae] = a.number.split("-").map(Number);
      const [bs, be] = b.number.split("-").map(Number);
      return as - bs || ae - be;
    });

    const names = new Set([series.title, series.matchedName, series.originalTitle, ...members.map((item) => item.resolution.series.matchedName)].filter(Boolean));

    const raw = {
      origin: "discovery",
      inclusionSource: "youtube-official-channel-discovery",
      ...(existing.id ? { id: existing.id } : {}),
      title: `${series.title}${seasonSuffix(season)}`,
      originalTitle: series.originalTitle || "",
      aliases: [...names],
      mediaType: "tv",
      tmdbId: series.tmdbId,
      ...(season !== null ? { tmdbSeason: season } : {}),
      ...(season === null && series.year ? { year: series.year } : {}),
      tamilDubVerified: true,
      verification: winners.map(({ item }) => ({
        url: watchUrl(item.video.videoId),
        channelId: item.video.channelId,
        checkedAt,
        note: `Official channel video; its title begins with "${item.assessment.parsed.languageProof}" (YouTube channel and ownership confirmed through the API).`
      })),
      episodes: winners.map(({ number, item }) => ({ number, url: watchUrl(item.video.videoId) })),
      provenance: winners.map(({ number, item }) => provenanceRow(item, nowIso, number))
    };

    groups.push({
      label: `${raw.title} (YouTube discovery, tmdb ${series.tmdbId})`,
      raw,
      videoIds: members.map((item) => item.video.videoId),
      duplicateVideoIds: duplicates
    });
  }

  return { groups, unplaced };
}

module.exports = { buildGroups, findExistingIdentity, watchUrl };
