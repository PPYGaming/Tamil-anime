"use strict";

// Shared helpers for the season / backfill / enrichment suites. Not a test file itself.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// Same discovery rule as updater-curated_test.js: look in the usual places, or set UPDATER_PATH.
const updaterPath = [process.env.UPDATER_PATH, "../../update-anime.js", "../../scripts/update-anime.js", "../../.github/scripts/update-anime.js", "../../tools/update-anime.js"]
  .filter(Boolean)
  .map((candidate) => path.resolve(__dirname, candidate))
  .find((candidate) => fs.existsSync(candidate));

if (!updaterPath) throw new Error("update-anime.js not found next to tests/ or in scripts/; set UPDATER_PATH");

const updater = require(updaterPath);

const CHANNEL = `UC${"a".repeat(22)}`;
const OTHER_CHANNEL = `UC${"b".repeat(22)}`;
const CR_NEWS = "https://www.crunchyroll.com/news/announcements/2023/9/21/demo-tamil-dub";
const CR_SERIES = "https://www.crunchyroll.com/series/GABC123/demo-quest";
const NF_TITLE = "https://www.netflix.com/title/81234567";
const PRIME_TITLE = "https://www.primevideo.com/detail/0ABCDEF123";
const VIDEO = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";

const FIXTURES = path.resolve(__dirname, "..", "fixtures");
const FIXTURE_MANIFEST = path.join(FIXTURES, "official-tamil-dub-manifest.27-entries.json");
const FIXTURE_CATALOG = path.join(FIXTURES, "anime.25-records.json");

const clone = (value) => structuredClone(value);

const manifestOf = (...entries) => ({
  version: 1,
  updatedAt: "2026-10-01",
  officialYouTubeChannels: [{ name: "Muse India", channelId: CHANNEL }],
  entries
});

// A valid manifest entry for one season of a shared TMDB series.
const seasonEntry = (tmdbId, season, extra = {}) => ({
  id: `show-${tmdbId}-season-${season}`,
  title: `Demo Show Season ${season}`,
  aliases: ["Demo Show"],
  mediaType: "tv",
  year: 2019 + season,
  tmdbId,
  tmdbSeason: season,
  tamilDubVerified: true,
  verification: { url: `https://www.crunchyroll.com/news/announcements/2023/9/${season}/demo-tamil-dub`, checkedAt: "2026-10-01", note: `Tamil dub, season ${season}` },
  ...extra
});

// A full-schema catalog record like the ones the updater already published.
function record(id, extra = {}) {
  return {
    id,
    title: id,
    originalTitle: id,
    description: "Existing description",
    image: "https://img.example/p.jpg",
    backdrop: "https://img.example/b.jpg",
    rating: 7.5,
    likes: null,
    availability: "Completed",
    status: "Ended",
    firstAirDate: "2020-01-01",
    createdAt: "2020-01-01T00:00:00Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    isNew: false,
    tags: ["Anime", "Action"],
    platforms: [
      { name: "Crunchyroll", available: true, officialUrl: CR_NEWS, tamilDubVerified: true, tamilDubVerificationUrl: CR_NEWS },
      { name: "Netflix", available: false, officialUrl: null, tamilDubVerified: false },
      { name: "Amazon Prime Video", available: false, officialUrl: null, tamilDubVerified: false }
    ],
    episodes: [{ number: "1-1", url: null }, { number: "1-2", url: null }],
    youtube: [],
    tamilDubVerified: true,
    tamilDubVerificationSource: "Crunchyroll official listing/announcement",
    tamilDubVerificationUrl: CR_NEWS,
    tamilDubVerifiedAt: "2026-10-01",
    tamilDubEvidence: [{ platform: "Crunchyroll", url: CR_NEWS, source: "Crunchyroll official listing/announcement", checkedAt: "2026-10-01", note: "Tamil dub" }],
    inclusionSource: "official-source-manifest",
    mediaType: "tv",
    region: "IN",
    ...extra
  };
}

// A published-style record that is already consistent with a manifest entry (merging it is a no-op).
function recordFor(entry, extra = {}) {
  const url = entry.verification.url;

  return record(entry.id, {
    title: entry.title,
    originalTitle: entry.title,
    tmdbId: entry.tmdbId,
    tmdbUrl: `https://www.themoviedb.org/${entry.mediaType || "tv"}/${entry.tmdbId}`,
    platforms: [
      { name: "Crunchyroll", available: true, officialUrl: url, tamilDubVerified: true, tamilDubVerificationUrl: url },
      { name: "Netflix", available: false, officialUrl: null, tamilDubVerified: false },
      { name: "Amazon Prime Video", available: false, officialUrl: null, tamilDubVerified: false }
    ],
    tamilDubVerificationUrl: url,
    tamilDubEvidence: [{ platform: "Crunchyroll", url, source: "Crunchyroll official listing/announcement", checkedAt: "2026-10-01", note: entry.verification.note }],
    ...extra
  });
}

const VERIFICATION_KEYS = ["tamilDubVerified", "tamilDubVerificationSource", "tamilDubVerificationUrl", "tamilDubVerifiedAt", "tamilDubEvidence"];
const pick = (object, keys) => Object.fromEntries(keys.map((key) => [key, object[key]]));

// Runs updater.run() on a temp catalog + manifest with console output muted. No keys unless given.
async function runUpdater({ catalog = { lastUpdated: "2026-09-01T00:00:00.000Z", region: "IN", anime: [] }, manifest, catalogFile, manifestFile, ...options }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tamil-anime-season-"));
  const files = {
    dir,
    catalogFile: catalogFile || path.join(dir, "anime.json"),
    manifestFile: manifestFile || path.join(dir, "manifest.json")
  };

  if (!catalogFile) fs.writeFileSync(files.catalogFile, `${JSON.stringify(catalog, null, 2)}\n`);
  if (!manifestFile) fs.writeFileSync(files.manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);

  const manifestText = fs.readFileSync(files.manifestFile, "utf8");
  const saved = { log: console.log, warn: console.warn };
  console.log = console.warn = () => {};

  try {
    const report = await updater.run({
      catalogFile: files.catalogFile,
      manifestFile: files.manifestFile,
      tmdbApiKey: "",
      youtubeApiKey: "",
      extraChannelIds: [],
      failOnZeroAdd: false,
      tmdbDelayMs: 0,
      region: "IN",
      ...options
    });

    return {
      ...files,
      report,
      catalog: JSON.parse(fs.readFileSync(files.catalogFile, "utf8")),
      manifestUntouched: fs.readFileSync(files.manifestFile, "utf8") === manifestText
    };
  } finally {
    Object.assign(console, saved);
  }
}

// Re-run on the catalog file a previous run left behind.
const rerun = (previous, manifest, options = {}) =>
  runUpdater({ catalogFile: previous.catalogFile, manifestFile: previous.manifestFile, manifest, ...options });

const reviewText = (report) => report.needsReview.map((item) => `${item.entry}: ${item.reason}`).join("\n");

// Mocks global fetch. handler(url) -> { status, body }. Returns whatever fn returns.
async function withFetch(handler, fn) {
  const original = global.fetch;
  const calls = [];

  global.fetch = async (url) => {
    calls.push(String(url));
    const { status = 200, body = {} } = await handler(String(url));
    return { ok: status >= 200 && status < 300, status, statusText: String(status), json: async () => body, text: async () => JSON.stringify(body) };
  };

  try {
    return await fn(calls);
  } finally {
    global.fetch = original;
  }
}

// Any network call is a test failure (proves no-key runs stay offline).
const withNoNetwork = (fn) =>
  withFetch(
    (url) => {
      throw new Error(`unexpected network call: ${url}`);
    },
    fn
  );

// TMDB mock. series: { [id]: details }, seasons: { "<id>:<season>": seasonDetails }. Unknown -> 404.
function tmdbMock({ series = {}, seasons = {}, failSeasonWith = null, failSeriesWith = null } = {}) {
  return (url) => {
    const match = /\/3\/tv\/(\d+)(?:\/season\/(\d+))?(?:\?|$)/.exec(url);
    if (!match) return { status: 404, body: { status_message: "not mocked" } };

    const [, id, season] = match;

    if (season !== undefined) {
      if (failSeasonWith) return { status: failSeasonWith, body: {} };
      const body = seasons[`${id}:${season}`];
      return body ? { body } : { status: 404, body: { status_message: "no such season" } };
    }

    if (failSeriesWith) return { status: failSeriesWith, body: {} };
    return series[id] ? { body: series[id] } : { status: 404, body: { status_message: "no such series" } };
  };
}

const requested = (calls, fragment) => calls.some((url) => url.includes(fragment));

module.exports = {
  updater, CHANNEL, OTHER_CHANNEL, CR_NEWS, CR_SERIES, NF_TITLE, PRIME_TITLE, VIDEO,
  FIXTURES, FIXTURE_MANIFEST, FIXTURE_CATALOG, VERIFICATION_KEYS,
  clone, manifestOf, seasonEntry, record, recordFor, pick, runUpdater, rerun, reviewText,
  withFetch, withNoNetwork, tmdbMock, requested
};
