"use strict";

/*
 * Tavily lead discovery. LEADS ONLY.
 *
 * Tavily is a search index, not an exhaustive platform audit. Its results are leads that need a human look; a
 * missing result means nothing about availability. This script never writes "verified", never edits the manifest
 * or data/anime.json, and never creates a reported row. A lead can become "reported" only through the existing
 * reported-tier rules (scripts/add-reported.js) and "verified" only through the official-proof manifest path.
 *
 * Output: data/discovery-leads.json  { "version": 1, "leads": [{ title, platform, pageUrl, snippet, foundAt,
 *   status: "needsReview" }] }
 *
 * Safety: TAVILY_API_KEY is read only from process.env, sent only in the Authorization header, and never logged,
 * written to data, or placed in URLs or error text. Missing key -> "tavily discovery skipped", exit 0.
 * Any failure exits 0 with no changes. At most MAX_REQUESTS requests per run, each with a timeout, and no retries.
 * Search is restricted (include_domains) to official platform hosts, and every result must also pass the same
 * title-page URL rules used for reports. Third-party lead sites are never queried or used.
 */

const fs = require("fs");
const path = require("path");
const { platformUrlOk } = require("./add-reported");

const API_URL = "https://api.tavily.com/search";
const MAX_REQUESTS = 12;
const TIMEOUT_MS = 15000;
const MAX_LEADS = 500;
const SNIPPET_MAX = 300;
const BLOCKED_HOSTS = [];
const EXCLUDED = [/jujutsu\s*kaisen/i];


const PLATFORMS = [
  { name: "Crunchyroll", domains: ["crunchyroll.com"] },
  { name: "Netflix", domains: ["netflix.com"] },
  { name: "Amazon Prime Video", domains: ["primevideo.com", "amazon.in"] },
  { name: "JioHotstar", domains: ["hotstar.com", "jiohotstar.com"] },
  { name: "Sony LIV", domains: ["sonyliv.com"] }
];

const queriesFor = (platform) => [`Tamil dub ${platform.name}`, `${platform.name} new season Tamil dub announcement`];
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const norm = (v) => String(v || "").toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, " ").trim();

function cleanTitle(raw) {
  return String(raw || "")
    .replace(/\s+[|\-\u2013\u2014]\s+(?:Crunchyroll|Netflix|Prime Video|Amazon|JioHotstar|Hotstar|Sony ?LIV).*$/i, "")
    .replace(/^Watch\s+/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

function hostOf(url) {
  try { return new URL(url).hostname.toLowerCase(); } catch { return ""; }
}

function leadUrlOk(platform, url) {
  const host = hostOf(url);
  if (!host || BLOCKED_HOSTS.some((h) => host === h || host.endsWith(`.${h}`))) return false;
  if (!platform.domains.some((d) => host === d || host.endsWith(`.${d}`))) return false;
  if (platformUrlOk(platform.name, url)) return true;
  // amazon.in video detail pages (platformUrlOk covers primevideo.com only)
  if (platform.name === "Amazon Prime Video" && /(^|\.)amazon\.in$/.test(host)) {
    try { const u = new URL(url); return u.protocol === "https:" && !u.username && /^\/gp\/video\/detail\/[A-Za-z0-9]+/.test(u.pathname); } catch { return false; }

  }
  return false;
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; }
}

function knownFromCatalog(catalog) {
  const titles = new Set();
  const urls = new Set();
  for (const record of Array.isArray(catalog && catalog.anime) ? catalog.anime : []) {
    if (!isObj(record)) continue;
    for (const t of [record.title, record.originalTitle]) if (norm(t)) titles.add(norm(t));
    for (const row of Array.isArray(record.platforms) ? record.platforms : []) if (isObj(row) && row.officialUrl) urls.add(String(row.officialUrl));
  }
  return { titles, urls };
}

async function run(options = {}) {
  const env = options.env || process.env;
  const log = options.log || console.log;
  const fetchImpl = options.fetchImpl || (typeof fetch === "function" ? fetch : null);
  const root = path.join(__dirname, "..");
  const catalogFile = options.catalogFile || env.ANIME_DATA_FILE || path.join(root, "data", "anime.json");
  const leadsFile = options.leadsFile || env.DISCOVERY_LEADS_FILE || path.join(root, "data", "discovery-leads.json");
  const maxRequests = Math.min(Number.isInteger(options.maxRequests) && options.maxRequests > 0 ? options.maxRequests : MAX_REQUESTS, MAX_REQUESTS);
  const key = String(env.TAVILY_API_KEY || "").trim();

  if (!key || !fetchImpl) {
    log("tavily discovery skipped");
    return { skipped: true, requests: 0, added: 0 };

  }

  const known = knownFromCatalog(readJson(catalogFile, {}));
  const stored = readJson(leadsFile, { version: 1, leads: [] });
  const leads = Array.isArray(stored.leads) ? stored.leads.filter(isObj) : [];
  const seenUrls = new Set([...known.urls, ...leads.map((l) => l.pageUrl)]);
  const seenKeys = new Set(leads.map((l) => `${l.platform}|${norm(l.title)}`));
  const foundAt = (options.now ? new Date(options.now) : new Date()).toISOString().slice(0, 10);
  let requests = 0;
  let added = 0;

  outer:
  for (const platform of PLATFORMS) {
    for (const query of queriesFor(platform)) {
      if (requests >= maxRequests) break outer;
      requests++;
      let res;
      try {
        res = await fetchImpl(API_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
          body: JSON.stringify({ query, include_domains: platform.domains, max_results: 10, search_depth: "basic" }),
          signal: AbortSignal.timeout(TIMEOUT_MS)
        });
      } catch (error) {
        log(`tavily request failed (${(error && error.name) || "error"})`);
        continue;
      }
      if (res.status === 429 || res.status === 401 || res.status === 403) { log(`tavily stopped: HTTP ${res.status}`); break outer; }
      if (!res.ok) { log(`tavily query skipped: HTTP ${res.status}`); continue; }
      let data;
      try { data = await res.json(); } catch { log("tavily response was not valid JSON"); continue; }


      for (const r of Array.isArray(data && data.results) ? data.results : []) {
        if (!isObj(r) || typeof r.url !== "string") continue;
        if (!leadUrlOk(platform, r.url)) continue;
        const title = cleanTitle(r.title);
        if (!title || EXCLUDED.some((re) => re.test(title) || re.test(String(r.content || "")))) continue;
        const pageKey = `${platform.name}|${norm(title)}`;
        if (seenUrls.has(r.url) || seenKeys.has(pageKey) || known.titles.has(norm(title))) continue;
        seenUrls.add(r.url);
        seenKeys.add(pageKey);
        leads.push({ title, platform: platform.name, pageUrl: r.url, snippet: String(r.content || "").replace(/\s+/g, " ").trim().slice(0, SNIPPET_MAX), foundAt, status: "needsReview" });
        added++;
      }
    }
  }

  if (added > 0) {
    fs.mkdirSync(path.dirname(leadsFile), { recursive: true });
    fs.writeFileSync(leadsFile, `${JSON.stringify({ version: 1, leads: leads.slice(-MAX_LEADS) }, null, 2)}\n`);
  }
  log(`tavily discovery: ${requests} requests, ${added} new leads (needs review)`);
  return { skipped: false, requests, added };
}

if (require.main === module) {
  run().then(() => process.exit(0), () => { console.log("tavily discovery failed (no changes made)"); process.exit(0); });
}

module.exports = { run, leadUrlOk, cleanTitle, MAX_REQUESTS };
