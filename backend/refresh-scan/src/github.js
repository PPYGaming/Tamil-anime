"use strict";

/*
 * The only module that talks to the GitHub REST API with the dispatch token. It can do exactly three things, all
 * against ONE repository and ONE workflow file chosen by the operator's configuration - never by a request:
 *
 *   dispatch()    POST /repos/{repo}/actions/workflows/{file}/dispatches   (needs "Actions: write")
 *   listRuns()    GET  /repos/{repo}/actions/workflows/{file}/runs          (needs "Actions: read")
 *   getRun(id)    GET  /repos/{repo}/actions/runs/{id}                      (needs "Actions: read")
 *
 * dispatch() sends return_run_details:true. GitHub then answers 200 with { workflow_run_id, run_url, html_url } so the
 * exact run can be followed. If a response is 204 (no details) the caller falls back to finding the run in listRuns().
 * Checked against the GitHub REST docs on 2026-10-03; re-check them before deploying.
 */

const API = "https://api.github.com";
const VERSION = "2022-11-28";

class GitHubError extends Error {
  constructor(message, { kind, status = null } = {}) {
    super(message);
    this.name = "GitHubError";
    this.kind = kind; // auth | forbidden | not-found | validation | rate-limit | server | network | timeout | bad-response
    this.status = status;
  }
}

function kindOf(status, remaining) {
  if (status === 401) return "auth";
  if (status === 403 && remaining === "0") return "rate-limit";
  if (status === 403) return "forbidden";
  if (status === 404) return "not-found";
  if (status === 422) return "validation";
  if (status === 429) return "rate-limit";
  if (status >= 500) return "server";
  return "bad-response";
}

function createGitHubClient({ repository, token, workflowFile, ref, fetchImpl = (url, init) => globalThis.fetch(url, init), timeoutMs = 10000, apiBase = API }) {
  const workflowPath = `/repos/${repository}/actions/workflows/${encodeURIComponent(workflowFile)}`;

  // The token must never reach a log line or an error message, even if GitHub or a proxy echoes a header back.
  const scrub = (text) => String(text).split(token).join("***");

  async function call(method, path, body) {
    let response;

    try {
      response = await fetchImpl(`${apiBase}${path}`, {
        method,
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${token}`,
          "X-GitHub-Api-Version": VERSION,
          "User-Agent": "tamil-anime-refresh-scan",
          ...(body ? { "Content-Type": "application/json" } : {})
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(timeoutMs)
      });
    } catch (error) {
      const timedOut = error && (error.name === "TimeoutError" || error.name === "AbortError");
      throw new GitHubError(scrub(`GitHub ${timedOut ? "timed out" : "request failed"}: ${error && error.message ? error.message : error}`), { kind: timedOut ? "timeout" : "network" });
    }

    if (response.status === 204) return { status: 204, json: null };

    let json = null;

    try {
      json = await response.json();
    } catch {
      json = null;
    }

    if (!response.ok) {
      const remaining = response.headers && typeof response.headers.get === "function" ? response.headers.get("x-ratelimit-remaining") : null;
      throw new GitHubError(scrub(`GitHub answered ${response.status}${json && json.message ? `: ${String(json.message).slice(0, 160)}` : ""}`), { kind: kindOf(response.status, remaining), status: response.status });
    }

    return { status: response.status, json };
  }

  const normalizeRun = (run) => {
    if (!run || typeof run !== "object" || !Number.isSafeInteger(run.id)) return null;

    return {
      id: run.id,
      status: String(run.status || ""),
      conclusion: run.conclusion ? String(run.conclusion) : null,
      event: String(run.event || ""),
      createdAt: String(run.created_at || ""),
      startedAt: String(run.run_started_at || run.created_at || ""),
      updatedAt: String(run.updated_at || ""),
      htmlUrl: typeof run.html_url === "string" && run.html_url.startsWith("https://github.com/") ? run.html_url : null,
      path: String(run.path || "")
    };
  };

  return {
    async dispatch() {
      const result = await call("POST", `${workflowPath}/dispatches`, { ref, return_run_details: true });
      const id = result.json && Number(result.json.workflow_run_id);

      return { runId: Number.isSafeInteger(id) && id > 0 ? id : null };
    },

    async listRuns({ perPage = 10 } = {}) {
      const result = await call("GET", `${workflowPath}/runs?branch=${encodeURIComponent(ref)}&per_page=${perPage}`);
      const runs = result.json && Array.isArray(result.json.workflow_runs) ? result.json.workflow_runs : [];

      return runs.map(normalizeRun).filter(Boolean);
    },

    /* Returns null for a run that does not belong to the configured workflow, so this can never describe other runs. */
    async getRun(id) {
      if (!/^\d{1,15}$/.test(String(id))) throw new GitHubError("invalid run id", { kind: "validation" });

      let result;

      try {
        result = await call("GET", `/repos/${repository}/actions/runs/${id}`);
      } catch (error) {
        if (error.kind === "not-found") return null;
        throw error;
      }

      const run = normalizeRun(result.json);
      if (!run) throw new GitHubError("GitHub returned an unreadable run", { kind: "bad-response" });
      if (run.path && !run.path.startsWith(`.github/workflows/${workflowFile}`)) return null;

      return run;
    }
  };
}

module.exports = { createGitHubClient, GitHubError };
