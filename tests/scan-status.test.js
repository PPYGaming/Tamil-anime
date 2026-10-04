"use strict";

// Frontend scan-status module: the public "last scan" text, the owner-only scan client, and - most importantly - that the
// catalog is reloaded only after a scan has REALLY completed and been published. Also: no token, key or guessed endpoint
// anywhere in the files the browser downloads. Pure Node, no DOM library, no network.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const status = require("../scan-status.js");

const ROOT = path.resolve(__dirname, "..");
const ENDPOINT = "https://scan.example.test";
const TOKEN = "TEST-SESSION-TOKEN-0000.signature";

const fakeClock = () => ({ t: 1_000_000, now() { return this.t; }, async sleep(ms) { this.t += ms; } });

/* scripted backend: replies in order for each path */
function backend(script) {
  const calls = [];
  const queue = { ...script };

  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url);
    calls.push({ method: init.method || "GET", path: u.pathname, headers: init.headers || {} });
    const list = queue[`${init.method || "GET"} ${u.pathname.replace(/\d+$/, "{id}")}`];
    if (!list || !list.length) throw new Error(`unscripted ${init.method || "GET"} ${u.pathname}`);

    const next = list.length > 1 ? list.shift() : list[0];
    if (next instanceof Error) throw next;
    const { status: code = 200, body = {}, headers = {} } = next;
    return { ok: code >= 200 && code < 300, status: code, headers: { get: (name) => headers[String(name).toLowerCase()] ?? null }, json: async () => body };
  };

  return { fetchImpl, calls };
}

const run = (state, extra = {}) => ({ status: 200, body: { state, jobId: 9001, createdAt: "2026-10-04T10:00:00.000Z", ...extra } });

function client(script, tokenRef = { token: TOKEN }, clock = fakeClock()) {
  const { fetchImpl, calls } = backend(script);
  return { calls, clock, tokenRef, client: status.createScanClient({ endpoint: ENDPOINT, fetchImpl, getToken: () => tokenRef.token, setToken: (v) => { tokenRef.token = v; }, sleep: (ms) => clock.sleep(ms), now: () => clock.now(), pollIntervalMs: 1000, maxWaitMs: 60_000 }) };
}

/* ------------------------------ the public last-scan text ------------------------------ */

const scanCatalog = (scan) => ({ updateInfo: { lastScan: { scannedAt: "2026-10-04T06:00:00.000Z", added: 0, ...scan } } });

test("last scan: says what was added", () => {
  const { text, tone } = status.describeLastScan(scanCatalog({ added: 2 }));
  assert.match(text, /added 2 new titles/);
  assert.match(text, /2026-10-04 06:00 UTC/);
  assert.equal(tone, "ok");
  assert.match(status.describeLastScan(scanCatalog({ added: 1 })).text, /added 1 new title\./);
});

test("last scan: a zero-add scan shows the precise reason the updater recorded", () => {
  const reason = 'The scan completed and no video on the allow-listed channel has a title starting with "Tamil Dub".';
  const { text } = status.describeLastScan(scanCatalog({ zeroAddReason: reason }));

  assert.match(text, /nothing new was added/);
  assert.ok(text.includes(reason));
});

test("last scan: incomplete discovery is flagged so 'nothing found' is never mistaken for 'nothing exists'", () => {
  const { text, tone } = status.describeLastScan(scanCatalog({ zeroAddReason: "x", discovery: { status: "partial", completeness: { complete: false, stopReason: "quota-exhausted" } } }));

  assert.match(text, /incomplete \(quota-exhausted\)/);
  assert.equal(tone, "warn");

  const skipped = status.describeLastScan(scanCatalog({ discovery: { status: "skipped", completeness: { complete: false } } }));
  assert.doesNotMatch(skipped.text, /incomplete/, "a skipped discovery is explained by its reason, not called incomplete");
});

test("last scan: absent or hostile data never throws and never produces markup", () => {
  assert.deepEqual(status.describeLastScan(null), { text: "", tone: "none" });
  assert.deepEqual(status.describeLastScan({}), { text: "", tone: "none" });
  assert.deepEqual(status.describeLastScan({ updateInfo: { lastScan: "nope" } }), { text: "", tone: "none" });

  const hostile = status.describeLastScan(scanCatalog({ zeroAddReason: `<img src=x onerror=alert(1)>\n${"A".repeat(5000)}` }));
  assert.ok(hostile.text.length < 500);
  assert.doesNotMatch(hostile.text, /\n/);
});

/* ------------------------------ configuration ------------------------------ */

test("endpoint: https only (http for localhost), no credentials, query or fragment", () => {
  assert.equal(status.normalizeEndpoint("https://scan.example.test/"), "https://scan.example.test");
  assert.equal(status.normalizeEndpoint("https://scan.example.test/api/"), "https://scan.example.test/api");
  assert.equal(status.normalizeEndpoint("http://localhost:8787"), "http://localhost:8787");
  assert.equal(status.normalizeEndpoint("http://scan.example.test"), "");
  assert.equal(status.normalizeEndpoint("https://user:pass@scan.example.test"), "");
  assert.equal(status.normalizeEndpoint("https://scan.example.test/?x=1"), "");
  assert.equal(status.normalizeEndpoint("https://scan.example.test/#frag"), "");
  assert.equal(status.normalizeEndpoint("javascript:alert(1)"), "");
  assert.equal(status.normalizeEndpoint(""), "");
  assert.equal(status.normalizeEndpoint(null), "");
});

test("the shipped index.html has an EMPTY endpoint: no guessed backend address", () => {
  const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
  const meta = /<meta name="refresh-scan-endpoint" content="([^"]*)">/.exec(html);

  assert.ok(meta, "the endpoint meta tag exists");
  assert.equal(meta[1], "");
  assert.equal(status.endpointFrom({ querySelector: () => ({ getAttribute: () => meta[1] }) }), "");
});

test("session hand-over: only the exact fragment shapes are accepted", () => {
  assert.deepEqual(status.takeSessionFromHash(`#scan-session=${TOKEN}`), { token: TOKEN, error: null, consumed: true });
  assert.deepEqual(status.takeSessionFromHash("#scan-error=not-authorized"), { token: null, error: "not-authorized", consumed: true });
  assert.equal(status.takeSessionFromHash("#scan-session=short").token, null);

  for (const hash of ["", "#/", "#/anime/abc", "#scan-session=", "#scan-session=a b", "#x=1&scan-session=AAAAAAAAAAAA", "#scan-session=<script>"]) {
    assert.equal(status.takeSessionFromHash(hash).consumed, false, hash);
  }
});

/* ------------------------------ client ------------------------------ */

test("start: without a session nothing is sent", async () => {
  const { client: c, calls } = client({}, { token: null });
  assert.deepEqual(await c.start(), { ok: false, state: "needs-login" });
  assert.equal(calls.length, 0);
});

test("start: the session goes only in the Authorization header, and a job id comes back", async () => {
  const { client: c, calls } = client({ "POST /scan": [{ status: 202, body: { jobId: 9001, state: "queued", coalesced: true } }] });
  const result = await c.start();

  assert.deepEqual({ ok: result.ok, jobId: result.jobId, coalesced: result.coalesced }, { ok: true, jobId: 9001, coalesced: true });
  assert.equal(calls[0].headers.Authorization, `Bearer ${TOKEN}`);
  assert.equal(calls[0].path, "/scan");
});

test("start: each refusal maps to its own state, and a rejected session is dropped from memory", async () => {
  const cases = [
    [{ status: 401, body: { error: "session-expired", message: "Your session expired." } }, "needs-login"],
    [{ status: 403, body: { error: "forbidden" } }, "forbidden"],
    [{ status: 429, body: {}, headers: { "retry-after": "42" } }, "rate-limited"],
    [{ status: 503, body: { error: "not-configured" } }, "unavailable"],
    [{ status: 500, body: {} }, "error"],
    [new Error("offline"), "error"]
  ];

  for (const [reply, expected] of cases) {
    const ref = { token: TOKEN };
    const { client: c } = client({ "POST /scan": [reply] }, ref);
    const result = await c.start();

    assert.equal(result.state, expected);
    assert.equal(result.ok, false);
    if (expected === "needs-login") assert.equal(ref.token, null, "the dead session is forgotten");
    if (expected === "rate-limited") assert.equal(result.retryAfter, 42);
  }
});

test("watch: follows queued -> running -> completed and reports every step", async () => {
  const { client: c, calls, clock } = client({ "GET /scan/{id}": [run("queued"), run("running"), run("running"), run("completed")] });
  const seen = [];
  const final = await c.watch(9001, (step) => seen.push(step.state));

  assert.deepEqual(seen, ["queued", "running", "running", "completed"]);
  assert.equal(final.state, "completed");
  assert.equal(calls.length, 4);
  assert.equal(clock.t, 1_000_000 + 3000, "it waited between polls, not in a hot loop");
});

test("watch: failed and not-found end the wait; a poll the server rate-limits keeps the last known state", async () => {
  const failed = await client({ "GET /scan/{id}": [run("running"), run("failed", { conclusion: "failure" })] }).client.watch(1);
  assert.equal(failed.state, "failed");
  assert.equal(failed.conclusion, "failure");

  const gone = await client({ "GET /scan/{id}": [{ status: 404, body: { state: "not-found" } }] }).client.watch(1);
  assert.equal(gone.state, "not-found");

  const seen = [];
  await client({ "GET /scan/{id}": [run("running"), { status: 429, body: {} }, run("completed")] }).client.watch(1, (step) => seen.push(step.state));
  assert.deepEqual(seen, ["running", "running", "completed"]);
});

test("watch: gives up with timeout after its own limit, never loops forever", async () => {
  const { client: c } = client({ "GET /scan/{id}": [run("running")] });
  const final = await c.watch(1);

  assert.equal(final.state, "timeout");
});

test("watch: repeated network failures end as an error; an expired session ends as needs-login", async () => {
  const offline = await client({ "GET /scan/{id}": [new Error("offline")] }).client.watch(1);
  assert.equal(offline.state, "error");

  const ref = { token: TOKEN };
  const expired = await client({ "GET /scan/{id}": [run("running"), { status: 401, body: { error: "session-expired" } }] }, ref).client.watch(1);
  assert.equal(expired.state, "needs-login");
  assert.equal(ref.token, null);
});

test("watch: server text is length-bounded and a hostile run URL is dropped", async () => {
  const { client: c } = client({ "GET /scan/{id}": [run("completed", { message: "x".repeat(900), runUrl: "javascript:alert(1)" })] });
  const final = await c.watch(1);

  assert.ok(final.message.length <= 200);
  assert.equal(final.runUrl, "");
});

/* ------------------------------ reload only after a real, published completion ------------------------------ */

function scenario(script, { catalogs = [], token = TOKEN } = {}) {
  const ref = { token };
  const built = client(script, ref);
  const events = [];
  const queue = [...catalogs];
  let reloads = 0;

  const fetchCatalog = async () => {
    events.push("catalog-fetch");
    const next = queue.length > 1 ? queue.shift() : queue[0];
    if (!next) throw new Error("no catalog scripted");
    return next;
  };

  const go = () =>
    status.runScan({
      client: built.client,
      fetchCatalog,
      reload: async () => {
        reloads++;
        events.push("RELOAD");
      },
      onStatus: (step) => events.push(`status:${step.state}`),
      sleep: (ms) => built.clock.sleep(ms),
      now: () => built.clock.now(),
      publishIntervalMs: 1000,
      publishMaxWaitMs: 30_000
    });

  return { go, events, reloads: () => reloads, calls: built.calls };
}

const oldCatalog = { updateInfo: { lastScan: { scannedAt: "2026-10-04T05:00:00.000Z" } } }; // before the run was created (10:00)
const newCatalog = { updateInfo: { lastScan: { scannedAt: "2026-10-04T10:00:30.000Z" } } };
const START = { "POST /scan": [{ status: 202, body: { jobId: 9001, state: "queued" } }] };

test("a completed AND published scan reloads the catalog exactly once, and only at the end", async () => {
  const s = scenario({ ...START, "GET /scan/{id}": [run("queued"), run("running"), run("completed")] }, { catalogs: [oldCatalog, oldCatalog, newCatalog] });
  const result = await s.go();

  assert.equal(result.state, "reloaded");
  assert.equal(s.reloads(), 1);
  assert.ok(s.events.indexOf("RELOAD") > s.events.indexOf("status:completed"), "reload comes after completion");
  assert.ok(s.events.indexOf("RELOAD") > s.events.lastIndexOf("catalog-fetch"), "reload comes after the published catalog was seen");
  assert.equal(s.events.filter((e) => e === "catalog-fetch").length, 3, "an old catalog was not mistaken for the new one");
  assert.ok(!s.events.slice(0, s.events.indexOf("status:completed")).includes("RELOAD"), "never reloads while queued or running");
});

test("queued or running: the catalog is never touched or reloaded", async () => {
  const s = scenario({ ...START, "GET /scan/{id}": [run("queued"), run("running"), run("running")] }, { catalogs: [newCatalog] });
  const result = await s.go();

  assert.equal(result.state, "timeout", "ended by the client's own wait limit");
  assert.equal(s.reloads(), 0);
  assert.equal(s.events.filter((e) => e === "catalog-fetch").length, 0);
});

test("failed, cancelled, timed-out, missing: no reload and no 'scan finished' message", async () => {
  const failures = [
    { "GET /scan/{id}": [run("running"), run("failed", { conclusion: "failure" })] },
    { "GET /scan/{id}": [run("failed", { conclusion: "cancelled" })] },
    { "GET /scan/{id}": [run("running"), run("timeout")] },
    { "GET /scan/{id}": [{ status: 404, body: { state: "not-found" } }] },
    { "GET /scan/{id}": [{ status: 500, body: {} }] }
  ];

  for (const script of failures) {
    const s = scenario({ ...START, ...script }, { catalogs: [newCatalog] });
    const result = await s.go();

    assert.notEqual(result.state, "reloaded");
    assert.equal(s.reloads(), 0);
    assert.ok(!s.events.includes("status:publishing"));
    assert.ok(!s.events.includes("status:reloaded"));
  }
});

test("completed but the site has not published the result yet: wait, then say so, and do NOT reload", async () => {
  const s = scenario({ ...START, "GET /scan/{id}": [run("completed")] }, { catalogs: [oldCatalog] });
  const result = await s.go();

  assert.equal(result.state, "publish-pending");
  assert.equal(s.reloads(), 0);
  assert.ok(s.events.filter((e) => e === "catalog-fetch").length > 1, "it kept checking for a while");
});

test("a catalog fetch that fails while waiting for publication is 'not yet', not a crash", async () => {
  const ref = { token: TOKEN };
  const built = client({ ...START, "GET /scan/{id}": [run("completed")] }, ref);
  let attempt = 0;
  let reloads = 0;

  const result = await status.runScan({
    client: built.client,
    fetchCatalog: async () => {
      if (++attempt < 3) throw new Error("HTTP 503");
      return newCatalog;
    },
    reload: async () => { reloads++; },
    onStatus: () => {},
    sleep: (ms) => built.clock.sleep(ms),
    now: () => built.clock.now(),
    publishIntervalMs: 1000,
    publishMaxWaitMs: 30_000
  });

  assert.equal(result.state, "reloaded");
  assert.equal(reloads, 1);
});

test("no session, rate limit, forbidden, unavailable, untracked: nothing is followed and nothing is reloaded", async () => {
  const noSession = scenario({}, { token: null, catalogs: [newCatalog] });
  assert.equal((await noSession.go()).state, "needs-login");
  assert.equal(noSession.calls.length, 0);
  assert.equal(noSession.reloads(), 0);

  for (const [reply, state] of [[{ status: 429, body: {} }, "rate-limited"], [{ status: 403, body: {} }, "forbidden"], [{ status: 503, body: {} }, "unavailable"]]) {
    const s = scenario({ "POST /scan": [reply] }, { catalogs: [newCatalog] });
    assert.equal((await s.go()).state, state);
    assert.equal(s.calls.filter((call) => call.path.startsWith("/scan/")).length, 0);
    assert.equal(s.reloads(), 0);
  }

  const untracked = scenario({ "POST /scan": [{ status: 202, body: { jobId: null, state: "queued", untracked: true } }] }, { catalogs: [newCatalog] });
  assert.equal((await untracked.go()).state, "untracked");
  assert.equal(untracked.reloads(), 0);
});

test("a scan that joined one already queued is followed like any other", async () => {
  const s = scenario({ "POST /scan": [{ status: 202, body: { jobId: 9002, state: "queued", coalesced: true } }], "GET /scan/{id}": [run("completed", { jobId: 9002 })] }, { catalogs: [newCatalog] });
  assert.equal((await s.go()).state, "reloaded");
  assert.equal(s.calls.at(-1).path, "/scan/9002");
});

/* ------------------------------ DOM wiring with a tiny fake document ------------------------------ */

function fakeWindow({ hash = "", endpoint = ENDPOINT, scanScript = {}, catalogs = [] } = {}) {
  const el = () => ({ textContent: "", hidden: true, disabled: false, dataset: {}, listeners: {}, addEventListener(name, fn) { this.listeners[name] = fn; } });
  const elements = { "#scanSummary": el(), "#ownerTools": el(), "#scanButton": el(), "#scanProgress": el() };
  const meta = { getAttribute: () => endpoint };
  const replaced = [];
  const assigned = [];
  const { fetchImpl } = backend(scanScript);
  const queue = [...catalogs];

  const win = {
    document: { querySelector: (selector) => (selector === 'meta[name="refresh-scan-endpoint"]' ? meta : elements[selector] || null) },
    location: { hash, pathname: "/Tamil-anime/", search: "", origin: "https://owner.github.io", assign: (url) => assigned.push(url) },
    history: { replaceState: (...args) => replaced.push(args) },
    fetch: async (url, init) => {
      if (String(url).startsWith("data/anime.json")) return { ok: true, status: 200, json: async () => (queue.length > 1 ? queue.shift() : queue[0]) };
      return fetchImpl(url, init);
    }
  };

  return { win, elements, replaced, assigned };
}

test("DOM: with no endpoint the owner tools stay hidden and only the public summary works", () => {
  const { win, elements } = fakeWindow({ endpoint: "" });
  const ui = status.createScanUi(win, { loadCatalog: async () => {} });

  assert.equal(ui.hasEndpoint, false);
  assert.equal(elements["#ownerTools"].hidden, true);
  assert.equal(elements["#scanButton"].listeners.click, undefined);

  ui.onCatalog({ updateInfo: { lastScan: { scannedAt: "2026-10-04T06:00:00.000Z", added: 1 } } });
  assert.match(elements["#scanSummary"].textContent, /added 1 new title/);
  assert.equal(elements["#scanSummary"].hidden, false);

  ui.onCatalog({});
  assert.equal(elements["#scanSummary"].hidden, true);
});

test("DOM: the session in the URL fragment is moved to memory and removed from the address bar at once", () => {
  const { win, elements, replaced } = fakeWindow({ hash: `#scan-session=${TOKEN}` });
  const ui = status.createScanUi(win, null);

  assert.equal(ui.getToken(), TOKEN);
  assert.equal(replaced.length, 1);
  assert.ok(!String(replaced[0][2]).includes(TOKEN), "the address bar no longer holds the token");
  assert.ok(!JSON.stringify(elements).includes(TOKEN), "the token is never written into the page");
  assert.equal(elements["#ownerTools"].hidden, false);
});

test("DOM: a denied sign-in is explained and no token is kept", () => {
  const { win, elements } = fakeWindow({ hash: "#scan-error=not-authorized" });
  const ui = status.createScanUi(win, null);

  assert.equal(ui.getToken(), null);
  assert.match(elements["#scanProgress"].textContent, /not allowed/);
});

test("DOM: clicking without a session goes to the backend's sign-in, returning to this site only", async () => {
  const { win, elements, assigned } = fakeWindow();
  status.createScanUi(win, null);
  await elements["#scanButton"].listeners.click();

  assert.equal(assigned.length, 1);
  const target = new URL(assigned[0]);
  assert.equal(target.origin + target.pathname, `${ENDPOINT}/auth/login`);
  assert.equal(target.searchParams.get("return"), "https://owner.github.io/Tamil-anime/");
});

test("DOM: a full click reloads through the app exactly once, after completion and publication", async () => {
  const { win, elements } = fakeWindow({
    hash: `#scan-session=${TOKEN}`,
    scanScript: { "POST /scan": [{ status: 202, body: { jobId: 9001, state: "queued" } }], "GET /scan/{id}": [run("completed")] },
    catalogs: [newCatalog]
  });
  const loads = [];
  status.createScanUi(win, { loadCatalog: async (message) => { loads.push(message); } });

  // The real pauses are long; run the click against a zero-wait timer.
  const realSetTimeout = global.setTimeout;
  global.setTimeout = (fn) => realSetTimeout(fn, 0);

  try {
    await elements["#scanButton"].listeners.click();
  } finally {
    global.setTimeout = realSetTimeout;
  }

  assert.deepEqual(loads, ["Refreshing catalog..."]);
  assert.match(elements["#scanProgress"].textContent, /reloaded/);
  assert.equal(elements["#scanButton"].disabled, false, "the button is usable again");
});

/* ------------------------------ nothing secret ships to the browser ------------------------------ */

const SHIPPED = ["index.html", "app.js", "scan-status.js", "style.css"];
const read = (file) => fs.readFileSync(path.join(ROOT, file), "utf8");

test("shipped frontend files contain no token, key, secret or credential-looking value", () => {
  const patterns = [
    [/ghp_[A-Za-z0-9]{20,}/, "GitHub personal token"],
    [/github_pat_[A-Za-z0-9_]{20,}/, "GitHub fine-grained token"],
    [/gh[ousr]_[A-Za-z0-9]{20,}/, "GitHub token"],
    [/AIza[0-9A-Za-z_-]{20,}/, "Google API key"],
    [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, "private key"],
    [/\bapi[_-]?key\s*[:=]\s*["'][^"']{8,}["']/i, "api key assignment"],
    [/client_secret\s*[:=]\s*["'][^"']+["']/i, "oauth client secret"],
    [/YOUTUBE_API_KEY|TMDB_API_KEY|GITHUB_DISPATCH_TOKEN|SESSION_SECRET/, "secret variable name"]
  ];

  for (const file of SHIPPED) {
    const text = read(file);
    for (const [pattern, label] of patterns) assert.doesNotMatch(text, pattern, `${file} contains a ${label}`);
  }
});

test("the scan module never touches browser storage, cookies, innerHTML or eval", () => {
  const code = read("scan-status.js").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  for (const banned of [/localStorage/, /sessionStorage/, /indexedDB/, /document\.cookie/, /innerHTML/, /outerHTML/, /insertAdjacentHTML/, /\beval\s*\(/, /new Function/, /document\.write/]) {
    assert.doesNotMatch(code, banned, String(banned));
  }
});

test("the scan module embeds no URL of its own: the endpoint can only come from the page's meta tag", () => {
  const code = read("scan-status.js").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const urls = code.match(/https?:\/\/[^\s"'`)]+/g) || [];

  assert.deepEqual(urls.filter((url) => !url.startsWith("https://github.com/")), [], "only the GitHub run-link prefix check appears");
});

test("index.html loads the scan module before app.js and exposes no inline script", () => {
  const html = read("index.html");

  assert.ok(html.indexOf('src="scan-status.js"') > -1 && html.indexOf('src="scan-status.js"') < html.indexOf('src="app.js"'));
  assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>/i, "no inline scripts");
  assert.match(html, /Refresh reloads the saved catalog; it does not search any source itself/);
});
