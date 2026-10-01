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
 *     "year": 2005,                                // or "firstAirDate": "2005-04-01"
 *     "id": "optional-explicit-id", "originalTitle": "", "aliases": [],
 *     "description": "", "image": "", "tags": []
 *   }]
 * }
 *
 * Env: TMDB_API_KEY, YOUTUBE_API_KEY (both optional), CONTENT_REGION,
 * ANIME_DATA_FILE, OFFICIAL_MANIFEST_PATH, OFFICIAL_YOUTUBE_CHANNEL_IDS
 * (comma list), FAIL_ON_ZERO_ADD. API keys are read from the environment only.
 */

const fs = require("fs/promises");
const path = require("path");
const crypto = require("crypto");

const USER_AGENT = "Tamil-Dub-Anime-Catalog/3.0";
const REQUIRED_PLATFORMS = ["Crunchyroll", "Netflix", "Amazon Prime Video"];
const PLACEHOLDER_DESCRIPTION = "No description available.";
const MAX_REPORT_ITEMS = 50;
const MAX_TAGS = 8;
const MAX_EPISODES = 200;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

const SOURCE_LABELS = {
  Crunchyroll: "Crunchyroll official listing/announcement",
  Netflix: "Netflix official listing/announcement",
  "Amazon Prime Video": "Amazon Prime Video official listing"
};

const RECORD_KEY_ORDER = [
  "id", "title", "originalTitle", "description", "image", "backdrop", "rating",
  "likes", "availability", "status", "firstAirDate", "createdAt", "updatedAt",
  "isNew", "tags", "platforms", "episodes", "youtube", "tamilDubVerified",
  "tamilDubVerificationSource", "tamilDubVerificationUrl", "tamilDubVerifiedAt",
  "tamilDubEvidence", "inclusionSource", "tmdbId", "tmdbUrl", "mediaType", "region"
];

// TMDB may fill these, but only when missing/placeholder on a verified title.
const ENRICHABLE_KEYS = [
  "originalTitle", "description", "image", "backdrop", "rating",
  "status", "firstAirDate", "createdAt", "tags"
];

// Merged by dedicated logic instead of the generic fill-if-empty rule.
const SPECIAL_KEYS = new Set([
  "tamilDubVerified", "tamilDubVerificationSource", "tamilDubVerificationUrl",
  "tamilDubVerifiedAt", "tamilDubEvidence", "platforms",
  "tmdbId", "tmdbUrl", "mediaType"
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
    tmdbDelayMs: 120
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

function validateEntry(raw, channels) {
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

  let id = cleanText(raw.id);
  if (!id) {
    if (tmdbId) id = mediaType === "movie" ? `tmdb-movie-${tmdbId}` : `tmdb-${tmdbId}`;
    else if (year) id = `official-${slugify(title)}-${year}`;
    else return reject("needs an explicit id, a tmdbId, or a year to build a stable ID");
  }

  return {
    ok: true,
    problems,
    entry: {
      id,
      title,
      originalTitle: cleanText(raw.originalTitle),
      aliases: Array.isArray(raw.aliases) ? uniqueStrings(raw.aliases) : [],
      mediaType,
      tmdbId,
      firstAirDate,
      year,
      description: cleanText(raw.description),
      image: isHttpsUrl(cleanText(raw.image)) ? cleanText(raw.image) : "",
      backdrop: isHttpsUrl(cleanText(raw.backdrop)) ? cleanText(raw.backdrop) : "",
      tags: Array.isArray(raw.tags) ? uniqueStrings(raw.tags) : [],
      evidence
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

  return changed;
}

function mergeRecord(target, patch) {
  const changed = mergeMissing(target, patch);

  if (mergeTmdbIdentity(target, patch)) changed.push("tmdbId");

  const verification = mergeVerification(target, patch);
  changed.push(...verification.changed);

  if (!verification.conflict && mergePlatforms(target, patch.platforms)) changed.push("platforms");

  return { changed, conflict: verification.conflict };
}

/* ------------------------------------------------------------------ */
/* Record construction                                                 */
/* ------------------------------------------------------------------ */

function buildManifestPatch(entry, region) {
  const primary = entry.evidence[0];
  const verifiedPlatforms = new Map();

  for (const item of entry.evidence) {
    if (!verifiedPlatforms.has(item.platform)) {
      verifiedPlatforms.set(item.platform, {
        name: item.platform,
        available: true,
        officialUrl: item.url,
        tamilDubVerified: true,
        tamilDubVerificationUrl: item.url
      });
    }
  }

  const platforms = [...verifiedPlatforms.values()];

  for (const name of REQUIRED_PLATFORMS) {
    if (!verifiedPlatforms.has(name)) {
      platforms.push({ name, available: false, officialUrl: null, tamilDubVerified: false });
    }
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
    youtube: entry.evidence
      .filter((item) => item.platform === "YouTube")
      .map((item) => ({ title: entry.title, url: item.url })),
    tamilDubVerified: true,
    tamilDubVerificationSource: primary.source,
    tamilDubVerificationUrl: primary.url,
    tamilDubVerifiedAt: primary.checkedAt || "",
    tamilDubEvidence: entry.evidence,
    inclusionSource: "official-source-manifest",
    region
  };

  if (entry.tmdbId) {
    patch.tmdbId = entry.tmdbId;
    patch.tmdbUrl = `https://www.themoviedb.org/${entry.mediaType}/${entry.tmdbId}`;
    patch.mediaType = entry.mediaType;
  }

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

function tmdbDate(details, type) {
  return (type === "movie" ? details.release_date : details.first_air_date) || null;
}

function tmdbMetadata(details, type) {
  const isTv = type === "tv";
  const title = cleanText(isTv ? details.name : details.title);
  const original = cleanText(isTv ? details.original_name : details.original_title);
  const date = tmdbDate(details, type);
  const status = details.status || null;

  let availability = "Available";
  if (isTv && status === "Ended") availability = "Completed";
  else if (isTv && status === "Returning Series") availability = "Ongoing";

  return {
    title,
    originalTitle: original || title,
    description: cleanText(details.overview),
    image: details.poster_path ? `https://image.tmdb.org/t/p/w500${details.poster_path}` : null,
    backdrop: details.backdrop_path ? `https://image.tmdb.org/t/p/w1280${details.backdrop_path}` : null,
    rating: typeof details.vote_average === "number" ? Number(details.vote_average.toFixed(1)) : null,
    availability,
    status,
    firstAirDate: date,
    createdAt: date ? `${date}T00:00:00Z` : null,
    tags: createTags(details),
    episodes: isTv ? createEpisodes(details) : []
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

function needsEnrichment(record, type) {
  const missing = ENRICHABLE_KEYS.some(
    (key) => isEmptyValue(record[key]) || isPlaceholderValue(key, record[key])
  );

  return missing || (type === "tv" && isEmptyValue(record.episodes));
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

async function enrichRecord(state, record, extraNames = []) {
  state.enrichAttempted.add(record);

  if (!state.tmdbEnabled || !isOfficiallyVerified(record, state.channelIds)) return [];

  const key = recordTmdbKey(record);
  if (!key) return [];

  const [type, rawId] = key.split(":");
  if (!needsEnrichment(record, type)) return [];

  const lookup = await lookupTmdb(state, type, Number(rawId));
  if (lookup.status !== "ok") return [];

  if (!titlesCompatible(recordNames(record, extraNames), lookup.details, type)) {
    state.review(
      record.title || record.id,
      "TMDB title does not match the catalog title; enrichment skipped (add an alias or fix tmdbId)"
    );
    return [];
  }

  return mergeMissing(record, tmdbMetadata(lookup.details, type));
}

/* ------------------------------------------------------------------ */
/* Per-entry processing                                                */
/* ------------------------------------------------------------------ */

async function processEntry(state, entry, label) {
  const { anime, cfg } = state;
  const entryKey = entry.tmdbId ? `${entry.mediaType}:${entry.tmdbId}` : null;
  const entryNames = [entry.title, entry.originalTitle, ...entry.aliases];

  // 1. Stable identity: exact ID, or a known TMDB key including media type.
  const hits = anime.filter(
    (record) =>
      isPlainObject(record) &&
      ((!isEmptyValue(record.id) && String(record.id) === entry.id) ||
        (entryKey && recordTmdbKey(record) === entryKey))
  );

  if (hits.length > 1) {
    state.review(label, "identity matches several existing records; resolve the duplicates manually");
    return;
  }

  let target = hits[0] || null;
  let entryLookup = null;

  // 2. Title match, only when release years prove it is the same production.
  if (!target) {
    const candidates = anime.filter((record) => {
      if (!isPlainObject(record) || !titlesOverlap(entry, record)) return false;

      const key = recordTmdbKey(record);
      return !(entryKey && key && key !== entryKey);
    });

    if (candidates.length) {
      let year = entry.year;

      if (year === null && entryKey && state.tmdbEnabled) {
        entryLookup = await lookupTmdb(state, entry.mediaType, entry.tmdbId);
        if (entryLookup.status === "ok") year = yearOf(tmdbDate(entryLookup.details, entry.mediaType));
      }

      const decision = resolveTitleMatch(year, candidates);

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
  }

  const record = {};
  mergeRecord(record, patch);
  await enrichRecord(state, record, entryNames);

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

async function writeJsonAtomic(file, data, expectedCurrentText) {
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
      throw new Error("Catalog changed on disk during the scan; aborting without writing.");
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

function explainZeroAdd(report) {
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
  console.log(`TMDB metadata enrichment: ${cfg.tmdbApiKey ? "enabled" : "disabled (no TMDB_API_KEY)"}`);
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
    tmdb: { enabled: Boolean(cfg.tmdbApiKey), requests: 0, failures: 0 }
  };

  const reviewSeen = new Set();
  const state = {
    cfg,
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
      if (!reviewSeen.has(`${entry}|${reason}`)) {
        reviewSeen.add(`${entry}|${reason}`);
        report.needsReview.push({ entry, reason });
      }
    }
  };

  if (!manifest.found) console.warn(`WARNING: manifest not found at ${rel(cfg.manifestFile)}; no titles can be added.`);

  for (let index = 0; index < manifest.entries.length; index++) {
    const raw = manifest.entries[index];
    const label = cleanText(raw && raw.title) || `entry #${index + 1}`;

    try {
      const validation = validateEntry(raw, channels);

      if (!validation.ok) {
        report.rejected.push({ entry: label, reason: validation.reason });
        continue;
      }

      for (const problem of validation.problems) console.warn(`${label}: ignored one evidence item (${problem})`);

      const entry = validation.entry;
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

  // Only updater-owned metadata changes; every other top-level property is kept as-is.
  if (report.added > 0 || updatedExisting.length > 0 || isEmptyValue(working.lastUpdated)) {
    working.lastUpdated = nowIso;
  }

  if (isEmptyValue(working.region)) working.region = cfg.region;

  working.updateInfo = {
    ...(isPlainObject(working.updateInfo) ? working.updateInfo : {}),
    automatic: true,
    source: "Official-source manifest (Muse India YouTube, Crunchyroll, Netflix, Amazon Prime Video)",
    metadataSource: "TMDB (artwork, rating, dates and metadata only, for already-verified titles)",
    youtubeEnabled: Boolean(cfg.youtubeApiKey),
    tmdbEnabled: Boolean(cfg.tmdbApiKey),
    discoveredAnime: report.added,
    manualAnime: working.anime.filter(
      (record) => isPlainObject(record) && !String(record.id || "").startsWith("tmdb-")
    ).length,
    tamilDubVerification: "Required: every added title needs tamilDubVerified:true and an official-source URL",
    note:
      "Coverage is limited to titles listed in the official-source manifest; it is not an exhaustive " +
      "scan of all Tamil-dubbed anime. Streaming-provider availability does not prove Tamil audio.",
    lastScan: report
  };

  assertNoLoss(original, working);
  await writeJsonAtomic(cfg.catalogFile, working, originalText);

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
  resolveTitleMatch,
  mergeRecord,
  isEmptyValue,
  writeJsonAtomic
};

if (require.main === module) {
  main().catch((error) => {
    console.error("Updater failed:");
    console.error(redact(error && error.stack ? error.stack : error));
    process.exit(1);
  });
      }
