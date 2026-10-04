"use strict";

/*
 * Framework-neutral request handler: (Request) -> Promise<Response>, using only the Web Fetch API types that Node 18+
 * and most serverless/edge runtimes provide. Nothing in here is specific to a hosting product.
 *
 *   GET  /health            liveness + whether configuration is complete (no names, no values)
 *   GET  /auth/login        starts GitHub OAuth (proves WHO is asking; requests no scopes)
 *   GET  /auth/callback     checks the person is on the owner list, mints a short-lived session token
 *   POST /scan              (Bearer session) starts the scan workflow, or joins one that is already queued
 *   GET  /scan/{runId}      (Bearer session) queued | running | completed | failed | timeout | not-found
 *
 * What this service refuses to be: a public dispatch proxy. There is no route that dispatches without a valid session,
 * the session needs a GitHub login on an explicit owner list, and a request can never choose the repository, the
 * workflow, the branch or any workflow input - those come from operator configuration only.
 */

const nodeCrypto = require("node:crypto");
const { createGitHubClient } = require("./github");
const { createRateLimiter } = require("./ratelimit");
const { createMemoryStore } = require("./store");
const { issueSession, verifySession, issueState, verifyState, bearerToken, readCookie, safeEqual } = require("./auth");

const PENDING = new Set(["queued", "pending", "waiting", "requested"]);
const COOKIE = "__Host-scan_oauth";
const START_REQUESTS_PER_10_MIN = 30;

const MESSAGES = {
  queued: "The scan is queued and will start shortly.",
  running: "The scan is running.",
  completed: "The scan finished.",
  failed: "The scan did not finish successfully.",
  timeout: "The scan has not finished within the time this page will wait. It may still complete; check again later.",
  "not-found": "No such scan."
};

function describeRun(run, nowMs, timeoutMs) {
  const base = { jobId: run.id, createdAt: run.createdAt, startedAt: run.startedAt, updatedAt: run.updatedAt, conclusion: run.conclusion, runUrl: run.htmlUrl };

  if (run.status === "completed") {
    return run.conclusion === "success"
      ? { ...base, state: "completed", completedAt: run.updatedAt, reload: true, message: MESSAGES.completed }
      : { ...base, state: "failed", completedAt: run.updatedAt, reload: false, message: `${MESSAGES.failed} (${run.conclusion || "no conclusion"})` };
  }

  const created = Date.parse(run.createdAt);

  if (!Number.isNaN(created) && nowMs - created > timeoutMs) return { ...base, state: "timeout", reload: false, message: MESSAGES.timeout };
  if (run.status === "in_progress") return { ...base, state: "running", reload: false, message: MESSAGES.running };

  return { ...base, state: "queued", reload: false, message: MESSAGES.queued };
}

function createRefreshHandler({
  config: loaded,
  github,
  store,
  clock = { now: () => Date.now() },
  fetchImpl = (url, init) => globalThis.fetch(url, init),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  randomBytes = (size) => nodeCrypto.randomBytes(size),
  logger = { info() {}, warn() {} }
} = {}) {
  const configured = Boolean(loaded && loaded.ok);
  const config = configured ? loaded.value : null;
  const kv = store || createMemoryStore({ now: clock.now });
  const limiter = createRateLimiter(kv);
  const gh = configured ? github || createGitHubClient({ repository: config.repository, token: config.dispatchToken, workflowFile: config.workflowFile, ref: config.workflowRef, fetchImpl }) : null;
  const nowSeconds = () => Math.floor(clock.now() / 1000);
  let inflight = null; // single-flight inside one instance

  /* ---------------- responses ---------------- */

  function headersFor(request, extra = {}) {
    const headers = new Headers({
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      ...extra
    });

    const origin = request.headers.get("origin");

    if (configured && origin && origin === config.allowedOrigin) {
      headers.set("Access-Control-Allow-Origin", origin);
      headers.set("Access-Control-Allow-Headers", "Authorization, Content-Type");
      headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      headers.set("Access-Control-Max-Age", "600");
      headers.append("Vary", "Origin");
    }

    return headers;
  }

  function json(request, status, body, extra = {}) {
    const headers = headersFor(request, { "Content-Type": "application/json; charset=utf-8", ...extra });
    return new Response(JSON.stringify(body), { status, headers });
  }

  const fail = (request, status, error, message, extra) => json(request, status, { error, message }, extra);

  function redirect(request, location, cookies = []) {
    const headers = headersFor(request, { Location: location });
    for (const cookie of cookies) headers.append("Set-Cookie", cookie);
    return new Response(null, { status: 302, headers });
  }

  const clientIp = (request) => {
    if (config && config.trustProxy) return (request.headers.get("x-forwarded-for") || "").split(",")[0].trim() || "unknown";
    return request.headers.get("x-socket-ip") || "unknown"; // set by the adapter from the socket; a client cannot choose it
  };

  /* ---------------- guards ---------------- */

  function originProblem(request) {
    const origin = request.headers.get("origin");
    return origin && origin !== config.allowedOrigin ? fail(request, 403, "origin-not-allowed", "This origin may not use the service.") : null;
  }

  async function requireSession(request) {
    const token = bearerToken(request.headers);
    if (!token) return { response: fail(request, 401, "unauthorized", "Sign in as the site owner first.", { "WWW-Authenticate": "Bearer" }) };

    const result = verifySession(token, { secret: config.sessionSecret, nowSeconds: nowSeconds() });

    if (!result.ok) {
      const expired = result.reason === "expired";
      return { response: fail(request, 401, expired ? "session-expired" : "unauthorized", expired ? "Your session expired. Sign in again." : "Sign in as the site owner first.", { "WWW-Authenticate": "Bearer" }) };
    }

    // The owner list is re-checked on every request, so removing a login takes effect without waiting for expiry.
    const login = String(result.payload.sub || "").toLowerCase();
    const idOk = config.ownerUserIds.length === 0 || config.ownerUserIds.includes(String(result.payload.uid));

    if (!config.ownerLogins.includes(login) || !idOk) return { response: fail(request, 403, "forbidden", "This account may not start scans.") };

    return { session: { login, userId: result.payload.uid } };
  }

  async function limited(request, key, limit, windowSeconds) {
    const verdict = await limiter.hit(key, { limit, windowSeconds });
    if (verdict.allowed) return null;

    return fail(request, 429, "rate-limited", "Too many requests. Try again shortly.", { "Retry-After": String(verdict.retryAfterSeconds) });
  }

  function githubFailure(request, error) {
    logger.warn({ event: "github-error", kind: error && error.kind, status: error && error.status }); // never the message body: it is not needed and could echo input

    switch (error && error.kind) {
      case "auth":
      case "forbidden":
        return fail(request, 502, "github-denied", "GitHub refused the service's token. The operator must check its repository permissions (Actions: read and write).");
      case "rate-limit":
        return fail(request, 503, "github-rate-limited", "GitHub is rate limiting this service. Try again later.", { "Retry-After": "60" });
      case "validation":
        return fail(request, 502, "dispatch-rejected", "GitHub rejected the dispatch (does the workflow have a workflow_dispatch trigger on the configured branch?).");
      default:
        return fail(request, 502, "github-unavailable", "GitHub could not be reached. Try again later.");
    }
  }

  /* ---------------- OAuth ---------------- */

  async function login(request, url) {
    const limit = await limited(request, `auth:${clientIp(request)}`, config.authAttemptsPer10Min, 600);
    if (limit) return limit;

    let returnTo;

    try {
      returnTo = new URL(url.searchParams.get("return") || "");
    } catch {
      return fail(request, 400, "bad-return", "A return URL on the site's own origin is required.");
    }

    if (returnTo.origin !== config.allowedOrigin) return fail(request, 400, "bad-return", "A return URL on the site's own origin is required."); // no open redirect

    returnTo.hash = "";
    const nonce = randomBytes(18).toString("base64url");
    const state = issueState({ nonce, returnTo: returnTo.toString() }, { secret: config.sessionSecret, nowSeconds: nowSeconds() });

    const authorize = new URL("https://github.com/login/oauth/authorize");
    authorize.searchParams.set("client_id", config.oauthClientId);
    authorize.searchParams.set("redirect_uri", `${config.publicBaseUrl}${config.basePath}/auth/callback`);
    authorize.searchParams.set("state", state);
    authorize.searchParams.set("allow_signup", "false");
    // No scope is requested: the token can only read the public profile, which is all that is needed to learn the login.

    return redirect(request, authorize.toString(), [`${COOKIE}=${nonce}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=600`]);
  }

  async function callback(request, url) {
    const limit = await limited(request, `auth:${clientIp(request)}`, config.authAttemptsPer10Min, 600);
    if (limit) return limit;

    const state = verifyState(url.searchParams.get("state"), { secret: config.sessionSecret, nowSeconds: nowSeconds() });
    const cookie = readCookie(request.headers, COOKIE);

    if (!state.ok || !cookie || !safeEqual(cookie, String(state.payload.n))) {
      return fail(request, 400, "bad-state", "The sign-in attempt could not be verified. Start again from the site.");
    }

    const clearCookie = `${COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`;
    const back = new URL(state.payload.ret);
    if (back.origin !== config.allowedOrigin) return fail(request, 400, "bad-return", "Invalid return address.");

    const done = (fragment) => {
      back.hash = fragment;
      return redirect(request, back.toString(), [clearCookie]);
    };

    const code = url.searchParams.get("code") || "";
    if (!/^[A-Za-z0-9_-]{1,200}$/.test(code)) return done("scan-error=login-failed");

    let profile;

    try {
      const exchange = await fetchImpl("https://github.com/login/oauth/access_token", {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json", "User-Agent": "tamil-anime-refresh-scan" },
        body: JSON.stringify({ client_id: config.oauthClientId, client_secret: config.oauthClientSecret, code, redirect_uri: `${config.publicBaseUrl}${config.basePath}/auth/callback` }),
        signal: AbortSignal.timeout(10000)
      });
      const granted = await exchange.json();
      if (!granted || typeof granted.access_token !== "string") return done("scan-error=login-failed");

      const me = await fetchImpl("https://api.github.com/user", {
        headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${granted.access_token}`, "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "tamil-anime-refresh-scan" },
        signal: AbortSignal.timeout(10000)
      });
      profile = await me.json();
      // The user's own token is dropped here: it is never stored, logged or returned.
    } catch {
      return done("scan-error=login-failed");
    }

    const loginName = String((profile && profile.login) || "").toLowerCase();
    const userId = profile && Number.isSafeInteger(profile.id) ? profile.id : null;
    const allowed = config.ownerLogins.includes(loginName) && (config.ownerUserIds.length === 0 || (userId !== null && config.ownerUserIds.includes(String(userId))));

    if (!allowed) {
      logger.info({ event: "login-denied" });
      return done("scan-error=not-authorized");
    }

    const token = issueSession({ login: loginName, userId }, { secret: config.sessionSecret, nowSeconds: nowSeconds(), ttlSeconds: config.sessionTtlSeconds });
    logger.info({ event: "login-ok" });

    return done(`scan-session=${token}`); // fragment: never sent to a server, never in a log
  }

  /* ---------------- scan ---------------- */

  async function launch(session) {
    const runs = await gh.listRuns();

    // 1. A run that has not started yet will see everything uploaded so far: join it instead of adding another.
    const pending = runs.find((run) => PENDING.has(run.status));
    if (pending) return { status: 202, body: { jobId: pending.id, state: "queued", coalesced: true, message: "A scan is already queued; joined it." } };

    // 2. A scan was started moments ago (possibly by another instance): join that one.
    const last = await kv.get("last-dispatch");

    if (last && last.runId && clock.now() - last.at < config.dispatchCooldownSeconds * 1000) {
      return { status: 202, body: { jobId: last.runId, state: "queued", coalesced: true, message: "A scan was just started; joined it." } };
    }

    // 3. A real dispatch costs budget. One hourly budget is shared by every owner.
    const budget = await limiter.hit("dispatch-hour", { limit: config.maxDispatchesPerHour, windowSeconds: 3600 });

    if (!budget.allowed) {
      return { status: 429, body: { error: "rate-limited", message: "The hourly scan limit was reached. Try again later." }, headers: { "Retry-After": String(budget.retryAfterSeconds) } };
    }

    const known = new Set(runs.map((run) => run.id));
    const dispatchedAt = clock.now();
    let { runId } = await gh.dispatch();

    // Older API behaviour answers 204 with no run id: find the new run instead.
    for (let attempt = 0; runId === null && attempt < 3; attempt++) {
      await sleep(1500);
      const fresh = (await gh.listRuns()).filter((run) => !known.has(run.id) && run.event === "workflow_dispatch" && Date.parse(run.createdAt) >= dispatchedAt - 10000);
      if (fresh.length) runId = Math.max(...fresh.map((run) => run.id));
    }

    logger.info({ event: "dispatched", by: session.login, runId });

    if (runId === null) {
      return { status: 202, body: { jobId: null, state: "queued", coalesced: false, untracked: true, message: "The scan was requested but its run could not be identified, so progress cannot be shown. The saved catalog updates when the run finishes." } };
    }

    await kv.set("last-dispatch", { runId, at: dispatchedAt }, 3600);
    return { status: 202, body: { jobId: runId, state: "queued", coalesced: false, message: MESSAGES.queued } };
  }

  async function startScan(request) {
    const origin = originProblem(request);
    if (origin) return origin;

    const auth = await requireSession(request);
    if (auth.response) return auth.response;

    const limit = await limited(request, `start:${auth.session.login}`, START_REQUESTS_PER_10_MIN, 600);
    if (limit) return limit;

    try {
      if (inflight) {
        const shared = await inflight; // a request arriving while another is launching shares its outcome
        return json(request, shared.status, { ...shared.body, ...(shared.status === 202 ? { coalesced: true } : {}) }, shared.headers);
      }

      inflight = launch(auth.session);

      try {
        const outcome = await inflight;
        return json(request, outcome.status, outcome.body, outcome.headers);
      } finally {
        inflight = null;
      }
    } catch (error) {
      return githubFailure(request, error);
    }
  }

  async function scanStatus(request, id) {
    const origin = originProblem(request);
    if (origin) return origin;

    const auth = await requireSession(request);
    if (auth.response) return auth.response;

    const limit = await limited(request, `poll:${auth.session.login}`, config.statusPollsPer10Min, 600);
    if (limit) return limit;

    if (!/^\d{1,15}$/.test(id)) return fail(request, 400, "bad-id", "Scan ids are numbers.");

    try {
      const run = await gh.getRun(id);
      if (!run) return json(request, 404, { jobId: Number(id), state: "not-found", reload: false, message: MESSAGES["not-found"] });

      return json(request, 200, describeRun(run, clock.now(), config.scanWaitTimeoutMs));
    } catch (error) {
      return githubFailure(request, error);
    }
  }

  /* ---------------- routing ---------------- */

  return async function handle(request) {
    const url = new URL(request.url);
    const method = request.method.toUpperCase();
    let path = url.pathname;

    if (configured && config.basePath) {
      // Only paths inside the base path are served, and the prefix must end at a path-segment boundary.
      if (path !== config.basePath && !path.startsWith(`${config.basePath}/`)) return fail(request, 404, "not-found", "Not found.");
      path = path.slice(config.basePath.length) || "/";
    }

    path = path.replace(/\/+$/, "") || "/";

    if (path === "/health" && method === "GET") return json(request, 200, { ok: true, configured });

    if (!configured) return fail(request, 503, "not-configured", "This service is not configured yet. Nothing was started.");

    if (method === "OPTIONS") {
      const allowed = request.headers.get("origin") === config.allowedOrigin;
      return new Response(null, { status: allowed ? 204 : 403, headers: headersFor(request) });
    }

    if (path === "/auth/login" && method === "GET") return login(request, url);
    if (path === "/auth/callback" && method === "GET") return callback(request, url);
    if (path === "/scan" && method === "POST") return startScan(request);

    const status = /^\/scan\/([^/]+)$/.exec(path);
    if (status && method === "GET") return scanStatus(request, status[1]);

    if (["/auth/login", "/auth/callback", "/scan"].includes(path) || status) return fail(request, 405, "method-not-allowed", "Method not allowed.");

    return fail(request, 404, "not-found", "Not found.");
  };
}

module.exports = { createRefreshHandler, describeRun };
