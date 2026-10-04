"use strict";

// The undeployed Refresh backend (backend/refresh-scan) against a fake GitHub: configuration, owner-only auth, OAuth,
// CORS, rate limits, run coalescing, dispatch contents, and queued/running/completed/failed/timeout status mapping.
// Everything is mocked. No GitHub call, token, host or endpoint is real.
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { loadConfig, createRefreshHandler, createMemoryStore } = require("../backend/refresh-scan/src");
const { issueSession, issueState } = require("../backend/refresh-scan/src/auth");
const { createServer, toRequest } = require("../backend/refresh-scan/adapters/node-server");

const SITE = "https://owner.github.io";
const BASE = "https://refresh.example.test";
const DISPATCH_TOKEN = "TEST-DISPATCH-TOKEN-0000";
const OAUTH_SECRET = "TEST-OAUTH-CLIENT-SECRET-0000";
const SESSION_SECRET = "TEST-SESSION-SECRET-0000-0000-0000-0000";
const USER_TOKEN = "TEST-USER-OAUTH-TOKEN-0000";
const T0 = Date.parse("2026-10-04T00:00:00Z");

const ENV = {
  GITHUB_REPOSITORY: "owner/catalog",
  GITHUB_DISPATCH_TOKEN: DISPATCH_TOKEN,
  GITHUB_OAUTH_CLIENT_ID: "TEST-CLIENT-ID",
  GITHUB_OAUTH_CLIENT_SECRET: OAUTH_SECRET,
  SESSION_SECRET,
  OWNER_GITHUB_LOGINS: "Owner-Login",
  ALLOWED_ORIGIN: SITE,
  PUBLIC_BASE_URL: BASE
};

const SECRETS = [DISPATCH_TOKEN, OAUTH_SECRET, SESSION_SECRET, USER_TOKEN];

function clockAt(start = T0) {
  return { t: start, now() { return this.t; }, advance(ms) { this.t += ms; } };
}

/* A fake GitHub: workflow dispatch + run listing + run lookup + OAuth endpoints. */
function fakeGitHub({ dispatchStyle = "details", profile = { login: "owner-login", id: 4242 }, plan = {} } = {}) {
  const gh = { runs: [], calls: [], nextId: 9000, dispatches: [], clock: null };

  const makeRun = (overrides = {}) => ({
    id: ++gh.nextId,
    status: "queued",
    conclusion: null,
    event: "workflow_dispatch",
    created_at: new Date(gh.clock.now()).toISOString(),
    run_started_at: new Date(gh.clock.now()).toISOString(),
    updated_at: new Date(gh.clock.now()).toISOString(),
    html_url: "https://github.com/owner/catalog/actions/runs/1",
    path: ".github/workflows/update-anime.yml@refs/heads/main",
    ...overrides
  });

  gh.addRun = (overrides) => {
    const run = makeRun(overrides);
    gh.runs.unshift(run);
    return run;
  };

  const reply = (status, body, headers = {}) => ({ ok: status >= 200 && status < 300, status, headers: { get: (name) => headers[String(name).toLowerCase()] ?? null }, json: async () => body });

  gh.fetch = async (url, init = {}) => {
    const u = new URL(url);
    const method = (init.method || "GET").toUpperCase();
    const headers = init.headers || {};
    const body = init.body ? JSON.parse(init.body) : null;
    gh.calls.push({ method, url: String(url), path: u.pathname, headers, body });

    if (plan.fail) {
      const failure = plan.fail({ method, path: u.pathname, url: String(url) });
      if (failure instanceof Error) throw failure;
      if (failure) return reply(failure.status, failure.body || {}, failure.headers);
    }

    if (u.hostname === "github.com" && u.pathname === "/login/oauth/access_token") {
      return body.code === "good-code" ? reply(200, { access_token: USER_TOKEN, token_type: "bearer" }) : reply(200, { error: "bad_verification_code" });
    }

    if (u.hostname === "api.github.com" && u.pathname === "/user") {
      return headers.Authorization === `Bearer ${USER_TOKEN}` ? reply(200, profile) : reply(401, { message: "Bad credentials" });
    }

    if (/\/actions\/workflows\/[^/]+\/dispatches$/.test(u.pathname) && method === "POST") {
      gh.dispatches.push(body);
      const run = gh.addRun();
      return dispatchStyle === "details" ? reply(200, { workflow_run_id: run.id, run_url: `https://api.github.com/repos/owner/catalog/actions/runs/${run.id}`, html_url: run.html_url }) : reply(204, null);
    }

    if (/\/actions\/workflows\/[^/]+\/runs$/.test(u.pathname)) return reply(200, { total_count: gh.runs.length, workflow_runs: gh.runs.slice(0, Number(u.searchParams.get("per_page") || 30)) });

    const one = /\/actions\/runs\/(\d+)$/.exec(u.pathname);
    if (one) {
      const run = gh.runs.find((item) => String(item.id) === one[1]) || gh.foreign;
      return run && String(run.id) === one[1] ? reply(200, run) : reply(404, { message: "Not Found" });
    }

    return reply(404, { message: "Not Found" });
  };

  return gh;
}

function setup({ env = {}, gh, clock = clockAt(), store, logs = [] } = {}) {
  const github = gh || fakeGitHub();
  github.clock = clock;
  const config = loadConfig({ ...ENV, ...env });
  const logger = { info: (entry) => logs.push(JSON.stringify(entry)), warn: (entry) => logs.push(JSON.stringify(entry)) };
  const handle = createRefreshHandler({ config, store: store || createMemoryStore({ now: clock.now.bind(clock) }), clock, fetchImpl: github.fetch, sleep: async () => {}, logger });

  const session = (login = "owner-login", userId = 4242, extra = {}) =>
    issueSession({ login, userId }, { secret: SESSION_SECRET, nowSeconds: Math.floor(clock.now() / 1000), ttlSeconds: 1800, ...extra });

  const send = (path, { method = "GET", token, origin = SITE, headers = {}, ip = "198.51.100.7" } = {}) =>
    handle(new Request(`${BASE}${path}`, { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(origin ? { Origin: origin } : {}), "x-socket-ip": ip, ...headers } }));

  return { gh: github, clock, handle, send, session, logs, config };
}

const body = async (response) => response.json();

/* ------------------------------ configuration ------------------------------ */

test("config: complete configuration loads", () => {
  const result = loadConfig(ENV);
  assert.equal(result.ok, true);
  assert.deepEqual(result.missing, []);
  assert.deepEqual(result.value.ownerLogins, ["owner-login"]);
  assert.equal(result.value.allowedOrigin, SITE);
});

test("config: missing values are listed by NAME and never guessed", () => {
  const result = loadConfig({});
  assert.equal(result.ok, false);
  for (const name of ["GITHUB_REPOSITORY", "GITHUB_DISPATCH_TOKEN", "GITHUB_OAUTH_CLIENT_ID", "GITHUB_OAUTH_CLIENT_SECRET", "SESSION_SECRET", "OWNER_GITHUB_LOGINS", "ALLOWED_ORIGIN", "PUBLIC_BASE_URL"]) {
    assert.ok(result.missing.includes(name), name);
  }
});

test("config: unsafe values are rejected without echoing them", () => {
  const bad = loadConfig({ ...ENV, ALLOWED_ORIGIN: "*", SESSION_SECRET: "short-secret", GITHUB_REPOSITORY: "not a repo", OWNER_GITHUB_LOGINS: "bad login!", WORKFLOW_FILE: "../evil.yml" });
  const text = JSON.stringify(bad.problems);

  assert.equal(bad.ok, false);
  assert.equal(bad.problems.length, 5);
  assert.ok(!text.includes("short-secret"));
  assert.equal(loadConfig({ ...ENV, ALLOWED_ORIGIN: "http://owner.github.io" }).ok, false, "plain http is refused for a real origin");
  assert.equal(loadConfig({ ...ENV, ALLOWED_ORIGIN: "http://localhost:8080" }).ok, true, "but allowed for local development");
  assert.equal(loadConfig({ ...ENV, ALLOWED_ORIGIN: `${SITE}/path` }).ok, false, "an origin has no path");
  assert.equal(loadConfig({ ...ENV, MAX_DISPATCHES_PER_HOUR: "9999" }).ok, false);
});

test("not configured: every route except /health says so, and nothing is sent to GitHub", async () => {
  const { send, gh } = setup({ env: { GITHUB_DISPATCH_TOKEN: "" } });

  const health = await send("/health");
  assert.deepEqual(await body(health), { ok: true, configured: false });

  for (const [path, method] of [["/scan", "POST"], ["/scan/123", "GET"], ["/auth/login", "GET"], ["/scan", "OPTIONS"]]) {
    const response = await send(path, { method });
    assert.equal(response.status, 503, `${method} ${path}`);
    const data = await body(response);
    assert.equal(data.error, "not-configured");
    assert.ok(!JSON.stringify(data).includes("GITHUB_DISPATCH_TOKEN"), "variable names are not exposed over HTTP");
  }

  assert.equal(gh.calls.length, 0);
});

/* ------------------------------ authentication ------------------------------ */

test("POST /scan without a session is 401 and never reaches GitHub", async () => {
  const { send, gh } = setup();
  const response = await send("/scan", { method: "POST" });

  assert.equal(response.status, 401);
  assert.equal(response.headers.get("www-authenticate"), "Bearer");
  assert.equal(gh.calls.length, 0);
});

test("forged, tampered, wrongly-signed and non-session tokens are refused", async () => {
  const { send, session, gh, clock } = setup();
  const good = session();
  const [payload, signature] = good.split(".");
  const forgedPayload = Buffer.from(JSON.stringify({ sub: "owner-login", uid: 4242, exp: 9999999999, aud: "refresh-scan-session" })).toString("base64url");
  const otherSecret = issueSession({ login: "owner-login", userId: 4242 }, { secret: "X".repeat(40), nowSeconds: Math.floor(clock.now() / 1000), ttlSeconds: 1800 });
  const oauthState = issueState({ nonce: "n", returnTo: SITE }, { secret: SESSION_SECRET, nowSeconds: Math.floor(clock.now() / 1000) });

  for (const token of [`${forgedPayload}.${signature}`, `${payload}.${"A".repeat(signature.length)}`, otherSecret, oauthState, "garbage", `${payload}`, "a.b.c"]) {
    const response = await send("/scan", { method: "POST", token });
    assert.equal(response.status, 401, token.slice(0, 20));
  }

  assert.equal(gh.calls.length, 0);
});

test("an expired session is refused with a specific code", async () => {
  const { send, session, clock, gh } = setup();
  const token = session();
  clock.advance(31 * 60 * 1000);
  const response = await send("/scan", { method: "POST", token });

  assert.equal(response.status, 401);
  assert.equal((await body(response)).error, "session-expired");
  assert.equal(gh.calls.length, 0);
});

test("a valid session for a login that is not on the owner list is 403", async () => {
  const { send, session, gh } = setup();
  const response = await send("/scan", { method: "POST", token: session("someone-else", 1) });

  assert.equal(response.status, 403);
  assert.equal(gh.calls.length, 0);
});

test("removing an owner takes effect immediately, without waiting for the session to expire", async () => {
  const first = setup();
  const token = first.session();
  const second = setup({ env: { OWNER_GITHUB_LOGINS: "different-owner" } });

  assert.equal((await second.send("/scan", { method: "POST", token })).status, 403);
});

test("numeric account ids, when configured, must match as well as the login", async () => {
  const { send, session, gh } = setup({ env: { OWNER_GITHUB_USER_IDS: "4242" } });

  assert.equal((await send("/scan", { method: "POST", token: session("owner-login", 999) })).status, 403);
  assert.equal(gh.calls.length, 0);
  assert.equal((await send("/scan", { method: "POST", token: session("owner-login", 4242) })).status, 202);
});

test("CORS: only the configured origin is allowed; any other browser origin is refused before auth is even read", async () => {
  const { send, session, gh } = setup();
  const token = session();

  const evil = await send("/scan", { method: "POST", token, origin: "https://evil.example" });
  assert.equal(evil.status, 403);
  assert.equal((await body(evil)).error, "origin-not-allowed");
  assert.equal(evil.headers.get("access-control-allow-origin"), null);
  assert.equal(gh.calls.length, 0);

  const preflight = await send("/scan", { method: "OPTIONS", origin: SITE });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get("access-control-allow-origin"), SITE);
  assert.match(preflight.headers.get("access-control-allow-headers"), /Authorization/);
  assert.notEqual(preflight.headers.get("access-control-allow-origin"), "*");

  const badPreflight = await send("/scan", { method: "OPTIONS", origin: "https://evil.example" });
  assert.equal(badPreflight.status, 403);
  assert.equal(badPreflight.headers.get("access-control-allow-origin"), null);
});

test("responses are never cacheable and carry no wildcard CORS", async () => {
  const { send, session } = setup();
  const response = await send("/scan", { method: "POST", token: session() });

  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
});

/* ------------------------------ GitHub OAuth ------------------------------ */

test("login redirects to GitHub with a signed state, a bound cookie and no scopes", async () => {
  const { send } = setup();
  const response = await send(`/auth/login?return=${encodeURIComponent(`${SITE}/Tamil-anime/`)}`, { origin: null });

  assert.equal(response.status, 302);
  const target = new URL(response.headers.get("location"));
  assert.equal(target.origin + target.pathname, "https://github.com/login/oauth/authorize");
  assert.equal(target.searchParams.get("client_id"), "TEST-CLIENT-ID");
  assert.equal(target.searchParams.get("redirect_uri"), `${BASE}/auth/callback`);
  assert.equal(target.searchParams.get("scope"), null, "no OAuth scope is requested");
  assert.ok(target.searchParams.get("state"));
  assert.ok(!target.toString().includes(OAUTH_SECRET));

  const cookie = response.headers.get("set-cookie");
  assert.match(cookie, /^__Host-scan_oauth=/);
  for (const flag of ["HttpOnly", "Secure", "SameSite=Lax", "Path=/"]) assert.ok(cookie.includes(flag), flag);
});

test("login refuses a return address on any other origin (no open redirect)", async () => {
  const { send } = setup();

  for (const target of ["https://evil.example/", "javascript:alert(1)", "", "//evil.example", `${SITE}.evil.example/`]) {
    const response = await send(`/auth/login?return=${encodeURIComponent(target)}`, { origin: null });
    assert.equal(response.status, 400, target);
  }
});

async function signIn(ctx, { code = "good-code", profile } = {}) {
  const login = await ctx.send(`/auth/login?return=${encodeURIComponent(`${SITE}/Tamil-anime/`)}`, { origin: null });
  const state = new URL(login.headers.get("location")).searchParams.get("state");
  const cookie = login.headers.get("set-cookie").split(";")[0];
  if (profile) ctx.gh.profile = profile;

  const callback = await ctx.send(`/auth/callback?code=${code}&state=${encodeURIComponent(state)}`, { origin: null, headers: { cookie } });
  return { login, state, cookie, callback };
}

test("callback: an owner gets a session token in the URL FRAGMENT, and the user's GitHub token is dropped", async () => {
  const ctx = setup();
  const { callback } = await signIn(ctx);

  assert.equal(callback.status, 302);
  const location = new URL(callback.headers.get("location"));
  assert.equal(location.origin, SITE);
  assert.equal(location.search, "", "the token is not in the query string");
  assert.match(location.hash, /^#scan-session=[\w.-]+$/);
  assert.match(callback.headers.get("set-cookie"), /Max-Age=0/, "the state cookie is cleared");

  const token = location.hash.slice("#scan-session=".length);
  assert.ok(!token.includes(USER_TOKEN));
  assert.ok(!Buffer.from(token.split(".")[0], "base64url").toString().includes(USER_TOKEN), "the user's GitHub token is not inside the session");

  const response = await ctx.send("/scan", { method: "POST", token });
  assert.equal(response.status, 202, "the minted session works");
});

test("callback: a GitHub account that is not on the owner list gets no session", async () => {
  const ctx = setup({ gh: fakeGitHub({ profile: { login: "stranger", id: 7 } }) });
  const { callback } = await signIn(ctx);
  const location = new URL(callback.headers.get("location"));

  assert.equal(location.hash, "#scan-error=not-authorized");
  assert.ok(!callback.headers.get("location").includes("scan-session"));
});

test("callback: a login on the list with the wrong numeric id is refused (renamed or re-registered account)", async () => {
  const ctx = setup({ env: { OWNER_GITHUB_USER_IDS: "4242" }, gh: fakeGitHub({ profile: { login: "owner-login", id: 31337 } }) });
  const { callback } = await signIn(ctx);

  assert.equal(new URL(callback.headers.get("location")).hash, "#scan-error=not-authorized");
});

test("callback: a bad code, a missing cookie, a tampered state or an expired state never produce a session", async () => {
  const ctx = setup();
  const good = await signIn(ctx, { code: "wrong-code" });
  assert.equal(new URL(good.callback.headers.get("location")).hash, "#scan-error=login-failed");

  const other = setup();
  const login = await other.send(`/auth/login?return=${encodeURIComponent(SITE)}`, { origin: null });
  const state = new URL(login.headers.get("location")).searchParams.get("state");
  const cookie = login.headers.get("set-cookie").split(";")[0];

  const noCookie = await other.send(`/auth/callback?code=good-code&state=${encodeURIComponent(state)}`, { origin: null });
  assert.equal(noCookie.status, 400);

  const wrongCookie = await other.send(`/auth/callback?code=good-code&state=${encodeURIComponent(state)}`, { origin: null, headers: { cookie: "__Host-scan_oauth=attacker-nonce" } });
  assert.equal(wrongCookie.status, 400);

  const tampered = await other.send(`/auth/callback?code=good-code&state=${encodeURIComponent(`${state}x`)}`, { origin: null, headers: { cookie } });
  assert.equal(tampered.status, 400);

  other.clock.advance(11 * 60 * 1000);
  const expired = await other.send(`/auth/callback?code=good-code&state=${encodeURIComponent(state)}`, { origin: null, headers: { cookie } });
  assert.equal(expired.status, 400);

  for (const response of [noCookie, wrongCookie, tampered, expired]) assert.ok(!(response.headers.get("location") || "").includes("scan-session"));
});

/* ------------------------------ dispatch ------------------------------ */

test("a signed-in owner starts a scan: one dispatch, to the configured repo/workflow/branch only", async () => {
  const { send, session, gh } = setup();
  const response = await send("/scan?workflow=evil.yml&ref=evil&repo=x/y", { method: "POST", token: session(), headers: { "content-type": "application/json" } });
  const data = await body(response);

  assert.equal(response.status, 202);
  assert.equal(data.state, "queued");
  assert.equal(data.coalesced, false);
  assert.equal(data.jobId, gh.runs[0].id);

  const dispatch = gh.calls.find((call) => call.method === "POST");
  assert.equal(dispatch.path, "/repos/owner/catalog/actions/workflows/update-anime.yml/dispatches");
  assert.deepEqual(dispatch.body, { ref: "main", return_run_details: true }, "nothing a request says can change the repo, workflow, ref or inputs");
  assert.equal(dispatch.headers.Authorization, `Bearer ${DISPATCH_TOKEN}`);
  assert.equal(dispatch.headers["X-GitHub-Api-Version"], "2022-11-28");
});

test("coalescing: a scan that is already queued is joined, not duplicated", async () => {
  const { send, session, gh } = setup();
  const queued = gh.addRun({ status: "queued", event: "schedule" });
  const response = await send("/scan", { method: "POST", token: session() });
  const data = await body(response);

  assert.equal(data.jobId, queued.id);
  assert.equal(data.coalesced, true);
  assert.equal(gh.dispatches.length, 0);
});

test("coalescing: simultaneous clicks make exactly one dispatch and share its job id", async () => {
  const { send, session, gh } = setup();
  const token = session();
  const results = await Promise.all([1, 2, 3, 4, 5].map(() => send("/scan", { method: "POST", token }).then(body)));

  assert.equal(gh.dispatches.length, 1);
  assert.equal(new Set(results.map((item) => item.jobId)).size, 1);
  assert.equal(results.filter((item) => item.coalesced === false).length, 1);
});

test("coalescing: a click right after another click joins the scan just started, even from another instance", async () => {
  const shared = createMemoryStore({ now: () => T0 });
  const clock = clockAt();
  const gh = fakeGitHub();
  const a = setup({ gh, clock, store: shared });
  const first = await body(await a.send("/scan", { method: "POST", token: a.session() }));

  gh.runs[0].status = "in_progress"; // it has started, so it no longer counts as "queued"
  const b = setup({ gh, clock, store: shared });
  const second = await body(await b.send("/scan", { method: "POST", token: b.session() }));

  assert.equal(gh.dispatches.length, 1);
  assert.equal(second.jobId, first.jobId);
  assert.equal(second.coalesced, true);
});

test("a run that is already in progress (started before the click) does not swallow the click: a new run queues behind it", async () => {
  const { send, session, gh, clock } = setup();
  gh.addRun({ status: "in_progress", event: "schedule" });
  clock.advance(5 * 60 * 1000); // outside the cooldown
  const data = await body(await send("/scan", { method: "POST", token: session() }));

  assert.equal(gh.dispatches.length, 1);
  assert.equal(data.coalesced, false);
});

test("API fallback: when GitHub answers 204 with no run id, the new run is found by listing", async () => {
  const gh = fakeGitHub({ dispatchStyle: "no-details" });
  const { send, session } = setup({ gh });
  const data = await body(await send("/scan", { method: "POST", token: session() }));

  assert.equal(data.jobId, gh.runs[0].id);
  assert.equal(data.untracked, undefined);
});

test("API fallback: if the run cannot be identified the click is reported as untracked, never as a fake job", async () => {
  const gh = fakeGitHub({ dispatchStyle: "no-details" });
  const original = gh.addRun;
  gh.addRun = () => ({ id: 1 }); // the dispatch creates nothing visible
  gh.runs.length = 0;
  const { send, session } = setup({ gh });
  const response = await send("/scan", { method: "POST", token: session() });
  const data = await body(response);
  gh.addRun = original;

  assert.equal(response.status, 202);
  assert.equal(data.jobId, null);
  assert.equal(data.untracked, true);
});

/* ------------------------------ rate limits ------------------------------ */

test("the hourly dispatch budget is enforced, with Retry-After", async () => {
  const { send, session, gh, clock } = setup({ env: { MAX_DISPATCHES_PER_HOUR: "2", DISPATCH_COOLDOWN_SECONDS: "0" } });
  const token = session();
  const statuses = [];

  for (let i = 0; i < 3; i++) {
    gh.runs.forEach((run) => { run.status = "completed"; run.conclusion = "success"; });
    clock.advance(1000);
    const response = await send("/scan", { method: "POST", token });
    statuses.push(response.status);
    if (response.status === 429) assert.ok(Number(response.headers.get("retry-after")) > 0);
  }

  assert.deepEqual(statuses, [202, 202, 429]);
  assert.equal(gh.dispatches.length, 2);
});

test("repeated start requests are limited even when they all coalesce", async () => {
  const { send, session, gh } = setup();
  const token = session();
  gh.addRun({ status: "queued" });
  let last;

  for (let i = 0; i < 31; i++) last = await send("/scan", { method: "POST", token });

  assert.equal(last.status, 429);
  assert.equal(gh.dispatches.length, 0);
});

test("status polling is rate limited per signed-in user", async () => {
  const { send, session, gh } = setup({ env: { STATUS_POLLS_PER_10_MIN: "10" } });
  const token = session();
  const run = gh.addRun({ status: "in_progress" });
  let last;

  for (let i = 0; i < 11; i++) last = await send(`/scan/${run.id}`, { token });

  assert.equal(last.status, 429);
});

test("sign-in attempts are limited per client address", async () => {
  const { send } = setup({ env: { AUTH_ATTEMPTS_PER_10_MIN: "3" } });
  const results = [];

  for (let i = 0; i < 4; i++) results.push((await send(`/auth/login?return=${encodeURIComponent(SITE)}`, { origin: null, ip: "203.0.113.9" })).status);
  assert.deepEqual(results, [302, 302, 302, 429]);

  assert.equal((await send(`/auth/login?return=${encodeURIComponent(SITE)}`, { origin: null, ip: "203.0.113.10" })).status, 302, "another address is unaffected");
});

test("a client cannot choose its own address for rate limiting through headers", async () => {
  const { send } = setup({ env: { AUTH_ATTEMPTS_PER_10_MIN: "3" } });
  const results = [];

  for (let i = 0; i < 4; i++) results.push((await send(`/auth/login?return=${encodeURIComponent(SITE)}`, { origin: null, ip: "203.0.113.9", headers: { "x-forwarded-for": `10.0.0.${i}` } })).status);

  assert.equal(results[3], 429, "X-Forwarded-For is ignored unless TRUST_PROXY is on");
});

/* ------------------------------ status mapping ------------------------------ */

const statusOf = async (ctx, overrides) => {
  const run = ctx.gh.addRun(overrides);
  const response = await ctx.send(`/scan/${run.id}`, { token: ctx.session() });
  return { response, data: await body(response), run };
};

test("status: queued, running, completed, failed and timeout are told apart", async () => {
  const ctx = setup();

  const queued = await statusOf(ctx, { status: "queued" });
  assert.equal(queued.data.state, "queued");
  assert.equal(queued.data.reload, false);

  const running = await statusOf(ctx, { status: "in_progress" });
  assert.equal(running.data.state, "running");
  assert.equal(running.data.reload, false);

  const done = await statusOf(ctx, { status: "completed", conclusion: "success" });
  assert.equal(done.data.state, "completed");
  assert.equal(done.data.reload, true);
  assert.ok(done.data.completedAt);

  for (const conclusion of ["failure", "cancelled", "timed_out", "startup_failure", "skipped", null]) {
    const failed = await statusOf(ctx, { status: "completed", conclusion });
    assert.equal(failed.data.state, "failed", String(conclusion));
    assert.equal(failed.data.reload, false, String(conclusion));
  }

  const stale = ctx.gh.addRun({ status: "in_progress" });
  ctx.clock.advance(26 * 60 * 1000);
  const timeout = await body(await ctx.send(`/scan/${stale.id}`, { token: ctx.session() }));
  assert.equal(timeout.state, "timeout");
  assert.equal(timeout.reload, false);
});

test("status: reload is true only for a run that actually completed successfully", async () => {
  const ctx = setup();
  const seen = new Set();

  for (const [status, conclusion] of [["queued", null], ["pending", null], ["waiting", null], ["in_progress", null], ["action_required", null], ["completed", "success"], ["completed", "failure"], ["completed", "cancelled"]]) {
    const { data } = await statusOf(ctx, { status, conclusion });
    if (data.reload) seen.add(`${status}/${conclusion}`);
  }

  assert.deepEqual([...seen], ["completed/success"]);
});

test("status: a job that finished after the wait window is still reported as completed, not as a timeout", async () => {
  const ctx = setup();
  const run = ctx.gh.addRun({ status: "in_progress" });
  ctx.clock.advance(40 * 60 * 1000);
  run.status = "completed";
  run.conclusion = "success";

  const data = await body(await ctx.send(`/scan/${run.id}`, { token: ctx.session() }));
  assert.equal(data.state, "completed");
});

test("status: requires a session, validates the id, and cannot be used to inspect other workflows", async () => {
  const ctx = setup();
  const run = ctx.gh.addRun({ status: "queued" });

  assert.equal((await ctx.send(`/scan/${run.id}`)).status, 401);
  assert.equal((await ctx.send("/scan/abc", { token: ctx.session() })).status, 400);
  assert.equal((await ctx.send("/scan/1;drop", { token: ctx.session() })).status, 400);
  assert.equal((await ctx.send("/scan/12345678901234567890", { token: ctx.session() })).status, 400);

  ctx.gh.foreign = { ...run, id: 777, path: ".github/workflows/deploy-secrets.yml@refs/heads/main" };
  const foreign = await ctx.send("/scan/777", { token: ctx.session() });
  assert.equal(foreign.status, 404);
  assert.equal((await body(foreign)).state, "not-found");

  const missing = await ctx.send("/scan/424242", { token: ctx.session() });
  assert.equal(missing.status, 404);
});

/* ------------------------------ GitHub failures and secrecy ------------------------------ */

test("GitHub refusing the dispatch token is reported as a configuration problem, without the token", async () => {
  const gh = fakeGitHub({ plan: { fail: ({ method }) => (method === "POST" ? { status: 403, body: { message: `Resource not accessible by personal access token ${DISPATCH_TOKEN}` } } : null) } });
  const { send, session } = setup({ gh });
  const response = await send("/scan", { method: "POST", token: session() });
  const text = JSON.stringify(await body(response));

  assert.equal(response.status, 502);
  assert.match(text, /github-denied/);
  assert.ok(!text.includes(DISPATCH_TOKEN));
});

test("GitHub outages, rate limits and rejected dispatches map to distinct, calm errors", async () => {
  const cases = [
    [{ status: 500 }, 502, "github-unavailable"],
    [new Error(`socket hang up ${DISPATCH_TOKEN}`), 502, "github-unavailable"],
    [{ status: 403, headers: { "x-ratelimit-remaining": "0" } }, 503, "github-rate-limited"],
    [{ status: 422, body: { message: "Workflow does not have 'workflow_dispatch' trigger" } }, 502, "dispatch-rejected"]
  ];

  for (const [failure, status, code] of cases) {
    const gh = fakeGitHub({ plan: { fail: ({ method }) => (method === "POST" ? failure : null) } });
    const { send, session } = setup({ gh });
    const response = await send("/scan", { method: "POST", token: session() });
    const data = await body(response);

    assert.equal(response.status, status, code);
    assert.equal(data.error, code);
    assert.ok(!JSON.stringify(data).includes(DISPATCH_TOKEN));
  }
});

test("no secret ever appears in any response or log line, across sign-in, scan and status", async () => {
  const logs = [];
  const ctx = setup({ logs });
  const seen = [];
  const collect = async (response) => {
    seen.push([...response.headers.entries()].map(([name, value]) => `${name}: ${value}`).join("\n"));
    seen.push(await response.clone().text());
    return response;
  };

  const { callback } = await signIn(ctx);
  await collect(callback);
  const token = new URL(callback.headers.get("location")).hash.slice("#scan-session=".length);

  const started = await collect(await ctx.send("/scan", { method: "POST", token }));
  const { jobId } = await started.json();
  await collect(await ctx.send(`/scan/${jobId}`, { token }));
  await collect(await ctx.send("/scan", { method: "POST" }));
  await collect(await ctx.send("/health"));

  const everything = [...seen, ...logs].join("\n");
  for (const secret of [DISPATCH_TOKEN, OAUTH_SECRET, SESSION_SECRET, USER_TOKEN]) assert.ok(!everything.includes(secret), "a secret leaked");
});

/* ------------------------------ routing and adapter ------------------------------ */

test("unknown paths are 404 and wrong methods are 405", async () => {
  const { send, session } = setup();

  assert.equal((await send("/nope")).status, 404);
  assert.equal((await send("/scan", { token: session() })).status, 405, "GET /scan");
  assert.equal((await send("/scan/1", { method: "POST", token: session() })).status, 405);
  assert.equal((await send("/auth/login", { method: "POST" })).status, 405);
});

test("there is no route that dispatches without a session (exhaustive over methods and paths)", async () => {
  const { send, gh } = setup();

  for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE"]) {
    for (const path of ["/", "/scan", "/scan/1", "/scan/latest", "/dispatch", "/api/scan", "/auth/login", "/auth/callback", "//scan"]) {
      await send(path, { method, origin: null });
    }
  }

  assert.equal(gh.dispatches.length, 0);
  assert.equal(gh.calls.filter((call) => call.method === "POST").length, 0);
});

test("a base path can be configured", async () => {
  const { send, session, gh } = setup({ env: { BASE_PATH: "/refresh" } });

  assert.equal((await send("/refresh/scan", { method: "POST", token: session() })).status, 202);
  assert.equal(gh.dispatches.length, 1);
  assert.equal((await send("/scan", { method: "POST", token: session() })).status, 404);
  assert.equal((await send("/refreshx/scan", { method: "POST", token: session() })).status, 404, "the prefix must end at a path segment");
});

test("node adapter: a client cannot spoof the socket address header, and a real HTTP round trip works", async () => {
  const request = toRequest({ headers: { "x-socket-ip": "6.6.6.6", host: "x", "x-other": "1" }, socket: { remoteAddress: "198.51.100.1" }, url: "/health", method: "GET" }, "http://localhost");
  assert.equal(request.headers.get("x-socket-ip"), "198.51.100.1");
  assert.equal(request.headers.get("x-other"), "1");

  const silent = { log() {}, warn() {}, error() {} };
  const server = createServer({ env: {}, logger: silent });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  try {
    const { port } = server.address();
    const get = (path, method = "GET") =>
      new Promise((resolve, reject) => {
        const req = http.request({ host: "127.0.0.1", port, path, method }, (res) => {
          let data = "";
          res.on("data", (chunk) => (data += chunk));
          res.on("end", () => resolve({ status: res.statusCode, body: data }));
        });
        req.on("error", reject);
        req.end();
      });

    assert.deepEqual(JSON.parse((await get("/health")).body), { ok: true, configured: false });
    assert.equal((await get("/scan", "POST")).status, 503);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
