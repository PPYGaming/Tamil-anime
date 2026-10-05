"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { CONFIG } = require("./free-site-listings.js");

const MAX_AGE = 14 * 864e5, MAX_LEADS = 400;
const SUFFIX = /\s(?:season \d+|part \d+|tamil|hindi|dub|dubbed|tv)$/;

function normalize(s) {
  return String(s == null ? "" : s).normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, " ").replace(/\s+/g, " ").trim();
}
function variants(title) {
  let cur = normalize(title);
  const out = new Set();
  if (cur) out.add(cur);
  for (let i = 0; i < 3; i++) {
    const m = cur.replace(SUFFIX, "");
    if (m === cur || !m) break;
    cur = m; out.add(cur);
  }
  return out;
}
const recordKeys = (a) => [normalize(a.title), normalize(a.originalTitle)].filter(Boolean);
function matchTitle(siteTitle, record) {
  const keys = recordKeys(record || {});
  return [...variants(siteTitle)].some((v) => keys.includes(v));
}
function readJson(f) { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return null; } }
function writeAtomic(f, s) { const t = f + ".tmp"; fs.writeFileSync(t, s); fs.renameSync(t, f); }


function run(o = {}) {
  try {
    const d = path.join(__dirname, "..", "data");
    const animeFile = o.animeFile || path.join(d, "anime.json");
    const listingsFile = o.listingsFile || path.join(d, "free-site-listings.json");
    const leadsFile = o.leadsFile || path.join(d, "free-site-leads.json");
    const nowD = o.now ? o.now() : new Date();
    let raw, data;
    try { raw = fs.readFileSync(animeFile, "utf8"); data = JSON.parse(raw); } catch { return null; }
    if (!data || !Array.isArray(data.anime)) return null;

    const listed = readJson(listingsFile);
    const byName = new Map((listed && Array.isArray(listed.sites) ? listed.sites : []).filter(Boolean).map((s) => [s.name, s]));
    const sites = [];
    for (const c of CONFIG) {
      const s = byName.get(c.name), t = s ? Date.parse(s.checkedAt) : NaN;
      if (s && s.ok === true && Array.isArray(s.titles) && s.titles.length > 0 && Number.isFinite(t) && +nowD - t <= MAX_AGE) {
        const keys = new Set();
        s.titles.forEach((x) => variants(x).forEach((v) => keys.add(v)));
        sites.push({ name: c.name, t, keys, titles: s.titles });
      }
    }

    const catalog = new Set();
    const oldest = sites.length ? new Date(Math.min(...sites.map((s) => s.t))).toISOString().slice(0, 10) : null;
    for (const a of data.anime) {
      if (!a || typeof a !== "object") continue;
      if (!sites.length) { delete a.freeSites; delete a.freeSitesCheckedAt; continue; }
      const keys = recordKeys(a);
      keys.forEach((k) => catalog.add(k));
      a.freeSites = sites.map((s) => ({ name: s.name, available: keys.some((k) => s.keys.has(k)) }));
      a.freeSitesCheckedAt = oldest;

    }
    const indent = /\n\s+"/.test(raw) ? 2 : 0;
    const out = JSON.stringify(data, null, indent) + (raw.endsWith("\n") ? "\n" : "");
    if (out !== raw) writeAtomic(animeFile, out);

    if (sites.length) {
      const seen = new Set(), leads = [];
      for (const s of sites) for (const t of s.titles) {
        const n = normalize(t);
        if (!n || seen.has(n) || [...variants(t)].some((v) => catalog.has(v))) continue;
        seen.add(n); leads.push({ title: t, site: s.name });
      }
      leads.length = Math.min(leads.length, MAX_LEADS);
      const prev = readJson(leadsFile);
      if (!(prev && JSON.stringify(prev.leads) === JSON.stringify(leads))) {
        writeAtomic(leadsFile, JSON.stringify({ version: 1, updatedAt: nowD.toISOString(), leads }) + "\n");
      }
    }
    return { sites: sites.map((s) => s.name) };
  } catch {
    return null;
  }
}

if (require.main === module) { try { run(); } catch {} }
module.exports = { run, matchTitle, normalize };
