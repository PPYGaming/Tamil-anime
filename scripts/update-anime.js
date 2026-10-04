"use strict";

/*
 * Tamil-dub anime catalog updater: ADD-ONLY, official-source manifest driven.
 *
 * INCLUSION: only titles listed in a checked-in manifest, each with
 * tamilDubVerified:true and an official-source URL (Muse India's official
 * YouTube channel/video, Crunchyroll, Netflix, Amazon Prime Video).
 * TMDB and YouTube search can NOT add titles or prove Tamil audio.
 * TMDB only fills MISSING artwork/rating/dates/metadata on verified titles.
 *
 * Manifest (default data/official-tamil-dub-manifest.json):
 * {
 *   "version": 1, "updatedAt": "2026-09-30",
 *   "officialYouTubeChannels": [{ "name": "Muse India", "channelId": "UC..." }],
 *   "entries": [{
 *     "title": "Example", "tamilDubVerified": true,
 *     "verification": { "url": "https://www.crunchyroll.com/series/ID/slug",
 *                       "checkedAt": "2026-09-30", "note": "Tamil in audio list",
 *                       "channelId": "UC..." },   // channelId: YouTube evidence only
 *     "tmdbId": 12345, "mediaType": "tv",          // optional (enables enrichment)
 *     "tmdbSeason": 2,                             // optional, TV only: this entry is ONE season of tmdbId
 *     "year": 2005,                                // or "firstAirDate": "2005-04-01"
 *     "id": "optional-explicit-id", "originalTitle": "", "aliases": [],
 *     "description": "", "image": "", "tags": []
 *   }]
 * }
 *
 * Optional curated entry fields (they never add a title and never prove Tamil audio):
 *   "platforms": [{ "name": "Netflix", "available": true,
 *                   "officialUrl": "https://www.netflix.com/title/123456" }]
 *       name: Crunchyroll | Netflix | Amazon Prime Video. officialUrl must be that platform's own title
 *       page. The row means "available, no confirmed Tamil audio". Tamil proof only ever comes from
 *       "verification": a tamilDubVerified flag on a platforms row is ignored.
 *   "episodes": [{ "number": "1-1", "title": "Optional", "url": "https://www.crunchyroll.com/watch/ID/slug" }]
 *       url must be an official watch page (Crunchyroll /watch/, Netflix /watch/<id>, Prime Video detail,
 *       YouTube video) on a platform that already has Tamil proof in "verification" (YouTube: one of the
 *       verified videos). Otherwise the episode is kept without a link. Numbers merge into existing rows by
 *       exact match, so reuse the catalog's numbering (TMDB rows are "season-episode", e.g. "1-1");
 *       an unknown number is appended as a new row.
 *
 * Seasons (tmdbSeason). Several manifest entries may share one tmdbId (one per season). An entry with
 * tmdbSeason is matched ONLY by exact id or by media type + tmdbId + tmdbSeason, never by a shared TMDB
 * id, alias, original title or year, and different seasons never merge. Entries without tmdbSeason keep
 * the series-level matching. A season is never guessed: a missing tmdbSeason does not mean season 1.
 * Older catalog records have no tmdbSeason; their exact manifest id says which manifest entry (and so
 * which season) they belong to. That identity is used in memory only and is NOT written to those records.
 * For a season entry TMDB supplies only that season's episode rows (title/airDate, url always null) and
 * its air date; series-level poster/rating/tags are still used, the series first_air_date never is.
 *
 * Automatic discovery (opt-in: DISCOVERY_ENABLED=true; scripts/discovery/). With a YOUTUBE_API_KEY and an
 * allow-listed official channel ID (manifest officialYouTubeChannels, or OFFICIAL_YOUTUBE_CHANNEL_IDS) the
 * updater walks that channel's uploads, keeps ONLY videos whose title starts with "Tamil Dub" and whose API-reported
 * snippet.channelId is on the allow-list, resolves the series/season conservatively, and pushes the result through
 * the same validateEntry -> processEntry -> mergeRecord path as manifest entries. The manifest is never written.
 * Checkpoints live in DISCOVERY_STATE_FILE (default data/discovery-state.json), written after the catalog. TMDB
 * only names the series; it never proves Tamil audio. Unsettled videos stay in the state queue and are retried.
 *
 * Env: TMDB_API_KEY, YOUTUBE_API_KEY (both optional), CONTENT_REGION,
 * ANIME_DATA_FILE, OFFICIAL_MANIFEST_PATH, OFFICIAL_YOUTUBE_CHANNEL_IDS
 * (comma list), FAIL_ON_ZERO_ADD, DISCOVERY_ENABLED, DISCOVERY_STATE_FILE and the DISCOVERY_* limits documented in
 * scripts/discovery/index.js. API keys are read from the environment only.
 */

const fs = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
const { startDiscovery, readDiscoveryConfig } = require("./discovery");
const { parseState, serializeState } = require("./discovery/state");
const { sanitizeProvenance, mergeProvenance, applyAvailability, provenanceRows } = require("./discovery/provenance");

const USER_AGENT = "Tamil-Dub-Anime-Catalog/3.0";
const REQUIRED_PLATFORMS = ["Crunchyroll", "Netflix", "Amazon Prime Video"];
const PLACEHOLDER_DESCRIPTION = "No description available.";
const MAX_REPORT_ITEMS = 50;
const MAX_TAGS = 8;
const MAX_EPISODES = 200;
const MAX_SEASON = 99;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

const SOURCE_LABELS = {
  Crunchyroll: "Crunchyroll official listing/announcement",
  Netflix: "Netflix official listing/announcement",
  "Amazon Prime Video": "Amazon Prime Video official listing"
};

const RECORD_KEY_ORDER = [
  "id", "title", "originalTitle", "description", "image", "backdrop", "rating",
  "likes", "availability", "status", "firstAirDate", "createdAt", "updatedAt",
  "isNew", "tags", "numberOfSeasons", "numberOfEpisodes", "platforms", "episodes", "youtube", "tamilDubVerified",
  "tamilDubVerificationSource", "tamilDubVerificationUrl", "tamilDubVerifiedAt",
  "tamilDubEvidence", "discoveryProvenance", "inclusionSource", "tmdbId", "tmdbUrl", "tmdbSeason", "tmdbSeasonUrl",
  "mediaType", "region"
];

// TMDB may fill these, but only when missing/placeholder on a verified title.
const ENRICHABLE_KEYS = [
  "originalTitle", "description", "image", "backdrop", "rating",
  "status", "firstAirDate", "createdAt", "tags"
];

// Merged by dedicated logic instead of the generic fill-if-empty rule.
const SPECIAL_KEYS = new Set([
  "tamilDubVerified", "tamilDubVerificationSource", "tamilDubVerificationUrl",
  "tamilDubVerifiedAt", "tamilDubEvidence", "platforms", "discoveryProvenance",
  "tmdbId", "tmdbUrl", "mediaType", "tmdbSeason", "tmdbSeasonUrl"
]);

/* ------------------------------------------------------------------ */
/* Config, secrets, HTTP                                               */
/* ------------------------------------------------------------------ */

const secrets = new Set();

function readConfig(env = process.env) {
  const resolve = (value, fallback) => path.resolve(process.cwd(), value || fallback);

  return {
    catalogFile: resolve(env.ANIME_DATA_FILE, path.join("data", "anime.json")),
    manifestFile: resolve(
      env.OFFICIAL_MANIFEST_PATH,
      path.join("data", "official-tamil-dub-manifest.json")
    ),
    tmdbApiKey: env.TMDB_API_KEY || "",
    youtubeApiKey: env.YOUTUBE_API_KEY || "",
    region: env.CONTENT_REGION || "IN",
    extraChannelIds: String(env.OFFICIAL_YOUTUBE_CHANNEL_IDS || "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
    failOnZeroAdd: /^(1|true|yes)$/i.test(env.FAIL_ON_ZERO_ADD || ""),
    tmdbDelayMs: 120,
    discoveryStateFile: resolve(env.DISCOVERY_STATE_FILE, path.join("data", "discovery-state.json")),
    discovery: readDiscoveryConfig(env) // opt-in: enabled only by DISCOVERY_ENABLED=true
  };
}

function redact(message) {
  let text = String(message);
  for (const secret of secrets) text = text.split(secret).join("***");
  return text;
}

function errorMessage(error) {
  return redact(error && error.message ? error.message : error);
}

function sleep(ms) {
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
}

async function getJson(url, { retries = 2, timeoutMs = 20000 } = {}) {
  let lastError;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const response = await fetch(url, {
        headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
        signal: AbortSignal.timeout(timeoutMs)
      });

      if (!response.ok) {
        const text = await response.text().catch(() => "");
        const error = new Error(`HTTP ${response.status} ${response.statusText} - ${text.slice(0, 300)}`);
        error.status = response.status;
        error.retryable = response.status === 429 || response.status >= 500;
        throw error;
      }

      return await response.json();
    } catch (error) {
      lastError = error;
      if (error.retryable === false || attempt === retries) break;
      await sleep(500 * 2 ** attempt);
    }
  }

  throw lastError;
}

function tmdbUrl(apiKey, endpoint, params = {}) {
  const url = new URL(`https://api.themoviedb.org/3${endpoint}`);
  url.searchParams.set("api_key", apiKey);

  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(key, value);
    }
  }

  return url.toString();
}

/* ------------------------------------------------------------------ */
/* Generic helpers                                                     */
/* ------------------------------------------------------------------ */

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function cleanText(value) {
  return String(value === undefined || value === null ? "" : value).replace(/\s+/g, " ").trim();
}

function isEmptyValue(value) {
  if (value === null || value === undefined) return true;
  if (typeof value === "string") return value.trim() === "";
  if (Array.isArray(value)) return value.length === 0;
  if (isPlainObject(value)) return Object.keys(value).length === 0;
  return false; // numbers and booleans (0, false) are real values
}

function isPlaceholderValue(key, value) {
  if (key === "description") return cleanText(value) === PLACEHOLDER_DESCRIPTION;
  if (key === "tags") {
    return Array.isArray(value) && value.every((tag) => cleanText(tag).toLowerCase() === "anime");
  }
  return false;
}

function uniqueStrings(values) {
  const seen = new Set();
  const result = [];

  for (const value of values) {
    const text = cleanText(value);
    if (text && !seen.has(text.toLowerCase())) {
      seen.add(text.toLowerCase());
      result.push(text);
    }
  }

  return result;
}

function normalizeTitle(value) {
  return String(value === undefined || value === null ? "" : value)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "") // strip Latin accents only; keep Tamil/Japanese marks
    .normalize("NFKC")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^\p{L}\p{N}\p{M}]+/gu, " ")
    .trim();
}

function slugify(title) {
  const normalized = normalizeTitle(title);
  const ascii = normalized.replace(/\s+/g, "-");

  return ascii && /^[a-z0-9-]+$/.test(ascii)
    ? ascii.slice(0, 80)
    : crypto.createHash("sha1").update(normalized).digest("hex").slice(0, 12);
}

function yearOf(value) {
  const match = /^(\d{4})/.exec(cleanText(value));
  return match ? Number(match[1]) : null;
}

function recordYear(record) {
  return yearOf(record.firstAirDate) ?? yearOf(record.releaseDate) ?? yearOf(record.year);
}

// Bounded, single-line copy of external text for reports and logs.
function short(value, max) {
  return String(value === undefined || value === null ? "" : value).replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, max);
}

function isHttpsUrl(value) {
  try {
    const url = new URL(String(value));
    return url.protocol === "https:" && !url.username && !url.password;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ */
/* Official-source evidence                                            */
/* ------------------------------------------------------------------ */

const SEARCH_PARAMS = ["q", "query", "search_query", "phrase", "k", "keywords"];
const AMAZON_HOST = /^(?:www\.)?amazon\.(?:com|in|co\.uk|de|fr|es|it|ca|com\.au|co\.jp)$/;

function hostMatches(host, domain) {
  return host === domain || host.endsWith(`.${domain}`);
}

const PLATFORM_RULES = [
  {
    platform: "Crunchyroll",
    host: (h) => hostMatches(h, "crunchyroll.com"),
    page: (h, p) =>
      /^\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?(?:series|watch|news|movie)\/[^/]+/i.test(p) ||
      /^\/hc\/[^/]+\/articles\/[^/]+/i.test(p)
  },
  {
    platform: "Netflix",
    host: (h) => hostMatches(h, "netflix.com"),
    page: (h, p) =>
      /^\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?title\/\d+/i.test(p) ||
      /^\/tudum\/articles\//i.test(p) ||
      (h === "about.netflix.com" && /\/news\//i.test(p))
  },
  {
    platform: "Amazon Prime Video",
    host: (h) => hostMatches(h, "primevideo.com") || AMAZON_HOST.test(h),
    page: (h, p) =>
      hostMatches(h, "primevideo.com")
        ? /(^|\/)detail\/[A-Za-z0-9]+/.test(p)
        : /^\/gp\/video\/detail\/[A-Za-z0-9]+/.test(p)
  }
];

/*
 * Checks that a URL is the shape of an official, title-specific page on an
 * allow-listed platform. It does NOT fetch the page, so it cannot read the
 * audio-language list: that judgement stays with whoever curates the manifest.
 */
function classifyOfficialUrl(rawUrl) {
  const fail = (reason) => ({ ok: false, reason });
  let url;

  try {
    url = new URL(String(rawUrl === undefined ? "" : rawUrl).trim());
  } catch {
    return fail("verification URL is missing or not an absolute URL");
  }

  if (url.protocol !== "https:") return fail("verification URL must use https");
  if (url.username || url.password) return fail("verification URL must not contain credentials");

  url.hash = "";
  const host = url.hostname.toLowerCase();
  const pathname = url.pathname;

  if (
    /(^|\/)(search|results)(\/|$)/i.test(pathname) ||
    SEARCH_PARAMS.some((param) => url.searchParams.has(param))
  ) {
    return fail("search/browse URLs cannot prove Tamil audio or official ownership");
  }

  if (hostMatches(host, "youtube.com") || host === "youtu.be") {
    const videoId =
      host === "youtu.be"
        ? pathname.split("/")[1]
        : pathname === "/watch"
          ? url.searchParams.get("v")
          : null;

    return videoId && /^[A-Za-z0-9_-]{11}$/.test(videoId)
      ? { ok: true, platform: "YouTube", url: url.href, videoId }
      : fail("YouTube evidence must be a specific video URL (not search results or a channel page)");
  }

  const rule = PLATFORM_RULES.find((item) => item.host(host));
  if (!rule) return fail(`host "${host}" is not an allow-listed official source`);
  if (!rule.page(host, pathname)) return fail(`${rule.platform} URL must be a title or announcement page`);

  return { ok: true, platform: rule.platform, url: url.href };
}

function validateEvidence(raw, channels) {
  const fail = (reason) => ({ ok: false, reason });
  const item = typeof raw === "string" ? { url: raw } : raw;

  if (!isPlainObject(item)) return fail("verification must be a URL string or an object with a url");

  const classified = classifyOfficialUrl(item.url);
  if (!classified.ok) return classified;

  const evidence = {
    platform: classified.platform,
    url: classified.url,
    source: SOURCE_LABELS[classified.platform]
  };

  const checkedAt = cleanText(item.checkedAt);
  if (checkedAt) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(checkedAt)) return fail("checkedAt must be YYYY-MM-DD");
    evidence.checkedAt = checkedAt;
  }

  if (cleanText(item.note)) evidence.note = cleanText(item.note);

  if (classified.platform === "YouTube") {
    const channelId = cleanText(item.channelId);
    if (!channelId) return fail("YouTube evidence needs the official channelId");

    const channel = channels.get(channelId);
    if (!channel) return fail(`channelId ${channelId} is not in the official channel allow-list`);

    evidence.channelId = channelId;
    evidence.videoId = classified.videoId;
    evidence.source = `${channel.name} (YouTube)`;
  }

  return { ok: true, evidence };
}

/* ------------------------------------------------------------------ */
/* Optional curated fields: platform availability and episode links    */
/* ------------------------------------------------------------------ */

const LOCALE_SEGMENT = "(?:[a-z]{2}(?:-[a-z]{2})?\\/)?";

// Availability needs a title page and an episode link a watch page; classifyOfficialUrl is looser
// (it also accepts announcements). Prime Video detail pages serve as both.
const TITLE_PAGE = {
  Crunchyroll: new RegExp(`^\\/${LOCALE_SEGMENT}(?:series|movie)\\/[^/]+`, "i"),
  Netflix: new RegExp(`^\\/${LOCALE_SEGMENT}title\\/\\d+`, "i")
};

const EPISODE_PAGE = {
  Crunchyroll: new RegExp(`^\\/${LOCALE_SEGMENT}watch\\/[^/]+`, "i"),
  Netflix: new RegExp(`^\\/${LOCALE_SEGMENT}watch\\/\\d+`, "i")
};

// classifyOfficialUrl predates episode links and does not know Netflix /watch/<id> pages.
function netflixWatchUrl(rawUrl) {
  try {
    const url = new URL(cleanText(rawUrl));
    const ok =
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      hostMatches(url.hostname.toLowerCase(), "netflix.com") &&
      EPISODE_PAGE.Netflix.test(url.pathname) &&
      !SEARCH_PARAMS.some((param) => url.searchParams.has(param));

    url.hash = "";
    return ok ? url.href : null;
  } catch {
    return null;
  }
}

function classifyLink(rawUrl, kind) {
  if (kind === "episode") {
    const watch = netflixWatchUrl(rawUrl);
    if (watch) return { ok: true, platform: "Netflix", url: watch };
  }

  const result = classifyOfficialUrl(rawUrl);
  if (!result.ok) return result;

  if (result.platform === "YouTube") {
    return kind === "episode"
      ? result
      : { ok: false, reason: "YouTube availability comes from verification evidence, not from a platforms row" };
  }

  const rule = (kind === "title" ? TITLE_PAGE : EPISODE_PAGE)[result.platform];

  if (rule && !rule.test(new URL(result.url).pathname)) {
    return { ok: false, reason: `${result.platform} URL must be a ${kind === "title" ? "title" : "watch"} page` };
  }

  return result;
}

function parseCuratedPlatforms(raw, warnings) {
  if (raw === undefined || raw === null) return [];

  if (!Array.isArray(raw)) {
    warnings.push("platforms must be an array; ignored");
    return [];
  }

  const rows = [];

  for (const item of raw) {
    const given = cleanText(isPlainObject(item) ? item.name : item);
    const name = REQUIRED_PLATFORMS.find((known) => known.toLowerCase() === given.toLowerCase());

    if (!name) {
      warnings.push(`platforms: unknown platform "${given}" ignored`);
      continue;
    }

    if (item.available !== true) continue; // "not available" is already the default for every required platform

    if (rows.some((row) => row.name === name)) {
      warnings.push(`platforms: duplicate ${name} row ignored`);
      continue;
    }

    const link = classifyLink(item.officialUrl, "title");

    if (!link.ok || link.platform !== name) {
      warnings.push(`platforms: ${name} row ignored (${link.ok ? `officialUrl is a ${link.platform} URL` : link.reason})`);
      continue;
    }

    rows.push({ name, officialUrl: link.url, claimsTamil: item.tamilDubVerified === true });
  }

  return rows;
}

function parseCuratedEpisodes(raw, warnings) {
  if (raw === undefined || raw === null) return [];

  if (!Array.isArray(raw)) {
    warnings.push("episodes must be an array; ignored");
    return [];
  }

  const episodes = [];
  const seen = new Set();
  const counts = new Map(); // one note per kind of problem, not one per episode
  const note = (message) => counts.set(message, (counts.get(message) || 0) + 1);

  for (const item of raw) {
    if (episodes.length >= MAX_EPISODES) {
      warnings.push(`episodes: only the first ${MAX_EPISODES} are used`);
      break;
    }

    const numeric = isPlainObject(item) && (typeof item.number === "string" || Number.isFinite(item.number));
    const number = numeric ? cleanText(item.number).slice(0, 20) : "";

    if (!number) {
      note("episodes: item without a number ignored");
      continue;
    }

    if (seen.has(number)) {
      note("episodes: duplicate number ignored");
      continue;
    }

    seen.add(number);

    const episode = { number };
    const title = cleanText(item.title).slice(0, 200);
    if (title) episode.title = title;

    if (cleanText(item.url)) {
      const link = classifyLink(item.url, "episode");

      if (link.ok) {
        episode.url = link.url;
        episode.platform = link.platform;
        if (link.videoId) episode.videoId = link.videoId;
      } else {
        note(`episodes: link dropped (${link.reason})`);
      }
    }

    episodes.push(episode);
  }

  for (const [message, count] of counts) warnings.push(count > 1 ? `${message} x${count}` : message);

  return episodes;
}

// A link needs Tamil proof on its own platform; a YouTube link needs that exact video in the proof.
function episodeLinkAllowed(episode, evidence) {
  if (!episode.url) return false;

  return episode.platform === "YouTube"
    ? evidence.some((item) => item.platform === "YouTube" && item.videoId === episode.videoId)
    : evidence.some((item) => item.platform === episode.platform);
}

// With a YouTube key, confirms the video really belongs to the claimed channel.
async function confirmYouTubeEvidence(evidence, cfg) {
  if (evidence.platform !== "YouTube") return { ok: true };

  if (!cfg.youtubeApiKey) {
    evidence.channelCheck = "manifest-asserted";
    return { ok: true };
  }

  try {
    const url = new URL("https://www.googleapis.com/youtube/v3/videos");
    url.searchParams.set("key", cfg.youtubeApiKey);
    url.searchParams.set("part", "snippet");
    url.searchParams.set("id", evidence.videoId);

    const data = await getJson(url.toString());
    const item = Array.isArray(data.items) ? data.items[0] : null;

    if (!item || !item.snippet) {
      return { ok: false, reason: "YouTube video not found, private, or removed" };
    }

    if (item.snippet.channelId !== evidence.channelId) {
      return { ok: false, reason: "YouTube video belongs to a different channel than the manifest claims" };
    }

    evidence.channelCheck = "api-confirmed";
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      deferred: true,
      reason: `YouTube API check failed, will retry next run: ${errorMessage(error)}`
    };
  }
}

/* ------------------------------------------------------------------ */
/* Manifest                                                            */
/* ------------------------------------------------------------------ */

async function loadManifest(file) {
  let raw;

  try {
    raw = await fs.readFile(file, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") {
      return { found: false, entries: [], channels: [], version: null, updatedAt: null };
    }
    throw error;
  }

  let parsed;
  try {
    parsed = JSON.parse(raw.replace(/^\uFEFF/, ""));
  } catch (error) {
    throw new Error(`Manifest is not valid JSON (catalog left untouched): ${error.message}`);
  }

  const entries = Array.isArray(parsed) ? parsed : parsed && parsed.entries;
  if (!Array.isArray(entries)) {
    throw new Error("Manifest must be an array or an object with an 'entries' array.");
  }

  const meta = isPlainObject(parsed) ? parsed : {};
  const channels = [];

  for (const channel of Array.isArray(meta.officialYouTubeChannels) ? meta.officialYouTubeChannels : []) {
    const channelId = cleanText(channel && channel.channelId);

    if (/^UC[A-Za-z0-9_-]{22}$/.test(channelId)) {
      channels.push({ channelId, name: cleanText(channel.name) || "Official YouTube channel" });
    } else {
      console.warn(`Ignoring malformed officialYouTubeChannels entry: ${JSON.stringify(channel)}`);
    }
  }

  return {
    found: true,
    entries,
    channels,
    version: meta.version ?? null,
    updatedAt: cleanText(meta.updatedAt) || null
  };
}

function describeValue(value) {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

// options.discovery = true is passed by code only (never by manifest content): it lets the entry carry its origin,
// inclusion source and per-video provenance. A hand-written manifest entry cannot claim any of these.
function validateEntry(raw, channels, options = {}) {
  const reject = (reason) => ({ ok: false, reason });

  if (!isPlainObject(raw)) return reject("entry must be an object");

  const title = cleanText(raw.title);
  if (!title) return reject("missing title");
  if (raw.tamilDubVerified !== true) return reject("tamilDubVerified must be exactly true");

  const mediaType = raw.mediaType === undefined ? "tv" : String(raw.mediaType).toLowerCase();
  if (mediaType !== "tv" && mediaType !== "movie") return reject('mediaType must be "tv" or "movie"');

  let tmdbId = null;
  if (raw.tmdbId !== undefined && raw.tmdbId !== null && raw.tmdbId !== "") {
    tmdbId = Number(raw.tmdbId);
    if (!Number.isInteger(tmdbId) || tmdbId <= 0) return reject("tmdbId must be a positive integer");
  }

  // A season is only valid as a real JSON integer, only for TV, and only next to a tmdbId.
  // It is never inferred: no tmdbSeason means "series-level entry", not "season 1".
  let tmdbSeason = null;
  if (raw.tmdbSeason !== undefined && raw.tmdbSeason !== null && raw.tmdbSeason !== "") {
    if (mediaType !== "tv") return reject('tmdbSeason is only valid for TV entries (mediaType "tv")');

    if (typeof raw.tmdbSeason !== "number" || !Number.isInteger(raw.tmdbSeason) || raw.tmdbSeason < 1 || raw.tmdbSeason > MAX_SEASON) {
      return reject(`tmdbSeason must be an integer from 1 to ${MAX_SEASON} (got ${describeValue(raw.tmdbSeason)})`);
    }

    if (tmdbId === null) return reject("tmdbSeason needs a tmdbId (a season only means something for a TMDB series)");
    tmdbSeason = raw.tmdbSeason;
  }

  const firstAirDate = cleanText(raw.firstAirDate);
  if (firstAirDate && !/^\d{4}-\d{2}-\d{2}$/.test(firstAirDate)) {
    return reject("firstAirDate must be YYYY-MM-DD (use year for year-only)");
  }

  let year = yearOf(firstAirDate);
  if (year === null && raw.year !== undefined && raw.year !== null && raw.year !== "") {
    year = Number(raw.year);
    if (!Number.isInteger(year) || year < 1900 || year > 2100) return reject("year must be a 4-digit year");
  }

  const list = Array.isArray(raw.verification) ? raw.verification : raw.verification ? [raw.verification] : [];
  if (!list.length) return reject("missing verification (official-source URL)");

  const evidence = [];
  const problems = [];

  for (const item of list) {
    const result = validateEvidence(item, channels);

    if (!result.ok) problems.push(result.reason);
    else if (!evidence.some((existing) => existing.url === result.evidence.url)) evidence.push(result.evidence);
  }

  if (!evidence.length) return reject(`no acceptable official-source evidence: ${problems.join("; ")}`);

  // Optional curated fields. Problems only drop the offending row or link, never the entry.
  const warnings = [];
  const curatedPlatforms = parseCuratedPlatforms(raw.platforms, warnings);
  let episodes = parseCuratedEpisodes(raw.episodes, warnings);

  if (tmdbSeason !== null) {
    // Rows explicitly numbered for another season ("1-3" on a season-2 entry) would put the wrong
    // season's episodes (and links) on this record: drop them and say so.
    const foreign = episodes.filter((episode) => {
      const match = /^(\d+)-\d+$/.exec(episode.number);
      return match && Number(match[1]) !== tmdbSeason;
    });

    if (foreign.length) {
      episodes = episodes.filter((episode) => !foreign.includes(episode));
      warnings.push(`episodes: ${foreign.length} row(s) numbered for another season dropped (this entry is season ${tmdbSeason})`);
    }
  }

  for (const row of curatedPlatforms) {
    if (row.claimsTamil && !evidence.some((item) => item.platform === row.name)) {
      warnings.push(`platforms: tamilDubVerified on ${row.name} ignored (no official-source Tamil proof for it in verification)`);
    }
  }

  const unanchored = new Map();

  for (const episode of episodes) {
    if (episode.url && !episodeLinkAllowed(episode, evidence)) {
      unanchored.set(episode.platform, (unanchored.get(episode.platform) || 0) + 1);
    }
  }

  for (const [platform, count] of unanchored) {
    warnings.push(`episodes: ${count} ${platform} link(s) will be dropped (no matching Tamil proof in verification)`);
  }

  let id = cleanText(raw.id);
  if (!id) {
    if (tmdbId) {
      id = mediaType === "movie" ? `tmdb-movie-${tmdbId}` : tmdbSeason !== null ? `tmdb-${tmdbId}-s${tmdbSeason}` : `tmdb-${tmdbId}`;
    }
    else if (year) id = `official-${slugify(title)}-${year}`;
    else return reject("needs an explicit id, a tmdbId, or a year to build a stable ID");
  }

  return {
    ok: true,
    problems,
    ...(warnings.length ? { warnings } : {}),
    entry: {
      id,
      title,
      originalTitle: cleanText(raw.originalTitle),
      aliases: Array.isArray(raw.aliases) ? uniqueStrings(raw.aliases) : [],
      mediaType,
      tmdbId,
      ...(tmdbSeason !== null ? { tmdbSeason } : {}),
      firstAirDate,
      year,
      description: cleanText(raw.description),
      image: isHttpsUrl(cleanText(raw.image)) ? cleanText(raw.image) : "",
      backdrop: isHttpsUrl(cleanText(raw.backdrop)) ? cleanText(raw.backdrop) : "",
      tags: Array.isArray(raw.tags) ? uniqueStrings(raw.tags) : [],
      evidence,
      ...(curatedPlatforms.length ? { curatedPlatforms } : {}),
      ...(episodes.length ? { episodes } : {}),
      ...(options.discovery === true
        ? {
            origin: "discovery",
            inclusionSource: cleanText(raw.inclusionSource) || "youtube-official-channel-discovery",
            provenance: sanitizeProvenance(raw.provenance)
          }
        : {})
    }
  };
}

/* ------------------------------------------------------------------ */
/* Matching (conservative: a false merge would attach false proof)     */
/* ------------------------------------------------------------------ */

function recordTmdbKey(record) {
  if (!isPlainObject(record)) return null;

  const fromUrl = /themoviedb\.org\/(tv|movie)\/(\d+)/i.exec(String(record.tmdbUrl || ""));
  if (fromUrl) return `${fromUrl[1].toLowerCase()}:${fromUrl[2]}`;

  const numericId = Number(record.tmdbId);
  if ((record.mediaType === "tv" || record.mediaType === "movie") && Number.isInteger(numericId) && numericId > 0) {
    return `${record.mediaType}:${numericId}`;
  }

  const fromId = /^tmdb-(movie-)?(\d+)$/.exec(String(record.id || ""));
  return fromId ? `${fromId[1] ? "movie" : "tv"}:${fromId[2]}` : null; // never match a bare number
}

function recordNames(record, extra = []) {
  const names = [record.title, record.originalTitle, ...extra];
  if (Array.isArray(record.aliases)) names.push(...record.aliases);

  return new Set(names.map(normalizeTitle).filter(Boolean));
}

function titlesOverlap(entry, record) {
  const existing = recordNames(record);
  return [...recordNames(entry)].some((name) => existing.has(name));
}

function resolveTitleMatch(entryYear, candidates) {
  const sameYear = [];
  let uncertain = 0;

  for (const candidate of candidates) {
    const year = recordYear(candidate);

    if (entryYear === null || entryYear === undefined || year === null) uncertain++;
    else if (year === entryYear) sameYear.push(candidate);
    else if (Math.abs(year - entryYear) === 1) uncertain++;
    // 2+ years apart: a different production that shares the title
  }

  if (uncertain) {
    return {
      action: "review",
      reason:
        "title matches an existing record whose release year is unknown or within one year; " +
        "set the manifest id to that record's id to merge, or give a firstAirDate to separate them"
    };
  }

  if (sameYear.length === 1) return { action: "merge", record: sameYear[0] };
  if (sameYear.length > 1) return { action: "review", reason: "several existing records share this title and year" };

  return { action: "new" };
}

/* ------------------------------------------------------------------ */
/* Season-aware identity                                               */
/*                                                                     */
/* recordTmdbKey above is series-level ("tv:95479") and stays that way */
/* for existing callers. Seasons get their own helpers below.          */
/* ------------------------------------------------------------------ */

// State of the tmdbSeason field on a catalog record: absent, a usable season, or present-but-unusable.
function recordSeasonState(record) {
  const value = isPlainObject(record) ? record.tmdbSeason : undefined;

  if (value === undefined || value === null || value === "") return { kind: "none", season: null };

  return Number.isInteger(value) && value >= 1 && value <= MAX_SEASON
    ? { kind: "explicit", season: value }
    : { kind: "invalid", season: null };
}

// Season-aware identity: "tv:95479:s2". Only TV seasons have one.
function tmdbSeasonKey(type, tmdbId, season) {
  return type === "tv" && Number.isInteger(tmdbId) && tmdbId > 0 && Number.isInteger(season) && season >= 1
    ? `tv:${tmdbId}:s${season}`
    : null;
}

// Season identity of a record from its OWN fields only (a record without tmdbSeason has none).
function recordSeasonKey(record) {
  const key = recordTmdbKey(record);
  const state = recordSeasonState(record);

  return key && key.startsWith("tv:") && state.kind === "explicit" ? `${key}:s${state.season}` : null;
}

const entryTmdbKey = (entry) => (entry.tmdbId ? `${entry.mediaType}:${entry.tmdbId}` : null);

/*
 * What the whole manifest says about identity, worked out before any entry is processed:
 *  - claims: manifest id -> { key, season }. A catalog record whose id equals a manifest id belongs to
 *    that entry (and its season) even when the record itself has no tmdbSeason. In memory only.
 *  - conflicts: entries that cannot be trusted to pick a record (one id with different identities, or
 *    two different ids describing the same season). They are reported, not guessed.
 */
function analyzeManifestIdentities(items) {
  const claims = new Map();
  const conflicts = new Map();
  const byId = new Map();
  const bySeason = new Map();
  const identityOf = (entry) => `${entry.mediaType}|${entry.tmdbId || ""}|${entry.tmdbSeason || ""}`;

  for (const item of items) {
    const { entry } = item;
    if (!byId.has(entry.id)) byId.set(entry.id, []);
    byId.get(entry.id).push(item);

    const seasonKey = tmdbSeasonKey(entry.mediaType, entry.tmdbId, entry.tmdbSeason);
    if (seasonKey) {
      if (!bySeason.has(seasonKey)) bySeason.set(seasonKey, []);
      bySeason.get(seasonKey).push(item);
    }
  }

  for (const [id, group] of byId) {
    const disagree = new Set(group.map((item) => identityOf(item.entry))).size > 1;
    const first = group[0].entry;

    claims.set(id, { key: entryTmdbKey(first), season: first.tmdbSeason || null, conflict: disagree });

    if (disagree) {
      for (const item of group) {
        conflicts.set(item.entry, `manifest id "${id}" is used by entries with different tmdbId/tmdbSeason/mediaType; fix the manifest`);
      }
    }
  }

  for (const [seasonKey, group] of bySeason) {
    const ids = [...new Set(group.map((item) => item.entry.id))];

    if (ids.length > 1) {
      for (const item of group) {
        if (!conflicts.has(item.entry)) {
          conflicts.set(item.entry, `manifest entries ${ids.join(", ")} all describe ${seasonKey}; keep one entry per season`);
        }
      }
    }
  }

  return { claims, conflicts };
}

const claimOf = (claims, record) => (claims && claims.get(String(record.id))) || null;

// How a record that shares the entry's series-level TMDB key relates to a SEASON entry.
function seasonRelation(record, entry, claims) {
  const state = recordSeasonState(record);

  if (state.kind === "explicit") return state.season === entry.tmdbSeason ? "same" : "different";
  if (state.kind === "invalid") return "ambiguous";

  // No season on the record: it either belongs to another manifest entry or nobody can say which season it is.
  return claimOf(claims, record) && String(record.id) !== entry.id ? "other" : "ambiguous";
}

// A record is season-specific when it says so itself, or when the manifest entry that owns its id does.
function isSeasonSpecific(record, claims) {
  const claim = claimOf(claims, record);
  return recordSeasonState(record).kind !== "none" || Boolean(claim && (claim.season || claim.conflict));
}

// An exact-id hit is the curator's explicit identity, but it must not contradict an explicit season or TMDB id.
function seasonConflict(record, entry, entryKey) {
  const state = recordSeasonState(record);

  if (state.kind === "invalid") {
    return `existing record ${record.id} has an unusable tmdbSeason (${describeValue(record.tmdbSeason)}); fix it before merging`;
  }

  if (state.kind === "explicit" && state.season !== entry.tmdbSeason) {
    return `existing record ${record.id} is season ${state.season} but this manifest entry is season ${entry.tmdbSeason}; seasons are never merged`;
  }

  const key = recordTmdbKey(record);

  if (key && entryKey && key !== entryKey) {
    return `existing record ${record.id} is ${key} but this manifest entry is ${entryKey}; the ids conflict`;
  }

  return null;
}

/*
 * Stable identity only (no title guessing). Returns:
 *   { action: "merge", record }  one record is certainly this entry
 *   { action: "review", reason } identity is ambiguous or conflicting: report it, change nothing
 *   { action: "none" }           no record has this identity (the caller may still try the title fallback)
 */
function matchIdentity(anime, entry, claims) {
  const review = (reason) => ({ action: "review", reason });
  const entryKey = entryTmdbKey(entry);
  const records = anime.filter(isPlainObject);
  const exact = records.filter((record) => !isEmptyValue(record.id) && String(record.id) === entry.id);
  const several = "identity matches several existing records; resolve the duplicates manually";
  const names = (list) => list.map((record) => record.id).join(", ");

  if (entry.tmdbSeason) {
    if (exact.length > 1) return review(several);

    if (exact.length === 1) {
      const conflict = seasonConflict(exact[0], entry, entryKey);
      return conflict ? review(conflict) : { action: "merge", record: exact[0] };
    }

    const same = [];
    const ambiguous = [];

    for (const record of records) {
      if (recordTmdbKey(record) !== entryKey) continue;

      const relation = seasonRelation(record, entry, claims);
      if (relation === "same") same.push(record);
      else if (relation === "ambiguous") ambiguous.push(record);
    }

    if (same.length > 1) return review(`several existing records are ${entryKey} season ${entry.tmdbSeason}; resolve the duplicates manually`);
    if (same.length === 1) return { action: "merge", record: same[0] };

    if (ambiguous.length) {
      return review(
        `existing record(s) ${names(ambiguous)} share ${entryKey} but have no usable tmdbSeason and no manifest entry claims them, ` +
          `so season ${entry.tmdbSeason} cannot be told apart from them; set this entry's id to that record's id to merge, or add tmdbSeason to the record`
      );
    }

    return { action: "none" };
  }

  // Series-level entry (no tmdbSeason): behaves as before, except it never silently joins a season-specific record.
  const sharing = entryKey ? records.filter((record) => !exact.includes(record) && recordTmdbKey(record) === entryKey) : [];
  const seasoned = sharing.filter((record) => isSeasonSpecific(record, claims));
  const hits = [...exact, ...sharing.filter((record) => !seasoned.includes(record))];

  if (hits.length > 1) return review(several);
  if (hits.length === 1) return { action: "merge", record: hits[0] };

  if (seasoned.length) {
    return review(
      `this entry has no tmdbSeason but existing record(s) ${names(seasoned)} are season-specific; ` +
        "add tmdbSeason to the entry, or set its id to that record's id"
    );
  }

  return { action: "none" };
}

// Title/alias fallback candidates. Season-specific records never take part in a series-level fallback,
// and a season entry never considers another season's record or a record another manifest entry owns.
function titleCandidates(anime, entry, claims) {
  const entryKey = entryTmdbKey(entry);

  return anime.filter((record) => {
    if (!isPlainObject(record) || !titlesOverlap(entry, record)) return false;

    const key = recordTmdbKey(record);
    if (entryKey && key && key !== entryKey) return false;

    const state = recordSeasonState(record);
    const claim = claimOf(claims, record);
    const ownedByOther = Boolean(claim) && String(record.id) !== entry.id;

    if (entry.tmdbSeason) {
      if (state.kind === "explicit" && state.season !== entry.tmdbSeason) return false;
      return !ownedByOther;
    }

    if (state.kind !== "none") return false;
    return !(ownedByOther && claim.season);
  });
}

/* ------------------------------------------------------------------ */
/* Merging: fill what is missing, never overwrite what exists          */
/* ------------------------------------------------------------------ */

function fillIfEmpty(target, key, value) {
  if (isEmptyValue(value) || !isEmptyValue(target[key])) return false;

  target[key] = structuredClone(value);
  return true;
}

function mergeMissing(target, patch) {
  const changed = [];

  for (const [key, value] of Object.entries(patch)) {
    if (SPECIAL_KEYS.has(key) || isEmptyValue(value)) continue;

    if (isEmptyValue(target[key]) || isPlaceholderValue(key, target[key])) {
      target[key] = structuredClone(value);
      changed.push(key);
    }
  }

  return changed;
}

function mergeTmdbIdentity(target, patch) {
  if (isEmptyValue(patch.tmdbId) || !isEmptyValue(target.tmdbId)) return false;

  target.tmdbId = patch.tmdbId;
  fillIfEmpty(target, "tmdbUrl", patch.tmdbUrl);
  fillIfEmpty(target, "mediaType", patch.mediaType);

  // The season is written only together with a brand-new TMDB identity (a new record). A record that
  // already has a tmdbId keeps matching through its manifest id and is never rewritten to add a season.
  fillIfEmpty(target, "tmdbSeason", patch.tmdbSeason);
  fillIfEmpty(target, "tmdbSeasonUrl", patch.tmdbSeasonUrl);
  return true;
}

function mergeVerification(target, patch) {
  const incoming = Array.isArray(patch.tamilDubEvidence) ? patch.tamilDubEvidence : [];
  const result = { changed: [], conflict: false };

  if (!incoming.length) return result;

  const hasEvidence = ["tamilDubVerificationUrl", "tamilDubVerificationSource", "tamilDubEvidence"].some(
    (key) => !isEmptyValue(target[key])
  );

  // Explicitly "not verified" with evidence on file is curated: never override it.
  if (target.tamilDubVerified === false && hasEvidence) {
    result.conflict = true;
    return result;
  }

  if (target.tamilDubVerified !== true) {
    target.tamilDubVerified = true;
    result.changed.push("tamilDubVerified");
  }

  for (const key of ["tamilDubVerificationSource", "tamilDubVerificationUrl", "tamilDubVerifiedAt"]) {
    if (fillIfEmpty(target, key, patch[key])) result.changed.push(key);
  }

  const current = target.tamilDubEvidence;
  if (current === undefined || current === null || Array.isArray(current)) {
    const list = Array.isArray(current) ? current : [];
    const known = new Set(list.map((item) => (isPlainObject(item) ? item.url : item)));
    const fresh = incoming.filter((item) => !known.has(item.url));

    if (fresh.length) {
      target.tamilDubEvidence = [...list, ...structuredClone(fresh)];
      result.changed.push("tamilDubEvidence");
    }
  }

  return result;
}

function mergePlatforms(target, incoming) {
  if (!Array.isArray(incoming) || !incoming.length) return false;

  if (!Array.isArray(target.platforms) || !target.platforms.length) {
    target.platforms = structuredClone(incoming);
    return true;
  }

  let changed = false;

  // Placeholder platforms (no evidence) never join an existing list.
  for (const platform of incoming.filter((item) => item.tamilDubVerified === true)) {
    const existing = target.platforms.find(
      (item) => isPlainObject(item) && cleanText(item.name).toLowerCase() === platform.name.toLowerCase()
    );

    if (!existing) {
      target.platforms.push(structuredClone(platform));
      changed = true;
      continue;
    }

    const verified = existing.tamilDubVerified === true;
    if (!verified && !isEmptyValue(existing.tamilDubVerificationUrl)) continue; // curated "unverified"

    if (!verified) {
      existing.tamilDubVerified = true;
      existing.available = true;
      changed = true;
    }

    changed = fillIfEmpty(existing, "officialUrl", platform.officialUrl) || changed;
    changed = fillIfEmpty(existing, "tamilDubVerificationUrl", platform.tamilDubVerificationUrl) || changed;
  }

  // Curated availability (official title page, no Tamil proof): add a missing row or fill an
  // empty placeholder. Never touches Tamil flags and never downgrades an existing row.
  for (const platform of incoming.filter((item) => item.available === true && item.tamilDubVerified !== true)) {
    const existing = target.platforms.find(
      (item) => isPlainObject(item) && cleanText(item.name).toLowerCase() === platform.name.toLowerCase()
    );

    if (!existing) {
      target.platforms.push(structuredClone(platform));
      changed = true;
    } else if (existing.available !== true) {
      if (!isEmptyValue(existing.tamilDubVerificationUrl) || !isEmptyValue(existing.officialUrl)) continue; // curated, leave it

      existing.available = true;
      existing.officialUrl = platform.officialUrl;
      changed = true;
    } else {
      changed = fillIfEmpty(existing, "officialUrl", platform.officialUrl) || changed;
    }
  }

  return changed;
}

// Episodes merge by number: fill a missing title or link, append unknown numbers, never overwrite.
function mergeEpisodes(target, incoming) {
  if (!Array.isArray(incoming) || !incoming.length) return false;

  if (!Array.isArray(target.episodes) || !target.episodes.length) {
    target.episodes = structuredClone(incoming);
    return true;
  }

  let changed = false;

  for (const episode of incoming) {
    const existing = target.episodes.find(
      (item) => isPlainObject(item) && cleanText(item.number) === cleanText(episode.number)
    );

    if (!existing) {
      if (target.episodes.length < MAX_EPISODES) {
        target.episodes.push(structuredClone(episode));
        changed = true;
      }
      continue;
    }

    changed = fillIfEmpty(existing, "title", episode.title) || changed;
    changed = fillIfEmpty(existing, "airDate", episode.airDate) || changed;

    if (isEmptyValue(existing.url) && episode.url) {
      existing.url = episode.url;
      if (episode.platform) existing.platform = episode.platform;
      changed = true;
    }
  }

  return changed;
}

function mergeRecord(target, patch) {
  const changed = mergeMissing(target, patch);

  if (mergeTmdbIdentity(target, patch)) changed.push("tmdbId");

  const verification = mergeVerification(target, patch);
  changed.push(...verification.changed);

  if (!verification.conflict && mergePlatforms(target, patch.platforms)) changed.push("platforms");
  if (!verification.conflict && mergeEpisodes(target, patch.episodes)) changed.push("episodes");
  if (!verification.conflict && mergeProvenance(target, patch.discoveryProvenance)) changed.push("discoveryProvenance");

  return { changed, conflict: verification.conflict };
}

/* ------------------------------------------------------------------ */
/* Record construction                                                 */
/* ------------------------------------------------------------------ */

// Final episode list: a link survives only if the confirmed evidence backs its platform (or video).
function anchoredEpisodes(entry) {
  return (entry.episodes || []).map((episode) => {
    const { videoId, url, platform, ...plain } = episode;

    return episodeLinkAllowed(episode, entry.evidence) ? { ...plain, url, platform } : { ...plain, url: null };
  });
}

function buildManifestPatch(entry, region) {
  const primary = entry.evidence[0];
  const verifiedPlatforms = new Map();
  const curated = new Map((entry.curatedPlatforms || []).map((row) => [row.name, row]));

  for (const item of entry.evidence) {
    if (!verifiedPlatforms.has(item.platform)) {
      verifiedPlatforms.set(item.platform, {
        name: item.platform,
        available: true,
        officialUrl: curated.has(item.platform) ? curated.get(item.platform).officialUrl : item.url, // title page beats a news/announcement proof URL
        tamilDubVerified: true,
        tamilDubVerificationUrl: item.url
      });
    }
  }

  const platforms = [...verifiedPlatforms.values()];

  for (const name of REQUIRED_PLATFORMS) {
    if (verifiedPlatforms.has(name)) continue;

    const row = curated.get(name); // availability from an official title page, still no Tamil proof
    platforms.push(
      row
        ? { name, available: true, officialUrl: row.officialUrl, tamilDubVerified: false }
        : { name, available: false, officialUrl: null, tamilDubVerified: false }
    );
  }

  const patch = {
    id: entry.id,
    title: entry.title,
    originalTitle: entry.originalTitle,
    description: entry.description,
    image: entry.image,
    backdrop: entry.backdrop,
    firstAirDate: entry.firstAirDate,
    createdAt: entry.firstAirDate ? `${entry.firstAirDate}T00:00:00Z` : "",
    tags: entry.tags.length ? uniqueStrings(["Anime", ...entry.tags]).slice(0, MAX_TAGS) : [],
    platforms,
    // The detail view lists at most 10 videos; episode rows carry the per-episode links.
    youtube: entry.evidence
      .filter((item) => item.platform === "YouTube")
      .map((item) => ({ title: entry.title, url: item.url }))
      .slice(0, entry.origin === "discovery" ? 10 : undefined),
    tamilDubVerified: true,
    tamilDubVerificationSource: primary.source,
    tamilDubVerificationUrl: primary.url,
    tamilDubVerifiedAt: primary.checkedAt || "",
    tamilDubEvidence: entry.evidence,
    inclusionSource: entry.inclusionSource || "official-source-manifest",
    region
  };

  if (entry.provenance && entry.provenance.length) patch.discoveryProvenance = entry.provenance;

  if (entry.tmdbId) {
    patch.tmdbId = entry.tmdbId;
    patch.tmdbUrl = `https://www.themoviedb.org/${entry.mediaType}/${entry.tmdbId}`;
    patch.mediaType = entry.mediaType;

    if (entry.tmdbSeason) {
      patch.tmdbSeason = entry.tmdbSeason;
      patch.tmdbSeasonUrl = `${patch.tmdbUrl}/season/${entry.tmdbSeason}`;
    }
  }

  const episodes = anchoredEpisodes(entry);
  if (episodes.length) patch.episodes = episodes;

  return patch;
}

function finalizeNewRecord(record, nowIso) {
  const defaults = {
    originalTitle: record.title,
    description: PLACEHOLDER_DESCRIPTION,
    image: null,
    backdrop: null,
    rating: null,
    likes: null,
    availability: "Available",
    status: null,
    firstAirDate: null,
    createdAt: nowIso,
    updatedAt: nowIso,
    tags: ["Anime"],
    episodes: [],
    youtube: []
  };

  for (const [key, value] of Object.entries(defaults)) {
    if (isEmptyValue(record[key])) record[key] = value;
  }

  const airTime = record.firstAirDate ? new Date(`${record.firstAirDate}T00:00:00Z`).getTime() : 0;
  record.isNew = airTime > Date.now() - WEEK_MS;

  const ordered = {};
  for (const key of RECORD_KEY_ORDER) if (key in record) ordered[key] = record[key];
  for (const key of Object.keys(record)) if (!(key in ordered)) ordered[key] = record[key];

  return ordered;
}

/* ------------------------------------------------------------------ */
/* TMDB enrichment (verified titles only, missing fields only)         */
/* ------------------------------------------------------------------ */

function createTags(details) {
  const genres = Array.isArray(details.genres)
    ? details.genres.map((genre) => genre && genre.name).filter(Boolean)
    : [];

  return uniqueStrings(["Anime", ...genres]).slice(0, MAX_TAGS);
}

function createEpisodes(details) {
  const episodes = [];

  for (const season of Array.isArray(details.seasons) ? details.seasons : []) {
    if (!season || season.season_number === 0) continue;

    for (let i = 1; i <= Math.min(Number(season.episode_count || 0), 100); i++) {
      episodes.push({ number: `${season.season_number}-${i}`, url: null });
    }

    if (episodes.length >= MAX_EPISODES) break;
  }

  return episodes.slice(0, MAX_EPISODES);
}

const isIsoDate = (value) => /^\d{4}-\d{2}-\d{2}$/.test(String(value === undefined || value === null ? "" : value));

// Rows for ONE season from TMDB's season endpoint. Never another season, never specials, never a link:
// a number, optional title/airDate, and url:null (links only ever come from explicit official evidence).
function createSeasonEpisodes(seasonDetails, number) {
  const seen = new Set();
  const found = [];

  for (const item of Array.isArray(seasonDetails && seasonDetails.episodes) ? seasonDetails.episodes : []) {
    if (!isPlainObject(item)) continue;
    if (item.season_number !== undefined && item.season_number !== number) continue;

    const episodeNumber = item.episode_number;
    if (!Number.isInteger(episodeNumber) || episodeNumber < 1 || seen.has(episodeNumber)) continue;
    seen.add(episodeNumber);

    const row = { number: `${number}-${episodeNumber}` };
    const title = cleanText(item.name).slice(0, 200);

    if (title && !/^episode\s*\d+$/i.test(title)) row.title = title; // TMDB's "Episode 5" is not a title
    if (isIsoDate(item.air_date)) row.airDate = item.air_date;
    row.url = null;

    found.push({ episodeNumber, row });
  }

  return found
    .sort((a, b) => a.episodeNumber - b.episodeNumber)
    .slice(0, MAX_EPISODES)
    .map((item) => item.row);
}

function tmdbDate(details, type) {
  return (type === "movie" ? details.release_date : details.first_air_date) || null;
}

// season (optional): { number, details } where details is TMDB's season payload or null when unavailable.
// In season mode the series first_air_date and series status are NOT used (they describe the series, not
// this season); the date is the season's own air_date, and episodes come only from that season.
function tmdbMetadata(details, type, season = null) {
  const isTv = type === "tv";
  const seasonDetails = season ? season.details : null;
  const title = cleanText(isTv ? details.name : details.title);
  const original = cleanText(isTv ? details.original_name : details.original_title);
  const date = season ? (seasonDetails && isIsoDate(seasonDetails.air_date) ? seasonDetails.air_date : null) : tmdbDate(details, type);
  const status = season ? null : details.status || null;

  let availability = "Available";
  if (isTv && status === "Ended") availability = "Completed";
  else if (isTv && status === "Returning Series") availability = "Ongoing";

  return {
    title,
    originalTitle: original || title,
    description: (season && cleanText(seasonDetails && seasonDetails.overview)) || cleanText(details.overview),
    image: details.poster_path ? `https://image.tmdb.org/t/p/w500${details.poster_path}` : null,
    backdrop: details.backdrop_path ? `https://image.tmdb.org/t/p/w1280${details.backdrop_path}` : null,
    rating: typeof details.vote_average === "number" ? Number(details.vote_average.toFixed(1)) : null,
    availability,
    status,
    firstAirDate: date,
    createdAt: date ? `${date}T00:00:00Z` : null,
    tags: createTags(details),
    // Series totals for the site (it shows only "N seasons, N episodes"); a single season has no series totals.
    numberOfSeasons: isTv && !season && Number.isInteger(details.number_of_seasons) && details.number_of_seasons > 0 ? details.number_of_seasons : null,
    numberOfEpisodes: isTv && !season && Number.isInteger(details.number_of_episodes) && details.number_of_episodes > 0 ? details.number_of_episodes : null,
    episodes: !isTv ? [] : season ? (seasonDetails ? createSeasonEpisodes(seasonDetails, season.number) : []) : createEpisodes(details)
  };
}

function titlesCompatible(names, details, type) {
  const isTv = type === "tv";
  const tmdbNames = new Set(
    [isTv ? details.name : details.title, isTv ? details.original_name : details.original_title]
      .map(normalizeTitle)
      .filter(Boolean)
  );

  return [...names].some((name) => tmdbNames.has(normalizeTitle(name)));
}

// Season rows are only numbered "<season>-<n>" on records that carry an explicit tmdbSeason, so only those
// can be checked row by row. A row needs data when it has neither a title nor an air date.
function seasonRowsNeedData(record, number) {
  const prefix = `${number}-`;
  const rows = (Array.isArray(record.episodes) ? record.episodes : []).filter(
    (item) => isPlainObject(item) && cleanText(item.number).startsWith(prefix)
  );

  return rows.length === 0 || rows.some((item) => isEmptyValue(item.title) && isEmptyValue(item.airDate));
}

// season: null, or { number, explicit } (explicit = the record itself carries tmdbSeason)
function needsEnrichment(record, type, season = null) {
  const keys = season ? ENRICHABLE_KEYS.filter((key) => key !== "status") : ENRICHABLE_KEYS; // a season has no status of its own
  const missing = keys.some((key) => isEmptyValue(record[key]) || isPlaceholderValue(key, record[key]));

  if (missing) return true;
  if (type !== "tv") return false;
  if (isEmptyValue(record.episodes)) return true;

  return Boolean(season && season.explicit && seasonRowsNeedData(record, season.number));
}

function isOfficiallyVerified(record, channelIds) {
  if (!isPlainObject(record) || record.tamilDubVerified !== true) return false;

  const evidence = Array.isArray(record.tamilDubEvidence) ? record.tamilDubEvidence : [];
  const platforms = Array.isArray(record.platforms) ? record.platforms : [];

  const candidates = [
    ...evidence.map((item) => (isPlainObject(item) ? item : { url: item })),
    { url: record.tamilDubVerificationUrl },
    { url: record.tamilDubVerificationSource },
    ...platforms
      .filter((item) => isPlainObject(item) && item.tamilDubVerified === true)
      .map((item) => ({ url: item.tamilDubVerificationUrl }))
  ];

  return candidates.some((candidate) => {
    const result = classifyOfficialUrl(candidate.url);

    // A bare YouTube URL says nothing about who owns the video.
    return result.ok && (result.platform !== "YouTube" || channelIds.has(candidate.channelId));
  });
}

async function lookupTmdb(state, type, id) {
  const cacheKey = `${type}:${id}`;
  if (state.tmdbCache.has(cacheKey)) return state.tmdbCache.get(cacheKey);

  await sleep(state.cfg.tmdbDelayMs);
  state.report.tmdb.requests++;

  let result;

  try {
    const details = await getJson(tmdbUrl(state.cfg.tmdbApiKey, `/${type}/${id}`, { language: "en-US" }));
    result = details && details.id ? { status: "ok", details } : { status: "error", details: null };
  } catch (error) {
    state.report.tmdb.failures++;
    console.warn(`TMDB ${type}/${id} lookup failed: ${errorMessage(error)}`);
    result = { status: error.status === 404 ? "not_found" : "error", details: null };
  }

  state.tmdbCache.set(cacheKey, result);
  return result;
}

async function lookupTmdbSeason(state, id, number) {
  const cacheKey = `tv:${id}:s${number}`;
  if (state.tmdbCache.has(cacheKey)) return state.tmdbCache.get(cacheKey);

  await sleep(state.cfg.tmdbDelayMs);
  state.report.tmdb.requests++;

  let result;

  try {
    const details = await getJson(tmdbUrl(state.cfg.tmdbApiKey, `/tv/${id}/season/${number}`, { language: "en-US" }));
    const usable =
      isPlainObject(details) &&
      Array.isArray(details.episodes) &&
      (details.season_number === undefined || details.season_number === number); // never accept another season's payload

    result = usable ? { status: "ok", details } : { status: "error", details: null };
  } catch (error) {
    state.report.tmdb.failures++;
    console.warn(`TMDB tv/${id}/season/${number} lookup failed: ${errorMessage(error)}`);
    result = { status: error.status === 404 ? "not_found" : "error", details: null };
  }

  state.tmdbCache.set(cacheKey, result);
  return result;
}

/*
 * TMDB adapter for discovery. It only NAMES series: search results are suggestions, and nothing here ever proves Tamil
 * audio. Series details go through lookupTmdb, so discovery and enrichment share one cache and one request counter.
 */
function createDiscoveryTmdb(state) {
  const searches = new Map();

  return {
    enabled: state.tmdbEnabled,

    async search(query) {
      const text = cleanText(query);
      const cacheKey = text.toLowerCase();
      if (searches.has(cacheKey)) return searches.get(cacheKey);

      await sleep(state.cfg.tmdbDelayMs);
      state.report.tmdb.requests++;

      let result;

      try {
        const data = await getJson(tmdbUrl(state.cfg.tmdbApiKey, "/search/tv", { query: text, language: "en-US", include_adult: "false" }));
        const list = Array.isArray(data && data.results) ? data.results.filter(isPlainObject).slice(0, 20) : [];

        result = {
          status: "ok",
          results: list
            .map((item) => ({
              id: item.id,
              name: cleanText(item.name),
              originalName: cleanText(item.original_name),
              firstAirYear: yearOf(item.first_air_date),
              genreIds: Array.isArray(item.genre_ids) ? item.genre_ids.filter(Number.isInteger) : [],
              originCountry: Array.isArray(item.origin_country) ? item.origin_country.filter((code) => typeof code === "string") : [],
              originalLanguage: cleanText(item.original_language)
            }))
            .filter((item) => Number.isInteger(item.id) && item.id > 0)
        };
      } catch (error) {
        state.report.tmdb.failures++;
        console.warn(`TMDB search failed: ${errorMessage(error)}`);
        result = { status: "error", results: [] };
      }

      searches.set(cacheKey, result);
      return result;
    },

    details: (type, id) => lookupTmdb(state, type, id)
  };
}

// TMDB lists the season (or does not say which seasons exist).
function seasonListed(series, number) {
  const seasons = Array.isArray(series && series.seasons) ? series.seasons : [];
  return seasons.length === 0 || seasons.some((item) => item && item.season_number === number);
}

/*
 * Which season (if any) a record is known to be, for metadata purposes:
 *  - explicit: the record has tmdbSeason itself.
 *  - claimed:  the record has none, but a manifest entry owns its id and names a season (same TMDB key).
 *    Such older records keep their own episode rows (their numbering is not season-based), so they only
 *    receive season rows when they have none at all.
 */
function enrichmentSeason(state, record) {
  const own = recordSeasonState(record);
  if (own.kind === "explicit") return { number: own.season, explicit: true };

  const claim = claimOf(state.claims, record);
  const key = recordTmdbKey(record);

  return claim && claim.season && !claim.conflict && key && key === claim.key ? { number: claim.season, explicit: false } : null;
}

async function enrichSeason(state, record, series, tmdbId, season) {
  let seasonDetails = null;

  if (!seasonListed(series, season.number)) {
    state.unavailable(record, `TMDB lists no season ${season.number} for tv ${tmdbId}; season date and episode rows skipped`);
  } else {
    const lookup = await lookupTmdbSeason(state, tmdbId, season.number);

    if (lookup.status === "ok") seasonDetails = lookup.details;
    else {
      state.unavailable(
        record,
        `TMDB season ${season.number} of tv ${tmdbId} ${lookup.status === "not_found" ? "was not found" : "could not be fetched"}; season date and episode rows skipped`
      );
    }
  }

  const { episodes, ...fields } = tmdbMetadata(series, "tv", { number: season.number, details: seasonDetails });
  const changed = mergeMissing(record, fields); // series poster/rating/tags still apply; the series date and status do not

  // Explicit-season records merge rows by number. Older records keep their own rows (fill only when empty).
  if ((season.explicit || isEmptyValue(record.episodes)) && mergeEpisodes(record, episodes)) changed.push("episodes");

  return changed;
}

async function enrichRecord(state, record, extraNames = []) {
  state.enrichAttempted.add(record);

  if (!state.tmdbEnabled || !isOfficiallyVerified(record, state.channelIds)) return [];

  const key = recordTmdbKey(record);
  if (!key) return [];

  const [type, rawId] = key.split(":");

  if (recordSeasonState(record).kind === "invalid") {
    state.unavailable(record, `record has an unusable tmdbSeason (${describeValue(record.tmdbSeason)}); TMDB enrichment skipped`);
    return [];
  }

  const season = type === "tv" ? enrichmentSeason(state, record) : null;
  if (!needsEnrichment(record, type, season)) return [];

  const lookup = await lookupTmdb(state, type, Number(rawId));

  if (lookup.status !== "ok") {
    state.unavailable(record, `TMDB ${type}/${rawId} ${lookup.status === "not_found" ? "was not found" : "could not be fetched"}; existing data kept`);
    return [];
  }

  if (!titlesCompatible(recordNames(record, extraNames), lookup.details, type)) {
    state.review(
      record.title || record.id,
      "TMDB title does not match the catalog title; enrichment skipped (add an alias or fix tmdbId)"
    );
    return [];
  }

  return season ? enrichSeason(state, record, lookup.details, Number(rawId), season) : mergeMissing(record, tmdbMetadata(lookup.details, type));
}

// Stable numeric order for "<season>-<episode>" rows of a record created by discovery. Rows that do not
// follow that numbering keep their relative position after the numbered ones.
function sortEpisodeRows(record) {
  if (!Array.isArray(record.episodes)) return;

  const parse = (row) => {
    const match = isPlainObject(row) ? /^(\d+)-(\d+)$/.exec(cleanText(row.number)) : null;
    return match ? [Number(match[1]), Number(match[2])] : null;
  };

  record.episodes = record.episodes
    .map((row, index) => ({ row, index, key: parse(row) }))
    .sort((a, b) => {
      if (a.key && b.key) return a.key[0] - b.key[0] || a.key[1] - b.key[1] || a.index - b.index;
      if (a.key) return -1;
      if (b.key) return 1;
      return a.index - b.index;
    })
    .map((item) => item.row);
}

/* ------------------------------------------------------------------ */
/* Per-entry processing                                                */
/* ------------------------------------------------------------------ */

async function processEntry(state, entry, label) {
  const { anime, cfg } = state;
  const entryKey = entryTmdbKey(entry);
  const entryNames = [entry.title, entry.originalTitle, ...entry.aliases];

  // 1. Stable identity: exact ID, or (season entries) media type + tmdbId + tmdbSeason, or (series entries)
  //    a known TMDB key including media type. Ambiguity is reported, never guessed.
  const identity = matchIdentity(anime, entry, state.claims);

  if (identity.action === "review") {
    state.review(label, identity.reason);
    return;
  }

  let target = identity.action === "merge" ? identity.record : null;
  let entryLookup = null;

  // 2. Title match, only when release years prove it is the same production. A season entry never merges
  //    by title: aliases include the series title, which every season shares.
  if (!target) {
    const candidates = titleCandidates(anime, entry, state.claims);

    if (candidates.length) {
      let year = entry.year;

      if (year === null && entryKey && state.tmdbEnabled) {
        if (entry.tmdbSeason) {
          const seasonLookup = await lookupTmdbSeason(state, entry.tmdbId, entry.tmdbSeason);
          if (seasonLookup.status === "ok") year = yearOf(seasonLookup.details.air_date); // never the series date
        } else {
          entryLookup = await lookupTmdb(state, entry.mediaType, entry.tmdbId);
          if (entryLookup.status === "ok") year = yearOf(tmdbDate(entryLookup.details, entry.mediaType));
        }
      }

      let decision = resolveTitleMatch(year, candidates);

      if (decision.action === "merge" && entry.tmdbSeason) {
        decision = {
          action: "review",
          reason:
            `title matches existing record ${decision.record.id}, which has no season identity of its own; ` +
            "a season entry merges only by exact id or tmdbId + tmdbSeason (set the manifest id to that record's id to merge)"
        };
      }

      if (decision.action === "review") {
        state.review(label, decision.reason);
        return;
      }

      if (decision.action === "merge") target = decision.record;
    }
  }

  const patch = buildManifestPatch(entry, cfg.region);

  if (target) {
    const merged = mergeRecord(target, patch);
    const changed = [...merged.changed, ...(await enrichRecord(state, target, entryNames))];

    if (merged.conflict) {
      state.review(label, "existing record is explicitly tamilDubVerified:false with its own evidence; left unchanged");
    }

    if (changed.length) {
      state.touched.add(target);
      state.changeLog.push({ id: target.id, fields: [...new Set(changed)] });
    } else if (!merged.conflict) {
      state.alreadyInCatalog++;
    }

    return;
  }

  // 3. New record. A wrong tmdbId would poison a permanent ID, so check it first.
  if (entryKey && state.tmdbEnabled) {
    const lookup = entryLookup || (await lookupTmdb(state, entry.mediaType, entry.tmdbId));

    if (lookup.status === "not_found") {
      state.review(label, `tmdbId ${entry.tmdbId} (${entry.mediaType}) not found on TMDB`);
      return;
    }

    if (lookup.status === "ok" && !titlesCompatible(entryNames, lookup.details, entry.mediaType)) {
      state.review(label, `tmdbId ${entry.tmdbId} resolves to a different title on TMDB; fix tmdbId or add an alias`);
      return;
    }

    if (lookup.status === "ok" && entry.tmdbSeason && !seasonListed(lookup.details, entry.tmdbSeason)) {
      state.review(label, `TMDB lists no season ${entry.tmdbSeason} for tv ${entry.tmdbId}; fix tmdbSeason or tmdbId`);
      return;
    }
  }

  const record = {};
  mergeRecord(record, patch);
  await enrichRecord(state, record, entryNames);
  if (entry.origin === "discovery") sortEpisodeRows(record); // discovered rows arrive first; TMDB rows are appended

  const finished = finalizeNewRecord(record, state.nowIso);
  anime.push(finished); // appended: existing order is never disturbed
  state.addedRecords.add(finished);
  state.enrichAttempted.add(finished);
  state.addedIds.push(finished.id);
}

/* ------------------------------------------------------------------ */
/* Safety net and atomic write                                         */
/* ------------------------------------------------------------------ */

function assertNoLoss(original, updated) {
  for (const key of Object.keys(original)) {
    if (!(key in updated)) throw new Error(`Safety check failed: top-level "${key}" would be lost.`);
  }

  const before = Array.isArray(original.anime) ? original.anime : [];

  if (updated.anime.length < before.length) throw new Error("Safety check failed: records would be removed.");

  before.forEach((record, index) => {
    const after = updated.anime[index];

    if (!isPlainObject(record)) {
      if (JSON.stringify(record) !== JSON.stringify(after)) {
        throw new Error(`Safety check failed: record #${index} was altered.`);
      }
      return;
    }

    if (!isPlainObject(after) || String(record.id) !== String(after.id)) {
      throw new Error(`Safety check failed: record #${index} was replaced.`);
    }

    for (const key of Object.keys(record)) {
      if (!(key in after)) throw new Error(`Safety check failed: field "${key}" would be lost on record #${index}.`);
    }
  });
}

async function writeJsonAtomic(file, data, expectedCurrentText, label = "Catalog") {
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
  let handle = null;

  try {
    handle = await fs.open(tmp, "w", 0o644);
    await handle.writeFile(`${JSON.stringify(data, null, 2)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;

    JSON.parse(await fs.readFile(tmp, "utf8")); // the temp file must round-trip

    if (expectedCurrentText !== undefined && (await fs.readFile(file, "utf8")) !== expectedCurrentText) {
      throw new Error(`${label} changed on disk during the scan; aborting without writing.`);
    }

    const mode = await fs.stat(file).then((stat) => stat.mode, () => null);
    if (mode !== null) await fs.chmod(tmp, mode).catch(() => {});

    await fs.rename(tmp, file); // atomic replace: readers see the old or the new file, never half
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    await fs.unlink(tmp).catch(() => {});
    throw error;
  }
}

/* ------------------------------------------------------------------ */
/* Reporting                                                           */
/* ------------------------------------------------------------------ */

// The catalog-level zero-add reason: what the manifest did, plus (when discovery ran) what discovery did.
function explainZeroAdd(report) {
  const base = explainManifestZeroAdd(report);
  const discovery = report.discovery;

  return discovery && discovery.zeroAddReason ? `${base} Discovery: ${discovery.zeroAddReason}` : base;
}

function explainManifestZeroAdd(report) {
  if (!report.manifest.found) {
    return (
      `No official-source manifest found at ${report.manifest.path}. Nothing can be added without it: ` +
      "TMDB and YouTube search are not allowed to establish Tamil audio."
    );
  }

  if (report.manifest.entries === 0) return "The manifest has no entries.";

  const parts = [];
  if (report.alreadyInCatalog) parts.push(`${report.alreadyInCatalog} manifest entries were already in the catalog`);
  if (report.rejected.length) parts.push(`${report.rejected.length} rejected (see rejected)`);
  if (report.needsReview.length) parts.push(`${report.needsReview.length} need manual review (see needsReview)`);
  if (report.deferred.length) parts.push(`${report.deferred.length} deferred to the next run (see deferred)`);

  return parts.join("; ") || "No manifest entry produced a new record.";
}

function logScanSummary(report) {
  console.log(`\n=== SCAN RESULT: ${report.status === "zero-add" ? "ZERO-ADD" : "RECORDS ADDED"} ===`);
  console.log(`Catalog: ${report.catalogBefore} -> ${report.catalogAfter} titles`);
  console.log(`Manifest: ${report.manifest.found ? `${report.manifest.entries} entries` : "NOT FOUND"} (${report.manifest.path})`);
  console.log(`Added: ${report.added} | Existing updated: ${report.updatedExisting} | Already present: ${report.alreadyInCatalog}`);
  console.log(`Rejected: ${report.rejected.length} | Needs review: ${report.needsReview.length} | Deferred: ${report.deferred.length}`);

  if (report.zeroAddReason) console.log(`Reason: ${report.zeroAddReason}`);

  if (report.discovery) {
    const d = report.discovery;
    console.log(`Discovery: ${d.status}${d.skipReason ? ` (${d.skipReason})` : ""}${d.completeness ? ` | complete: ${d.completeness.complete} | pages: ${d.completeness.pagesProcessed}` : ""}`);

    if (d.counts) {
      console.log(
        `  videos seen: ${d.counts.videosSeen} | "Tamil Dub" titles: ${d.counts.tamilDubPrefixed} | excluded (other titles): ${d.counts.excludedNotTamilDub} | ` +
          `accepted: ${d.counts.accepted} | review: ${d.counts.review} | deferred: ${d.counts.deferred} | rejected: ${d.counts.rejected}`
      );
    }

    if (d.api) console.log(`  YouTube units used: ${d.api.unitsUsed}/${d.api.unitBudget} | failures: ${d.api.failures.length}`);
    if (d.zeroAddReason) console.log(`  discovery reason: ${d.zeroAddReason}`);
    for (const item of (d.review || []).slice(0, 10)) console.log(`  discovery review - ${item.videoId} "${item.title}": ${item.reason}`);
  }

  console.log(
    `TMDB: ${report.tmdb.enabled ? `${report.tmdb.requests} request(s), ${report.tmdb.failures} failure(s)` : "disabled"}` +
      (report.tmdb.unavailable.length ? ` | enrichment unavailable for ${report.tmdb.unavailable.length} item(s)` : "")
  );
  for (const item of report.tmdb.unavailable.slice(0, 10)) console.log(`  tmdb - ${item.entry}: ${item.reason}`);

  for (const [name, items] of [["rejected", report.rejected], ["review", report.needsReview], ["deferred", report.deferred]]) {
    for (const item of items.slice(0, 10)) console.log(`  ${name} - ${item.entry}: ${item.reason}`);
  }
}

/* ------------------------------------------------------------------ */
/* Main                                                                */
/* ------------------------------------------------------------------ */

async function run(options = {}) {
  const cfg = { ...readConfig(), ...options };
  for (const value of [cfg.tmdbApiKey, cfg.youtubeApiKey]) if (value) secrets.add(value);

  const nowIso = new Date().toISOString();
  const rel = (file) => path.relative(process.cwd(), file).split(path.sep).join("/") || file;

  console.log("Starting Tamil-dub anime catalog updater (add-only, official-source manifest)...");
  console.log(
    `TMDB metadata enrichment: ${
      cfg.tmdbApiKey
        ? "enabled"
        : "disabled (no TMDB_API_KEY): artwork, ratings, season dates and season episode rows are not fetched; existing and manifest data are kept"
    }`
  );
  console.log(`YouTube channel confirmation: ${cfg.youtubeApiKey ? "enabled" : "disabled (manifest-asserted)"}`);

  const originalText = await fs.readFile(cfg.catalogFile, "utf8");
  let original;

  try {
    original = JSON.parse(originalText.replace(/^\uFEFF/, ""));
  } catch (error) {
    throw new Error(`Existing catalog is not valid JSON; refusing to touch it: ${error.message}`);
  }

  if (!isPlainObject(original)) throw new Error("Existing catalog must be a JSON object; refusing to touch it.");
  if (original.anime !== undefined && !Array.isArray(original.anime)) {
    throw new Error('"anime" exists but is not an array; refusing to overwrite it.');
  }

  const working = structuredClone(original); // the original object is never mutated
  if (!Array.isArray(working.anime)) working.anime = [];

  const manifest = await loadManifest(cfg.manifestFile);
  const channels = new Map(manifest.channels.map((item) => [item.channelId, { name: item.name }]));

  for (const channelId of cfg.extraChannelIds) {
    if (!channels.has(channelId)) channels.set(channelId, { name: "Official YouTube channel" });
  }

  // Validate the whole manifest first so identity (which season each manifest id owns, which entries
  // contradict each other) never depends on the order entries are processed in.
  const prepared = manifest.entries.map((raw, index) => {
    const label = cleanText(raw && raw.title) || `entry #${index + 1}`;

    try {
      return { label, validation: validateEntry(raw, channels) };
    } catch (error) {
      return { label, error };
    }
  });

  const manifestAnalysis = analyzeManifestIdentities(
    prepared
      .filter((item) => item.validation && item.validation.ok)
      .map((item) => ({ label: item.label, entry: item.validation.entry }))
  );
  let analysis = manifestAnalysis; // widened below if discovery contributes entries

  const report = {
    scannedAt: nowIso,
    status: "zero-add",
    zeroAddReason: null,
    manifest: {
      path: rel(cfg.manifestFile),
      found: manifest.found,
      version: manifest.version,
      updatedAt: manifest.updatedAt,
      entries: manifest.entries.length
    },
    catalogBefore: working.anime.length,
    catalogAfter: working.anime.length,
    added: 0,
    addedIds: [],
    updatedExisting: 0,
    updatedIds: [],
    alreadyInCatalog: 0,
    rejected: [],
    needsReview: [],
    deferred: [],
    tmdb: {
      enabled: Boolean(cfg.tmdbApiKey),
      requests: 0,
      failures: 0,
      note: cfg.tmdbApiKey
        ? null
        : "TMDB_API_KEY not set: no TMDB metadata, season dates or season episode rows were fetched; existing and manifest data were kept.",
      unavailable: []
    }
  };

  const reviewSeen = new Set();
  const reviewByLabel = new Map(); // label -> reasons, so discovery can tell which groups the catalog refused
  const unavailableSeen = new Set();
  const state = {
    cfg,
    claims: manifestAnalysis.claims,
    nowIso,
    report,
    anime: working.anime,
    channelIds: new Set(channels.keys()),
    tmdbEnabled: Boolean(cfg.tmdbApiKey),
    tmdbCache: new Map(),
    enrichAttempted: new Set(),
    addedRecords: new Set(),
    addedIds: [],
    touched: new Set(),
    changeLog: [],
    alreadyInCatalog: 0,
    review(entry, reason) {
      if (!reviewByLabel.has(entry)) reviewByLabel.set(entry, []);
      if (!reviewByLabel.get(entry).includes(reason)) reviewByLabel.get(entry).push(reason);

      if (!reviewSeen.has(`${entry}|${reason}`)) {
        reviewSeen.add(`${entry}|${reason}`);
        report.needsReview.push({ entry, reason });
      }
    },
    // Enrichment that could not run (failed fetch, missing season): reported, never an error, data untouched.
    unavailable(record, reason) {
      const entry = cleanText(record && record.title) || String((record && record.id) || "record");

      if (!unavailableSeen.has(`${entry}|${reason}`)) {
        unavailableSeen.add(`${entry}|${reason}`);
        report.tmdb.unavailable.push({ entry, reason });
      }
    }
  };

  if (!manifest.found) console.warn(`WARNING: manifest not found at ${rel(cfg.manifestFile)}; no titles can be added.`);

  /* ---- Automatic discovery (opt-in). Runs BEFORE the manifest loop only to learn what the channel has; every ---- */
  /* ---- discovered entry still goes through validateEntry/processEntry below, after the manifest entries.     ---- */
  const discoveryEnabled = Boolean(cfg.discovery && cfg.discovery.enabled);
  const discoveredPrepared = [];
  const discoveryResults = new Map();
  let discoverySession = null;
  let discoveryFailure = null;
  let stateFileText = null;
  let addedByDiscovery = 0;

  if (discoveryEnabled) {
    try {
      stateFileText = await fs.readFile(cfg.discoveryStateFile, "utf8").catch((error) => {
        if (error.code === "ENOENT") return null;
        throw error;
      });

      const parsedState = parseState(stateFileText);
      if (parsedState.problem) console.warn(`Discovery state: ${parsedState.problem}`);

      discoverySession = await startDiscovery({
        cfg: cfg.discovery,
        youtubeApiKey: cfg.youtubeApiKey,
        channels,
        state: parsedState.state,
        anime: working.anime,
        claims: manifestAnalysis.claims,
        tmdb: createDiscoveryTmdb(state),
        helpers: { normalizeTitle, recordTmdbKey },
        nowIso,
        region: cfg.region,
        redact,
        sleep: cfg.sleep,
        random: cfg.random,
        catalogProvenance: provenanceRows(working.anime)
      });

      if (parsedState.problem) discoverySession.report.notes.push(parsedState.problem);

      for (const group of discoverySession.groups) {
        try {
          discoveredPrepared.push({ label: group.label, group, validation: validateEntry(group.raw, channels, { discovery: true }) });
        } catch (error) {
          discoveredPrepared.push({ label: group.label, group, error });
        }
      }

      analysis = analyzeManifestIdentities(
        [...prepared, ...discoveredPrepared]
          .filter((item) => item.validation && item.validation.ok)
          .map((item) => ({ label: item.label, entry: item.validation.entry }))
      );
      state.claims = analysis.claims;
    } catch (error) {
      // Discovery must never take the manifest path down, and a failed discovery never moves a checkpoint.
      discoverySession = null;
      discoveryFailure = errorMessage(error);
      console.warn(`Discovery failed unexpectedly (checkpoints unchanged): ${discoveryFailure}`);
    }
  }

  for (const item of prepared) {
    const { label } = item;

    try {
      if (item.error) throw item.error;

      const validation = item.validation;

      if (!validation.ok) {
        report.rejected.push({ entry: label, reason: validation.reason });
        continue;
      }

      for (const problem of validation.problems) console.warn(`${label}: ignored one evidence item (${problem})`);
      for (const warning of validation.warnings || []) state.review(label, `manifest note: ${warning}`);

      const entry = validation.entry;
      const conflict = analysis.conflicts.get(entry);

      if (conflict) {
        state.review(label, conflict);
        continue;
      }

      const confirmed = [];
      const failures = [];
      let deferred = false;

      for (const evidence of entry.evidence) {
        const check = await confirmYouTubeEvidence(evidence, cfg);

        if (check.ok) {
          confirmed.push(evidence);
        } else {
          failures.push(check.reason);
          deferred = deferred || Boolean(check.deferred);
        }
      }

      if (!confirmed.length) {
        (deferred ? report.deferred : report.rejected).push({ entry: label, reason: failures.join("; ") });
        continue;
      }

      entry.evidence = confirmed;
      await processEntry(state, entry, label);
    } catch (error) {
      report.rejected.push({ entry: label, reason: `unexpected error: ${errorMessage(error)}` });
    }
  }

  /* ---- Discovered entries: the same validated merge path as manifest entries ------------------------------- */
  for (const item of discoveredPrepared) {
    const { label } = item;
    const addedBefore = state.addedIds.length;

    try {
      if (item.error) throw item.error;

      const validation = item.validation;

      if (!validation.ok) {
        discoveryResults.set(label, { ok: false, reason: `entry rejected by validation: ${validation.reason}` });
        continue;
      }

      const entry = validation.entry;
      const conflict = analysis.conflicts.get(entry);

      if (conflict) {
        state.review(label, conflict);
        discoveryResults.set(label, { ok: false, reason: conflict });
        continue;
      }

      // Ownership of every video was confirmed through videos.list during the scan; no second call is needed.
      for (const evidence of entry.evidence) evidence.channelCheck = "api-confirmed";

      await processEntry(state, entry, label);

      const reasons = reviewByLabel.get(label) || [];
      discoveryResults.set(label, reasons.length ? { ok: false, reason: reasons.join("; ") } : { ok: true });
      addedByDiscovery += state.addedIds.length - addedBefore;
    } catch (error) {
      discoveryResults.set(label, { ok: false, deferred: true, reason: `unexpected error: ${errorMessage(error)}` });
    }
  }

  // Videos that went private, regional-blocked, retitled or missing are recorded on their provenance row only.
  if (discoverySession && !discoverySession.skipped && discoverySession.availabilityUpdates.size) {
    for (const record of state.anime) {
      if (applyAvailability(record, discoverySession.availabilityUpdates)) {
        state.touched.add(record);
        state.changeLog.push({ id: record.id, fields: ["discoveryProvenance"] });
      }
    }
  }

  let settledDiscovery = null;

  if (discoverySession) {
    settledDiscovery = discoverySession.finalize(discoveryResults, { addedByDiscovery });
    report.discovery = settledDiscovery.report;
  } else if (discoveryEnabled) {
    report.discovery = {
      status: "error",
      skipReason: null,
      scannedAt: nowIso,
      error: short(discoveryFailure, 300),
      zeroAddReasonCode: "api-error",
      zeroAddReason: `Discovery failed unexpectedly and changed nothing (checkpoints unchanged): ${short(discoveryFailure, 200)}`
    };
  }

  // Enrich other officially verified records that still miss metadata.
  for (const record of state.anime) {
    if (!isPlainObject(record) || state.enrichAttempted.has(record)) continue;

    try {
      const changed = await enrichRecord(state, record);

      if (changed.length) {
        state.touched.add(record);
        state.changeLog.push({ id: record.id, fields: [...new Set(changed)] });
      }
    } catch (error) {
      console.warn(`Enrichment skipped for ${record.id}: ${errorMessage(error)}`);
    }
  }

  const updatedExisting = [...state.touched].filter((record) => !state.addedRecords.has(record));

  report.added = state.addedRecords.size;
  report.addedIds = state.addedIds.slice(0, MAX_REPORT_ITEMS);
  report.updatedExisting = updatedExisting.length;
  report.updatedIds = state.changeLog.filter((item) => !state.addedIds.includes(item.id)).slice(0, MAX_REPORT_ITEMS);
  report.alreadyInCatalog = state.alreadyInCatalog;
  report.catalogAfter = working.anime.length;
  report.status = report.added > 0 ? "added" : "zero-add";
  report.zeroAddReason = report.added > 0 ? null : explainZeroAdd(report);

  for (const key of ["rejected", "needsReview", "deferred"]) report[key] = report[key].slice(0, MAX_REPORT_ITEMS);
  report.tmdb.unavailable = report.tmdb.unavailable.slice(0, MAX_REPORT_ITEMS);

  // Only updater-owned metadata changes; every other top-level property is kept as-is.
  if (report.added > 0 || updatedExisting.length > 0 || isEmptyValue(working.lastUpdated)) {
    working.lastUpdated = nowIso;
  }

  if (isEmptyValue(working.region)) working.region = cfg.region;

  // When discovery really scanned, the coverage text says so; otherwise the original wording is kept verbatim.
  const discoveryScanned = Boolean(discoverySession && !discoverySession.skipped);

  working.updateInfo = {
    ...(isPlainObject(working.updateInfo) ? working.updateInfo : {}),
    automatic: true,
    source: discoveryScanned
      ? "Official-source manifest plus automatic discovery from allow-listed official YouTube channels (Muse India), Crunchyroll, Netflix, Amazon Prime Video"
      : "Official-source manifest (Muse India YouTube, Crunchyroll, Netflix, Amazon Prime Video)",
    metadataSource: "TMDB (artwork, rating, dates and metadata only, for already-verified titles)",
    youtubeEnabled: Boolean(cfg.youtubeApiKey),
    tmdbEnabled: Boolean(cfg.tmdbApiKey),
    discoveredAnime: report.added,
    manualAnime: working.anime.filter(
      (record) => isPlainObject(record) && !String(record.id || "").startsWith("tmdb-")
    ).length,
    tamilDubVerification: "Required: every added title needs tamilDubVerified:true and an official-source URL",
    note: discoveryScanned
      ? 'Discovery covers only allow-listed official YouTube channels and only videos whose title starts with "Tamil Dub"; ' +
        "it is not an exhaustive scan of Netflix, Prime Video or Crunchyroll Tamil dubs. " +
        "Streaming-provider availability does not prove Tamil audio."
      : "Coverage is limited to titles listed in the official-source manifest; it is not an exhaustive " +
        "scan of all Tamil-dubbed anime. Streaming-provider availability does not prove Tamil audio.",
    lastScan: report
  };

  assertNoLoss(original, working);
  await writeJsonAtomic(cfg.catalogFile, working, originalText);

  // The checkpoint is written only after the catalog it describes. A crash in between just repeats some pages.
  if (settledDiscovery && !discoverySession.skipped) {
    await writeJsonAtomic(
      cfg.discoveryStateFile,
      serializeState(settledDiscovery.state),
      stateFileText === null ? undefined : stateFileText,
      "Discovery state"
    );
  }

  logScanSummary(report);
  console.log(`Catalog written successfully: ${working.anime.length} titles`);

  return report;
}

async function main() {
  const cfg = readConfig();
  const report = await run(cfg);

  if (report.status === "zero-add" && cfg.failOnZeroAdd) {
    console.error("FAIL_ON_ZERO_ADD is set and this scan added nothing.");
    process.exitCode = 3;
  }
}

module.exports = {
  run,
  readConfig,
  classifyOfficialUrl,
  validateEntry,
  normalizeTitle,
  recordTmdbKey,
  recordSeasonKey,
  tmdbSeasonKey,
  matchIdentity,
  analyzeManifestIdentities,
  createSeasonEpisodes,
  resolveTitleMatch,
  mergeRecord,
  mergeEpisodes,
  isEmptyValue,
  writeJsonAtomic,
  sortEpisodeRows,
  explainZeroAdd
};

if (require.main === module) {
  main().catch((error) => {
    console.error("Updater failed:");
    console.error(redact(error && error.stack ? error.stack : error));
    process.exit(1);
  });
    }
