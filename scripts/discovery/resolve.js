"use strict";

/*
 * Series and season resolution for a Tamil-Dub episode candidate. Conservative on purpose:
 *
 *  - A series is identified only by an EXACT normalised title match, first against series the catalog already
 *    knows (they carry a TMDB identity), then against a TMDB search. TMDB search results are suggestions: a result
 *    resolves only when it is the single exact-title match that is Japanese animation. Fuzzy matches go to review.
 *  - A season is explicit in the video title or it is not known. A missing season is never assumed to be season 1.
 *    The one exception is a FACT, not a guess: TMDB lists exactly one regular season for the series.
 *  - TMDB never proves Tamil audio here; it only names the series. The Tamil evidence is the official video.
 *
 * Network access goes through the injected `tmdb` adapter, so tests need no network and a missing key degrades to
 * "catalog-known series with an explicit season only".
 */

const ANIMATION_GENRE_ID = 16;

const SEASON_SUFFIX = /\s+(?:season\s*\d+|s\d+|\d+(?:st|nd|rd|th)\s+season)\s*$/iu;

function createSeriesResolver({ anime, tmdb, helpers }) {
  const { normalizeTitle, recordTmdbKey } = helpers;
  const stripSeason = (normalized) => normalized.replace(/\s+(?:season\s*\d+|s\d+|\d+(?:st|nd|rd|th)\s+season)$/u, "").trim();
  const nameKey = (value) => stripSeason(normalizeTitle(value));

  /* ---- catalog index: name -> series the catalog already knows --------------------------------------------- */
  const byName = new Map();

  for (const record of anime) {
    if (!record || typeof record !== "object") continue;

    const key = recordTmdbKey(record);
    const names = [record.title, record.originalTitle, ...(Array.isArray(record.aliases) ? record.aliases : [])];

    for (const name of names) {
      const normalized = nameKey(name);
      if (!normalized) continue;

      if (!byName.has(normalized)) byName.set(normalized, { keys: new Map(), withoutTmdb: new Set() });
      const slot = byName.get(normalized);

      if (key) {
        if (!slot.keys.has(key)) slot.keys.set(key, record);
      } else slot.withoutTmdb.add(String(record.id));
    }
  }

  const memo = new Map();

  async function searchTmdb(name, yearHint) {
    const normalized = normalizeTitle(name);
    const stripped = stripSeason(normalized);
    const result = await tmdb.search(name);

    if (result.status !== "ok") return { status: "deferred", reason: "TMDB search failed; will retry next run" };

    const exact = result.results.filter((item) => [item.name, item.originalName].some((candidate) => normalizeTitle(candidate) === normalized || nameKey(candidate) === stripped));
    const animated = exact.filter((item) => item.genreIds.includes(ANIMATION_GENRE_ID) && (item.originCountry.includes("JP") || item.originalLanguage === "ja"));

    let pool = animated;
    if (pool.length > 1 && yearHint) pool = pool.filter((item) => item.firstAirYear === yearHint);

    if (pool.length === 1) {
      const item = pool[0];
      return { status: "hit", series: { key: `tv:${item.id}`, tmdbId: item.id, title: item.name, originalTitle: item.originalName, year: item.firstAirYear, source: "tmdb-search", matchedName: name } };
    }

    if (pool.length > 1) {
      return { status: "review", reason: `several TMDB series share the exact title "${name}" (${pool.slice(0, 3).map((item) => `#${item.id} ${item.firstAirYear || "?"}`).join(", ")}); add the series to the manifest or catalog to disambiguate` };
    }

    if (exact.length) return { status: "review", reason: `TMDB has an exact title "${name}" but not as Japanese animation; not auto-added` };

    const hints = result.results.slice(0, 3).map((item) => `#${item.id} "${item.name}"${item.firstAirYear ? ` (${item.firstAirYear})` : ""}`);
    return { status: "review", reason: `no exact TMDB title match for "${name}"${hints.length ? ` (fuzzy suggestions only: ${hints.join(", ")})` : ""}` };
  }

  async function resolveName(name, yearHint) {
    const normalized = nameKey(name);
    const cacheKey = `${normalized}|${yearHint || ""}`;
    if (memo.has(cacheKey)) return memo.get(cacheKey);

    let outcome;
    const known = byName.get(normalized);

    if (known && known.keys.size > 1) {
      outcome = { status: "review", reason: `"${name}" matches catalog records for different TMDB series (${[...known.keys.keys()].join(", ")})` };
    } else if (known && known.keys.size === 1) {
      const [key, record] = [...known.keys.entries()][0];

      outcome = key.startsWith("tv:")
        ? {
            status: "hit",
            series: {
              key,
              tmdbId: Number(key.slice(3)),
              title: String(record.title || name).replace(SEASON_SUFFIX, "").trim(),
              originalTitle: String(record.originalTitle || ""),
              year: null,
              source: "catalog",
              matchedName: name
            }
          }
        : { status: "review", reason: `"${name}" matches a catalog movie record; movies are not auto-added` };
    } else if (known && known.withoutTmdb.size) {
      outcome = { status: "review", reason: `"${name}" matches existing catalog record(s) ${[...known.withoutTmdb].join(", ")} that have no TMDB identity; set tmdbId on the record or seed it in the manifest` };
    } else if (!tmdb.enabled) {
      outcome = { status: "review", reason: `"${name}" is not a series the catalog already knows and TMDB_API_KEY is not set, so the series cannot be identified` };
    } else {
      outcome = await searchTmdb(name, yearHint);
    }

    memo.set(cacheKey, outcome);
    return outcome;
  }

  const regularSeasons = (details) => (Array.isArray(details && details.seasons) ? details.seasons.filter((item) => item && Number.isInteger(item.season_number) && item.season_number >= 1) : []);

  /*
   * resolve(parsed) ->
   *   { status: "resolved", series, season, numberingSeason, seasonSource, details }
   *   { status: "review" | "deferred", reason }
   * season is the entry's tmdbSeason (null = series-level entry); numberingSeason is the "<season>-<episode>" prefix.
   */
  async function resolve(parsed) {
    if (!parsed.nameCandidates.length) return { status: "review", reason: "no series name could be read from the title" };

    const hits = new Map();
    const reviews = [];
    let deferredReason = null;

    for (const name of parsed.nameCandidates) {
      const outcome = await resolveName(name, parsed.yearHint);

      if (outcome.status === "hit") hits.set(outcome.series.key, outcome.series);
      else if (outcome.status === "deferred") deferredReason = outcome.reason;
      else reviews.push(outcome.reason);
    }

    if (hits.size > 1) return { status: "review", reason: `title segments match different series (${[...hits.keys()].join(", ")})` };

    if (hits.size === 0) {
      if (deferredReason) return { status: "deferred", reason: deferredReason };
      return { status: "review", reason: reviews[0] || "series could not be identified" };
    }

    const series = [...hits.values()][0];

    // Details are only needed to validate a season, or to learn the season when the title has none.
    let details = null;
    let detailsStatus = "disabled";

    if (tmdb.enabled) {
      const lookup = await tmdb.details("tv", series.tmdbId);
      detailsStatus = lookup.status;
      details = lookup.status === "ok" ? lookup.details : null;
    }

    if (details) {
      if (!series.year && details.first_air_date) series.year = Number(String(details.first_air_date).slice(0, 4)) || null;
      if (!series.originalTitle && details.original_name) series.originalTitle = String(details.original_name);
    }

    const seasons = regularSeasons(details);
    const episode = parsed.episode;

    if (parsed.season !== null) {
      if (details && seasons.length && !seasons.some((item) => item.season_number === parsed.season)) {
        return { status: "review", reason: `TMDB lists no season ${parsed.season} for "${series.title}" (seasons: ${seasons.map((item) => item.season_number).join(", ")})` };
      }

      const info = seasons.find((item) => item.season_number === parsed.season);
      const ongoing = details && details.status === "Returning Series" && seasons.length && parsed.season === Math.max(...seasons.map((item) => item.season_number));

      if (info && info.episode_count > 0 && episode > info.episode_count && !ongoing) {
        return { status: "review", reason: `episode ${episode} is beyond TMDB's ${info.episode_count} episodes for "${series.title}" season ${parsed.season}; the title may use absolute numbering` };
      }

      return { status: "resolved", series, season: parsed.season, numberingSeason: parsed.season, seasonSource: "explicit-in-title", details };
    }

    // No explicit season. Only a TMDB fact (exactly one regular season) can supply it; nothing is guessed.
    if (detailsStatus === "disabled") return { status: "review", reason: `title has no season and TMDB_API_KEY is not set, so the season of "${series.title}" cannot be established` };
    if (detailsStatus !== "ok") return { status: "deferred", reason: `TMDB details for "${series.title}" could not be fetched; season unknown, will retry next run` };

    if (seasons.length === 1) {
      const info = seasons[0];
      const ongoing = details.status === "Returning Series";

      if (info.episode_count > 0 && episode > info.episode_count && !ongoing) {
        return { status: "review", reason: `episode ${episode} is beyond TMDB's ${info.episode_count} episodes for "${series.title}"` };
      }

      return { status: "resolved", series, season: null, numberingSeason: info.season_number, seasonSource: "tmdb-single-regular-season", details };
    }

    return { status: "review", reason: `title has no season and TMDB lists ${seasons.length} regular seasons for "${series.title}"; the season is not guessed` };
  }

  return { resolve };
}

module.exports = { createSeriesResolver, ANIMATION_GENRE_ID };
