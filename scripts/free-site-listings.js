"use strict";
const fs = require("node:fs");
const path = require("node:path");

const CONFIG = [
  { name: "Animesalt", bases: ["https://animesalt.ro", "https://animesalt.in", "https://animesalt.me"], listPath: "/language/tamil/", pagePath: (n) => `/language/tamil/page/${n}/`, maxPages: 15 },
  { name: "Toon Stream", bases: ["https://toonstream.live", "https://toonstream.love"], listPath: "/language/tamil/", pagePath: (n) => `/language/tamil/page/${n}/`, maxPages: 15 },
];
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const BLOCK_BODY = /Just a moment|cf-chl|Attention Required/i;
const MAX_REQUESTS = 200, MAX_SITE_MS = 90000, PAUSE_MS = 1500;

function cp(n) { try { return String.fromCodePoint(n); } catch { return ""; } }
function decode(s) {
  const named = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", rsquo: "\u2019", lsquo: "\u2018", ndash: "\u2013", mdash: "\u2014" };
  return String(s).replace(/&(?:#(\d+)|#x([0-9a-f]+)|([a-z]+));/gi, (m, d, h, n) => (d ? cp(+d) : h ? cp(parseInt(h, 16)) : named[n.toLowerCase()] ?? m));
}

function parseTitles(html) {
  const out = new Set();
  const add = (raw) => {
    const t = decode(String(raw).replace(/<[^>]*>/g, "")).replace(/\s+/g, " ").trim();
    if (t && !/https?:\/\/|www\./i.test(t)) out.add(t);
  };
  const re = /<article\b[^>]*\bclass\s*=\s*["'][^"']*\bbs\b[^"']*["'][^>]*>([\s\S]*?)<\/article>/gi;
  const src = String(html || "");
  let m;
  while ((m = re.exec(src))) {
    const a = /<a\b[^>]*\btitle\s*=\s*(["'])([\s\S]*?)\1/i.exec(m[1]);
    if (a) add(a[2]);
    const h = /<h2\b[^>]*>([\s\S]*?)<\/h2>/i.exec(m[1]);

    if (h) add(h[1]);
  }
  return [...out];
}

async function scrapeSite(cfg, io) {
  const t0 = Date.now();
  const get = async (url) => {
    if (io.budget.left <= 0) return { hard: "request cap reached" };
    io.budget.left--;
    let r;
    try {
      r = await io.fetchImpl(url, { method: "GET", headers: { "User-Agent": UA, Accept: "text/html" }, signal: AbortSignal.timeout(15000) });
    } catch (e) {
      return { soft: e && e.name === "TimeoutError" ? "timeout" : "network error" };
    }
    if ([403, 429, 503].includes(r.status)) return { hard: `blocked (HTTP ${r.status})` };
    let html = "";
    try { html = await r.text(); } catch { return { soft: "read error" }; }
    if (BLOCK_BODY.test(html)) return { hard: "challenge page" };
    return { status: r.status, html };
  };

  let base = null, r = null, why = "no base reachable";
  for (const b of cfg.bases) {
    const x = await get(b + cfg.listPath);
    if (x.hard) return { fail: x.hard };
    if (x.soft) { why = x.soft; continue; }
    if (x.status === 200) { base = b; r = x; break; }
    why = `HTTP ${x.status}`;
  }
  if (!base) return { fail: why };


  const seen = new Set(), titles = [];
  for (let n = 1; ; n++) {
    const fresh = parseTitles(r.html).filter((t) => !seen.has(t));
    if (!fresh.length) break;
    fresh.forEach((t) => { seen.add(t); titles.push(t); });
    if (n >= cfg.maxPages) break;
    await io.sleep(PAUSE_MS);
    if (Date.now() - t0 > MAX_SITE_MS) return { fail: "time limit" };
    r = await get(base + cfg.pagePath(n + 1));
    if (r.hard) return { fail: r.hard };
    if (r.soft) return { fail: r.soft };
    if (r.status === 404) break;
    if (r.status !== 200) return { fail: `HTTP ${r.status}` };
  }
  return { base, titles };
}

async function run(o = {}) {
  const fetchImpl = o.fetchImpl || globalThis.fetch;
  const now = o.now || (() => new Date());
  const outFile = o.outFile || path.join(__dirname, "..", "data", "free-site-listings.json");
  const sleep = o.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const config = o.config || CONFIG;
  const say = (s) => { try { (o.log || console.log)(s); } catch {} };
  try {
    let prev = [];
    try { const j = JSON.parse(fs.readFileSync(outFile, "utf8")); if (Array.isArray(j.sites)) prev = j.sites; } catch {}
    const budget = { left: MAX_REQUESTS };
    const sites = [];
    for (const cfg of config) {
      const old = prev.find((s) => s && s.name === cfg.name);

      const oldN = old && Array.isArray(old.titles) ? old.titles.length : 0;
      let res;
      try { res = await scrapeSite(cfg, { fetchImpl, sleep, budget }); } catch { res = { fail: "unexpected error" }; }
      if (!res.fail) {
        const n = res.titles.length;
        if (n === 0 || (n < 20 && n < oldN * 0.5)) res = { fail: `too few titles (${n})` };
      }
      if (res.fail) {
        const reason = String(res.fail).replace(/https?:\/\/\S*/gi, "").slice(0, 80);
        sites.push(old ? { ...old, lastError: reason } : { name: cfg.name, checkedAt: null, ok: false, titles: [], lastError: reason });
        say(`${cfg.name}: failed (${reason})${old ? ", kept previous" : ""}`);
      } else {
        sites.push({ name: cfg.name, checkedAt: now().toISOString().replace(/\.\d+Z$/, "Z"), ok: true, titles: res.titles });
        say(`${cfg.name}: ok, ${res.titles.length} titles`);
      }
    }
    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    const tmp = outFile + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, sites }) + "\n");
    fs.renameSync(tmp, outFile);
    return { sites };
  } catch {
    say("free-site-listings: unexpected failure, nothing changed");
    return { sites: [] };
  }
}

if (require.main === module) run().catch(() => {});
module.exports = { run, parseTitles, CONFIG };
