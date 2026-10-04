"use strict";

// Configuration and repository hygiene: env parsing, the owner-confirmed channel allow-list, the workflow files (read as
// text - they are never executed or dispatched here), and a repo-wide scan for anything that looks like a credential.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { readDiscoveryConfig, DEFAULTS, ZERO_ADD_TEXT } = require("../scripts/discovery");
const { readConfig } = require("../scripts/update-anime");

const ROOT = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(ROOT, file), "utf8");

/* ------------------------------ env parsing ------------------------------ */

test("discovery is OFF by default and only DISCOVERY_ENABLED turns it on", () => {
  assert.equal(readDiscoveryConfig({}).enabled, false);
  for (const value of ["true", "TRUE", "1", "yes"]) assert.equal(readDiscoveryConfig({ DISCOVERY_ENABLED: value }).enabled, true, value);
  for (const value of ["false", "0", "no", "", "enabled", "on"]) assert.equal(readDiscoveryConfig({ DISCOVERY_ENABLED: value }).enabled, false, value);
});

test("defaults keep a run far below the default 10,000 units/day YouTube quota", () => {
  const cfg = readDiscoveryConfig({});

  assert.equal(cfg.unitBudget, DEFAULTS.unitBudget);
  assert.ok(cfg.unitBudget * 4 <= 10000, "four runs a day at the unit budget stay within the default daily quota");
  assert.equal(cfg.overlapHours, 72);
  assert.equal(cfg.bootstrapPageBudget, 100);
});

test("invalid or out-of-range tuning values fall back to the defaults instead of being trusted", () => {
  const cfg = readDiscoveryConfig({
    DISCOVERY_BOOTSTRAP_PAGES: "-5",
    DISCOVERY_INCREMENTAL_PAGES: "abc",
    DISCOVERY_UNIT_BUDGET: "99999999",
    DISCOVERY_OVERLAP_HOURS: "1.5",
    DISCOVERY_RETRIES: "50",
    DISCOVERY_MIN_EPISODE_SECONDS: ""
  });

  assert.equal(cfg.bootstrapPageBudget, DEFAULTS.bootstrapPageBudget);
  assert.equal(cfg.incrementalPageBudget, DEFAULTS.incrementalPageBudget);
  assert.equal(cfg.unitBudget, DEFAULTS.unitBudget);
  assert.equal(cfg.overlapHours, DEFAULTS.overlapHours);
  assert.equal(cfg.retries, DEFAULTS.retries);
  assert.equal(cfg.minEpisodeSeconds, DEFAULTS.minEpisodeSeconds);

  assert.equal(readDiscoveryConfig({ DISCOVERY_UNIT_BUDGET: "500", DISCOVERY_BOOTSTRAP_PAGES: "7" }).unitBudget, 500);
  assert.equal(readDiscoveryConfig({ DISCOVERY_UNIT_BUDGET: "500", DISCOVERY_BOOTSTRAP_PAGES: "7" }).bootstrapPageBudget, 7);
});

test("readConfig carries discovery settings and the checkpoint path, with data/discovery-state.json as the default", () => {
  const cfg = readConfig({ DISCOVERY_ENABLED: "true", YOUTUBE_API_KEY: "TEST-YT-KEY-0000", OFFICIAL_YOUTUBE_CHANNEL_IDS: "UCaaaaaaaaaaaaaaaaaaaaaa, UCbbbbbbbbbbbbbbbbbbbbbb" });

  assert.equal(cfg.discovery.enabled, true);
  assert.equal(path.relative(process.cwd(), cfg.discoveryStateFile).split(path.sep).join("/"), "data/discovery-state.json");
  assert.deepEqual(cfg.extraChannelIds, ["UCaaaaaaaaaaaaaaaaaaaaaa", "UCbbbbbbbbbbbbbbbbbbbbbb"]);
  assert.equal(readConfig({}).discovery.enabled, false);
});

test("every zero-add reason code the owner asked for has its own text", () => {
  for (const code of ["all-known", "no-tamil-evidence", "missing-youtube-key", "missing-channel-allowlist", "incomplete-scan", "api-error", "quota-exhausted"]) {
    assert.ok(ZERO_ADD_TEXT[code] && ZERO_ADD_TEXT[code].length > 20, code);
  }

  assert.equal(new Set(Object.values(ZERO_ADD_TEXT)).size, Object.keys(ZERO_ADD_TEXT).length, "no two codes share a sentence");
});

/* ------------------------------ the allow-list ------------------------------ */

test("the manifest allow-list holds exactly the owner-confirmed Muse India channel", () => {
  const manifest = JSON.parse(read("data/official-tamil-dub-manifest.json"));

  assert.deepEqual(manifest.officialYouTubeChannels, [{ name: "Muse India", channelId: "UCYYhAzgWuxPauRXdPpLAX3Q" }]);
  assert.equal(manifest.entries.length, 96, "earlier entries plus 9 Muse India series and Crunchyroll Tamil-audio titles added on 2026-10-04");
});

/* ------------------------------ workflows (text checks only) ------------------------------ */

test("update workflow: serialised, bounded, discovery on, and both data files committed", () => {
  const workflow = read(".github/workflows/update-anime.yml");

  assert.match(workflow, /concurrency:\s*\n\s+group: update-anime-catalog\s*\n\s+cancel-in-progress: false/);
  assert.match(workflow, /timeout-minutes: 20/);
  assert.match(workflow, /DISCOVERY_ENABLED: 'true'/);
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /cron: '0 \*\/6 \* \* \*'/);
  assert.match(workflow, /git add -A -- data\/anime\.json data\/discovery-state\.json/);
  assert.match(workflow, /git diff --cached --quiet/);
  assert.doesNotMatch(workflow, /git add (-A|\.|--all)\s*$/m, "it never stages the whole tree");
  assert.doesNotMatch(workflow, /--force|push -f/);
});

test("update workflow: secrets are passed to the updater step only, by name, and never printed", () => {
  const workflow = read(".github/workflows/update-anime.yml");
  const used = [...workflow.matchAll(/\$\{\{\s*secrets\.([A-Z_]+)\s*\}\}/g)].map((match) => match[1]).sort();

  assert.deepEqual(used, ["TMDB_API_KEY", "YOUTUBE_API_KEY"], "only the two data keys, no dispatch token or other secret");
  assert.doesNotMatch(workflow, /echo[^\n]*secrets\./);
  assert.doesNotMatch(workflow, /set -x/);
});

test("the full-rescan switch is an explicit owner input, off by default", () => {
  const workflow = read(".github/workflows/update-anime.yml");
  assert.match(workflow, /full_rescan:[\s\S]*?type: boolean[\s\S]*?default: false/);
});

test("test workflow: read-only, secret-free, no network targets of its own", () => {
  const workflow = read(".github/workflows/tests.yml");

  assert.match(workflow, /permissions:\s*\n\s+contents: read/);
  assert.doesNotMatch(workflow, /secrets\./);
  assert.match(workflow, /npm test/);
  assert.doesNotMatch(workflow, /schedule:|workflow_dispatch/);
});

test("the Refresh backend is not wired into any workflow or deployment file", () => {
  const files = fs.readdirSync(path.join(ROOT, ".github", "workflows"));

  assert.deepEqual(files.sort(), ["tests.yml", "update-anime.yml"]);
  for (const name of ["vercel.json", "wrangler.toml", "netlify.toml", "Dockerfile", "fly.toml", "render.yaml", "serverless.yml", "Procfile", "app.yaml"]) {
    assert.ok(!fs.existsSync(path.join(ROOT, name)) && !fs.existsSync(path.join(ROOT, "backend", "refresh-scan", name)), `${name} must not exist: no host has been chosen`);
  }
});

/* ------------------------------ credentials hygiene ------------------------------ */

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if ([".git", "node_modules"].includes(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

test("no file in the repository contains a real-looking credential", () => {
  const patterns = [
    [/ghp_[A-Za-z0-9]{30,}/, "GitHub personal access token"],
    [/github_pat_[A-Za-z0-9_]{30,}/, "GitHub fine-grained token"],
    [/gh[ousr]_[A-Za-z0-9]{30,}/, "GitHub token"],
    [/AIza[0-9A-Za-z_-]{30,}/, "Google API key"],
    [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, "private key"],
    [/\b[0-9a-f]{32}\b(?=["'`]?\s*[,;)\n])(?<=api[_-]?key["'`]?\s*[:=]\s*["'`]?[0-9a-f]{32})/i, "32-hex api key assignment"]
  ];
  const offenders = [];

  for (const file of walk(ROOT)) {
    if (/\.(png|jpg|jpeg|gif|ico|woff2?)$/i.test(file)) continue;
    const text = fs.readFileSync(file, "utf8");
    for (const [pattern, label] of patterns) if (pattern.test(text)) offenders.push(`${path.relative(ROOT, file)}: ${label}`);
  }

  assert.deepEqual(offenders, []);
});

test("every .env template lists secret names with EMPTY values", () => {
  const secretNames = /^(TMDB_API_KEY|YOUTUBE_API_KEY|GITHUB_DISPATCH_TOKEN|GITHUB_OAUTH_CLIENT_ID|GITHUB_OAUTH_CLIENT_SECRET|SESSION_SECRET|PUBLIC_BASE_URL|ALLOWED_ORIGIN|OWNER_GITHUB_LOGINS|OWNER_GITHUB_USER_IDS)=(.*)$/;

  for (const file of [".env.example", "backend/refresh-scan/.env.example"]) {
    for (const line of read(file).split("\n")) {
      const match = secretNames.exec(line.trim());
      if (match) assert.equal(match[2].trim(), "", `${file}: ${match[1]} must be empty in a template`);
    }
  }
});

test(".gitignore keeps filled-in env files out but allows the templates", () => {
  const ignore = read(".gitignore");
  assert.match(ignore, /^\.env$/m);
  assert.match(ignore, /^\.env\.\*$/m);
  assert.match(ignore, /^!\.env\.example$/m);
});
