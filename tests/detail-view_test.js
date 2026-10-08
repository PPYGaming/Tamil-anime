"use strict";

// Run: node --test tests/*.test.js   (Node 18+, no dependencies)
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const app = require("../app.js");

const CR_SERIES = "https://www.crunchyroll.com/series/GABC123/demo-quest";
const CR_NEWS = "https://www.crunchyroll.com/news/2026/10/1/demo-quest-tamil-dub";
const NETFLIX = "https://www.netflix.com/title/81234567";
const VIDEO = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";

const placeholders = () => [
  { name: "Crunchyroll", available: false, officialUrl: null, tamilDubVerified: false },
  { name: "Netflix", available: false, officialUrl: null, tamilDubVerified: false },
  { name: "Amazon Prime Video", available: false, officialUrl: null, tamilDubVerified: false }
];

function record(extra = {}) {
  return {
    id: "demo-1",
    title: "Demo Quest",
    originalTitle: "Demo Kuest",
    description: "A demo title.",
    image: "https://img.example/poster.jpg",
    backdrop: "https://img.example/backdrop.jpg",
    rating: 8.1,
    likes: null,
    availability: "Completed",
    firstAirDate: "2024-04-01",
    createdAt: "2024-04-01T00:00:00Z",
    updatedAt: "2026-09-30T00:00:00Z",
    isNew: false,
    tags: ["Anime", "Action", "Fantasy", "Drama"],
    platforms: [
      { name: "Crunchyroll", available: true, officialUrl: CR_SERIES, tamilDubVerified: true, tamilDubVerificationUrl: CR_NEWS },
      { name: "Netflix", available: false, officialUrl: null, tamilDubVerified: false },
      { name: "Amazon Prime Video", available: false, officialUrl: null, tamilDubVerified: false }
    ],
    episodes: [
      { number: "1-1", title: "The Start", url: "https://www.crunchyroll.com/watch/G1/the-start", platform: "Crunchyroll" },
      { number: "1-2", url: null }
    ],
    youtube: [],
    tamilDubVerified: true,
    tamilDubVerificationUrl: CR_NEWS,
    tamilDubEvidence: [{ platform: "Crunchyroll", url: CR_NEWS }],
    ...extra
  };
}

// ---- small HTML readers (the renderers return strings) ----

function platformItems(html) {
  return html.split('<li class="platform-item ').slice(1).map((chunk) => {
    const item = chunk.split("</li>")[0];
    return {
      name: /<h3 class="platform-name">([^<]*)<\/h3>/.exec(item)[1],
      state: /^is-(\w+)/.exec(item)[1],
      label: /<span class="pill [^"]*">([^<]*)<\/span>/.exec(item)[1],
      hrefs: [...item.matchAll(/href="([^"]*)"/g)].map((m) => m[1]),
      text: item.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim()
    };
  });
}


const byName = (html) => Object.fromEntries(platformItems(html).map((p) => [p.name, p]));

/* ------------------------------------------------------------------ */
/* URL helpers                                                          */
/* ------------------------------------------------------------------ */

test("externalUrl only returns absolute http(s) URLs", () => {
  assert.equal(app.externalUrl("https://www.netflix.com/title/1"), "https://www.netflix.com/title/1");
  assert.equal(app.externalUrl("http://example.com/x"), "http://example.com/x");
  for (const bad of [null, undefined, "", "  ", "#", "relative/path", "javascript:alert(1)", "data:text/html,x", "ftp://x.test/a", "https://user:pw@example.com/", 42, {}]) {
    assert.equal(app.externalUrl(bad), null, `expected null for ${String(bad)}`);
  }
});

test("safeUrl keeps its existing contract (http/https or #)", () => {
  assert.equal(app.safeUrl("https://a.test/x"), "https://a.test/x");
  assert.equal(app.safeUrl("javascript:alert(1)"), "#");
  assert.equal(app.safeUrl("data:text/html,x"), "#");
  assert.equal(app.safeUrl("posters/a.jpg", "https://site.test/app/"), "https://site.test/app/posters/a.jpg");
});

test("youtubeId accepts watch and youtu.be video URLs only", () => {
  assert.equal(app.youtubeId(VIDEO), "dQw4w9WgXcQ");
  assert.equal(app.youtubeId("https://youtu.be/dQw4w9WgXcQ"), "dQw4w9WgXcQ");
  assert.equal(app.youtubeId("https://www.youtube.com/@MuseIndia"), null);
  assert.equal(app.youtubeId("https://www.youtube.com/results?search_query=x"), null);
  assert.equal(app.youtubeId("https://evil.test/watch?v=dQw4w9WgXcQ"), null);
  assert.equal(app.youtubeId("javascript:alert(1)"), null);
});

/* ------------------------------------------------------------------ */
/* Routing                                                              */
/* ------------------------------------------------------------------ */

test("routes round-trip ids with spaces, slashes, percent signs and Tamil text", () => {
  for (const id of ["demo-1", "a b/c", "100%", "தமிழ் 1", "x?y#z"]) {
    const hash = app.routeFor(id);
    assert.ok(hash.startsWith("#/anime/"));
    assert.ok(!/[\s/?#]/.test(hash.slice("#/anime/".length)), "encoded id must not contain raw separators");
    assert.deepEqual(app.parseRoute(hash), { view: "detail", id });
  }
});

test("any non-detail hash is the list view; broken encodings fail safely", () => {
  for (const hash of ["", "#", "#/", "#home", "#all", "#new", "#/anime/", "#/other/1"]) {
    assert.deepEqual(app.parseRoute(hash), { view: "list" }, hash);
  }
  assert.deepEqual(app.parseRoute("#/anime/%E0%A4%A"), { view: "detail", id: null });
});

test("recordId prefers id and falls back to a title slug", () => {
  assert.equal(app.recordId({ id: 7, title: "x" }), "7");
  assert.equal(app.recordId({ title: "Dragon Ball: Z!" }), "dragon-ball-z");
  assert.equal(app.recordId({}), null);
});

/* ------------------------------------------------------------------ */
/* Cards are discovery summaries only                                   */
/* ------------------------------------------------------------------ */

test("card shows poster, title link, description, metadata and badge, with no platform or episode blocks", () => {
  const html = app.cardHtml(record({ youtube: [{ title: "Demo Quest", url: VIDEO }], tamilDubVerified: true, freeSites: [{ name: "Animesalt", available: true, tamilDubConfirmed: true, tamilEvidenceUrl: "https://animesalt.ro/language/tamil/" }] }));
  assert.match(html, /<a class="card-link" href="#\/anime\/demo-1" data-id="demo-1">Demo Quest<\/a>/);
  assert.match(html, /A demo title\./);
  assert.match(html, /Tamil dub verified/);
  assert.match(html, /<span>2024<\/span>/);
  assert.match(html, /Rating 8\.1/);
  assert.equal((html.match(/<a /g) || []).length, 1, "the title link is the only link on a card");
  for (const gone of ["platform", "Crunchyroll", "Netflix", "Amazon", "Episode", "youtube", "YouTube", "Official"]) {
    assert.ok(!html.includes(gone), `card must not contain "${gone}"`);
  }
  assert.match(html, /<span class="tag">Action<\/span>/);
  assert.ok(!html.includes("Drama"), "cards show at most three tags");
});

test("card badge never claims verification the record does not have", () => {
  const html = app.cardHtml(record({ tamilDubVerified: false }));
  assert.match(html, /Tamil dub not confirmed/);
  assert.ok(!html.includes("Tamil dub verified"));
});

test("card for a legacy record without poster, rating or likes still renders", () => {
  const html = app.cardHtml({ title: "Old Title", description: "", tags: [], platforms: placeholders(), episodes: [{ number: "1-1", url: null }] });
  assert.match(html, /poster-fallback/);
  assert.match(html, /No description available\./);
  assert.match(html, /href="#\/anime\/old-title"/);
  assert.ok(!/Rating/.test(html) && !/Likes/.test(html) && !/Episode/.test(html));
});

test("card escapes untrusted fields and drops unsafe image URLs", () => {
  const html = app.cardHtml(record({
    id: '" onmouseover="alert(1)',
    title: "<img src=x onerror=alert(1)>",
    description: "<script>alert(1)</script>",
    tags: ["<b>x</b>"],
    image: "javascript:alert(1)"
  }));
  assert.ok(!html.includes("<img src=x"));
  assert.ok(!html.includes("<script>"));
  assert.ok(!html.includes("<b>x"));
  assert.ok(!html.includes('" onmouseover="'));
  assert.ok(!/src="javascript:/i.test(html));
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(html, /poster-fallback/);
});

/* ------------------------------------------------------------------ */
/* Detail view: platforms                                               */
/* ------------------------------------------------------------------ */

test("detail lists all supported sites in the fixed order", () => {
  const items = platformItems(app.detailHtml(record()));
  assert.deepEqual(items.map((p) => p.name), ["Crunchyroll", "Netflix", "Amazon Prime Video", "JioHotstar", "Sony LIV", "Muse Asia", "YouTube (Muse India)", "Animesalt", "Toon Stream"]);
});

test("detail never duplicates a platform even when the data does", () => {
  const dup = record({
    platforms: [
      ...record().platforms,
      { name: "crunchyroll", available: false, officialUrl: null, tamilDubVerified: false },
      { name: "Netflix", available: true, officialUrl: NETFLIX, tamilDubVerified: false },
      { name: "Netflix", available: false, officialUrl: null, tamilDubVerified: false },
      { name: "Disney+", available: true, officialUrl: "https://disneyplus.example/x", tamilDubVerified: true }
    ]
  });
  const items = platformItems(app.detailHtml(dup));
  assert.equal(items.length, 9);
  assert.equal(byName(app.detailHtml(dup)).Crunchyroll.state, "verified", "best row wins over a later placeholder");
  assert.equal(byName(app.detailHtml(dup)).Netflix.state, "unverified");
  assert.ok(!app.detailHtml(dup).includes("Disney"));
});

test("detail distinguishes verified, available-unverified and not available, plus verified YouTube", () => {
  const html = app.detailHtml(record({
    platforms: [
      { name: "Crunchyroll", available: true, officialUrl: CR_SERIES, tamilDubVerified: true, tamilDubVerificationUrl: CR_NEWS },
      { name: "Netflix", available: true, officialUrl: NETFLIX, tamilDubVerified: false },
      { name: "Amazon Prime Video", available: false, officialUrl: null, tamilDubVerified: false },
      { name: "YouTube", available: true, officialUrl: VIDEO, tamilDubVerified: true, tamilDubVerificationUrl: VIDEO }
    ],
    youtube: [{ title: "Demo Quest", url: VIDEO }],
    tamilDubEvidence: [
      { platform: "Crunchyroll", url: CR_NEWS },
      { platform: "YouTube", url: VIDEO, channelId: "UC" + "a".repeat(22), videoId: "dQw4w9WgXcQ" }
    ]
  }));
  const p = byName(html);

  assert.deepEqual([p.Crunchyroll.state, p.Crunchyroll.label], ["verified", "Tamil dub verified"]);
  assert.deepEqual(p.Crunchyroll.hrefs, [CR_SERIES, CR_NEWS]);
  assert.match(p.Crunchyroll.text, /Open on Crunchyroll/);
  assert.match(p.Crunchyroll.text, /View Tamil dub verification/);

  assert.deepEqual([p.Netflix.state, p.Netflix.label], ["unverified", "Available, no confirmed Tamil audio"]);
  assert.deepEqual(p.Netflix.hrefs, [NETFLIX]);
  assert.ok(!/verification/.test(p.Netflix.text), "no proof link without proof");

  assert.deepEqual([p["Amazon Prime Video"].state, p["Amazon Prime Video"].label], ["unavailable", "Not available"]);
  assert.deepEqual(p["Amazon Prime Video"].hrefs, []);

  assert.deepEqual([p["YouTube (Muse India)"].state, p["YouTube (Muse India)"].label], ["verified", "Tamil dub verified"]);
  assert.deepEqual(p["YouTube (Muse India)"].hrefs, [VIDEO]);
});

test("legacy record with only placeholder rows shows every platform as not available and links nothing", () => {
  const html = app.detailHtml({ id: "old", title: "Old Title", description: "x", platforms: placeholders(), episodes: [{ number: "1-1", url: null }], youtube: [] });
  const items = platformItems(html);
  assert.equal(items.length, 9);
  for (const item of items) {
    assert.equal(item.state, ["Animesalt", "Toon Stream"].includes(item.name) ? "free" : "unavailable", item.name);
    assert.equal(item.label, "Not available");
    assert.deepEqual(item.hrefs, []);
  }
});

test("records with no platforms array at all do not crash and show everything as unavailable", () => {
  const items = platformItems(app.detailHtml({ id: "bare", title: "Bare" }));
  assert.deepEqual(items.map((p) => p.state), [...Array(7).fill("unavailable"), "free", "free"]);
});

test("an available platform without a configured URL says so instead of linking", () => {
  for (const officialUrl of [null, "", "javascript:alert(1)", "data:text/html,x", "relative/path"]) {
    const item = byName(app.detailHtml(record({
      platforms: [{ name: "Netflix", available: true, officialUrl, tamilDubVerified: false }]
    }))).Netflix;
    assert.equal(item.state, "unverified");
    assert.deepEqual(item.hrefs, [], `no link for ${String(officialUrl)}`);
    assert.match(item.text, /Official link not configured/);
  }
});

test("available is not inferred from a URL or a verified flag alone", () => {
  const p = byName(app.detailHtml(record({
    platforms: [
      { name: "Crunchyroll", available: false, officialUrl: CR_SERIES, tamilDubVerified: true, tamilDubVerificationUrl: CR_NEWS },
      { name: "Netflix", available: false, officialUrl: NETFLIX, tamilDubVerified: false }
    ]
  })));
  assert.equal(p.Crunchyroll.state, "unavailable");
  assert.equal(p.Netflix.state, "unavailable");
  assert.deepEqual(p.Crunchyroll.hrefs.concat(p.Netflix.hrefs), []);
});

test("YouTube videos are linked only when the record's evidence confirms the video and an official channel", () => {
  const base = { platforms: placeholders(), tamilDubVerified: true };

  // listed in youtube[] but no evidence at all: not linked, not claimed as available
  let yt = byName(app.detailHtml(record({ ...base, youtube: [{ title: "Some video", url: VIDEO }], tamilDubEvidence: [] })))["YouTube (Muse India)"];
  assert.equal(yt.state, "unavailable");
  assert.deepEqual(yt.hrefs, []);
  assert.match(yt.text, /Some video/);
  assert.match(yt.text, /can't be confirmed/);

  // evidence without a channelId does not confirm ownership
  yt = byName(app.detailHtml(record({ ...base, youtube: [{ title: "Some video", url: VIDEO }], tamilDubEvidence: [{ platform: "YouTube", url: VIDEO }] })))["YouTube (Muse India)"];
  assert.deepEqual(yt.hrefs, []);

  // evidence for a different video does not confirm this one
  yt = byName(app.detailHtml(record({ ...base, youtube: [{ title: "Other", url: "https://youtu.be/AAAAAAAAAAA" }], tamilDubEvidence: [{ platform: "YouTube", url: VIDEO, channelId: "UC" + "a".repeat(22) }] })))["YouTube (Muse India)"];
  assert.deepEqual(yt.hrefs, []);

  // an explicit unverified row with no confirmed video: available, no link
  yt = byName(app.detailHtml(record({ ...base, platforms: [...placeholders(), { name: "YouTube", available: true, officialUrl: null, tamilDubVerified: false }] })))["YouTube (Muse India)"];
  assert.equal(yt.state, "unverified");
  assert.match(yt.text, /No confirmed official video link/);

  // confirmed video on an unverified record: official but not Tamil-confirmed
  yt = byName(app.detailHtml(record({ ...base, tamilDubVerified: false, youtube: [{ title: "Demo Quest", url: VIDEO }], tamilDubEvidence: [{ platform: "YouTube", url: VIDEO, channelId: "UC" + "a".repeat(22) }] })))["YouTube (Muse India)"];
  assert.equal(yt.state, "unverified");
  assert.deepEqual(yt.hrefs, [VIDEO]);
});

test("unsafe URLs in every link field never reach an href", () => {
  const html = app.detailHtml(record({
    image: "javascript:alert(1)",
    backdrop: "data:image/svg+xml,<svg onload=alert(1)>",
    platforms: [
      { name: "Crunchyroll", available: true, officialUrl: "javascript:alert(1)", tamilDubVerified: true, tamilDubVerificationUrl: "javascript:alert(2)" },
      { name: "Netflix", available: true, officialUrl: "data:text/html,<script>alert(1)</script>", tamilDubVerified: false },
      { name: "YouTube", available: true, officialUrl: "javascript:alert(3)", tamilDubVerified: true }
    ],
    youtube: [{ title: "x", url: "javascript:alert(4)" }],
    episodes: [{ number: "1-1", url: "javascript:alert(5)" }, { number: "1-2", url: "vbscript:x" }]
  }));
  assert.ok(!/javascript:|data:|vbscript:/i.test(html.replace(/&lt;[^]*?&gt;/g, "")), "no unsafe scheme in output");
  assert.ok(!/href="#"/.test(html), "no dummy # links either");
});

/* ------------------------------------------------------------------ */
/* Detail view: episodes                                                */
/* ------------------------------------------------------------------ */

test("no per-episode rows or episode links are rendered, only season and episode totals", () => {
  const html = app.detailHtml(record({
    episodes: [
      { number: "1-1", title: "The Start", url: "https://www.crunchyroll.com/watch/G1/the-start", platform: "Crunchyroll" },
      { number: "1-2", url: null },
      { number: "2-1", title: "Third", url: null }
    ]
  }));
  assert.ok(!/episode-row|episode-list|episodesHeading|Episode 1/.test(html));
  assert.ok(!html.includes("crunchyroll.com/watch/G1"), "an episode URL is never shown");
  assert.match(html, /<span>2 seasons<\/span>/);
  assert.match(html, /<span>3 episodes<\/span>/);
});

test("stored TMDB totals win over counting rows; a season record shows its season and episode count", () => {
  const series = app.countsOf({ numberOfSeasons: 5, numberOfEpisodes: 120, episodes: [{ number: "1-1" }] });
  assert.deepEqual([series.seasons, series.episodes, series.seasonNumber], [5, 120, null]);
  const season = app.countsOf({ tmdbSeason: 2, episodes: [{ number: "2-1" }, { number: "2-2" }] });
  assert.deepEqual([season.seasons, season.episodes, season.seasonNumber], [1, 2, 2]);
  assert.match(app.cardHtml({ title: "S", tmdbSeason: 2, episodes: [{ number: "2-1" }, { number: "2-2" }] }), /<span>Season 2<\/span><span>2 episodes<\/span>/);
  const none = app.countsOf({ episodes: [] });
  assert.deepEqual([none.seasons, none.episodes], [null, null]);
  assert.ok(!/season|episode/i.test(app.cardHtml({ title: "No counts", episodes: [] }).replace(/class="[^"]*"/g, "")));
});

test("a third-party reported platform row is labelled as reported, never as verified", () => {
  const html = app.detailHtml(record({
    platforms: [
      { name: "Crunchyroll", available: false, officialUrl: null, tamilDubVerified: false },
      { name: "Netflix", available: true, officialUrl: "https://www.netflix.com/title/81663323", tamilDubVerified: false, tamilDubReported: true, tamilDubReportSource: "Anime Mirchi", tamilDubReportUrl: "https://animemirchi.com/netflix-tamil-dubbed-anime-list/" },
      { name: "Amazon Prime Video", available: true, officialUrl: "https://www.primevideo.com/detail/0J3OTJAN6KC2NV157JXI5G0TCD", tamilDubVerified: false, tamilDubReported: true, tamilDubReportSource: "Anime News India", tamilDubReportUrl: "https://animenewsindia.com/x", regionNote: "India listing not confirmed" }
    ]
  }));
  const rows = byName(html);
  assert.equal(rows.Netflix.state, "reported");
  assert.match(rows.Netflix.label, /reported by a third party \(not confirmed\)/);
  assert.ok(!/Tamil dub verified/.test(rows.Netflix.text));
  assert.ok(rows.Netflix.hrefs.includes("https://www.netflix.com/title/81663323"));
  assert.match(rows.Netflix.text, /See report \(Anime Mirchi\)/);
  assert.match(rows["Amazon Prime Video"].text, /India listing not confirmed/);
});

/* ------------------------------------------------------------------ */
/* Detail view: page chrome and safety                                  */
/* ------------------------------------------------------------------ */

test("detail renders artwork, title, original title, description, tags and landmarks", () => {
  const html = app.detailHtml(record());
  assert.match(html, /<h1 id="detailTitle" tabindex="-1">Demo Quest<\/h1>/);
  assert.match(html, /<p class="detail-original">Demo Kuest<\/p>/);
  assert.match(html, /<img class="detail-poster" src="https:\/\/img\.example\/poster\.jpg" alt="Demo Quest poster">/);
  assert.match(html, /<img class="detail-backdrop" src="https:\/\/img\.example\/backdrop\.jpg" alt="">/);
  assert.match(html, /A demo title\./);
  assert.match(html, /<h2 id="platformsHeading">Where to watch<\/h2>/);
  assert.ok(!/episodesHeading/.test(html));
  assert.match(html, /aria-labelledby="platformsHeading"/);
  assert.match(html, /<span class="tag">Drama<\/span>/);
  assert.equal((html.match(/<h1/g) || []).length, 1);
});

test("every external link opens safely and announces the new tab", () => {
  const html = app.detailHtml(record());
  const anchors = html.match(/<a [^>]*>/g) || [];
  assert.ok(anchors.length >= 1);
  for (const a of anchors) {
    assert.match(a, /target="_blank"/);
    assert.match(a, /rel="noopener noreferrer"/);
  }
  assert.match(html, /\(opens in a new tab\)/);
});

test("detail escapes every untrusted text field", () => {
  const evil = "<img src=x onerror=alert(1)>";
  const html = app.detailHtml(record({
    title: evil,
    originalTitle: "<script>alert(2)</script>",
    description: "<svg onload=alert(3)>",
    tags: ["<i>t</i>"],
    episodes: [{ number: "1", title: evil, url: null }]
  }));
  for (const raw of ["<img src=x", "<script>", "<svg onload", "<i>t"]) assert.ok(!html.includes(raw), `raw ${raw} must not appear`);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
});

test("untitled or malformed records fall back to safe text", () => {
  const html = app.detailHtml({});
  assert.match(html, />Untitled</);
  assert.match(html, /No description available\./);
  assert.equal(platformItems(html).length, 9);
});

test("not-found, loading and error states are accessible headings", () => {
  for (const kind of ["loading", "notfound", "error"]) {
    const html = app.stateHtml(kind);
    assert.match(html, /<h1 id="detailTitle" tabindex="-1">/);
  }
  assert.match(app.stateHtml("notfound"), /Title not found/);
});

/* ------------------------------------------------------------------ */
/* Controller: fake window/document                                     */
/* ------------------------------------------------------------------ */

class El {
  constructor(doc, name) { this.doc = doc; this.name = name; this.hidden = false; this.textContent = ""; this.disabled = false; this.dataset = {}; this.listeners = {}; this.classList = { toggle() {} }; this._html = ""; }
  get innerHTML() { return this._html; }
  set innerHTML(v) { this._html = v; }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  fire(type, e = {}) { (this.listeners[type] || []).forEach((fn) => fn(e)); }
  focus() { this.doc.activeElement = this; }
  querySelector(sel) { return sel === "#detailTitle" && this._html.includes('id="detailTitle"') ? new El(this.doc, "detailTitle") : null; }
  querySelectorAll(sel) {
    if (sel !== ".card-link") return [];
    return [...this._html.matchAll(/<a class="card-link" href="[^"]*" data-id="([^"]*)"/g)].map((m) => {
      const link = new El(this.doc, "card-link");
      link.dataset.id = m[1];
      return link;
    });
  }
}

function makeEnv({ hash = "", anime = [], failFetch = false } = {}) {
  const doc = { title: "", activeElement: null };
  const ids = ["#animeGrid", "#status", "#searchInput", "#refreshButton", "#sortSelect", "#home", "#animeDetail", "#detailBody", "#backLink"];
  const els = Object.fromEntries(ids.map((id) => [id, new El(doc, id)]));
  els["#home"].hidden = false;
  els["#animeDetail"].hidden = true;
  const filters = ["all", "new", "updated"].map((f) => { const b = new El(doc, `filter-${f}`); b.dataset.filter = f; return b; });
  doc.querySelector = (sel) => els[sel] || null;
  doc.querySelectorAll = (sel) => (sel === "[data-filter]" ? filters : []);

  const listeners = [];
  const entries = [hash];
  let index = 0;
  const fire = () => listeners.forEach((fn) => fn({}));
  const win = {
    document: doc, scrollY: 0, scrolls: [], fetches: 0,
    scrollTo(x, y) { this.scrolls.push([x, y]); this.scrollY = y; },
    history: { scrollRestoration: "auto", backCalls: 0, back() { this.backCalls++; if (index > 0) { index--; fire(); } } },
    addEventListener(type, fn) { if (type === "hashchange") listeners.push(fn); },
    fetch: async () => {
      win.fetches++;
      return failFetch ? { ok: false, status: 500 } : { ok: true, json: async () => ({ lastUpdated: "2026-10-01T00:00:00Z", anime }) };
    }
  };
  Object.defineProperty(win, "location", {
    value: {
      get hash() { return entries[index]; },
      set hash(v) { const next = String(v).startsWith("#") ? String(v) : `#${v}`; if (next !== entries[index]) { entries.splice(index + 1); entries.push(next); index++; fire(); } }
    }
  });

  const instance = app.createApp(win);
  return { win, doc, instance, grid: els["#animeGrid"], status: els["#status"], search: els["#searchInput"], refresh: els["#refreshButton"], sort: els["#sortSelect"], listView: els["#home"], detailView: els["#animeDetail"], detailBody: els["#detailBody"], backLink: els["#backLink"], filters };
}

function click(kind, id, extra = {}) {
  const link = { dataset: { id } };
  const card = { dataset: { id }, querySelector: () => link };
  const control = kind === "link" ? link : kind === "button" ? { tag: "button" } : null;
  return { button: 0, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, target: { closest: (sel) => (sel.includes(".anime-card") ? card : control) }, ...extra };
}

const plainClick = () => ({ button: 0, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } });
const second = record({ id: "demo-2", title: "Zeta Force", rating: 6, isNew: true, createdAt: "2026-09-29T00:00:00Z", tags: ["Anime"], platforms: placeholders() });

test("page structure provides the hooks the app needs", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
  for (const id of ["animeGrid", "status", "searchInput", "refreshButton", "sortSelect", "home", "animeDetail", "detailBody", "backLink"]) {
    assert.ok(new RegExp(`id="${id}"`).test(html), `#${id} missing from index.html`);
  }
  assert.match(html, /id="animeDetail"[^>]*\bhidden\b/);
  assert.match(html, /id="backLink"[^>]*href="#\/"/);
  assert.equal((html.match(/data-filter=/g) || []).length, 3);
});

test("catalog loads into discovery cards and the existing controls still work", async () => {
  const env = makeEnv({ anime: [record(), second] });
  await env.instance.start();
  assert.match(env.status.textContent, /^Catalog updated:/);
  assert.equal(env.win.history.scrollRestoration, "manual");
  assert.ok(env.grid.innerHTML.indexOf("Zeta Force") < env.grid.innerHTML.indexOf("Demo Quest"), "default sort is newest first");

  env.search.fire("input", { target: { value: "zeta" } });
  assert.ok(env.grid.innerHTML.includes("Zeta Force") && !env.grid.innerHTML.includes("Demo Quest"));
  env.search.fire("input", { target: { value: "nothing matches" } });
  assert.match(env.grid.innerHTML, /No matching anime found\./);
  env.search.fire("input", { target: { value: "" } });

  env.sort.fire("change", { target: { value: "alpha" } });
  assert.ok(env.grid.innerHTML.indexOf("Demo Quest") < env.grid.innerHTML.indexOf("Zeta Force"));
  env.sort.fire("change", { target: { value: "rating" } });
  assert.ok(env.grid.innerHTML.indexOf("Demo Quest") < env.grid.innerHTML.indexOf("Zeta Force"), "8.1 outranks 6");

  env.filters[1].fire("click");
  assert.ok(env.grid.innerHTML.includes("Zeta Force") && !env.grid.innerHTML.includes("Demo Quest"), "New filter keeps only isNew");

  const before = env.win.fetches;
  env.refresh.fire("click");
  assert.equal(env.refresh.disabled, true);
  await new Promise((r) => setImmediate(r));
  assert.equal(env.win.fetches, before + 1);
  assert.equal(env.refresh.disabled, false);
});

test("a failed catalog load keeps the existing message and re-enables Refresh", async () => {
  const env = makeEnv({ failFetch: true });
  const original = console.error;
  console.error = () => {};
  try { await env.instance.start(); } finally { console.error = original; }
  assert.equal(env.status.textContent, "Unable to load the latest catalog.");
  assert.match(env.grid.innerHTML, /The catalog is temporarily unavailable\./);
  assert.equal(env.refresh.disabled, false);
});

test("clicking a card opens the detail view, resets scroll and moves focus to the title", async () => {
  const env = makeEnv({ anime: [record(), second] });
  await env.instance.start();
  env.win.scrollY = 420;

  const e = click("body", "demo-1");
  env.grid.fire("click", e);

  assert.equal(e.defaultPrevented, true);
  assert.equal(env.win.location.hash, "#/anime/demo-1");
  assert.equal(env.detailView.hidden, false);
  assert.equal(env.listView.hidden, true);
  assert.match(env.detailBody.innerHTML, /<h1 id="detailTitle" tabindex="-1">Demo Quest<\/h1>/);
  assert.equal(env.doc.title, "Demo Quest - Tamil Dub Anime");
  assert.equal(env.doc.activeElement.name, "detailTitle");
  assert.deepEqual(env.win.scrolls.at(-1), [0, 0]);
});

test("Back returns to the same list, scroll position and focused card; search state is kept", async () => {
  const env = makeEnv({ anime: [record(), second] });
  await env.instance.start();
  env.search.fire("input", { target: { value: "demo" } });
  const listHtml = env.grid.innerHTML;
  env.win.scrollY = 420;

  env.grid.fire("click", click("body", "demo-1"));
  const back = plainClick();
  env.backLink.fire("click", back);

  assert.equal(back.defaultPrevented, true);
  assert.equal(env.win.history.backCalls, 1);
  assert.equal(env.win.location.hash, "");
  assert.equal(env.listView.hidden, false);
  assert.equal(env.detailView.hidden, true);
  assert.equal(env.doc.title, "Tamil Dub Anime");
  assert.deepEqual(env.win.scrolls.at(-1), [0, 420]);
  assert.equal(env.doc.activeElement.dataset.id, "demo-1");
  assert.equal(env.grid.innerHTML, listHtml, "list is not rebuilt, so the filter result is unchanged");
  assert.equal(env.instance.state.search, "demo");
});

test("browser back and forward move between list and detail", async () => {
  const env = makeEnv({ anime: [record(), second] });
  await env.instance.start();
  env.grid.fire("click", click("body", "demo-2"));
  assert.match(env.detailBody.innerHTML, /Zeta Force/);

  env.win.history.back();
  assert.equal(env.listView.hidden, false);

  env.win.location.hash = app.routeFor("demo-1");
  assert.match(env.detailBody.innerHTML, /Demo Quest/);
  env.win.location.hash = app.routeFor("demo-2");
  assert.match(env.detailBody.innerHTML, /Zeta Force/);
});

test("nested controls, modified clicks and native link clicks do not trigger delegated navigation", async () => {
  const env = makeEnv({ anime: [record()] });
  await env.instance.start();

  const button = click("button", "demo-1");
  env.grid.fire("click", button);
  assert.equal(button.defaultPrevented, false);
  assert.equal(env.win.location.hash, "");
  assert.equal(env.instance.state.lastCard, null, "a nested control is not a card open");

  const ctrl = click("body", "demo-1", { ctrlKey: true });
  env.grid.fire("click", ctrl);
  assert.equal(ctrl.defaultPrevented, false);
  assert.equal(env.win.location.hash, "");

  const link = click("link", "demo-1");
  env.grid.fire("click", link);
  assert.equal(link.defaultPrevented, false, "the real anchor navigates natively");
  assert.equal(env.win.location.hash, "");
  assert.equal(env.instance.state.lastCard, "demo-1", "remembered so Back can restore focus");
});

test("a direct detail link shows a loading state, then the title; Back follows the plain list link", async () => {
  const env = makeEnv({ hash: app.routeFor("demo-1"), anime: [record()] });
  const started = env.instance.start();
  assert.match(env.detailBody.innerHTML, /Loading title/);
  assert.equal(env.detailView.hidden, false);

  await started;
  assert.match(env.detailBody.innerHTML, /Demo Quest/);
  assert.equal(env.doc.activeElement.name, "detailTitle");

  const back = plainClick();
  env.backLink.fire("click", back);
  assert.equal(back.defaultPrevented, false, "deep links must not call history.back()");
  assert.equal(env.win.history.backCalls, 0);

  env.win.location.hash = "#/"; // what the browser does when the plain link is followed
  assert.equal(env.listView.hidden, false);
  assert.equal(env.detailView.hidden, true);
});

test("unknown ids and failed loads show clear states with a way back", async () => {
  const missing = makeEnv({ hash: app.routeFor("nope"), anime: [record()] });
  await missing.instance.start();
  assert.match(missing.detailBody.innerHTML, /Title not found/);
  assert.equal(missing.doc.title, "Title not found - Tamil Dub Anime");

  const broken = makeEnv({ hash: app.routeFor("demo-1"), failFetch: true });
  const original = console.error;
  console.error = () => {};
  try { await broken.instance.start(); } finally { console.error = original; }
  assert.match(broken.detailBody.innerHTML, /Catalog unavailable/);
  assert.equal(broken.detailView.hidden, false);
});

test("ids with spaces, slashes and Tamil text open the right record", async () => {
  const odd = record({ id: "தமிழ் 1/2", title: "Odd Id" });
  const env = makeEnv({ anime: [record(), odd] });
  await env.instance.start();
  env.win.location.hash = app.routeFor("தமிழ் 1/2");
  assert.match(env.detailBody.innerHTML, /Odd Id/);
});

test("legacy catalog records (current schema) open without errors", async () => {
  const legacy = { id: "legacy-1", title: "Legacy", description: "No description available.", image: null, backdrop: null, rating: null, likes: null, availability: "Available", tags: ["Anime"], platforms: placeholders(), episodes: [{ number: "1-1", url: null }, { number: "1-2", url: null }], youtube: [], tamilDubVerified: true };
  const env = makeEnv({ anime: [legacy] });
  await env.instance.start();
  env.grid.fire("click", click("body", "legacy-1"));
  assert.match(env.detailBody.innerHTML, /Legacy/);
  assert.equal(platformItems(env.detailBody.innerHTML).length, 9);
  assert.ok(!/episode-row/.test(env.detailBody.innerHTML));
});
