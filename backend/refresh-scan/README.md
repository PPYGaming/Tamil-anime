# Refresh-scan backend (design + code for review - NOT deployed)

**Status: not deployed, not configured, not connected to anything.** No host has been chosen, no GitHub token or OAuth app exists, no workflow starts this service, and the website's endpoint setting is empty. Everything here is verified only by mocked tests (`tests/backend-refresh.test.js`, `tests/scan-status.test.js`). **Click-triggered scanning does not work until the owner completes the setup below.**

## Why a backend is needed at all

The site is static. The Refresh button can only re-download `data/anime.json`; it cannot search YouTube and it must not hold a GitHub token. Starting a scan means calling GitHub's *workflow dispatch* API, which needs a credential with `Actions: write` on the repository. That credential can only live on a server. This service is that server, built so that it cannot be turned into a public "run anything" proxy.

```
Browser (owner)            Refresh-scan service                    GitHub
      |  GET /auth/login  --->|  redirect ---------------------------> OAuth authorize (no scopes)
      |<--- #scan-session=token (URL fragment) <------ callback checks login is on OWNER list
      |  POST /scan  (Bearer session) -->|  list runs ---------------> GET  .../workflows/update-anime.yml/runs
      |                                  |  join queued run, or ----->  POST .../dispatches {ref, return_run_details}
      |<-- 202 { jobId } ----------------|
      |  GET /scan/{jobId} (poll) ------>|  ------------------------> GET  .../actions/runs/{id}
      |<-- queued | running | completed | failed | timeout
      |  completed -> wait until data/anime.json contains that run's lastScan -> reload the catalog
```

## Security model

| Threat | Control |
| --- | --- |
| Anyone on the internet starts scans | Every scan route needs a signed session; a session is only minted after GitHub OAuth proves the login is in `OWNER_GITHUB_LOGINS` (and, if set, the numeric id is in `OWNER_GITHUB_USER_IDS`). The owner list is re-checked on every request. |
| Request chooses the repo, workflow, branch or inputs | None of those are request-controlled. The dispatch body is always `{ ref: WORKFLOW_REF, return_run_details: true }` against `GITHUB_REPOSITORY` / `WORKFLOW_FILE` from configuration. `GET /scan/{id}` returns `404` for any run that is not this workflow. |
| Token in the browser | The GitHub dispatch token never leaves the server. The page holds only a short-lived signed session (default 30 min), in a JavaScript variable: no localStorage, no cookie, no HTML. It arrives in the URL **fragment** (never sent to a server or logged) and is removed from the address bar immediately. |
| Stolen session | Expires in minutes, carries no GitHub token, is rejected the moment the login leaves the owner list, and a signed OAuth `state` can never be replayed as a session (different signed audience). |
| Login CSRF / open redirect | OAuth `state` is signed, expires in 10 minutes, and is bound to a `__Host-` HttpOnly Secure SameSite cookie. The return address must be on `ALLOWED_ORIGIN` exactly. |
| Cross-site pages calling the API | CORS allows only `ALLOWED_ORIGIN` (never `*`); any other browser `Origin` is refused before authentication is read. |
| Click flooding / GitHub rate limit | A queued run is joined instead of duplicated; a just-started run is joined for `DISPATCH_COOLDOWN_SECONDS`; one shared hourly dispatch budget (`MAX_DISPATCHES_PER_HOUR`); per-user start/poll limits; per-address sign-in limits. The workflow's `concurrency` group is the backstop (one running, at most one waiting). |
| Spoofed client address | Rate limits use the socket address supplied by the adapter; `X-Forwarded-For` is ignored unless `TRUST_PROXY=true`. |
| Secrets in logs / errors | Config errors name variables and rules, never values. GitHub errors are scrubbed of the token and not echoed; log entries are event names only. Tests assert no secret appears in any response or log line. |
| Misconfiguration silently opens something | Missing or malformed config makes every route except `/health` answer `503 not-configured`. Nothing falls back to a default secret, origin or endpoint. |

### Known limits (honest list)

- The bundled store is in memory. On a platform that runs several instances, pass a shared store (same four methods as `src/store.js`) for rate limits and the "just started" marker. Correctness does not depend on it - GitHub is asked which runs exist before every dispatch - but limits become per-instance without it.
- A pending run can be replaced by GitHub's `concurrency` handling if another run is queued behind it (for example the cron firing). That run then reports `failed (cancelled)` and the page does not reload; the owner can simply click again.
- If GitHub answers a dispatch with `204` and no run id *and* the new run cannot be found, the response is `untracked`: the scan was requested but the page cannot follow it. It never invents a job id.
- "Completed" means the workflow finished. GitHub Pages may publish the commit a little later, so the page waits (up to 5 minutes) for the published `data/anime.json` to contain that run's `lastScan.scannedAt` before it reloads, and says plainly if it did not appear.
- Only the owner list can start scans. Public visitors still get the 6-hourly schedule, and the last-scan text on the page.

## Setup (owner actions - none of this has been done)

1. **Choose a host.** Any place that can run Node 18+ over HTTPS, or any platform that can call a `(Request) => Promise<Response>` handler. `adapters/node-server.js` is a plain Node adapter; `src/handler.js` is framework-neutral. This repository contains no deployment file for any product. Putting the service behind TLS is required (OAuth callback and `Secure` cookies).
2. **Create the dispatch token.** GitHub -> Settings -> Developer settings -> Fine-grained personal access tokens -> new token. *Resource owner:* the repository owner. *Repository access:* **only** the catalog repository. *Repository permissions:* **Actions: Read and write**, nothing else (Metadata: read is added automatically). Give it an expiry and put a reminder in your calendar. Store it only in the host's secret store as `GITHUB_DISPATCH_TOKEN`.
   - Read endpoints need "Actions: read", the dispatch endpoint needs "Actions: write" (GitHub REST docs, checked 2026-10-03; re-check before use).
3. **Create the OAuth app.** GitHub -> Settings -> Developer settings -> OAuth Apps -> new. *Authorization callback URL:* `<PUBLIC_BASE_URL>/auth/callback`. No scopes are ever requested. Store the client id and secret as `GITHUB_OAUTH_CLIENT_ID` / `GITHUB_OAUTH_CLIENT_SECRET`.
4. **Set the rest** (see `.env.example`, names only): `GITHUB_REPOSITORY`, `SESSION_SECRET` (`openssl rand -base64 48`), `OWNER_GITHUB_LOGINS`, `OWNER_GITHUB_USER_IDS` (recommended: `gh api users/<login> --jq .id`), `ALLOWED_ORIGIN` (e.g. `https://<user>.github.io`), `PUBLIC_BASE_URL`.
5. **Check it:** `GET <PUBLIC_BASE_URL>/health` must return `{"ok":true,"configured":true}`. `configured:false` means a required value is missing or malformed; the server's startup log lists the variable *names*.
6. **Only then** put the service's public address in the site: `<meta name="refresh-scan-endpoint" content="https://...">` in `index.html`. Until that tag is filled in, the "Scan now" button stays hidden.
7. **Try it:** sign in as the owner, click "Scan official channel now", watch queued -> running -> reloaded. Confirm a non-owner GitHub account is refused.

### Revoking

Delete the fine-grained token (the service can no longer dispatch), rotate `SESSION_SECRET` (all sessions die), or remove a login from `OWNER_GITHUB_LOGINS` (that person's session stops working on their next request).

## Files

- `src/config.js` - environment parsing; names-only errors.
- `src/handler.js` - routes, guards, coalescing, status mapping.
- `src/auth.js` - HMAC session and OAuth state tokens (`node:crypto`).
- `src/github.js` - the only code that holds the dispatch token; three calls on one workflow.
- `src/store.js`, `src/ratelimit.js` - bounded in-memory store and fixed-window limiter.
- `adapters/node-server.js` - optional plain-Node adapter (not a deployment).
- `.env.example` - variable names only.

## Tests

`npm test` runs `tests/backend-refresh.test.js` (auth, forged/expired/foreign tokens, OAuth, CORS, rate limits, coalescing including simultaneous clicks, dispatch contents, queued/running/completed/failed/timeout, GitHub failures, secret scan of every response and log line) and `tests/scan-status.test.js` (the page-side client: it reloads the catalog only after a real, published completion). All mocked.
