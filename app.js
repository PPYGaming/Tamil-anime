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
  const YOUTUBE_LABEL = "YouTube (Muse India)";
  const YOUTUBE_NAMES = ["youtube", "youtube (muse india)", "muse india"];
  const EPISODE_SITES = [...PLATFORM_ORDER, "YouTube"];
  const STATE_TEXT = {
    verified: "Tamil dub verified",
    unverified: "Available, no confirmed Tamil audio",
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

  function metaSpans(a) {
    const items = [];
    const year = /^(\d{4})/.exec(text(a.firstAirDate));
    if (year) items.push(year[1]);
    if (present(a.rating)) items.push(`Rating ${a.rating}`);
    if (present(a.likes)) items.push(`Likes ${a.likes}`);
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

  const stateOf = (row) => (!row || row.available !== true ? "unavailable" : row.tamilDubVerified === true ? "verified" : "unverified");

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
      const proof = state === "verified" ? externalUrl(row.tamilDubVerificationUrl) : null;
      // An announcement is evidence, not a place to watch: it never gets the "Open on <platform>" label.
      const announcement = official && isAnnouncementUrl(official) ? official : null;
      const titlePage = announcement ? null : official;
      actions = titlePage
        ? extLink(titlePage, `Open on ${name}`)
        : `<span class="muted">${announcement ? "Announcement only: no official title or watch page linked" : "Official link not configured"}</span>`;
      if (proof && proof !== titlePage) actions += extLink(proof, "View Tamil dub verification", "subtle");
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

    const state = (confirmed.length && a.tamilDubVerified === true) || (listed && row.tamilDubVerified === true)
      ? "verified"
      : listed || confirmed.length ? "unverified" : "unavailable";

    const links = confirmed.map((v, i) => {
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
    return [...PLATFORM_ORDER.map((name) => streamingItem(name, findRow(a.platforms, [name]))), youtubeItem(a)].join("");
  }

  function episodeRow(e) {
    const number = present(e.number) && text(e.number) ? `Episode ${text(e.number)}` : "Episode";
    const title = text(e.title);
    const parts = `<span class="ep-num">${esc(number)}</span>${title ? `<span class="ep-title">${esc(title)}</span>` : ""}`;
    const href = externalUrl(e.url);
    if (!href) return `<li class="episode-row is-static">${parts}<span class="sr-only"> Official link not available</span></li>`;
    const site = EPISODE_SITES.includes(text(e.platform)) ? text(e.platform) : "";
    return `<li class="episode-row has-link"><a href="${esc(href)}" target="_blank" rel="noopener noreferrer">${parts}<span class="ep-go">${esc(site ? `Watch on ${site}` : "Watch")}</span><span class="sr-only"> (opens in a new tab)</span></a></li>`;
  }

  function episodesSection(list) {
    const eps = (Array.isArray(list) ? list : []).filter(isObj);
    if (!eps.length) return `<p class="section-note lead">No episodes are listed for this title yet.</p>`;
    const linked = eps.filter((e) => externalUrl(e.url)).length;
    const note = !linked
      ? "Official episode links are not available for this title yet."
      : linked === eps.length
        ? "Every episode links to its official page."
        : `${linked} of ${eps.length} episodes have an official link. The rest have no confirmed official link yet.`;
    return `<p class="section-note lead">${note}</p><ul class="episode-list">${eps.map(episodeRow).join("")}</ul>`;
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
    <section class="detail-section" aria-labelledby="episodesHeading">
      <h2 id="episodesHeading">Episodes</h2>
      ${episodesSection(a.episodes)}
    </section>
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

  function createApp(win) {
    const doc = win.document;
    const $ = (s) => doc.querySelector(s);
    const state = {
      anime: [], filter: "all", search: "", sort: "newest",
      loaded: false, failed: false,
      view: null, detailId: undefined, detailKind: null, fromList: false, listScroll: 0, lastCard: null
    };
    const grid = $("#animeGrid");
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
      grid.innerHTML = list.length ? list.map(cardHtml).join("") : `<div class="empty">No matching anime found.</div>`;
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
      searchInput.addEventListener("input", (e) => { state.search = e.target.value; render(); });
      sortSelect.addEventListener("change", (e) => { state.sort = e.target.value; render(); });
      filterButtons.forEach((b) => b.addEventListener("click", () => {
        state.filter = b.dataset.filter;
        filterButtons.forEach((x) => x.classList.toggle("active", x === b));
        render();
      }));
      refreshButton.addEventListener("click", () => loadCatalog("Refreshing catalog..."));
      grid.addEventListener("click", onGridClick);
      backLink.addEventListener("click", onBack);
      win.addEventListener("hashchange", () => showRoute({ fresh: true }));
      showRoute({ fresh: true });
      return loadCatalog();
    }

    return { state, start, render, showRoute, loadCatalog };
  }

  const api = {
    esc, safeUrl, externalUrl, imageSrc, youtubeId, recordId, routeFor, parseRoute,
    cardHtml, detailHtml, stateHtml, platformRows, episodesSection, createApp, isAnnouncementUrl
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
