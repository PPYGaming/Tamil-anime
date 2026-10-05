"use strict";

/*
 * Tamil Dub Anime frontend: discovery grid + title detail view (vanilla JS).
 * Routing is hash based: "#/anime/<id>" opens a title, any other hash shows the list.
 * The pure helpers are exported (module.exports) so tests can run in Node without a DOM.
 */
(function () {
  const SITE_TITLE = "Tamil Dub Anime";
  const ROUTE_PREFIX = "#/anime/";
  const PLATFORM_ORDER = ["Crunchyroll", "Netflix", "Amazon Prime Video"];
  // Shown only when a record actually lists them (no "Not available" rows on every title).
  const OPTIONAL_PLATFORMS = ["JioHotstar", "Sony LIV"];
  const YOUTUBE_LABEL = "YouTube (Muse India)";
  const YOUTUBE_NAMES = ["youtube", "youtube (muse india)", "muse india"];
  const STATE_TEXT = {
    verified: "Tamil dub verified",
    unverified: "Available, no confirmed Tamil audio",
    reported: "Tamil dub reported by a third party (not confirmed)",
    unavailable: "Not available"
  };
  const NOTICE = {
    loading: ["Loading title...", "Fetching the catalog."],
    notfound: ["Title not found", "This title isn't in the catalog. The link may be wrong, or the title may have been removed. Go back to all anime to browse the list."],
    error: ["Catalog unavailable", "The catalog couldn't be loaded, so this title can't be shown. Go back to all anime and use Refresh to try again."]
  };

  /* ---------- helpers ---------- */

  const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
  const text = (v) => String(v ?? "").replace(/\s+/g, " ").trim();
  const present = (v) => v !== null && v !== undefined && v !== "";

  function esc(v){return String(v??"").replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;").replaceAll('"',"&quot;").replaceAll("'","&#039;")}
  function safeUrl(v, base){try{const u=new URL(v,base||(typeof location!=="undefined"?location.href:"http://localhost/"));return ["https:","http:"].includes(u.protocol)?u.href:"#"}catch{return "#"}}

  // Absolute http(s) URL or null. Unlike safeUrl it never turns null, "" or a relative
  // value into a link, so missing data can't become a bogus link.
  function externalUrl(v) {
    if (typeof v !== "string" || !v.trim()) return null;
    try {
      const u = new URL(v.trim());
      return (u.protocol === "https:" || u.protocol === "http:") && !u.username && !u.password ? u.href : null;
    } catch {
      return null;
    }
  }

  // A proof link is shown on a row only when it sits on that platform's own domain.
  const PLATFORM_DOMAINS = {
    "Crunchyroll": [/(^|\.)crunchyroll\.com$/],
    "Netflix": [/(^|\.)netflix\.com$/],
    "Amazon Prime Video": [/(^|\.)primevideo\.com$/, /(^|\.)amazon\.(?:com|in|co\.uk|de|fr|es|it|ca|com\.au|co\.jp)$/],
    "JioHotstar": [/(^|\.)hotstar\.com$/, /(^|\.)jiohotstar\.com$/],
    "Sony LIV": [/(^|\.)sonyliv\.com$/]
  };
  function ownDomain(name, v) {
    const href = externalUrl(v);
    if (!href) return false;
    const rules = PLATFORM_DOMAINS[name];
    if (!rules) return true;
    const host = new URL(href).hostname.toLowerCase();
    return rules.some((re) => re.test(host));
  }

  function imageSrc(v) {
    if (typeof v !== "string" || !v.trim()) return null;
    const u = safeUrl(v.trim());
    return u === "#" ? null : u;
  }

  function youtubeId(url) {
    const href = externalUrl(url);
    if (!href) return null;
    const u = new URL(href);
    const host = u.hostname.toLowerCase();
    let id = null;
    if (host === "youtu.be") id = u.pathname.split("/")[1];
    else if ((host === "youtube.com" || host.endsWith(".youtube.com")) && u.pathname === "/watch") id = u.searchParams.get("v");
    return id && /^[A-Za-z0-9_-]{11}$/.test(id) ? id : null;
  }

  function recordId(a) {
    if (!isObj(a)) return null;
    if (present(a.id)) return String(a.id);
    const slug = text(a.title).toLowerCase().replace(/[^\p{L}\p{N}\p{M}]+/gu, "-").replace(/^-+|-+$/g, "");
    return slug || null;
  }

  function routeFor(id) {
    return ROUTE_PREFIX + encodeURIComponent(String(id));
  }

  function parseRoute(hash) {
    const h = String(hash || "");
    if (!h.startsWith(ROUTE_PREFIX) || h.length === ROUTE_PREFIX.length) return { view: "list" };
    try {
      return { view: "detail", id: decodeURIComponent(h.slice(ROUTE_PREFIX.length)) };
    } catch {
      return { view: "detail", id: null };
    }
  }

  /* ---------- discovery card (summary only) ---------- */

  // "availability" defaults to "Available" and says nothing about platforms, so only
  // informative values such as Completed or Ongoing are shown next to the title.
  function releaseStatus(a) {
    const s = text(a.availability);
    return s && s.toLowerCase() !== "available" ? s : "";
  }

  // Only the totals are shown: no per-episode rows (there are no direct episode links to give).
  function countsOf(a) {
    const rows = (Array.isArray(a.episodes) ? a.episodes : []).filter(isObj);
    const whole = (v) => (Number.isInteger(v) && v > 0 ? v : null);
    if (Number.isInteger(a.tmdbSeason) && a.tmdbSeason > 0) {
      return { seasons: 1, episodes: rows.length || null, seasonNumber: a.tmdbSeason };
    }
    const seen = new Set();
    for (const r of rows) { const m = /^(\d+)-\d+$/.exec(text(r.number)); if (m) seen.add(m[1]); }
    return {
      seasons: whole(a.numberOfSeasons) || seen.size || null,
      episodes: whole(a.numberOfEpisodes) || rows.length || null,
      seasonNumber: null
    };
  }

  function metaSpans(a) {
    const items = [];
    const year = /^(\d{4})/.exec(text(a.firstAirDate));
    if (year) items.push(year[1]);
    if (present(a.rating)) items.push(`Rating ${a.rating}`);
    if (present(a.likes)) items.push(`Likes ${a.likes}`);
    const counts = countsOf(a);
    if (counts.seasonNumber) items.push(`Season ${counts.seasonNumber}`);
    else if (counts.seasons) items.push(`${counts.seasons} ${counts.seasons === 1 ? "season" : "seasons"}`);
    if (counts.episodes) items.push(`${counts.episodes} ${counts.episodes === 1 ? "episode" : "episodes"}`);
    const status = releaseStatus(a);
    if (status) items.push(status);
    return items.map((i) => `<span>${esc(i)}</span>`).join("");
  }

  function tagSpans(a, max) {
    const tags = (Array.isArray(a.tags) ? a.tags : []).map(text).filter(Boolean);
    return tags.slice(0, max).map((t) => `<span class="tag">${esc(t)}</span>`).join("");
  }

  function verifiedBadge(a) {
    return a.tamilDubVerified === true
      ? `<span class="badge badge-verified">${STATE_TEXT.verified}</span>`
      : `<span class="badge badge-unverified">Tamil dub not verified</span>`;
  }

  function cardHtml(a) {
    const id = recordId(a);
    const title = text(a.title) || "Untitled";
    const poster = imageSrc(a.image);
    const tags = tagSpans(a, 3);
    const heading = id === null
      ? esc(title)
      : `<a class="card-link" href="${esc(routeFor(id))}" data-id="${esc(id)}">${esc(title)}</a>`;
    return `<article class="anime-card"${id === null ? "" : ` data-id="${esc(id)}"`}>
    ${poster ? `<img src="${esc(poster)}" alt="" loading="lazy">` : `<div class="poster-fallback" aria-hidden="true"></div>`}
    <div class="anime-content">
      <h2>${heading}</h2>
      <p class="card-desc">${esc(a.description || "No description available.")}</p>
      ${tags ? `<div class="tags">${tags}</div>` : ""}
      <div class="meta">${metaSpans(a)}</div>
      ${verifiedBadge(a)}
    </div>
  </article>`;
  }

  /* ---------- detail view ---------- */

  function findRow(platforms, names) {
    const wanted = new Set(names.map((n) => n.toLowerCase()));
    const rank = (p) => (p.available === true ? 2 : 0) + (p.tamilDubVerified === true ? 1 : 0);
    return (Array.isArray(platforms) ? platforms : [])
      .filter((p) => isObj(p) && wanted.has(text(p.name).toLowerCase()))
      .reduce((best, p) => (!best || rank(p) > rank(best) ? p : best), null);
  }

  const stateOf = (row) => (!row || row.available !== true ? "unavailable" : row.tamilDubVerified === true ? "verified" : row.tamilDubReported === true ? "reported" : "unverified");

  function extLink(href, label, cls = "") {
    return `<a class="action${cls ? ` ${cls}` : ""}" href="${esc(href)}" target="_blank" rel="noopener noreferrer">${esc(label)}<span class="sr-only"> (opens in a new tab)</span></a>`;
  }

  function platformItem(name, state, actions) {
    return `<li class="platform-item is-${state}">
        <h3 class="platform-name">${esc(name)}</h3>
        <p class="platform-state"><span class="pill pill-${state}">${STATE_TEXT[state]}</span></p>
        <div class="platform-actions">${actions}</div>
      </li>`;
  }

  // A news/announcement page says a dub exists; it is not a title or watch page. Same shapes the
  // updater accepts as announcements (Crunchyroll news and help articles, Netflix Tudum and newsroom).
  function isAnnouncementUrl(v) {
    const href = externalUrl(v);
    if (!href) return false;
    const u = new URL(href);
    const host = u.hostname.toLowerCase();
    if (host === "crunchyroll.com" || host.endsWith(".crunchyroll.com")) {
      return /^\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?news\//i.test(u.pathname) || /^\/hc\//i.test(u.pathname);
    }
    if (host === "netflix.com" || host.endsWith(".netflix.com")) {
      return /^\/tudum\//i.test(u.pathname) || (host === "about.netflix.com" && /\/news\//i.test(u.pathname));
    }
    return false;
  }

  function streamingItem(name, row) {
    const state = stateOf(row);
    let actions = "";
    if (state !== "unavailable") {
      const official = externalUrl(row.officialUrl);
      const proofHref = state === "verified" ? externalUrl(row.tamilDubVerificationUrl) : null;
      const proof = proofHref && ownDomain(name, proofHref) ? proofHref : null;
      // An announcement is evidence, not a place to watch: it never gets the "Open on <platform>" label.
      const announcement = official && isAnnouncementUrl(official) ? official : null;
      const titlePage = announcement ? null : official;
      actions = titlePage
        ? extLink(titlePage, `Open on ${name}`)
        : `<span class="muted">${announcement ? "Announcement only: no official title or watch page linked" : "Official link not configured"}</span>`;
      if (proof && proof !== titlePage) actions += extLink(proof, "View Tamil dub verification", "subtle");
      if (state === "reported") {
        const report = externalUrl(row.tamilDubReportUrl);
        if (report) actions += extLink(report, `See report${row.tamilDubReportSource ? ` (${text(row.tamilDubReportSource)})` : ""}`, "subtle");
        if (text(row.regionNote)) actions += `<span class="muted">${esc(text(row.regionNote))}</span>`;
      }
      if (announcement && announcement !== proof) actions += extLink(announcement, "Read official announcement", "subtle");
    }
    return platformItem(name, state, actions);
  }

  // A YouTube video counts as official only when the record's own Tamil-dub evidence
  // names it together with an official channelId. Anything else stays unlinked.
  function youtubeItem(a) {
    const row = findRow(a.platforms, YOUTUBE_NAMES);
    const listed = Boolean(row) && row.available === true;
    const official = new Set(
      (Array.isArray(a.tamilDubEvidence) ? a.tamilDubEvidence : [])
        .filter((e) => isObj(e) && text(e.platform).toLowerCase() === "youtube" && text(e.channelId))
        .map((e) => youtubeId(e.url))
        .filter(Boolean)
    );
    const videos = (Array.isArray(a.youtube) ? a.youtube : []).filter(isObj).slice(0, 10);
    const rowVideo = listed ? { title: "", url: row.officialUrl } : null;
    const seen = new Set();
    const confirmed = [];
    const unconfirmed = [];
    for (const v of rowVideo ? [...videos, rowVideo] : videos) {
      const id = youtubeId(v.url);
      if (id && seen.has(id)) continue;
      if (id) seen.add(id);
      if (id && official.has(id)) confirmed.push(v);
      else if (v !== rowVideo) unconfirmed.push(v);
    }

    // Official Muse India "[Tamil Dub] <series>" playlists, attached by scripts/attach-playlists.js.
    const playlists = (Array.isArray(a.youtubePlaylists) ? a.youtubePlaylists : [])
      .filter((p) => isObj(p) && externalUrl(p.url) && /^https:\/\/www\.youtube\.com\/playlist\?list=PL[\w-]+$/.test(text(p.url)));
    const playlistLinks = playlists.map((p, i) => extLink(externalUrl(p.url), playlists.length > 1 ? `Watch playlist on YouTube (${i + 1})` : "Watch playlist on YouTube")).join("");
    const state = (confirmed.length && a.tamilDubVerified === true) || (listed && row.tamilDubVerified === true) || (playlists.length && a.tamilDubVerified === true)
      ? "verified"
      : listed || confirmed.length || playlists.length ? "unverified" : "unavailable";

    const links = playlistLinks + confirmed.map((v, i) => {
      const title = text(v.title);
      const label = title && title !== text(a.title) ? title : confirmed.length > 1 ? `Watch on YouTube (${i + 1})` : "Watch on YouTube";
      return extLink(externalUrl(v.url), label);
    }).join("");
    const none = state !== "unavailable" && !links ? `<span class="muted">No confirmed official video link</span>` : "";
    const other = unconfirmed.length
      ? `<p class="muted">Not linked, because it can't be confirmed as an official video: ${unconfirmed.map((v) => esc(text(v.title) || "Untitled video")).join(", ")}</p>`
      : "";
    return platformItem(YOUTUBE_LABEL, state, links + none + other);
  }

  function platformRows(a) {
    const optional = OPTIONAL_PLATFORMS.filter((name) => {
      const row = findRow(a.platforms, [name]);
      return row && row.available === true;
    });
    return [...[...PLATFORM_ORDER, ...optional].map((name) => streamingItem(name, findRow(a.platforms, [name]))), youtubeItem(a)].join("");
  }

  const SEASON_STATUS_CLASS = {
    Complete: "complete",
    Ongoing: "ongoing",
    Unknown: "unknown",
  };

  function seasonRowHtml(a, row) {
    if (!row || typeof row !== "object") return "";
    const statusLabel = Object.prototype.hasOwnProperty.call(SEASON_STATUS_CLASS, row.status)
      ? row.status
      : "Unknown";
    const statusClass = SEASON_STATUS_CLASS[statusLabel];

    const n = row.tamilEpisodes;
    let episodes = "Episode count not reported";
    if (Number.isInteger(n) && n >= 0) {
      episodes = n === 1 ? "1 Tamil episode" : `${n} Tamil episodes`;
    }

    const platformRow = findRow(a.platforms, [row.platform]);
    const verified = Boolean(
      platformRow && platformRow.available === true && platformRow.tamilDubVerified === true
    );
    const tierClass = verified ? "verified" : "reported";
    const tierLabel = verified ? "Verified" : "Reported";

    return `<li class="season-row">` +
      `<span class="season-platform">${esc(row.platform)}</span>` +
      `<span class="season-chip season-chip--${statusClass}">${esc(statusLabel)}</span>` +
      `<span class="season-episodes">${esc(episodes)}</span>` +
      `<span class="season-chip season-chip--${tierClass}">${esc(tierLabel)}</span>` +
      `</li>`;
  }

  function seasonSectionHtml(a) {
    const seasons = a && Array.isArray(a.seasonDetails) ? a.seasonDetails : [];
    const blocks = seasons
      .map((season) => {
        if (!season || !Array.isArray(season.rows)) return "";
        const rows = season.rows.map((row) => seasonRowHtml(a, row)).join("");
        if (!rows) return "";
        return `<div class="season-block"><h3>${esc(season.label)}</h3>` +
          `<ul class="season-rows">${rows}</ul></div>`;
      })
      .filter(Boolean);

    if (!blocks.length) return "";

    return `<section class="detail-section season-section" aria-labelledby="seasonsHeading">
      <h2 id="seasonsHeading">Tamil dub by season</h2>
      ${blocks.join("")}
      <p class="section-note">${esc("Season details come from community reports. Only titles marked Verified are confirmed from an official platform page; episode counts are not independently verified.")}</p>
    </section>`;
  }

  function detailHtml(a) {
    const title = text(a.title) || "Untitled";
    const original = text(a.originalTitle);
    const poster = imageSrc(a.image);
    const backdrop = imageSrc(a.backdrop);
    const tags = tagSpans(a, 12);
    return `<article class="detail-article">
    <header class="detail-hero">
      ${backdrop ? `<img class="detail-backdrop" src="${esc(backdrop)}" alt="">` : ""}
      <div class="detail-hero-inner">
        ${poster ? `<img class="detail-poster" src="${esc(poster)}" alt="${esc(title)} poster">` : `<div class="detail-poster poster-fallback" aria-hidden="true"></div>`}
        <div class="detail-info">
          <h1 id="detailTitle" tabindex="-1">${esc(title)}</h1>
          ${original && original !== title ? `<p class="detail-original">${esc(original)}</p>` : ""}
          <div class="detail-badges">${verifiedBadge(a)}${metaSpans(a)}</div>
          <p class="detail-desc">${esc(a.description || "No description available.")}</p>
          ${tags ? `<div class="tags">${tags}</div>` : ""}
        </div>
      </div>
    </header>
    <section class="detail-section" aria-labelledby="platformsHeading">
      <h2 id="platformsHeading">Where to watch</h2>
      <ul class="platform-list">${platformRows(a)}</ul>
      <p class="section-note">Only platforms with an official listing in the catalog show as available, and a listing alone does not prove Tamil audio.</p>
    </section>
    ${seasonSectionHtml(a)}
  </article>`;
  }

  function stateHtml(kind) {
    const [title, body] = NOTICE[kind] || NOTICE.error;
    return `<div class="detail-state"><h1 id="detailTitle" tabindex="-1">${esc(title)}</h1><p>${esc(body)}</p></div>`;
  }

  /* ---------- app wiring ---------- */

  // Optional scan-status panel (scan-status.js). It must never be able to break catalog loading.
  function notifyScanStatus(win, data) {
    try {
      if (win.ScanStatus && typeof win.ScanStatus.onCatalog === "function") win.ScanStatus.onCatalog(data);
    } catch (err) {
      console.error(err);
    }
  }

  const PAGE_SIZE = 20;

  // Pure: slice bounds for one page. start/end are 0-based slice indices (end exclusive).
  function pageWindow(total, page, size = PAGE_SIZE) {
    const count = Math.max(0, Math.floor(Number(total)) || 0);
    const per = Math.max(1, Math.floor(Number(size)) || PAGE_SIZE);
    const pages = Math.max(1, Math.ceil(count / per));
    const current = Math.min(pages, Math.max(1, Math.floor(Number(page)) || 1));
    const start = count ? (current - 1) * per : 0;
    const end = Math.min(count, start + per);
    return { page: current, pages, start, end };
  }

  // Pure: pager markup. Returns "" when there is nothing to page.
  function pagerHtml(page, pages) {
    const last = Math.max(1, Math.floor(Number(pages)) || 1);
    if (last <= 1) return "";
    const cur = Math.min(last, Math.max(1, Math.floor(Number(page)) || 1));
    const nums = [...new Set([1, last, cur - 1, cur, cur + 1])]
      .filter((n) => n >= 1 && n <= last)
      .sort((a, b) => a - b);
    let html = `<button type="button" class="pager-btn pager-prev" data-page="${Math.max(1, cur - 1)}"${cur === 1 ? " disabled" : ""}>Previous</button>`;
    let prev = 0;
    for (const n of nums) {
      if (n - prev > 1) html += `<span class="pager-gap" aria-hidden="true">&hellip;</span>`;
      html += n === cur
        ? `<button type="button" class="pager-btn pager-num active" data-page="${n}" aria-current="page" aria-label="Page ${n}">${n}</button>`
        : `<button type="button" class="pager-btn pager-num" data-page="${n}" aria-label="Page ${n}">${n}</button>`;
      prev = n;
    }
    html += `<button type="button" class="pager-btn pager-next" data-page="${Math.min(last, cur + 1)}"${cur === last ? " disabled" : ""}>Next</button>`;
    return `<div class="pager-buttons">${html}</div>`;
  }

  function createApp(win) {
    const doc = win.document;
    const $ = (s) => doc.querySelector(s);
    const state = {
      anime: [], filter: "all", search: "", sort: "newest", page: 1,
      loaded: false, failed: false,
      view: null, detailId: undefined, detailKind: null, fromList: false, listScroll: 0, lastCard: null
    };
    const grid = $("#animeGrid");
    const pager = $("#pager");
    const statusEl = $("#status");
    const searchInput = $("#searchInput");
    const refreshButton = $("#refreshButton");
    const sortSelect = $("#sortSelect");
    const listView = $("#home");
    const detailView = $("#animeDetail");
    const detailBody = $("#detailBody");
    const backLink = $("#backLink");
    const filterButtons = [...doc.querySelectorAll("[data-filter]")];

    function render() {
      const q = state.search.trim().toLowerCase();
      const list = state.anime.filter((a) => {
        const haystack = [a.title, a.description, ...(a.tags || [])].join(" ").toLowerCase();
        const filterOk = state.filter === "all" || (state.filter === "new" && a.isNew) || (state.filter === "updated" && a.updatedAt);
        return (!q || haystack.includes(q)) && filterOk;
      });
      list.sort((a, b) => {
        if (state.sort === "alpha") return String(a.title).localeCompare(String(b.title));
        if (state.sort === "rating") return (Number(b.rating) || 0) - (Number(a.rating) || 0);
        if (state.sort === "updated") return String(b.updatedAt || "").localeCompare(String(a.updatedAt || ""));
        return String(b.createdAt || b.updatedAt || "").localeCompare(String(a.createdAt || a.updatedAt || ""));
      });
      const w = pageWindow(list.length, state.page, PAGE_SIZE);
      state.page = w.page; // clamp: keeps a valid page after filter/refresh/back-navigation
      grid.innerHTML = list.length
        ? list.slice(w.start, w.end).map(cardHtml).join("")
        : `<div class="empty">No matching anime found.</div>`;
      renderPager(w, list.length);
    }

    function renderPager(w, total) {
      if (!pager) return;
      if (!total || w.pages <= 1) {
        pager.hidden = true;
        pager.innerHTML = "";
        return;
      }
      pager.hidden = false;
      pager.innerHTML = pagerHtml(w.page, w.pages) +
        `<p class="pager-status">Showing ${w.start + 1}-${w.end} of ${total}</p>`;
    }

    function onPagerClick(e) {
      const btn = e.target && e.target.closest ? e.target.closest("button[data-page]") : null;
      if (!btn || btn.disabled || !pager.contains(btn)) return;
      const next = Number(btn.dataset.page);
      if (!Number.isFinite(next) || next === state.page) return;
      state.page = next;
      render();
      // The pager was just re-rendered, so hand keyboard focus to the new current page.
      const current = pager.querySelector("[aria-current='page']");
      if (current && current.focus) current.focus({ preventScroll: true });
      const top = grid.getBoundingClientRect().top + (win.pageYOffset || 0) - 12;
      win.scrollTo({ top: Math.max(0, top), behavior: "smooth" });
    }

    function showList() {
      const comingBack = state.view === "detail";
      state.view = "list";
      state.fromList = false;
      detailView.hidden = true;
      listView.hidden = false;
      doc.title = SITE_TITLE;
      if (!comingBack) return;
      win.scrollTo(0, state.listScroll);
      const link = [...grid.querySelectorAll(".card-link")].find((l) => l.dataset.id === state.lastCard);
      if (link) link.focus({ preventScroll: true });
    }

    function showDetail(route, { fresh = true } = {}) {
      if (state.view !== "detail") {
        state.listScroll = win.scrollY || 0;
        state.fromList = state.view === "list";
      } else if (state.detailId !== route.id) {
        state.fromList = false;
      }
      state.view = "detail";
      state.detailId = route.id;
      listView.hidden = true;
      detailView.hidden = false;

      const record = route.id === null ? null : state.anime.find((a) => recordId(a) === route.id);
      state.detailKind = record ? "ready" : state.loaded ? "notfound" : state.failed ? "error" : "loading";
      detailBody.innerHTML = record ? detailHtml(record) : stateHtml(state.detailKind);
      doc.title = `${record ? text(record.title) || "Untitled" : NOTICE[state.detailKind][0]} - ${SITE_TITLE}`;

      if (!fresh) return;
      win.scrollTo(0, 0);
      const heading = detailBody.querySelector("#detailTitle");
      if (heading) heading.focus({ preventScroll: true });
    }

    function showRoute(opts) {
      const route = parseRoute(win.location.hash);
      if (route.view === "detail") showDetail(route, opts);
      else showList();
    }

    const modified = (e) => e.button > 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey;

    // Delegated: cards are rebuilt on every render.
    function onGridClick(e) {
      if (e.defaultPrevented || modified(e) || !e.target || !e.target.closest) return;
      const card = e.target.closest(".anime-card[data-id]");
      if (!card) return;
      const control = e.target.closest("a, button, input, select, textarea, summary, label");
      if (control && control !== card.querySelector(".card-link")) return; // other controls keep their own behaviour
      state.lastCard = card.dataset.id;
      if (control) return; // the card link itself navigates natively
      e.preventDefault();
      win.location.hash = routeFor(card.dataset.id);
    }

    function onBack(e) {
      if (!state.fromList || modified(e)) return; // deep links and new tabs follow the plain #/ link
      e.preventDefault();
      win.history.back();
    }

    async function loadCatalog(message = "Loading catalog...") {
      statusEl.textContent = message;
      refreshButton.disabled = true;
      try {
        const res = await win.fetch(`data/anime.json?t=${Date.now()}`, { cache: "no-store" });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        state.anime = Array.isArray(data.anime) ? data.anime.filter(isObj) : [];
        state.loaded = true;
        state.failed = false;
        state.page = 1;
        render();
        statusEl.textContent = data.lastUpdated ? `Catalog updated: ${new Date(data.lastUpdated).toLocaleString()}` : "Catalog loaded.";
        notifyScanStatus(win, data);
      } catch (err) {
        console.error(err);
        statusEl.textContent = "Unable to load the latest catalog.";
        if (!state.anime.length) grid.innerHTML = `<div class="empty">The catalog is temporarily unavailable.</div>`;
        if (!state.loaded) state.failed = true;
      } finally {
        refreshButton.disabled = false;
      }
      if (state.view === "detail") showRoute({ fresh: state.detailKind !== "ready" });
    }

    function start() {
      try { win.history.scrollRestoration = "manual"; } catch { /* not supported */ }
      searchInput.addEventListener("input", (e) => { state.search = e.target.value; state.page = 1; render(); });
      sortSelect.addEventListener("change", (e) => { state.sort = e.target.value; state.page = 1; render(); });
      filterButtons.forEach((b) => b.addEventListener("click", () => {
        state.filter = b.dataset.filter;
        state.page = 1;
        filterButtons.forEach((x) => x.classList.toggle("active", x === b));
        render();
      }));
      refreshButton.addEventListener("click", () => loadCatalog("Refreshing catalog..."));
      grid.addEventListener("click", onGridClick);
      if (pager) pager.addEventListener("click", onPagerClick);
      backLink.addEventListener("click", onBack);
      win.addEventListener("hashchange", () => showRoute({ fresh: true }));
      showRoute({ fresh: true });
      return loadCatalog();
    }

    return { state, start, render, showRoute, loadCatalog };
  }

  const api = {
    esc, safeUrl, externalUrl, imageSrc, youtubeId, recordId, routeFor, parseRoute,
    cardHtml, detailHtml, seasonSectionHtml, stateHtml, platformRows, countsOf, createApp, isAnnouncementUrl, ownDomain,
    pageWindow, pagerHtml
  };

  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (typeof window !== "undefined" && window.document && window.document.querySelector("#animeGrid")) {
    const app = createApp(window);
    try {
      if (window.ScanStatus && typeof window.ScanStatus.attach === "function") window.ScanStatus.attach(window, app);
    } catch (err) {
      console.error(err);
    }
    app.start();
  }
})();
