"use strict";

/*
 * Minimal YouTube Data API v3 client for the updater (server-side only; the key comes from the environment).
 *
 * Endpoints used, all 1 quota unit per call (https://developers.google.com/youtube/v3/determine_quota_cost,
 * checked 2026-10-03; default allocation 10,000 units/day for projects, reset at midnight Pacific Time):
 *   channels.list       part=snippet,contentDetails   -> verifies the channel ID and gets the uploads playlist
 *   playlistItems.list  part=snippet,contentDetails   -> pages of the uploads playlist (maxResults <= 50)
 *   videos.list         part=snippet,contentDetails,status, up to 50 ids per call
 * search.list is NOT used: it has its own default bucket of 100 calls/day, and a search hit cannot prove who owns
 * a video. Ownership comes only from videos.list snippet.channelId matched against the channel allow-list.
 *
 * Every request attempt is counted against a per-run unit budget (invalid requests also cost at least 1 unit).
 * The API key is never put in an error message, report or log line.
 */

const API_BASE = "https://www.googleapis.com/youtube/v3";
const UNIT_COST = 1;
const MAX_IDS_PER_CALL = 50;

class YouTubeApiError extends Error {
  constructor(message, { kind, status = null, reason = "", endpoint = "", retriable = false } = {}) {
    super(message);
    this.name = "YouTubeApiError";
    this.kind = kind; // quota | auth | rate-limit | not-found | bad-page-token | bad-request | server | network | timeout | budget | http
    this.status = status;
    this.reason = reason;
    this.endpoint = endpoint;
    this.retriable = retriable;
  }
}

const QUOTA_REASONS = /quotaExceeded|dailyLimitExceeded/i;
const RATE_REASONS = /rateLimitExceeded|userRateLimitExceeded|RATE_LIMIT_EXCEEDED/i;
const AUTH_REASONS = /keyInvalid|API_KEY_INVALID|API key not valid|accessNotConfigured|SERVICE_DISABLED|API_KEY_SERVICE_BLOCKED|ipRefererBlocked|forbidden|PERMISSION_DENIED|keyExpired|API_KEY_HTTP_REFERRER_BLOCKED/i;

function errorDetails(body) {
  const error = body && typeof body === "object" ? body.error : null;
  const first = error && Array.isArray(error.errors) ? error.errors[0] : null;

  return {
    reason: String((first && first.reason) || (error && error.status) || ""),
    message: String((error && error.message) || "")
  };
}

function classifyHttpError(status, body) {
  const { reason, message } = errorDetails(body);
  const probe = `${reason} ${message}`;

  if (status === 403 && QUOTA_REASONS.test(probe)) return { kind: "quota", retriable: false, reason };
  if (status === 429 || RATE_REASONS.test(probe)) return { kind: "rate-limit", retriable: true, reason };
  if (status === 401 || AUTH_REASONS.test(probe)) return { kind: "auth", retriable: false, reason };
  if (status === 404) return { kind: "not-found", retriable: false, reason };
  if (status === 400 && /pageToken/i.test(probe)) return { kind: "bad-page-token", retriable: false, reason };
  if (status === 400) return { kind: "bad-request", retriable: false, reason };
  if (status >= 500) return { kind: "server", retriable: true, reason };

  return { kind: "http", retriable: false, reason };
}

const defaultSleep = (ms) => (ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve());

function createYouTubeClient({
  apiKey,
  fetchImpl = (url, init) => globalThis.fetch(url, init), // resolved at call time so tests can swap globalThis.fetch
  sleep = defaultSleep,
  random = Math.random,
  retries = 3,
  backoffBaseMs = 500,
  backoffMaxMs = 15000,
  timeoutMs = 20000,
  unitBudget = Infinity,
  redact = (text) => text
} = {}) {
  const usage = { units: 0, requests: 0, failures: [] };

  const safe = (text) => {
    let clean = redact(String(text));
    if (apiKey) clean = clean.split(apiKey).join("***");
    return clean;
  };

  async function request(endpoint, params) {
    const url = new URL(`${API_BASE}/${endpoint}`);
    for (const [key, value] of Object.entries(params)) if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, value);
    url.searchParams.set("key", apiKey);

    let lastError;

    for (let attempt = 0; attempt <= retries; attempt++) {
      if (usage.units + UNIT_COST > unitBudget) {
        throw new YouTubeApiError(`quota budget of ${unitBudget} units for this run is used up`, { kind: "budget", endpoint });
      }

      usage.units += UNIT_COST;
      usage.requests++;

      let retryAfterMs = 0;

      try {
        const response = await fetchImpl(url.toString(), {
          headers: { Accept: "application/json", "User-Agent": "Tamil-Dub-Anime-Catalog/3.0" },
          signal: AbortSignal.timeout(timeoutMs)
        });

        const raw = await response.text();
        let body = null;

        try {
          body = raw ? JSON.parse(raw) : null;
        } catch {
          body = null;
        }

        if (response.ok) {
          if (!body || typeof body !== "object") {
            throw new YouTubeApiError(`${endpoint} returned an unreadable body`, { kind: "server", status: response.status, endpoint, retriable: true });
          }
          return body;
        }

        const classified = classifyHttpError(response.status, body);
        const header = response.headers && typeof response.headers.get === "function" ? Number(response.headers.get("retry-after")) : NaN;
        if (Number.isFinite(header) && header > 0) retryAfterMs = Math.min(header * 1000, backoffMaxMs);

        throw new YouTubeApiError(
          safe(`${endpoint} failed: HTTP ${response.status}${classified.reason ? ` (${classified.reason})` : ""}`),
          { kind: classified.kind, status: response.status, reason: classified.reason, endpoint, retriable: classified.retriable }
        );
      } catch (error) {
        let failure = error;

        if (!(error instanceof YouTubeApiError)) {
          const timedOut = error && (error.name === "TimeoutError" || error.name === "AbortError");
          failure = new YouTubeApiError(safe(`${endpoint} ${timedOut ? "timed out" : "network error"}: ${error && error.message ? error.message : error}`), {
            kind: timedOut ? "timeout" : "network",
            endpoint,
            retriable: true
          });
        }

        lastError = failure;
        if (!failure.retriable || attempt === retries) break;

        const backoff = Math.min(backoffMaxMs, backoffBaseMs * 2 ** attempt) + Math.floor(random() * backoffBaseMs);
        await sleep(Math.max(backoff, retryAfterMs));
      }
    }

    usage.failures.push({ endpoint, kind: lastError.kind, status: lastError.status, reason: lastError.reason });
    throw lastError;
  }

  async function getChannel(channelId) {
    const body = await request("channels", { part: "snippet,contentDetails", id: channelId, maxResults: 1 });
    const item = Array.isArray(body.items) ? body.items[0] : null;

    if (!item || typeof item !== "object") return null;

    const related = item.contentDetails && item.contentDetails.relatedPlaylists;

    return {
      id: String(item.id || ""),
      title: String((item.snippet && item.snippet.title) || ""),
      uploadsPlaylistId: related && typeof related.uploads === "string" ? related.uploads : ""
    };
  }

  async function listUploads(playlistId, pageToken) {
    const body = await request("playlistItems", {
      part: "snippet,contentDetails",
      playlistId,
      maxResults: MAX_IDS_PER_CALL,
      pageToken
    });

    const items = [];

    for (const item of Array.isArray(body.items) ? body.items : []) {
      const videoId = (item && item.contentDetails && item.contentDetails.videoId) || (item && item.snippet && item.snippet.resourceId && item.snippet.resourceId.videoId);
      if (typeof videoId !== "string" || !/^[A-Za-z0-9_-]{11}$/.test(videoId)) continue;

      items.push({
        videoId,
        title: String((item.snippet && item.snippet.title) || ""),
        publishedAt: String((item.contentDetails && item.contentDetails.videoPublishedAt) || ""),
        addedAt: String((item.snippet && item.snippet.publishedAt) || "")
      });
    }

    return { items, nextPageToken: typeof body.nextPageToken === "string" && body.nextPageToken ? body.nextPageToken : null };
  }

  async function getVideos(videoIds) {
    const ids = [...new Set(videoIds)].filter((id) => /^[A-Za-z0-9_-]{11}$/.test(id));
    const found = new Map();

    for (let i = 0; i < ids.length; i += MAX_IDS_PER_CALL) {
      const body = await request("videos", { part: "snippet,contentDetails,status", id: ids.slice(i, i + MAX_IDS_PER_CALL).join(",") });

      for (const item of Array.isArray(body.items) ? body.items : []) {
        const video = normalizeVideo(item);
        if (video) found.set(video.videoId, video);
      }
    }

    return found; // ids missing from the map were not returned: deleted, private, or otherwise not visible to a key
  }

  return { getChannel, listUploads, getVideos, usage };
}

/* ISO-8601 duration ("PT1H2M3S", "P0D") -> seconds; null when unreadable. */
function parseDuration(value) {
  const match = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(String(value || ""));
  if (!match) return null;

  const [, d, h, m, s] = match;
  return Number(d || 0) * 86400 + Number(h || 0) * 3600 + Number(m || 0) * 60 + Number(s || 0);
}

function normalizeRestriction(value) {
  if (!value || typeof value !== "object") return null;

  const list = (items) => (Array.isArray(items) ? items.filter((code) => typeof code === "string" && /^[A-Z]{2}$/.test(code)).slice(0, 300) : undefined);
  const allowed = list(value.allowed);
  const blocked = list(value.blocked);

  return allowed || blocked ? { ...(allowed ? { allowed } : {}), ...(blocked ? { blocked } : {}) } : null;
}

/* Only the fields the scan needs, bounded in size. Never the raw response. */
function normalizeVideo(item) {
  if (!item || typeof item !== "object" || typeof item.id !== "string" || !/^[A-Za-z0-9_-]{11}$/.test(item.id)) return null;

  const snippet = item.snippet && typeof item.snippet === "object" ? item.snippet : {};
  const details = item.contentDetails && typeof item.contentDetails === "object" ? item.contentDetails : {};
  const status = item.status && typeof item.status === "object" ? item.status : {};

  return {
    videoId: item.id,
    channelId: String(snippet.channelId || ""),
    title: String(snippet.title || "").slice(0, 300),
    description: String(snippet.description || "").slice(0, 600),
    publishedAt: String(snippet.publishedAt || ""),
    liveBroadcastContent: String(snippet.liveBroadcastContent || "none"),
    defaultLanguage: String(snippet.defaultLanguage || ""),
    defaultAudioLanguage: String(snippet.defaultAudioLanguage || ""),
    durationSeconds: parseDuration(details.duration),
    regionRestriction: normalizeRestriction(details.regionRestriction),
    privacyStatus: String(status.privacyStatus || ""),
    uploadStatus: String(status.uploadStatus || "")
  };
}

/* Is the video watchable in a region, as far as the returned restriction metadata says? true / false / null (unknown). */
function playableIn(video, region) {
  const restriction = video && video.regionRestriction;
  if (!restriction) return true; // no restriction metadata: not blocked as far as the API says (not a playback guarantee)

  if (restriction.blocked && restriction.blocked.includes(region)) return false;
  if (restriction.allowed && !restriction.allowed.includes(region)) return false;

  return true;
}

module.exports = { YouTubeApiError, createYouTubeClient, classifyHttpError, parseDuration, normalizeVideo, playableIn, MAX_IDS_PER_CALL };
