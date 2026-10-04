"use strict";

// Mocks for the discovery suites: a fake YouTube Data API, a fake TMDB (search + details + seasons), and a runner
// around updater.run(). No network and no real keys: every key below is a visible test placeholder.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { updater, CHANNEL, OTHER_CHANNEL, clone } = require("./harness");

const TEST_KEY = "TEST-YT-KEY-0000";
const TEST_TMDB_KEY = "TEST-TMDB-KEY-0000";

const vid = (n) => `vid${String(n).padStart(8, "0")}`; // 11 characters, valid video ID shape
const PLAYLIST = "UUaaaaaaaaaaaaaaaaaaaaaa";
const daysAgo = (days) => new Date(Date.now() - days * 24 * 3600 * 1000).toISOString(); // test dates that must stay "recent" are relative to the real clock

// A video as videos.list returns it.
function video(id, title, extra = {}) {
  const { channelId = CHANNEL, publishedAt = "2026-09-01T10:00:00Z", duration = "PT24M10S", description = "", privacyStatus = "public", uploadStatus = "processed", liveBroadcastContent = "none", regionRestriction, defaultAudioLanguage } = extra;

  return {
    id,
    snippet: { channelId, title, description, publishedAt, liveBroadcastContent, ...(defaultAudioLanguage ? { defaultAudioLanguage } : {}) },
    contentDetails: { duration, ...(regionRestriction ? { regionRestriction } : {}) },
    status: { privacyStatus, uploadStatus }
  };
}

/*
 * Fake YouTube. `uploads` is the uploads playlist, newest first: an array of video resources (or { id, hidden: true }
 * for a playlist entry that videos.list does not return). `plan.fail(url, info)` may return a { status, body } error
 * or throw to simulate a network failure. `requests` logs every call.
 */
function createYouTube({ channelId = CHANNEL, returnedChannelId, uploads = [], pageSize = 50, extraVideos = [], plan = {} } = {}) {
  const requests = [];
  const byId = new Map();

  for (const item of [...uploads, ...extraVideos]) if (!item.hidden) byId.set(item.id, item);

  const handler = (url) => {
    const u = new URL(url);
    const endpoint = u.pathname.split("/").pop();
    const info = { endpoint, params: Object.fromEntries(u.searchParams), url };
    requests.push(info);

    if (plan.fail) {
      const failure = plan.fail(url, info, requests.length);
      if (failure) return failure;
    }

    if (endpoint === "channels") {
      if (plan.noChannel) return { body: { items: [] } };
      return { body: { items: [{ id: returnedChannelId || channelId, snippet: { title: "Muse India" }, contentDetails: { relatedPlaylists: { uploads: PLAYLIST } } }] } };
    }

    if (endpoint === "playlistItems") {
      const offset = info.params.pageToken ? Number(info.params.pageToken.replace("PAGE", "")) : 0;
      if (Number.isNaN(offset)) return { status: 400, body: { error: { code: 400, message: "Invalid page token", errors: [{ reason: "invalidPageToken" }] } } };

      const slice = uploads.slice(offset, offset + pageSize);
      const next = offset + pageSize < uploads.length ? `PAGE${offset + pageSize}` : undefined;

      return {
        body: {
          items: slice.map((item) => ({
            snippet: { title: item.hidden ? "Private video" : item.snippet.title, publishedAt: item.hidden ? (item.addedAt || daysAgo(2)) : item.snippet.publishedAt, resourceId: { videoId: item.id } },
            contentDetails: { videoId: item.id, ...(item.hidden ? {} : { videoPublishedAt: item.snippet.publishedAt }) }
          })),
          ...(next ? { nextPageToken: next } : {})
        }
      };
    }

    if (endpoint === "videos") {
      const ids = String(info.params.id || "").split(",").filter(Boolean);
      return { body: { items: ids.map((id) => byId.get(id)).filter(Boolean) } };
    }

    return { status: 404, body: {} };
  };

  return { handler, requests, byId, uploads };
}

/* Fake TMDB. series: { [id]: details }, seasons: { "<id>:<n>": details }, search: { [lowercased query]: results[] } */
function createTmdb({ series = {}, seasons = {}, search = {}, plan = {} } = {}) {
  const requests = [];

  const handler = (url) => {
    const u = new URL(url);
    requests.push(url);

    if (plan.fail) {
      const failure = plan.fail(url);
      if (failure) return failure;
    }

    const searchMatch = /\/3\/search\/tv$/.exec(u.pathname);
    if (searchMatch) return { body: { results: search[String(u.searchParams.get("query")).toLowerCase()] || [] } };

    const match = /\/3\/tv\/(\d+)(?:\/season\/(\d+))?$/.exec(u.pathname);
    if (!match) return { status: 404, body: {} };

    const [, id, season] = match;
    if (season !== undefined) return seasons[`${id}:${season}`] ? { body: seasons[`${id}:${season}`] } : { status: 404, body: {} };
    return series[id] ? { body: series[id] } : { status: 404, body: {} };
  };

  return { handler, requests };
}

const searchHit = (id, name, extra = {}) => ({ id, name, original_name: extra.original_name || name, first_air_date: extra.first_air_date || "2024-01-05", genre_ids: extra.genre_ids || [16, 10759], origin_country: extra.origin_country || ["JP"], original_language: extra.original_language || "ja" });

const tvDetails = (id, name, seasonEpisodeCounts, extra = {}) => ({
  id,
  name,
  original_name: extra.original_name || name,
  overview: `${name} overview`,
  poster_path: "/poster.jpg",
  backdrop_path: "/backdrop.jpg",
  vote_average: 8.1,
  first_air_date: extra.first_air_date || "2024-01-05",
  status: extra.status || "Ended",
  genres: [{ name: "Animation" }],
  seasons: [{ season_number: 0, episode_count: 2 }, ...seasonEpisodeCounts.map((count, index) => ({ season_number: index + 1, episode_count: count }))]
});

const seasonDetails = (number, count, airDate = "2024-01-05") => ({
  season_number: number,
  air_date: airDate,
  overview: `Season ${number}`,
  episodes: Array.from({ length: count }, (_, i) => ({ season_number: number, episode_number: i + 1, name: `Ep title ${number}-${i + 1}`, air_date: airDate }))
});

// Routes global.fetch to the fake YouTube / TMDB. Anything else is a test failure.
async function withApis({ youtube, tmdb }, fn) {
  const original = global.fetch;
  const other = [];

  global.fetch = async (url) => {
    const text = String(url);
    let result;

    if (text.startsWith("https://www.googleapis.com/youtube/v3/")) {
      if (!youtube) throw new Error(`unexpected YouTube call: ${text}`);
      result = await youtube.handler(text);
    } else if (text.startsWith("https://api.themoviedb.org/3/")) {
      if (!tmdb) throw new Error(`unexpected TMDB call: ${text}`);
      result = await tmdb.handler(text);
    } else {
      other.push(text);
      throw new Error(`unexpected network call: ${text}`);
    }

    const { status = 200, body = {}, headers = {} } = result;
    return { ok: status >= 200 && status < 300, status, statusText: String(status), headers: { get: (name) => headers[String(name).toLowerCase()] ?? null }, text: async () => JSON.stringify(body), json: async () => body };
  };

  try {
    return await fn({ other });
  } finally {
    global.fetch = original;
  }
}

function tempWorkspace(prefix = "tamil-discovery-") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return {
    dir,
    catalogFile: path.join(dir, "anime.json"),
    manifestFile: path.join(dir, "manifest.json"),
    stateFile: path.join(dir, "discovery-state.json")
  };
}

const writeJson = (file, value) => fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const readJsonIfExists = (file) => (fs.existsSync(file) && fs.statSync(file).isFile() ? readJson(file) : null);

const emptyCatalog = () => ({ lastUpdated: "2026-09-01T00:00:00.000Z", region: "IN", anime: [] });
const emptyManifest = (channels = [{ name: "Muse India", channelId: CHANNEL }], entries = []) => ({ version: 1, updatedAt: "2026-10-03", officialYouTubeChannels: channels, entries });

const DISCOVERY_FAST = { enabled: true, backoffBaseMs: 0, backoffMaxMs: 0, retries: 2 };

/*
 * Runs the updater once with discovery enabled against a workspace. Console output is muted and returned as `logs`.
 * Options: ws (reuse a workspace), catalog, manifest, youtube, tmdb, tmdbKey (default none), youtubeKey, discovery.
 */
async function runDiscovery({ ws = tempWorkspace(), catalog, manifest = emptyManifest(), youtube, tmdb, tmdbKey = "", youtubeKey = TEST_KEY, discovery = {}, extraChannelIds = [], writeFiles = true } = {}) {
  if (writeFiles) {
    if (catalog) writeJson(ws.catalogFile, catalog);
    else if (!fs.existsSync(ws.catalogFile)) writeJson(ws.catalogFile, emptyCatalog());
    if (manifest) writeJson(ws.manifestFile, manifest);
  }

  const logs = [];
  const saved = { log: console.log, warn: console.warn, error: console.error };
  console.log = (...args) => logs.push(args.join(" "));
  console.warn = (...args) => logs.push(args.join(" "));
  console.error = (...args) => logs.push(args.join(" "));

  try {
    const report = await withApis({ youtube, tmdb }, () =>
      updater.run({
        catalogFile: ws.catalogFile,
        manifestFile: ws.manifestFile,
        discoveryStateFile: ws.stateFile,
        tmdbApiKey: tmdbKey,
        youtubeApiKey: youtubeKey,
        extraChannelIds,
        failOnZeroAdd: false,
        tmdbDelayMs: 0,
        region: "IN",
        discovery: { ...DISCOVERY_FAST, ...discovery },
        sleep: async () => {}
      })
    );

    return { ws, report, logs, catalog: readJson(ws.catalogFile), state: readJsonIfExists(ws.stateFile), manifestText: fs.readFileSync(ws.manifestFile, "utf8") };
  } finally {
    Object.assign(console, saved);
  }
}

const idsOf = (catalog) => catalog.anime.map((item) => item.id);
const byId = (catalog, id) => catalog.anime.find((item) => item.id === id);
const withoutScan = (catalog) => {
  const copy = clone(catalog);
  delete copy.lastUpdated;
  delete copy.updateInfo;
  return copy;
};

module.exports = {
  CHANNEL, OTHER_CHANNEL, TEST_KEY, TEST_TMDB_KEY, PLAYLIST, daysAgo, vid, video, createYouTube, createTmdb, searchHit, tvDetails, seasonDetails,
  withApis, tempWorkspace, writeJson, readJson, readJsonIfExists, emptyCatalog, emptyManifest, runDiscovery, idsOf, byId, withoutScan, DISCOVERY_FAST
};
