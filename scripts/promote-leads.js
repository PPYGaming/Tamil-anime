"use strict";
const fs = require("fs");
const path = require("path");
const { leadUrlOk } = require("./discover-tavily");

const PLATFORM_DOMAINS = {
  "Crunchyroll": ["crunchyroll.com"],
  "Netflix": ["netflix.com"],
  "Amazon Prime Video": ["primevideo.com", "amazon.in"],
  "JioHotstar": ["hotstar.com", "jiohotstar.com"],
  "Sony LIV": ["sonyliv.com"],
};
const EXCLUDED = [/jujutsu\s*kaisen/i, /marriagetoxin/i];
const MAX_LEADS = 10, MAX_TAVILY = 10, MAX_TMDB = 20, MAX_ENTRIES = 300, RECHECK_DAYS = 7;
const NEWS_HOST = "animemirchi.com", NEWS_NAME = "Anime Mirchi";

class StopError extends Error { constructor(status) { super("stop"); this.status = status; } }
class NetError extends Error {}
class BudgetError extends Error {}

function normalize(s) {
  return String(s || "").normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

function cleanTitle(t) {
  return String(t || "")
    .replace(/^\s*prime video\s*:\s*/i, "")
    .replace(/\s+[-–|]\s*watch\b.*$/i, "")
    .replace(/\s*\([^)]*\b(?:dub|dubbed|tamil)\b[^)]*\)/gi, "")
    .replace(/\s*(?:,|-|–)?\s*season\s+\d+\s*$/i, "")
    .replace(/\s+/g, " ").replace(/[\s,:\-–]+$/, "").trim();

}

const readJson = (file) => {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch (e) { if (e.code === "ENOENT") return null; throw e; }
};
const writeJson = (file, obj) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file + ".tmp", JSON.stringify(obj, null, 2) + "\n");
  fs.renameSync(file + ".tmp", file);
};
const keyOf = (e) => [e.platform, e.mediaType, e.tmdbId].join("|");

async function run(options = {}) {
  const env = options.env || process.env;
  const log = options.log || console.log;
  const fetchImpl = options.fetchImpl || fetch;
  const root = path.join(__dirname, "..", "data");
  const leadsFile = options.leadsFile || env.DISCOVERY_LEADS_FILE || path.join(root, "discovery-leads.json");
  const outFile = options.outFile || env.AUTO_REPORTED_FILE || path.join(root, "auto-reported.json");
  const now = new Date(options.now || Date.now());
  const today = now.toISOString().slice(0, 10);

  const tmdbKey = env.TMDB_API_KEY, tavilyKey = env.TAVILY_API_KEY;
  if (!tmdbKey || !tavilyKey) { log("promote skipped (missing API key)"); return { skipped: true }; }

  const used = { tmdb: 0, tavily: 0 }, limits = { tmdb: MAX_TMDB, tavily: MAX_TAVILY };
  async function http(kind, url, init) {
    if (used[kind] >= limits[kind]) throw new BudgetError();
    used[kind]++;
    let res;
    try { res = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(15000) }); }

    catch { throw new NetError(); }
    if ([401, 403, 429].includes(res.status)) throw new StopError(res.status);
    if (!res.ok) throw new NetError();
    try { return await res.json(); } catch { throw new NetError(); }
  }

  const acceptable = (hits, nt) => (Array.isArray(hits) ? hits : []).filter((h) =>
    h && h.original_language === "ja" && Array.isArray(h.genre_ids) && h.genre_ids.includes(16) &&
    [h.name, h.original_name, h.title, h.original_title].some((n) => n && normalize(n) === nt));

  async function identify(title) {
    const nt = normalize(title);
    for (const kind of ["tv", "movie"]) {
      const url = `https://api.themoviedb.org/3/search/${kind}?api_key=${encodeURIComponent(tmdbKey)}&query=${encodeURIComponent(title)}`;
      const data = await http("tmdb", url, { method: "GET" });
      const ok = acceptable(data && data.results, nt);
      if (ok.length > 1) return { reason: "ambiguous-title" };
      if (ok.length === 1) {
        const h = ok[0], year = parseInt(String(h.first_air_date || h.release_date || "").slice(0, 4), 10);
        return { mediaType: kind, tmdbId: h.id, year: Number.isFinite(year) ? year : null };
      }
    }
    return { reason: "not-anime" };
  }

  async function findNews(title) {
    const data = await http("tavily", "https://api.tavily.com/search", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${tavilyKey}` },
      body: JSON.stringify({ query: `${title} Tamil dub`, include_domains: [NEWS_HOST], max_results: 5, search_depth: "basic" }),
    });
    const nt = ` ${normalize(title)} `;

    for (const r of (data && Array.isArray(data.results) ? data.results : [])) {
      let u; try { u = new URL(r.url); } catch { continue; }
      if (u.protocol !== "https:" || !(u.hostname === NEWS_HOST || u.hostname.endsWith("." + NEWS_HOST))) continue;
      const c = ` ${normalize(r.content)} `;
      if (c.includes(nt) && c.includes(" tamil ")) return r.url;
    }
    return null;
  }

  try {
    const leadsDoc = readJson(leadsFile);
    if (!leadsDoc || !Array.isArray(leadsDoc.leads)) { log("promote: no leads file"); return { promoted: 0 }; }
    const days = (d) => (Date.parse(today) - Date.parse(d)) / 86400000;
    const official = (l) => PLATFORM_DOMAINS[l.platform] &&
      leadUrlOk({ name: l.platform, domains: PLATFORM_DOMAINS[l.platform] }, l.pageUrl);
    const batch = leadsDoc.leads
      .filter((l) => l && (l.status === "needsReview" || (l.status === "notConfirmed" && days(l.checkedAt) > RECHECK_DAYS)))
      .filter((l) => !EXCLUDED.some((re) => re.test(String(l.title || ""))))
      .filter((l) => official(l))
      .sort((a, b) => String(a.foundAt || "").localeCompare(String(b.foundAt || "")))
      .slice(0, MAX_LEADS);

    const fresh = [];
    let changed = false;
    for (const lead of batch) {
      const title = cleanTitle(lead.title);
      if (!normalize(title)) continue;
      let outcome;
      try {
        const id = await identify(title);
        if (id.reason) outcome = { reason: id.reason };
        else {

          const newsUrl = await findNews(title);
          outcome = newsUrl ? { id, newsUrl } : { reason: "no-news-mention" };
        }
      } catch (e) {
        if (e instanceof NetError) { log("promote: network error, lead unchanged"); continue; }
        if (e instanceof BudgetError) { log("promote: request budget reached"); break; }
        throw e;
      }
      lead.checkedAt = today;
      changed = true;
      if (outcome.reason) {
        lead.status = "notConfirmed"; lead.reason = outcome.reason;
        log(`promote: ${lead.platform} "${title}" notConfirmed (${outcome.reason})`);
      } else {
        lead.status = "promoted"; delete lead.reason;
        fresh.push({
          title, mediaType: outcome.id.mediaType, tmdbId: outcome.id.tmdbId, year: outcome.id.year,
          platform: lead.platform, officialUrl: lead.pageUrl,
          report: { source: NEWS_NAME, url: outcome.newsUrl, checkedAt: today },
          autoPromoted: true,
        });
        log(`promote: ${lead.platform} "${title}" promoted`);
      }
    }

    let added = 0;
    if (fresh.length) {
      const existing = readJson(outFile);
      const entries = existing && Array.isArray(existing.entries) ? existing.entries.slice() : [];
      const seen = new Set(entries.map(keyOf));
      for (const e of fresh) if (!seen.has(keyOf(e))) { seen.add(keyOf(e)); entries.push(e); added++; }
      if (added) writeJson(outFile, { version: 1, updatedAt: today, entries: entries.slice(-MAX_ENTRIES) });

    }
    if (changed) writeJson(leadsFile, leadsDoc);
    log(`promote done: ${fresh.length} promoted, ${added} new entries`);
    return { promoted: fresh.length, added };
  } catch (e) {
    log(e instanceof StopError ? `promote failed (no changes): HTTP ${e.status}` : "promote failed (no changes)");
    return { failed: true };
  }
}

module.exports = { run, cleanTitle, normalize };

if (require.main === module) {
  run().catch(() => console.log("promote failed (no changes)")).finally(() => process.exit(0));
}
