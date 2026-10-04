"use strict";

/*
 * Configuration comes from the environment only. Nothing here has a default for a secret, and no function in this
 * module ever returns, logs or throws a secret VALUE: problems name the variable and the rule that failed.
 *
 * If anything required is missing or malformed, loadConfig() returns { ok: false, missing, problems } and the handler
 * answers 503 "not-configured" to every route except /health. It never falls back to a guessed endpoint, repository,
 * token or origin.
 */

const REQUIRED = [
  "GITHUB_REPOSITORY", // owner/name of the catalog repository
  "GITHUB_DISPATCH_TOKEN", // fine-grained token, ONE repository, "Actions: read and write" only
  "GITHUB_OAUTH_CLIENT_ID", // OAuth App used only to prove who the person clicking is
  "GITHUB_OAUTH_CLIENT_SECRET",
  "SESSION_SECRET", // >= 32 random characters; signs short-lived session tokens
  "OWNER_GITHUB_LOGINS", // comma separated GitHub logins allowed to start a scan
  "ALLOWED_ORIGIN", // the exact origin of the site, e.g. https://example.github.io
  "PUBLIC_BASE_URL" // the public URL of THIS service (used as the OAuth callback base)
];

const DEFAULTS = Object.freeze({
  WORKFLOW_FILE: "update-anime.yml",
  WORKFLOW_REF: "main",
  BASE_PATH: "",
  SESSION_TTL_SECONDS: 1800,
  SCAN_WAIT_TIMEOUT_MS: 25 * 60 * 1000, // longer than the workflow's own timeout-minutes (20), so a long run is not called "timeout" early
  DISPATCH_COOLDOWN_SECONDS: 60,
  MAX_DISPATCHES_PER_HOUR: 6,
  STATUS_POLLS_PER_10_MIN: 200,
  AUTH_ATTEMPTS_PER_10_MIN: 30,
  TRUST_PROXY: false
});

const intIn = (raw, fallback, min, max) => {
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  return Number.isInteger(value) && value >= min && value <= max ? value : NaN;
};

function parseOrigin(raw) {
  try {
    const url = new URL(raw);
    const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
    if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) return null;
    if (url.origin !== String(raw).replace(/\/+$/, "")) return null; // an origin only: no path, query or credentials
    return url.origin;
  } catch {
    return null;
  }
}

function loadConfig(env = process.env) {
  const value = {};
  const missing = [];
  const problems = [];
  const text = (name) => (typeof env[name] === "string" ? env[name].trim() : "");

  for (const name of REQUIRED) if (!text(name)) missing.push(name);

  const check = (name, ok, rule) => {
    if (text(name) && !ok) problems.push(`${name}: ${rule}`);
  };

  const repository = text("GITHUB_REPOSITORY");
  check("GITHUB_REPOSITORY", /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/.test(repository), "must look like owner/name");
  value.repository = repository;

  value.dispatchToken = text("GITHUB_DISPATCH_TOKEN");
  value.oauthClientId = text("GITHUB_OAUTH_CLIENT_ID");
  value.oauthClientSecret = text("GITHUB_OAUTH_CLIENT_SECRET");

  value.sessionSecret = text("SESSION_SECRET");
  check("SESSION_SECRET", value.sessionSecret.length >= 32, "must be at least 32 characters");

  const logins = text("OWNER_GITHUB_LOGINS").split(",").map((item) => item.trim().toLowerCase()).filter(Boolean);
  check("OWNER_GITHUB_LOGINS", logins.length > 0 && logins.every((login) => /^[a-z0-9](?:[a-z0-9-]{0,38})$/.test(login)), "must be comma separated GitHub logins");
  value.ownerLogins = logins;

  // Optional but recommended: numeric account ids, which survive a username being renamed or re-registered.
  const ids = text("OWNER_GITHUB_USER_IDS").split(",").map((item) => item.trim()).filter(Boolean);
  check("OWNER_GITHUB_USER_IDS", ids.every((id) => /^\d{1,12}$/.test(id)), "must be comma separated numeric ids");
  value.ownerUserIds = ids;

  const origin = parseOrigin(text("ALLOWED_ORIGIN"));
  check("ALLOWED_ORIGIN", origin !== null, "must be one exact https origin (http only for localhost), no path and no wildcard");
  value.allowedOrigin = origin;

  const base = text("PUBLIC_BASE_URL").replace(/\/+$/, "");
  check("PUBLIC_BASE_URL", parseOrigin(base.split("/").slice(0, 3).join("/")) !== null, "must be an https URL");
  value.publicBaseUrl = base;

  value.workflowFile = text("WORKFLOW_FILE") || DEFAULTS.WORKFLOW_FILE;
  check("WORKFLOW_FILE", /^[A-Za-z0-9_.-]+\.ya?ml$/.test(value.workflowFile), "must be a workflow file name such as update-anime.yml");

  value.workflowRef = text("WORKFLOW_REF") || DEFAULTS.WORKFLOW_REF;
  check("WORKFLOW_REF", /^[A-Za-z0-9_./-]{1,100}$/.test(value.workflowRef) && !value.workflowRef.includes(".."), "must be a branch name");

  value.basePath = text("BASE_PATH") || DEFAULTS.BASE_PATH;
  check("BASE_PATH", value.basePath === "" || /^\/[A-Za-z0-9_./-]*$/.test(value.basePath), "must be empty or start with /");
  value.basePath = value.basePath.replace(/\/+$/, "");

  const numeric = [
    ["sessionTtlSeconds", "SESSION_TTL_SECONDS", 60, 24 * 3600],
    ["scanWaitTimeoutMs", "SCAN_WAIT_TIMEOUT_MS", 60000, 6 * 3600 * 1000],
    ["dispatchCooldownSeconds", "DISPATCH_COOLDOWN_SECONDS", 0, 3600],
    ["maxDispatchesPerHour", "MAX_DISPATCHES_PER_HOUR", 1, 100],
    ["statusPollsPer10Min", "STATUS_POLLS_PER_10_MIN", 10, 5000],
    ["authAttemptsPer10Min", "AUTH_ATTEMPTS_PER_10_MIN", 3, 1000]
  ];

  for (const [key, name, min, max] of numeric) {
    const parsed = intIn(env[name], DEFAULTS[name], min, max);
    if (Number.isNaN(parsed)) problems.push(`${name}: must be an integer from ${min} to ${max}`);
    value[key] = Number.isNaN(parsed) ? DEFAULTS[name] : parsed;
  }

  value.trustProxy = /^(1|true|yes)$/i.test(text("TRUST_PROXY"));

  return { ok: missing.length === 0 && problems.length === 0, missing, problems, value };
}

module.exports = { loadConfig, REQUIRED, DEFAULTS };
