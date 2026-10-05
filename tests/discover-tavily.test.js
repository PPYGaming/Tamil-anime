"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { run, MAX_REQUESTS } = require("../scripts/discover-tavily");

const KEY = "TEST-TAVILY-KEY-0000";
const resp = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => { if (body === undefined) throw new SyntaxError("bad"); return body; } });
const result = (title, url, content = "Tamil audio listed.") => ({ title, url, content });

function setup(catalog = { anime: [] }, leads) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tavily-"));
  const catalogFile = path.join(dir, "anime.json");
  const leadsFile = path.join(dir, "leads.json");
  fs.writeFileSync(catalogFile, JSON.stringify(catalog));
  if (leads) fs.writeFileSync(leadsFile, JSON.stringify(leads));
  const logs = [];
  const base = { env: { TAVILY_API_KEY: KEY }, catalogFile, leadsFile, log: (m) => logs.push(m) };
  return { base, logs, leadsFile, read: () => JSON.parse(fs.readFileSync(leadsFile, "utf8")) };
}

test("missing key: skipped, no request, no file", async () => {
  const s = setup();
  let calls = 0;
  const out = await run({ ...s.base, env: {}, fetchImpl: async () => { calls++; } });
  assert.equal(out.skipped, true);
  assert.equal(calls, 0);
  assert.deepEqual(s.logs, ["tavily discovery skipped"]);
  assert.ok(!fs.existsSync(s.leadsFile));
});


test("429 stops the run immediately, no retry, nothing added", async () => {
  const s = setup();
  let calls = 0;
  const out = await run({ ...s.base, fetchImpl: async () => { calls++; return resp(429, {}); } });
  assert.equal(calls, 1);
  assert.equal(out.added, 0);
  assert.ok(!fs.existsSync(s.leadsFile));
});

test("malformed JSON and thrown errors are skipped without failing", async () => {
  const s = setup();
  let n = 0;
  const out = await run({ ...s.base, maxRequests: 3, fetchImpl: async () => { n++; if (n === 2) throw Object.assign(new Error(`boom ${KEY}`), { name: "TimeoutError" }); return resp(200); } });
  assert.equal(out.added, 0);
  assert.ok(s.logs.every((l) => !l.includes(KEY)));
});

test("domain filter: third-party sites, off-platform hosts and non-title pages are dropped", async () => {
  const s = setup();
  const out = await run({ ...s.base, maxRequests: 1, fetchImpl: async () => resp(200, { results: [
    result("Good Show", "https://www.crunchyroll.com/series/GABCDEF12/good-show"),
    result("Blog", "https://example.org/jiohotstar-tamil-dubbed-anime-list/"),
    result("Other", "https://www.netflix.com/title/81000001"),
    result("Search", "https://www.crunchyroll.com/search?q=tamil"),
    result("Evil", "https://crunchyroll.com.evil.com/series/GABCDEF12/x")
  ] }) });
  assert.equal(out.added, 1);
  assert.deepEqual(s.read().leads.map((l) => l.title), ["Good Show"]);
  assert.equal(s.read().leads[0].status, "needsReview");
});


test("dedupe: catalog title, catalog row URL, prior leads, same run; JJK skipped", async () => {
  const known = "https://www.crunchyroll.com/series/GKNOWN123/known-url";
  const s = setup(
    { anime: [{ title: "Known Title", platforms: [{ name: "Crunchyroll", officialUrl: known }] }] },
    { version: 1, leads: [{ title: "Prior Lead", platform: "Crunchyroll", pageUrl: "https://www.crunchyroll.com/series/GPRIOR123/prior", status: "needsReview" }] }
  );
  const out = await run({ ...s.base, maxRequests: 1, fetchImpl: async () => resp(200, { results: [
    result("Known Title - Crunchyroll", "https://www.crunchyroll.com/series/GNEWID123/known-title"),
    result("Other Name", known),
    result("Prior Lead", "https://www.crunchyroll.com/series/GPRIOR123/prior"),
    result("Fresh One", "https://www.crunchyroll.com/series/GFRESH123/fresh-one"),
    result("Fresh One", "https://www.crunchyroll.com/series/GFRESH123/fresh-one"),
    result("Jujutsu Kaisen Season 2", "https://www.crunchyroll.com/series/GJJK12345/jjk")
  ] }) });
  assert.equal(out.added, 1);
  assert.deepEqual(s.read().leads.map((l) => l.title), ["Prior Lead", "Fresh One"]);
});

test("request cap holds, even if a larger cap is requested", async () => {
  const s = setup();
  let calls = 0;
  await run({ ...s.base, maxRequests: 3, fetchImpl: async () => { calls++; return resp(200, { results: [] }); } });
  assert.equal(calls, 3);
  calls = 0;
  await run({ ...s.base, maxRequests: 999, fetchImpl: async () => { calls++; return resp(200, { results: [] }); } });
  assert.ok(calls <= MAX_REQUESTS && MAX_REQUESTS <= 12);
});

test("secret is only in the Authorization header: not in URL, body, logs or the leads file", async () => {
  const s = setup();
  const seen = [];
  await run({ ...s.base, maxRequests: 2, fetchImpl: async (url, init) => { seen.push({ url, init }); return resp(200, { results: [result("Lead A", "https://www.crunchyroll.com/series/GLEADA123/lead-a")] }); } });

  for (const { url, init } of seen) {
    assert.equal(url, "https://api.tavily.com/search");
    assert.equal(init.method, "POST");
    assert.equal(init.headers.Authorization, `Bearer ${KEY}`);
    assert.ok(!url.includes(KEY) && !init.body.includes(KEY));
  }
  assert.ok(!fs.readFileSync(s.leadsFile, "utf8").includes(KEY));
  assert.ok(s.logs.every((l) => !l.includes(KEY)));
});
