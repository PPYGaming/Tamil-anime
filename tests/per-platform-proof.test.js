"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { validateEntry } = require("../scripts/update-anime");

const CR = "https://www.crunchyroll.com/series/G79H23Z8P/shangri-la-frontier";
const PV = "https://www.primevideo.com/detail/0LA5USYMUJWOHIADWEXZSMJU6R";
const HS = "https://www.hotstar.com/in/shows/demon-slayer/1271234567";
const SONY = "https://www.sonyliv.com/shows/death-note-1700000123";
const BLOG = "https://example.org/some-post/";
const base = { title: "Show", tamilDubVerified: true, mediaType: "tv", tmdbId: 1, year: 2023 };
const row = (name, officialUrl, extra = {}) => ({ name, available: true, officialUrl, ...extra });
const platformsOf = (r) => r.entry.evidence.map((e) => e.platform).sort();

test("proof on each platform's own domain verifies both rows", () => {
  const r = validateEntry({ ...base, platforms: [
    row("Crunchyroll", CR, { verificationUrl: CR, checkedAt: "2026-10-05", note: "Tamil in Audio line" }),
    row("Amazon Prime Video", PV, { verificationUrl: PV })
  ] }, []);
  assert.equal(r.ok, true);
  assert.deepEqual(platformsOf(r), ["Amazon Prime Video", "Crunchyroll"]);
  assert.deepEqual(r.entry.curatedPlatforms.map((p) => p.proofUrl), [CR, PV]);
});

test("legacy verification still works and proves only its own platform", () => {
  const r = validateEntry({ ...base, verification: { url: PV, checkedAt: "2026-10-04" }, platforms: [row("Amazon Prime Video", PV), row("Crunchyroll", CR)] }, []);
  assert.equal(r.ok, true);
  assert.deepEqual(platformsOf(r), ["Amazon Prime Video"]);
  assert.ok(r.entry.curatedPlatforms.every((p) => p.proofUrl === undefined));
});

test("legacy plus a row proof (Shangri-La shape) gives both platforms", () => {

  const r = validateEntry({ ...base, verification: { url: PV, checkedAt: "2026-10-04" }, platforms: [row("Amazon Prime Video", PV), row("Crunchyroll", CR, { verificationUrl: CR })] }, []);
  assert.deepEqual(platformsOf(r), ["Amazon Prime Video", "Crunchyroll"]);
});

test("a blog, a search page, an announcement or another platform's URL never verifies a row", () => {
  const bad = [BLOG, PV, "https://www.crunchyroll.com/search?q=x", "https://www.crunchyroll.com/news/2026/1/1/x"];
  for (const url of bad) {
    const r = validateEntry({ ...base, verification: PV, platforms: [row("Crunchyroll", CR, { verificationUrl: url })] }, []);
    assert.equal(r.ok, true, url);
    assert.deepEqual(platformsOf(r), ["Amazon Prime Video"], url);
    assert.equal(r.entry.curatedPlatforms[0].proofUrl, undefined, url);
    assert.ok(r.warnings.some((w) => /Crunchyroll verificationUrl ignored/.test(w)), url);
  }
});

test("an entry whose only proof is invalid is rejected", () => {
  const r = validateEntry({ ...base, platforms: [row("Crunchyroll", CR, { verificationUrl: BLOG })] }, []);
  assert.equal(r.ok, false);
  assert.match(r.reason, /no acceptable official-source evidence/);
  assert.equal(validateEntry({ ...base }, []).ok, false);
});

test("a tamilDubVerified flag on a row is not proof", () => {
  const r = validateEntry({ ...base, verification: PV, platforms: [row("Crunchyroll", CR, { tamilDubVerified: true })] }, []);
  assert.deepEqual(platformsOf(r), ["Amazon Prime Video"]);
  assert.ok(r.warnings.some((w) => /tamilDubVerified on Crunchyroll ignored/.test(w)));
});

test("JioHotstar and Sony LIV rows: own-domain proof counts, cross-platform proof does not, no episode links", () => {
  const ok = validateEntry({ ...base, platforms: [row("JioHotstar", HS, { verificationUrl: HS }), row("Sony LIV", SONY, { verificationUrl: SONY })] }, []);
  assert.equal(ok.ok, true);
  assert.deepEqual(platformsOf(ok), ["JioHotstar", "Sony LIV"]);


  const cross = validateEntry({ ...base, verification: PV, platforms: [row("JioHotstar", HS, { verificationUrl: SONY })] }, []);
  assert.equal(cross.entry.curatedPlatforms[0].proofUrl, undefined);

  const eps = validateEntry({ ...base, platforms: [row("JioHotstar", HS, { verificationUrl: HS })], episodes: [{ number: "1-1", url: HS }] }, []);
  assert.equal(eps.entry.episodes[0].url, undefined);
});
