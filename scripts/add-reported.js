"use strict";

/*
 * Third-party "reported" Tamil dubs (Netflix and Prime Video).
 *
 * These are NOT verified. The title and the platform's own title-page link are shown, the row is marked
 * tamilDubReported:true / tamilDubVerified:false, and the third-party source URL is stored on the row.
 * Nothing here can make a record or a row "Tamil dub verified": that only comes from the official-source
 * manifest handled by scripts/update-anime.js.
 *
 * Input: data/third-party-reports.json
 *   { "version": 1, "entries": [{
 *       "title": "Blue Box", "mediaType": "tv", "tmdbId": 207347, "year": 2024,
 *       "platform": "Crunchyroll" | "Netflix" | "Amazon Prime Video",
 *       "officialUrl": "https://www.netflix.com/title/81663323",
 *       "report": { "source": "Anime Mirchi", "url": "https://...", "checkedAt": "2026-10-04" },
 *       "regionNote": "optional, e.g. India listing not confirmed" }] }
 *
 * Existing records (matched by TMDB id and media type) only gain a missing platform row; a row that is already
 * available (verified or not) is never changed. TMDB (TMDB_API_KEY, optional) only fills artwork and text on
 * records this script created.
 */

const fs = require("fs");
const path = require("path");

const DATA_FILE = process.env.ANIME_DATA_FILE || path.join(__dirname, "..", "data", "anime.json");
const REPORTS_FILE = process.env.REPORTS_FILE || path.join(__dirname, "..", "data", "third-party-reports.json");
const PLATFORMS = ["Crunchyroll", "Netflix", "Amazon Prime Video", "JioHotstar", "Sony LIV"];
// New records keep the original three empty rows; JioHotstar / Sony LIV rows exist only when reported or curated.
const CORE_PLATFORMS = ["Crunchyroll", "Netflix", "Amazon Prime Video"];

const HOTSTAR_HOSTS = ["hotstar.com", "www.hotstar.com", "jiohotstar.com", "www.jiohotstar.com"];
const SONYLIV_HOSTS = ["sonyliv.com", "www.sonyliv.com"];

function platformUrlOk(platform, value) {
  let url;
  try { url = new URL(String(value)); } catch { return false; }
  if (url.protocol !== "https:" || url.username || url.password) return false;
  const host = url.hostname.toLowerCase();
  if (platform === "Crunchyroll") return (host === "www.crunchyroll.com" || host === "crunchyroll.com") && /^\/series\/[0-9A-Z]{6,}(?:\/|$)/.test(url.pathname);
  if (platform === "Netflix") return (host === "www.netflix.com" || host === "netflix.com") && /^\/(?:[a-z]{2}\/)?title\/\d+/.test(url.pathname);
  if (platform === "Amazon Prime Video") return (host === "www.primevideo.com" || host === "primevideo.com") && /\/detail\/(?:[^/]+\/)?[0-9A-Z]{20,}/.test(url.pathname);
  if (platform === "JioHotstar") return HOTSTAR_HOSTS.includes(host) && /^\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?(?:shows|movies|tv)\/[^/]+\/\d+(?:\/|$)/i.test(url.pathname);
  if (platform === "Sony LIV") return SONYLIV_HOSTS.includes(host) && /^\/(?:shows|movies)\/[^/]+/i.test(url.pathname);
  return false;
}

function reportOk(report) {
  if (!report || typeof report !== "object") return false;
  try { return new URL(report.url).protocol === "https:" && String(report.source || "").trim().length > 1; } catch { return false; }
}

function validate(entry) {
  if (!entry || typeof entry !== "object") return "not an object";
  if (!String(entry.title || "").trim()) return "missing title";
  if (entry.mediaType !== "tv" && entry.mediaType !== "movie") return "mediaType must be tv or movie";
  if (!Number.isInteger(entry.tmdbId) || entry.tmdbId <= 0) return "tmdbId must be a positive integer";
  if (!PLATFORMS.includes(entry.platform)) return "platform must be Crunchyroll, Netflix, Amazon Prime Video, JioHotstar or Sony LIV";
  if (!platformUrlOk(entry.platform, entry.officialUrl)) return "officialUrl must be that platform's own title page";
  if (!reportOk(entry.report)) return "report needs an https url and a source name";
  if (entry.tmdbSeason !== undefined && (entry.mediaType !== "tv" || !Number.isInteger(entry.tmdbSeason) || entry.tmdbSeason < 1 || entry.tmdbSeason > 60)) return "tmdbSeason must be an integer 1-60 on a tv entry";
  return null;
}

const slugify = (value) => String(value).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

function tmdbKey(record) {
  const match = /themoviedb\.org\/(tv|movie)\/(\d+)/i.exec(String(record.tmdbUrl || ""));
  if (match) return `${match[1].toLowerCase()}:${match[2]}`;
  const id = Number(record.tmdbId);
  return (record.mediaType === "tv" || record.mediaType === "movie") && Number.isInteger(id) && id > 0 ? `${record.mediaType}:${id}` : null;
}

function reportedRow(entry) {
  return {
    name: entry.platform,
    available: true,
    officialUrl: entry.officialUrl,
    tamilDubVerified: false,
    tamilDubReported: true,
    tamilDubReportSource: String(entry.report.source).trim(),
    tamilDubReportUrl: entry.report.url,
    ...(entry.regionNote ? { regionNote: String(entry.regionNote).trim() } : {})
  };
}

function emptyRows() {
  return CORE_PLATFORMS.map((name) => ({ name, available: false, officialUrl: null, tamilDubVerified: false }));
}

function newRecord(entry, now) {
  const date = entry.year ? `${entry.year}-01-01` : "";
  return {
    id: `reported-${slugify(entry.title)}-${entry.tmdbId}${entry.tmdbSeason ? `-s${entry.tmdbSeason}` : ""}`,
    title: String(entry.title).trim(),
    originalTitle: "",
    description: "",
    image: "",
    backdrop: "",
    rating: null,
    likes: null,
    availability: "",
    status: "",
    firstAirDate: date,
    createdAt: date ? `${date}T00:00:00Z` : now,
    updatedAt: now,
    isNew: false,
    tags: ["Anime"],
    platforms: emptyRows(),
    episodes: [],
    tamilDubVerified: false,
    tmdbId: entry.tmdbId,
    tmdbUrl: `https://www.themoviedb.org/${entry.mediaType}/${entry.tmdbId}`,
    mediaType: entry.mediaType,
    inclusionSource: "third-party-report",
    ...(entry.tmdbSeason ? { tmdbSeason: entry.tmdbSeason, tmdbSeasonUrl: `https://www.themoviedb.org/tv/${entry.tmdbId}/season/${entry.tmdbSeason}` } : {})
  };
}

async function enrich(record, apiKey) {
  if (!apiKey || record.inclusionSource !== "third-party-report") return false;
  if (record.description && record.image) return false;
  const seasonal = Number.isInteger(record.tmdbSeason) && record.tmdbSeason > 0;
  const url = `https://api.themoviedb.org/3/${record.mediaType}/${record.tmdbId}${seasonal ? `/season/${record.tmdbSeason}` : ""}?api_key=${encodeURIComponent(apiKey)}&language=en-US`;
  let data;
  try {
    const response = await fetch(url, { headers: { "User-Agent": "Tamil-Dub-Anime-Catalog/3.0" } });
    if (!response.ok) return false;
    data = await response.json();
  } catch {
    return false;
  }
  let changed = false;
  const fill = (key, value) => {
    if (value === undefined || value === null || value === "") return;
    if (record[key] === "" || record[key] === null || record[key] === undefined) { record[key] = value; changed = true; }
  };
  fill("description", String(data.overview || "").trim());
  fill("image", data.poster_path ? `https://image.tmdb.org/t/p/w500${data.poster_path}` : "");
  if (seasonal && !record.image) {
    try {
      const series = await (await fetch(`https://api.themoviedb.org/3/tv/${record.tmdbId}?api_key=${encodeURIComponent(apiKey)}&language=en-US`, { headers: { "User-Agent": "Tamil-Dub-Anime-Catalog/3.0" } })).json();
      fill("image", series.poster_path ? `https://image.tmdb.org/t/p/w500${series.poster_path}` : "");
      fill("backdrop", series.backdrop_path ? `https://image.tmdb.org/t/p/w1280${series.backdrop_path}` : "");
    } catch {}
  }
  fill("backdrop", data.backdrop_path ? `https://image.tmdb.org/t/p/w1280${data.backdrop_path}` : "");
  fill("rating", typeof data.vote_average === "number" && data.vote_average > 0 ? Math.round(data.vote_average * 10) / 10 : null);
  fill("status", String(data.status || ""));
  const date = String(data.first_air_date || data.release_date || "");
  if (/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    if (!record.firstAirDate || /^\d{4}-01-01$/.test(record.firstAirDate)) { record.firstAirDate = date; changed = true; }
    record.createdAt = `${date}T00:00:00Z`;
  }
  const genres = Array.isArray(data.genres) ? data.genres.map((g) => g && g.name).filter(Boolean) : [];
  if (genres.length) { record.tags = ["Anime", ...genres.filter((g) => g !== "Anime")].slice(0, 8); changed = true; }
  return changed;
}

async function main() {
  if (!fs.existsSync(REPORTS_FILE) || !fs.existsSync(DATA_FILE)) {
    console.log("Reported dubs skipped: data file missing.");
    return { added: 0, rows: 0, skipped: 0 };
  }

  const reports = JSON.parse(fs.readFileSync(REPORTS_FILE, "utf8"));
  const catalog = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
  const anime = Array.isArray(catalog.anime) ? catalog.anime : [];
  const now = new Date().toISOString();
  const stats = { added: 0, rows: 0, skipped: 0 };

  for (const entry of Array.isArray(reports.entries) ? reports.entries : []) {
    const problem = validate(entry);
    if (problem) { console.warn(`Reported dub "${entry && entry.title}" skipped: ${problem}`); stats.skipped++; continue; }

    const key = `${entry.mediaType}:${entry.tmdbId}`;
    let targets = anime.filter((record) => tmdbKey(record) === key && (entry.tmdbSeason ? record.tmdbSeason === entry.tmdbSeason : true));

    if (!targets.length) {
      const record = newRecord(entry, now);
      anime.push(record);
      targets = [record];
      stats.added++;
    }

    for (const record of targets) {
      if (!Array.isArray(record.platforms)) record.platforms = emptyRows();
      const row = record.platforms.find((item) => item && item.name === entry.platform);
      if (row && row.available === true) continue; // never touch an available row (verified or reported)
      const next = reportedRow(entry);
      if (row) Object.assign(row, next); else record.platforms.push(next);
      stats.rows++;
    }
  }

  const apiKey = process.env.TMDB_API_KEY || "";
  for (const record of anime) await enrich(record, apiKey);

  catalog.anime = anime;
  fs.writeFileSync(DATA_FILE, `${JSON.stringify(catalog, null, 2)}\n`);
  console.log(`Reported dubs: ${stats.added} titles added, ${stats.rows} platform rows set, ${stats.skipped} skipped.`);
  return stats;
}

if (require.main === module) {
  main().catch((error) => { console.error(`Reported dubs failed: ${error && error.message}`); process.exit(1); });
}

module.exports = { validate, platformUrlOk, reportedRow, newRecord, main };
