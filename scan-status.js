"use strict";

/*
 * Scan status for the static site.
 *
 *  1. ALWAYS (no backend needed): shows what the last completed automatic scan found, read from the saved catalog
 *     (data/anime.json -> updateInfo.lastScan). The Refresh button only reloads that saved file. It does not search any
 *     source, and this page says so.
 *
 *  2. ONLY IF a backend endpoint is configured (<meta name="refresh-scan-endpoint" content="https://...">, empty by
 *     default): an owner-only "Scan now" button. It signs in through the backend (GitHub login), asks the backend to
 *     start the scan workflow, follows the run, and reloads the catalog ONLY after the run really completed AND the
 *     published catalog contains that run's result.
 *
 * Secrets: this file contains none and handles none. The session token the backend hands back lives in one JavaScript
 * variable (page memory) and nowhere else: it is not written to browser storage, a cookie, the URL or the DOM, and a
 * page reload simply asks for a new sign-in. There is no GitHub token anywhere in the browser.
 *
 * All text is inserted with textContent. Server text is never interpreted as HTML.
 */
(function (root) {
  const SESSION_KEY = "scan-session";
  const ERROR_KEY = "scan-error";
  const TERMINAL = new Set(["completed", "failed", "timeout", "not-found"]);

  const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
  const clean = (v, max) => String(v === undefined || v === null ? "" : v).replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
  const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  /* ------------------------------ last completed scan (public, static) ------------------------------ */

  const utc = (value) => {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? "" : `${date.toISOString().slice(0, 16).replace("T", " ")} UTC`;
  };

  /* -> { text, tone } where tone is "ok" | "warn" | "none". Never throws on odd data. */
  function describeLastScan(catalog, formatTime = utc) {
    const info = isObj(catalog) && isObj(catalog.updateInfo) ? catalog.updateInfo : null;
    const scan = info && isObj(info.lastScan) ? info.lastScan : null;

    if (!scan) return { text: "", tone: "none" };

    const when = formatTime(scan.scannedAt);
    const added = Number.isInteger(scan.added) ? scan.added : 0;
    const discovery = isObj(scan.discovery) ? scan.discovery : null;
    const parts = [];
    let tone = "ok";

    if (added > 0) parts.push(`Last scan${when ? ` (${when})` : ""}: added ${added} new title${added === 1 ? "" : "s"}.`);
    else {
      parts.push(`Last scan${when ? ` (${when})` : ""}: nothing new was added.`);
      const reason = clean(scan.zeroAddReason, 300);
      if (reason) parts.push(reason);
    }

    const completeness = discovery && isObj(discovery.completeness) ? discovery.completeness : null;

    if (completeness && completeness.complete === false && discovery.status !== "skipped" && discovery.status !== "disabled") {
      parts.push(`Channel discovery was incomplete (${clean(completeness.stopReason, 60) || "stopped early"}); it continues on the next scan.`);
      tone = "warn";
    }

    if (discovery && (discovery.status === "failed" || discovery.status === "error")) tone = "warn";

    return { text: parts.join(" "), tone };
  }

  /* ------------------------------ configuration and session hand-over ------------------------------ */

  /* A backend endpoint must be https (http only for local development), with no credentials, query or fragment. */
  function normalizeEndpoint(raw) {
    const value = clean(raw, 300);
    if (!value) return "";

    try {
      const url = new URL(value);
      const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
      if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) return "";
      if (url.username || url.password || url.search || url.hash) return "";
      return url.origin + url.pathname.replace(/\/+$/, "");
    } catch {
      return "";
    }
  }

  function endpointFrom(doc) {
    const meta = doc && doc.querySelector ? doc.querySelector('meta[name="refresh-scan-endpoint"]') : null;
    return meta ? normalizeEndpoint(meta.getAttribute("content")) : "";
  }

  /* The backend redirects back with "#scan-session=<token>" or "#scan-error=<code>". Fragments are never sent to a server. */
  function takeSessionFromHash(hash) {
    const body = String(hash || "").replace(/^#/, "");
    const match = new RegExp(`^(${SESSION_KEY}|${ERROR_KEY})=([A-Za-z0-9_.-]{1,2048})$`).exec(body);

    if (!match) return { token: null, error: null, consumed: false };
    if (match[1] === SESSION_KEY) return { token: match[2].length >= 10 ? match[2] : null, error: match[2].length >= 10 ? null : "login-failed", consumed: true };

    return { token: null, error: match[2], consumed: true };
  }

  /* ------------------------------ client ------------------------------ */

  function createScanClient({ endpoint, fetchImpl, getToken, setToken, sleep = defaultSleep, now = () => Date.now(), pollIntervalMs = 5000, maxWaitMs = 25 * 60 * 1000, maxFetchFailures = 3 }) {
    const call = async (path, init = {}) => {
      const headers = { Accept: "application/json", ...(getToken() ? { Authorization: `Bearer ${getToken()}` } : {}) };
      const response = await fetchImpl(`${endpoint}${path}`, { ...init, headers, cache: "no-store" });
      let data = null;

      try {
        data = await response.json();
      } catch {
        data = null;
      }

      return { response, data: isObj(data) ? data : {} };
    };

    const refused = (response, data) => {
      if (response.status === 401) {
        setToken(null); // the session is no good any more: drop it, ask for a fresh sign-in
        return { ok: false, state: "needs-login", message: clean(data.message, 200) };
      }
      if (response.status === 403) return { ok: false, state: "forbidden", message: clean(data.message, 200) };
      if (response.status === 429) return { ok: false, state: "rate-limited", retryAfter: Number(response.headers && response.headers.get ? response.headers.get("retry-after") : 0) || 0, message: clean(data.message, 200) };
      if (response.status === 503) return { ok: false, state: "unavailable", message: clean(data.message, 200) };
      return { ok: false, state: "error", message: clean(data.message, 200) || `HTTP ${response.status}` };
    };

    return {
      async start() {
        if (!getToken()) return { ok: false, state: "needs-login" };

        try {
          const { response, data } = await call("/scan", { method: "POST" });
          if (response.status !== 202) return refused(response, data);

          return { ok: true, state: "queued", jobId: Number.isSafeInteger(data.jobId) ? data.jobId : null, coalesced: data.coalesced === true, untracked: data.untracked === true, message: clean(data.message, 200) };
        } catch {
          return { ok: false, state: "error", message: "The scan service could not be reached." };
        }
      },

      /* Follows one job until it reaches a terminal state or the client-side wait runs out. onUpdate sees every poll. */
      async watch(jobId, onUpdate = () => {}) {
        const startedAt = now();
        let failures = 0;
        let lastState = "queued";

        for (;;) {
          let step;

          try {
            const { response, data } = await call(`/scan/${encodeURIComponent(jobId)}`);
            failures = 0;

            if (response.status === 429) {
              step = { state: lastState, waiting: true }; // polled too fast: keep what we knew and wait
            } else if (response.status === 401 || response.status === 403 || response.status >= 500) {
              return refused(response, data);
            } else {
              step = { state: clean(data.state, 20) || "error", jobId, createdAt: clean(data.createdAt, 40), conclusion: clean(data.conclusion, 30), message: clean(data.message, 200), runUrl: typeof data.runUrl === "string" && data.runUrl.startsWith("https://github.com/") ? data.runUrl : "" };
              if (response.status === 404) step.state = "not-found";
            }
          } catch {
            if (++failures >= maxFetchFailures) return { ok: false, state: "error", message: "The scan service could not be reached." };
            step = { state: lastState, waiting: true };
          }

          lastState = step.state;
          onUpdate(step);
          if (TERMINAL.has(step.state)) return step;

          if (now() - startedAt >= maxWaitMs) return { state: "timeout", jobId, message: "Still not finished; it may complete later." };
          await sleep(pollIntervalMs);
        }
      }
    };
  }

  /*
   * After the run completes, GitHub Pages still has to publish the commit. The catalog is only called published when
   * its own lastScan.scannedAt is not older than the moment the run was created.
   */
  async function waitForPublished({ fetchCatalog, since, sleep = defaultSleep, now = () => Date.now(), intervalMs = 10000, maxWaitMs = 5 * 60 * 1000 }) {
    const startedAt = now();

    for (;;) {
      try {
        const data = await fetchCatalog();
        const scannedAt = Date.parse(isObj(data) && isObj(data.updateInfo) && isObj(data.updateInfo.lastScan) ? data.updateInfo.lastScan.scannedAt : "");
        if (!Number.isNaN(scannedAt) && !Number.isNaN(since) && scannedAt >= since - 1000) return { published: true, data };
      } catch {
        /* a failed fetch is just "not yet" */
      }

      if (now() - startedAt >= maxWaitMs) return { published: false };
      await sleep(intervalMs);
    }
  }

  /* The whole click: start -> follow -> (only on a real success) wait for publication -> reload exactly once. */
  async function runScan({ client, fetchCatalog, reload, onStatus, sleep, now, publishIntervalMs, publishMaxWaitMs }) {
    const started = await client.start();
    onStatus(started);

    if (!started.ok) return started;
    if (started.jobId === null) return { ...started, state: "untracked" }; // requested, but there is no run to follow: never reload on a guess

    const final = await client.watch(started.jobId, onStatus);
    if (final.state !== "completed") {
      onStatus(final);
      return final; // failed, timeout, not-found, needs-login, error: no reload
    }

    onStatus({ state: "publishing" });
    const published = await waitForPublished({ fetchCatalog, since: Date.parse(final.createdAt), sleep, now, intervalMs: publishIntervalMs, maxWaitMs: publishMaxWaitMs });

    if (!published.published) {
      const pending = { state: "publish-pending" };
      onStatus(pending);
      return pending;
    }

    await reload();
    const done = { state: "reloaded" };
    onStatus(done);
    return done;
  }

  const MESSAGES = {
    "needs-login": "Sign in with the owner's GitHub account to start a scan.",
    queued: "Scan queued. It starts shortly.",
    running: "Scan running: checking the official channel...",
    publishing: "The scan finished. Waiting for the site to publish the result...",
    reloaded: "The scan finished and the catalog was reloaded.",
    "publish-pending": "The scan finished, but the site has not published it yet. Use Refresh in a minute.",
    failed: "The scan did not finish successfully. Nothing was changed on this page.",
    timeout: "The scan has not finished yet. It may still complete; use Refresh later.",
    "not-found": "That scan could not be found.",
    forbidden: "This account is not allowed to start scans.",
    "rate-limited": "Too many scans were requested. Try again shortly.",
    unavailable: "The scan service is not available right now.",
    untracked: "The scan was requested, but its progress cannot be shown. Use Refresh later.",
    error: "The scan service could not be reached."
  };

  const messageFor = (step) => {
    if (step.state === "rate-limited" && step.retryAfter) return `${MESSAGES["rate-limited"]} (about ${step.retryAfter}s)`;
    if (step.state === "queued" && step.coalesced) return "A scan was already queued; following that one.";
    return MESSAGES[step.state] || "";
  };

  /* ------------------------------ DOM wiring ------------------------------ */

  function createScanUi(win, app) {
    const doc = win.document;
    const $ = (selector) => doc.querySelector(selector);
    const summary = $("#scanSummary");
    const tools = $("#ownerTools");
    const button = $("#scanButton");
    const progress = $("#scanProgress");
    const endpoint = endpointFrom(doc);
    let token = null; // page memory only
    let busy = false;

    const show = (el, value) => {
      if (el) el.textContent = value;
    };

    function onCatalog(data) {
      if (!summary) return;
      const { text, tone } = describeLastScan(data, (value) => {
        const date = new Date(value);
        return Number.isNaN(date.getTime()) ? "" : date.toLocaleString();
      });
      summary.textContent = text;
      summary.dataset.tone = tone;
      summary.hidden = !text;
    }

    const fetchCatalog = async () => {
      const response = await win.fetch(`data/anime.json?t=${Date.now()}`, { cache: "no-store" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return response.json();
    };

    // Come back from the backend's sign-in: take the token out of the address bar immediately.
    const taken = takeSessionFromHash(win.location.hash);

    if (taken.consumed) {
      token = taken.token;
      try {
        win.history.replaceState(null, "", `${win.location.pathname}${win.location.search}#/`);
      } catch {
        /* history may be unavailable; the token is already out of reach of the page URL logic below */
      }
    }

    if (endpoint && tools && button) {
      tools.hidden = false;
      show(progress, taken.error === "not-authorized" ? MESSAGES.forbidden : taken.error ? "Sign-in did not complete. Try again." : token ? "Signed in. You can start a scan." : "");

      const client = createScanClient({ endpoint, fetchImpl: (url, init) => win.fetch(url, init), getToken: () => token, setToken: (value) => { token = value; } });

      button.addEventListener("click", async () => {
        if (busy) return;

        if (!token) {
          win.location.assign(`${endpoint}/auth/login?return=${encodeURIComponent(`${win.location.origin}${win.location.pathname}`)}`);
          return;
        }

        busy = true;
        button.disabled = true;

        try {
          await runScan({
            client,
            fetchCatalog,
            reload: () => (app && typeof app.loadCatalog === "function" ? app.loadCatalog("Refreshing catalog...") : Promise.resolve()),
            onStatus: (step) => show(progress, messageFor(step) || ""),
            publishIntervalMs: 10000,
            publishMaxWaitMs: 5 * 60 * 1000
          });
        } finally {
          busy = false;
          button.disabled = false;
        }
      });
    }

    return { onCatalog, hasEndpoint: Boolean(endpoint), getToken: () => token };
  }

  const api = { describeLastScan, normalizeEndpoint, endpointFrom, takeSessionFromHash, createScanClient, waitForPublished, runScan, messageFor, createScanUi, TERMINAL };

  if (typeof module !== "undefined" && module.exports) module.exports = api;

  if (typeof window !== "undefined" && window.document) {
    let ui = null;
    root.ScanStatus = {
      ...api,
      attach(win, app) {
        ui = createScanUi(win, app);
      },
      onCatalog(data) {
        if (ui) ui.onCatalog(data);
      }
    };
  }
})(typeof window !== "undefined" ? window : globalThis);
