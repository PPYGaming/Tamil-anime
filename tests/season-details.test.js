"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const appExports = require("../app.js");
const seasonSectionHtml =
  appExports.seasonSectionHtml || (appExports.api && appExports.api.seasonSectionHtml);
const { attachSeasonDetails } = require("../scripts/update-anime.js");

const row = (platform, status, tamilEpisodes) => ({ platform, status, tamilEpisodes });
const entry = (title, ...seasons) => ({ title, seasons });
const season = (label, ...rows) => ({ label, rows });
const file = (...entries) => ({ version: 1, updatedAt: "2026-10-05", note: "", entries });

// Adjust this helper if your catalog's platform rows use different keys.
const platformsFor = (name, available, tamilDubVerified) => [
  { name, platform: name, available, tamilDubVerified },
];

const count = (haystack, needle) => haystack.split(needle).length - 1;

test("seasonSectionHtml is exported", () => {
  assert.equal(typeof seasonSectionHtml, "function");
});

test("matches exact titles and 'Season N' suffix records", () => {
  const list = [
    { title: "JUJUTSU KAISEN Season 1" },
    { title: "Jujutsu Kaisen" },
    { title: "Jujutsu Kaisenx" },
    { title: "Unrelated Show" },
  ];
  const details = file(entry("Jujutsu Kaisen", season("Season 1", row("Netflix", "Complete", 24))));
  const changed = attachSeasonDetails(list, details);

  assert.equal(changed, 2);
  assert.equal(list[0].seasonDetails[0].label, "Season 1");
  assert.equal(list[1].seasonDetails[0].rows[0].platform, "Netflix");
  assert.equal("seasonDetails" in list[2], false);
  assert.equal("seasonDetails" in list[3], false);
});

test("matching goes through normalizeTitle (case, punctuation, accents)", () => {
  const list = [{ title: "SPY x FAMILY Season 2" }];
  const changed = attachSeasonDetails(
    list,
    file(entry("spy X family", season("Season 2", row("Crunchyroll", "Ongoing", 5))))
  );
  assert.equal(changed, 1);
  assert.equal(list[0].seasonDetails[0].rows[0].tamilEpisodes, 5);
});

test("longest matching entry title wins regardless of entry order", () => {
  const short = entry("Spy x Family", season("Short", row("Netflix", "Complete", 1)));
  const long = entry("Spy x Family Season 2", season("Long", row("Netflix", "Complete", 2)));

  for (const entries of [[short, long], [long, short]]) {
    const list = [{ title: "SPY x FAMILY Season 2" }, { title: "SPY x FAMILY Season 1" }];
    attachSeasonDetails(list, file(...entries));
    assert.equal(list[0].seasonDetails[0].label, "Long");
    assert.equal(list[1].seasonDetails[0].label, "Short");
  }
});

test("invalid rows, seasons and values are dropped or normalised", () => {
  const longLabel = "x".repeat(81);
  const list = [{ title: "Solo Leveling" }];
  const details = file(
    entry(
      "Solo Leveling",
      season(
        "Season 1",
        row("Crunchyroll", "Complete", 12),
        row("Hulu", "Complete", 12), // bad platform: dropped
        row("Netflix", "Weird", 1.5), // bad status -> Unknown, bad count -> null
        row("JioHotstar", "Ongoing", -1), // null
        row("Sony LIV", "Ongoing", 5001), // null
        row("Amazon Prime Video", "Complete", "12"), // null
        null
      ),
      season("Season 2", row("Hulu", "Complete", 3)), // all rows invalid: empty season dropped
      season(longLabel, row("Netflix", "Complete", 3)), // label too long: dropped
      { label: 5, rows: [row("Netflix", "Complete", 3)] }, // non-string label: dropped
      season("Season 5", row("Crunchyroll", "Complete", 5000), row("Netflix", "Complete", 0))
    )
  );
  attachSeasonDetails(list, details);

  const seasons = list[0].seasonDetails;
  assert.deepEqual(
    seasons.map((s) => s.label),
    ["Season 1", "Season 5"]
  );
  assert.deepEqual(seasons[0].rows, [
    row("Crunchyroll", "Complete", 12),
    row("Netflix", "Unknown", null),
    row("JioHotstar", "Ongoing", null),
    row("Sony LIV", "Ongoing", null),
    row("Amazon Prime Video", "Complete", null),
  ]);
  assert.deepEqual(seasons[1].rows, [
    row("Crunchyroll", "Complete", 5000),
    row("Netflix", "Complete", 0),
  ]);
});

test("at most 40 seasons are kept", () => {
  const many = Array.from({ length: 50 }, (_, i) =>
    season(`Season ${i + 1}`, row("Netflix", "Complete", 1))
  );
  const list = [{ title: "Long Runner" }];
  attachSeasonDetails(list, file(entry("Long Runner", ...many)));
  assert.equal(list[0].seasonDetails.length, 40);
});

test("seasonDetails is a deep copy of the file data", () => {
  const details = file(entry("Show", season("Season 1", row("Netflix", "Complete", 3))));
  const list = [{ title: "Show" }, { title: "Show Season 2" }];
  attachSeasonDetails(list, details);

  details.entries[0].seasons[0].rows[0].tamilEpisodes = 99;
  list[0].seasonDetails[0].rows[0].status = "Ongoing";

  assert.equal(list[1].seasonDetails[0].rows[0].tamilEpisodes, 3);
  assert.equal(list[1].seasonDetails[0].rows[0].status, "Complete");
  assert.notEqual(list[0].seasonDetails, list[1].seasonDetails);
});

test("idempotent: a second run changes nothing", () => {
  const list = [{ title: "Solo Leveling Season 1" }, { title: "Other" }];
  const details = file(entry("Solo Leveling", season("Season 1", row("Crunchyroll", "Complete", 12))));

  assert.equal(attachSeasonDetails(list, details), 1);
  const snapshot = JSON.parse(JSON.stringify(list));
  assert.equal(attachSeasonDetails(list, details), 0);
  assert.deepEqual(list, snapshot);
});

test("never changes tamilDubVerified or any other field", () => {
  const list = [
    { title: "Show A", tamilDubVerified: true, platforms: platformsFor("Netflix", true, true), extra: { k: 1 } },
    { title: "Show A Season 2", tamilDubVerified: false },
    { title: "Show A Season 3" },
  ];
  const before = JSON.parse(JSON.stringify(list));

  attachSeasonDetails(list, file(entry("Show A", season("Season 1", row("Netflix", "Complete", 3)))));

  for (const rec of list) assert.ok(Array.isArray(rec.seasonDetails));
  const stripped = list.map((rec) => {
    const copy = JSON.parse(JSON.stringify(rec));
    delete copy.seasonDetails;
    return copy;
  });
  assert.deepEqual(stripped, before);
  assert.equal(list[0].tamilDubVerified, true);
  assert.equal(list[1].tamilDubVerified, false);
  assert.equal("tamilDubVerified" in list[2], false);
});

test("preserves existing seasonDetails when the supplemental file has no usable match", () => {
  const existing = [season("Season 1", row("Netflix", "Complete", 1))];
  for (const details of [file(), file(entry("Other", season("S", row("Netflix", "Complete", 1)))), file(entry("Gone Show", season("S", row("Hulu", "Complete", 1))))]) {
    const list = [{ id: "existing", title: "Gone Show", seasonDetails: structuredClone(existing) }];
    const before = structuredClone(list);
    assert.equal(attachSeasonDetails(list, details), 0);
    assert.deepEqual(list, before);
  }
  const clean = [{ title: "Gone Show" }];
  assert.equal(attachSeasonDetails(clean, file()), 0);
  assert.equal("seasonDetails" in clean[0], false);
});

test("supplemental season details preserve every current catalog field", () => {
  const list = structuredClone(require("../data/anime.json").anime);
  const before = structuredClone(list);
  attachSeasonDetails(list, require("../data/season-details.json"));
  for (const [index, original] of before.entries()) {
    for (const key of Object.keys(original)) assert.ok(key in list[index], `${original.id}: ${key}`);

  }
});

test("malformed details file leaves the catalog untouched", () => {
  const list = [{ title: "Show", seasonDetails: [season("Season 1", row("Netflix", "Complete", 1))] }];
  const before = JSON.parse(JSON.stringify(list));
  assert.equal(attachSeasonDetails(list, null), 0);
  assert.equal(attachSeasonDetails(list, { entries: "nope" }), 0);
  assert.deepEqual(list, before);
});

test("escapes a <script> label", () => {
  const html = seasonSectionHtml({
    platforms: [],
    seasonDetails: [season("<script>alert(1)</script>", row("Netflix", "Complete", 2))],
  });
  assert.equal(html.includes("<script>"), false);
  assert.ok(html.includes("&lt;script&gt;"));
});

test("Verified vs Reported chips", () => {
  const seasonDetails = [season("Season 1", row("Netflix", "Complete", 3), row("Crunchyroll", "Complete", 4))];

  const verifiedHtml = seasonSectionHtml({
    platforms: platformsFor("Netflix", true, true),
    seasonDetails,
  });
  assert.equal(count(verifiedHtml, "season-chip--verified"), 1); // Netflix only
  assert.equal(count(verifiedHtml, "season-chip--reported"), 1); // Crunchyroll has no platform row

  const notAvailable = seasonSectionHtml({
    platforms: platformsFor("Netflix", false, true),
    seasonDetails,
  });
  assert.equal(count(notAvailable, "season-chip--verified"), 0);
  assert.equal(count(notAvailable, "season-chip--reported"), 2);

  const notVerified = seasonSectionHtml({
    platforms: platformsFor("Netflix", true, false),
    seasonDetails,
  });
  assert.equal(count(notVerified, "season-chip--verified"), 0);
  assert.equal(count(notVerified, "season-chip--reported"), 2);
});

test("renders heading, status chips and the note", () => {
  const html = seasonSectionHtml({
    platforms: [],
    seasonDetails: [season("Season 1", row("Netflix", "Ongoing", 3))],
  });
  assert.ok(html.includes('aria-labelledby="seasonsHeading"'));
  assert.ok(html.includes("Tamil dub by season"));
  assert.ok(html.includes("season-chip--ongoing"));
  assert.ok(html.includes("Season rows marked Confirmed have a checked Tamil dub listing."));
});

test("singular and plural episode text", () => {
  const one = seasonSectionHtml({ platforms: [], seasonDetails: [season("S1", row("Netflix", "Complete", 1))] });
  assert.ok(one.includes("1 Tamil episode<"));
  assert.equal(one.includes("1 Tamil episodes"), false);

  const many = seasonSectionHtml({ platforms: [], seasonDetails: [season("S1", row("Netflix", "Complete", 12))] });
  assert.ok(many.includes("12 Tamil episodes"));
});

test("null count shows 'Episode count not reported'", () => {
  const html = seasonSectionHtml({
    platforms: [],
    seasonDetails: [season("S1", row("Netflix", "Unknown", null))],
  });
  assert.ok(html.includes("Episode count not reported"));
  assert.equal(html.includes("Tamil episodes"), false);
});

test("returns empty string when there is nothing to show", () => {
  assert.equal(seasonSectionHtml({}), "");
  assert.equal(seasonSectionHtml({ seasonDetails: [] }), "");
  assert.equal(seasonSectionHtml({ seasonDetails: "nope" }), "");
  assert.equal(seasonSectionHtml({ seasonDetails: null }), "");
  assert.equal(seasonSectionHtml(null), "");
  assert.equal(seasonSectionHtml(undefined), "");
});
