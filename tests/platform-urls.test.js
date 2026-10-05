"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { platformUrlOk, validate, reportedRow } = require("../scripts/add-reported");
const { classifyOfficialUrl } = require("../scripts/update-anime");

const HS = "https://www.hotstar.com/in/shows/demon-slayer/1271234567";
const JIO = "https://www.jiohotstar.com/shows/demon-slayer/1271234567";
const SONY = "https://www.sonyliv.com/shows/death-note-1700000123";

test("JioHotstar page rules (add-reported)", () => {
  assert.ok(platformUrlOk("JioHotstar", HS));
  assert.ok(platformUrlOk("JioHotstar", JIO));
  assert.ok(platformUrlOk("JioHotstar", "https://www.hotstar.com/in/movies/some-movie/1260000001"));
  assert.ok(!platformUrlOk("JioHotstar", HS.replace("https", "http")));
  assert.ok(!platformUrlOk("JioHotstar", "https://www.hotstar.com.evil.com/in/shows/x/1"));
  assert.ok(!platformUrlOk("JioHotstar", "https://evil.com/in/shows/x/1"));
  assert.ok(!platformUrlOk("JioHotstar", "https://user:pw@www.hotstar.com/in/shows/x/1"));
  assert.ok(!platformUrlOk("JioHotstar", "https://www.hotstar.com/in/search?q=demon"));
  assert.ok(!platformUrlOk("JioHotstar", "https://example.org/jiohotstar-tamil-dubbed-anime-list/"));
  assert.ok(!platformUrlOk("JioHotstar", SONY));
});

test("Sony LIV page rules (add-reported)", () => {
  assert.ok(platformUrlOk("Sony LIV", SONY));
  assert.ok(platformUrlOk("Sony LIV", "https://www.sonyliv.com/movies/some-film-1000012345"));
  assert.ok(!platformUrlOk("Sony LIV", SONY.replace("https", "http")));
  assert.ok(!platformUrlOk("Sony LIV", "https://www.sonyliv.com/search?q=death"));
  assert.ok(!platformUrlOk("Sony LIV", "https://sonyliv.com.evil.com/shows/x-1"));
  assert.ok(!platformUrlOk("Sony LIV", HS));
});


test("updater classifier accepts each platform's own pages only", () => {
  assert.deepEqual([classifyOfficialUrl(HS).ok, classifyOfficialUrl(HS).platform], [true, "JioHotstar"]);
  assert.equal(classifyOfficialUrl(JIO).platform, "JioHotstar");
  assert.equal(classifyOfficialUrl(SONY).platform, "Sony LIV");
  assert.equal(classifyOfficialUrl(SONY.replace("https", "http")).ok, false);
  assert.equal(classifyOfficialUrl("https://www.sonyliv.com/search?q=x").ok, false);
  assert.equal(classifyOfficialUrl("https://example.org/sony-liv-adds-7-anime-in-hindi-tamil-telugu/").ok, false);
});

const base = (platform, officialUrl) => ({
  title: "X", mediaType: "tv", tmdbId: 1, platform, officialUrl,
  report: { source: "Anime Mirchi", url: "https://example.org/x/", checkedAt: "2026-10-05" }
});

test("reported entries on the new platforms validate and are never verified", () => {
  assert.equal(validate(base("JioHotstar", HS)), null);
  assert.equal(validate(base("Sony LIV", SONY)), null);
  assert.match(validate(base("Sony LIV", HS)), /own title page/);
  assert.match(validate(base("JioHotstar", "https://example.org/x/")), /own title page/);
  for (const [p, u] of [["JioHotstar", HS], ["Sony LIV", SONY]]) {
    const row = reportedRow(base(p, u));
    assert.equal(row.tamilDubReported, true);
    assert.equal(row.tamilDubVerified, false);
    assert.equal(row.available, true);
  }
});
