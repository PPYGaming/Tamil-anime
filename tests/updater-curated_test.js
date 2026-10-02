"use strict";

// Run: node --test tests/*.test.js   (Node 18+, no dependencies, no network)
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// The updater's folder isn't fixed by the repo layout: look in the usual places, or set UPDATER_PATH.
const updaterPath = [process.env.UPDATER_PATH, "../update-anime.js", "../scripts/update-anime.js", "../.github/scripts/update-anime.js", "../tools/update-anime.js"]
  .filter(Boolean)
  .map((candidate) => path.resolve(__dirname, candidate))
  .find((candidate) => fs.existsSync(candidate));

if (!updaterPath) throw new Error("update-anime.js not found next to tests/ or in scripts/; set UPDATER_PATH");

const updater = require(updaterPath);

const CHANNEL = `UC${"a".repeat(22)}`;
const CR_SERIES = "https://www.crunchyroll.com/series/GABC123/demo-quest";
const CR_NEWS = "https://www.crunchyroll.com/news/2026/10/1/demo-quest-tamil-dub";
const NF_TITLE = "https://www.netflix.com/title/81234567";
const PRIME = "https://www.primevideo.com/detail/0ABCDEF123";
const VIDEO = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";
const channels = new Map([[CHANNEL, { name: "Muse India" }]]);

const entry = (extra = {}) => ({
  id: "demo-quest",
  title: "Demo Quest",
  year: 2024,
  tamilDubVerified: true,
  verification: { url: CR_NEWS, checkedAt: "2026-09-30", note: "Tamil listed in audio options" },
  ...extra
});

const placeholder = (name) => ({ name, available: false, officialUrl: null, tamilDubVerified: false });

async function runUpdater({ catalog = { lastUpdated: "2026-09-01T00:00:00.000Z", anime: [] }, manifest }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tamil-anime-"));
  const catalogFile = path.join(dir, "anime.json");
  const manifestFile = path.join(dir, "manifest.json");
  const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
  fs.writeFileSync(catalogFile, `${JSON.stringify(catalog, null, 2)}\n`);
  fs.writeFileSync(manifestFile, manifestText);

  const saved = { log: console.log, warn: console.warn };
  console.log = console.warn = () => {};

  try {
    const report = await updater.run({
      catalogFile, manifestFile, tmdbApiKey: "", youtubeApiKey: "", extraChannelIds: [], failOnZeroAdd: false, tmdbDelayMs: 0, region: "IN"
    });

    return {
      report,
      catalogFile,
      manifestFile,
      catalog: JSON.parse(fs.readFileSync(catalogFile, "utf8")),
      manifestUntouched: fs.readFileSync(manifestFile, "utf8") === manifestText
    };
  } finally {
    Object.assign(console, saved);
  }
}

const manifestOf = (...entries) => ({
  version: 1,
  updatedAt: "2026-10-01",
  officialYouTubeChannels: [{ name: "Muse India", channelId: CHANNEL }],
  entries
});

const notes = (report) => report.needsReview.map((item) => item.reason).join("\n");

/* ------------------------------------------------------------------ */
/* validateEntry                                                        */
/* ------------------------------------------------------------------ */

test("legacy manifest entries validate to exactly the same shape as before", () => {
  const result = updater.validateEntry(entry(), channels);

  assert.equal(result.ok, true);
  assert.deepEqual(Object.keys(result).sort(), ["entry", "ok", "problems"]);
  assert.deepEqual(
    Object.keys(result.entry).sort(),
    ["aliases", "backdrop", "description", "evidence", "firstAirDate", "id", "image", "mediaType", "originalTitle", "tags", "title", "tmdbId", "year"]
  );
});

test("curated platform rows keep only known platforms with a matching official title page", () => {
  const result = updater.validateEntry(entry({
    platforms: [
      { name: "Netflix", available: true, officialUrl: NF_TITLE },
      { name: "amazon prime video", available: true, officialUrl: PRIME },
      { name: "Crunchyroll", available: true, officialUrl: CR_SERIES },
      { name: "Disney+", available: true, officialUrl: "https://www.disneyplus.com/series/x/1" },
      { name: "YouTube", available: true, officialUrl: VIDEO }
    ]
  }), channels);

  assert.equal(result.ok, true);
  assert.deepEqual(result.entry.curatedPlatforms.map((row) => [row.name, row.officialUrl]), [
    ["Netflix", NF_TITLE],
    ["Amazon Prime Video", PRIME],
    ["Crunchyroll", CR_SERIES]
  ]);
  assert.match(result.warnings.join("\n"), /unknown platform "Disney\+" ignored/);
  assert.match(result.warnings.join("\n"), /unknown platform "YouTube" ignored/);
});

test("curated platform rows with bad, mismatched or unsafe URLs are dropped, never linked", () => {
  const bad = [
    { name: "Netflix", available: true, officialUrl: "http://www.netflix.com/title/81234567" }, // not https
    { name: "Netflix", available: true, officialUrl: "javascript:alert(1)" },
    { name: "Netflix", available: true, officialUrl: null },
    { name: "Netflix", available: true, officialUrl: "https://www.netflix.com/search?q=demo" }, // search page
    { name: "Netflix", available: true, officialUrl: "https://www.netflix.com/watch/81234567" }, // watch page is not a title page
    { name: "Netflix", available: true, officialUrl: "https://evil.example/title/81234567" },
    { name: "Netflix", available: true, officialUrl: CR_SERIES }, // another platform's URL
    { name: "Crunchyroll", available: true, officialUrl: "https://www.crunchyroll.com/watch/G1/ep-1" }, // watch page is not a title page
    { name: "Amazon Prime Video", available: true, officialUrl: "https://www.primevideo.com/search?phrase=demo" }
  ];

  for (const row of bad) {
    const result = updater.validateEntry(entry({ platforms: [row] }), channels);
    assert.equal(result.ok, true, "a bad curated row never rejects the entry");
    assert.equal(result.entry.curatedPlatforms, undefined, JSON.stringify(row));
    assert.ok(result.warnings.length >= 1);
  }
});

test("'available: false', duplicates and non-array platforms are handled quietly", () => {
  let result = updater.validateEntry(entry({ platforms: [{ name: "Netflix", available: false, officialUrl: NF_TITLE }] }), channels);
  assert.equal(result.entry.curatedPlatforms, undefined);

  result = updater.validateEntry(entry({
    platforms: [{ name: "Netflix", available: true, officialUrl: NF_TITLE }, { name: "Netflix", available: true, officialUrl: "https://www.netflix.com/title/999" }]
  }), channels);
  assert.equal(result.entry.curatedPlatforms.length, 1);
  assert.equal(result.entry.curatedPlatforms[0].officialUrl, NF_TITLE);
  assert.match(result.warnings.join("\n"), /duplicate Netflix row ignored/);

  result = updater.validateEntry(entry({ platforms: "Netflix" }), channels);
  assert.equal(result.ok, true);
  assert.match(result.warnings.join("\n"), /platforms must be an array/);
});

test("curated fields never add a title: no verification means rejection", () => {
  const noEvidence = entry({ platforms: [{ name: "Netflix", available: true, officialUrl: NF_TITLE }], episodes: [{ number: "1" }] });
  delete noEvidence.verification;
  assert.equal(updater.validateEntry(noEvidence, channels).ok, false);

  const unverified = entry({ tamilDubVerified: false, platforms: [{ name: "Netflix", available: true, officialUrl: NF_TITLE }] });
  assert.equal(updater.validateEntry(unverified, channels).ok, false);

  const netflixOnlyAsPlatform = entry({ verification: { url: "https://evil.example/x", checkedAt: "2026-09-30" }, platforms: [{ name: "Netflix", available: true, officialUrl: NF_TITLE }] });
  assert.equal(updater.validateEntry(netflixOnlyAsPlatform, channels).ok, false, "a platforms row is not Tamil-audio evidence");
});

test("curated episodes: numbers required and unique, titles trimmed, only official watch URLs kept", () => {
  const result = updater.validateEntry(entry({
    verification: [{ url: CR_NEWS, checkedAt: "2026-09-30" }, { url: NF_TITLE, checkedAt: "2026-09-30" }],
    episodes: [
      { number: "1-1", title: "  The   Start ", url: "https://www.crunchyroll.com/watch/GEP1/the-start" },
      { number: 2, url: "https://www.netflix.com/watch/81000002" },
      { number: "1-3", url: "http://www.crunchyroll.com/watch/GEP3/x" },
      { number: "1-4", url: "https://evil.example/watch/1" },
      { number: "1-5", url: "javascript:alert(1)" },
      { number: "1-6", url: "https://www.crunchyroll.com/series/GABC123/demo-quest" },
      { number: "1-7", url: "https://www.youtube.com/@MuseIndia" },
      { number: "1-1", title: "Duplicate" },
      { title: "No number" },
      "1-8",
      null
    ]
  }), channels);

  assert.equal(result.ok, true);
  assert.deepEqual(result.entry.episodes.map((e) => e.number), ["1-1", "2", "1-3", "1-4", "1-5", "1-6", "1-7"]);
  assert.equal(result.entry.episodes[0].title, "The Start");
  assert.deepEqual(
    result.entry.episodes.map((e) => e.url || null),
    ["https://www.crunchyroll.com/watch/GEP1/the-start", "https://www.netflix.com/watch/81000002", null, null, null, null, null]
  );
  assert.equal(result.entry.episodes[1].platform, "Netflix");
  assert.match(result.warnings.join("\n"), /duplicate number ignored/);
  assert.match(result.warnings.join("\n"), /without a number ignored x3/);
});

test("episode links without Tamil proof on their platform are flagged for removal", () => {
  const result = updater.validateEntry(entry({
    episodes: [
      { number: "1", url: "https://www.netflix.com/watch/81000001" },
      { number: "2", url: "https://www.netflix.com/watch/81000002" },
      { number: "3", url: "https://www.crunchyroll.com/watch/GEP3/ok" }
    ]
  }), channels);

  assert.match(result.warnings.join("\n"), /2 Netflix link\(s\) will be dropped/);
  assert.ok(!/Crunchyroll link/.test(result.warnings.join("\n")), "Crunchyroll has proof in verification");
});

/* ------------------------------------------------------------------ */
/* run(): records built from the manifest                               */
/* ------------------------------------------------------------------ */

test("legacy entry produces the same record as before: three platform rows, no episodes", async () => {
  const { catalog, report, manifestUntouched } = await runUpdater({ manifest: manifestOf(entry()) });
  const record = catalog.anime[0];

  assert.equal(report.added, 1);
  assert.equal(manifestUntouched, true, "the approved manifest is never modified");
  assert.deepEqual(record.platforms, [
    { name: "Crunchyroll", available: true, officialUrl: CR_NEWS, tamilDubVerified: true, tamilDubVerificationUrl: CR_NEWS },
    placeholder("Netflix"),
    placeholder("Amazon Prime Video")
  ]);
  assert.deepEqual(record.episodes, []);
  assert.deepEqual(record.youtube, []);
  assert.equal(record.tamilDubVerified, true);
  assert.equal(record.inclusionSource, "official-source-manifest");
});

test("curated availability and episodes land in the catalog without inventing Tamil proof", async () => {
  const { catalog, report } = await runUpdater({
    manifest: manifestOf(entry({
      platforms: [
        { name: "Crunchyroll", available: true, officialUrl: CR_SERIES },
        { name: "Netflix", available: true, officialUrl: NF_TITLE, tamilDubVerified: true }, // claim is ignored
        { name: "Amazon Prime Video", available: true, officialUrl: "https://evil.example/detail/1" },
        { name: "Disney+", available: true, officialUrl: "https://www.disneyplus.com/series/x/1" }
      ],
      episodes: [
        { number: "1-1", title: "The Start", url: "https://www.crunchyroll.com/watch/GEP1/the-start" },
        { number: "1-2", url: "https://www.netflix.com/watch/81000001" },
        { number: "1-3", url: "http://www.crunchyroll.com/watch/GEP3/x" },
        { number: "1-4" }
      ]
    }))
  });
  const record = catalog.anime[0];

  assert.deepEqual(record.platforms, [
    { name: "Crunchyroll", available: true, officialUrl: CR_SERIES, tamilDubVerified: true, tamilDubVerificationUrl: CR_NEWS },
    { name: "Netflix", available: true, officialUrl: NF_TITLE, tamilDubVerified: false },
    placeholder("Amazon Prime Video")
  ]);
  assert.deepEqual(record.episodes, [
    { number: "1-1", title: "The Start", url: "https://www.crunchyroll.com/watch/GEP1/the-start", platform: "Crunchyroll" },
    { number: "1-2", url: null },
    { number: "1-3", url: null },
    { number: "1-4", url: null }
  ]);
  assert.deepEqual(record.tamilDubEvidence.map((e) => e.url), [CR_NEWS]);
  assert.match(notes(report), /unknown platform "Disney\+"/);
  assert.match(notes(report), /tamilDubVerified on Netflix ignored/);
  assert.match(notes(report), /Amazon Prime Video row ignored/);
  assert.match(notes(report), /1 Netflix link\(s\) will be dropped/);
});

test("Netflix episode links are kept only when Netflix itself has Tamil proof", async () => {
  const { catalog } = await runUpdater({
    manifest: manifestOf(entry({
      verification: [{ url: CR_NEWS, checkedAt: "2026-09-30" }, { url: NF_TITLE, checkedAt: "2026-09-30" }],
      episodes: [{ number: "1", url: "https://www.netflix.com/watch/81000001" }]
    }))
  });
  const record = catalog.anime[0];

  assert.deepEqual(record.episodes, [{ number: "1", url: "https://www.netflix.com/watch/81000001", platform: "Netflix" }]);
  assert.equal(record.platforms.find((p) => p.name === "Netflix").tamilDubVerified, true);
});

test("YouTube episode links need that exact video in the official-channel evidence", async () => {
  const { catalog } = await runUpdater({
    manifest: manifestOf(entry({
      verification: [{ url: CR_NEWS, checkedAt: "2026-09-30" }, { url: VIDEO, checkedAt: "2026-09-30", channelId: CHANNEL }],
      episodes: [
        { number: "1", url: "https://youtu.be/dQw4w9WgXcQ" },
        { number: "2", url: "https://www.youtube.com/watch?v=AAAAAAAAAAA" }
      ]
    }))
  });

  assert.deepEqual(catalog.anime[0].episodes, [
    { number: "1", url: `https://youtu.be/dQw4w9WgXcQ`, platform: "YouTube" },
    { number: "2", url: null }
  ]);
  assert.deepEqual(catalog.anime[0].youtube, [{ title: "Demo Quest", url: VIDEO }]);
});

test("a YouTube video from a channel outside the allow-list is rejected even with curated fields", async () => {
  const { catalog, report } = await runUpdater({
    manifest: manifestOf(entry({
      verification: { url: VIDEO, checkedAt: "2026-09-30", channelId: `UC${"b".repeat(22)}` },
      episodes: [{ number: "1", url: VIDEO }]
    }))
  });

  assert.equal(catalog.anime.length, 0);
  assert.equal(report.rejected.length, 1);
});

/* ------------------------------------------------------------------ */
/* run(): merging into published records (add-only)                     */
/* ------------------------------------------------------------------ */

function published(extra = {}) {
  return {
    id: "demo-quest",
    title: "Demo Quest",
    description: "Hand written description",
    image: "https://img.example/p.jpg",
    rating: 7.5,
    availability: "Ongoing",
    tags: ["Anime", "Action"],
    platforms: [
      { name: "Crunchyroll", available: true, officialUrl: CR_SERIES, tamilDubVerified: true, tamilDubVerificationUrl: CR_NEWS },
      placeholder("Netflix"),
      placeholder("Amazon Prime Video")
    ],
    episodes: [{ number: "1-1", url: null }, { number: "1-2", url: "https://www.crunchyroll.com/watch/KEEP/keep" }],
    youtube: [],
    tamilDubVerified: true,
    tamilDubVerificationSource: "Crunchyroll official listing/announcement",
    tamilDubVerificationUrl: CR_NEWS,
    tamilDubVerifiedAt: "2026-09-30",
    tamilDubEvidence: [{ platform: "Crunchyroll", url: CR_NEWS, source: "Crunchyroll official listing/announcement", checkedAt: "2026-09-30", note: "Tamil listed in audio options" }],
    inclusionSource: "official-source-manifest",
    region: "IN",
    ...extra
  };
}

test("curated fields fill gaps in a published record and never overwrite or remove anything", async () => {
  const before = published();
  const { catalog, report } = await runUpdater({
    catalog: { lastUpdated: "2026-09-01T00:00:00.000Z", anime: [structuredClone(before)] },
    manifest: manifestOf(entry({
      platforms: [{ name: "Netflix", available: true, officialUrl: NF_TITLE }],
      episodes: [
        { number: "1-1", title: "The Start", url: "https://www.crunchyroll.com/watch/GEP1/the-start" },
        { number: "1-2", title: "Second", url: "https://www.crunchyroll.com/watch/OTHER/other" },
        { number: "1-9", title: "New" }
      ]
    }))
  });
  const after = catalog.anime[0];

  assert.equal(catalog.anime.length, 1);
  assert.equal(report.added, 0);
  assert.deepEqual(report.updatedIds, [{ id: "demo-quest", fields: ["platforms", "episodes"] }]);

  assert.deepEqual(after.platforms, [
    before.platforms[0],
    { name: "Netflix", available: true, officialUrl: NF_TITLE, tamilDubVerified: false },
    placeholder("Amazon Prime Video")
  ]);
  assert.deepEqual(after.episodes, [
    { number: "1-1", url: "https://www.crunchyroll.com/watch/GEP1/the-start", title: "The Start", platform: "Crunchyroll" },
    { number: "1-2", url: "https://www.crunchyroll.com/watch/KEEP/keep", title: "Second" },
    { number: "1-9", title: "New", url: null }
  ]);

  const { platforms, episodes, ...rest } = after;
  const { platforms: _p, episodes: _e, ...restBefore } = before;
  assert.deepEqual(rest, restBefore, "every other published field is untouched");
});

test("a second run with the same manifest changes nothing", async () => {
  const first = await runUpdater({
    catalog: { lastUpdated: "2026-09-01T00:00:00.000Z", anime: [published()] },
    manifest: manifestOf(entry({
      platforms: [{ name: "Netflix", available: true, officialUrl: NF_TITLE }],
      episodes: [{ number: "1-1", title: "The Start", url: "https://www.crunchyroll.com/watch/GEP1/the-start" }]
    }))
  });
  const second = await runUpdater({ catalog: first.catalog, manifest: manifestOf(entry({
    platforms: [{ name: "Netflix", available: true, officialUrl: NF_TITLE }],
    episodes: [{ number: "1-1", title: "The Start", url: "https://www.crunchyroll.com/watch/GEP1/the-start" }]
  })) });

  assert.equal(second.report.updatedExisting, 0);
  assert.deepEqual(second.catalog.anime, first.catalog.anime);
});

test("an existing curated platform row is never downgraded or re-pointed", async () => {
  const existing = published({
    platforms: [
      { name: "Crunchyroll", available: true, officialUrl: CR_SERIES, tamilDubVerified: true, tamilDubVerificationUrl: CR_NEWS },
      { name: "Netflix", available: true, officialUrl: "https://www.netflix.com/title/111", tamilDubVerified: false },
      { name: "Amazon Prime Video", available: false, officialUrl: "https://www.primevideo.com/detail/CURATED", tamilDubVerified: false }
    ]
  });
  const { catalog } = await runUpdater({
    catalog: { lastUpdated: "2026-09-01T00:00:00.000Z", anime: [structuredClone(existing)] },
    manifest: manifestOf(entry({
      platforms: [{ name: "Netflix", available: true, officialUrl: NF_TITLE }, { name: "Amazon Prime Video", available: true, officialUrl: PRIME }]
    }))
  });

  assert.deepEqual(catalog.anime[0].platforms, existing.platforms);
});

test("a record explicitly marked not-verified with its own evidence is left unchanged and flagged", async () => {
  const existing = published({ tamilDubVerified: false });
  const { catalog, report } = await runUpdater({
    catalog: { lastUpdated: "2026-09-01T00:00:00.000Z", anime: [structuredClone(existing)] },
    manifest: manifestOf(entry({ platforms: [{ name: "Netflix", available: true, officialUrl: NF_TITLE }], episodes: [{ number: "1-1", url: "https://www.crunchyroll.com/watch/GEP1/x" }] }))
  });

  assert.deepEqual(catalog.anime[0], existing);
  assert.match(notes(report), /explicitly tamilDubVerified:false/);
});

test("manifest entries rejected for missing proof add nothing, curated fields included", async () => {
  const { catalog, report, manifestUntouched } = await runUpdater({
    manifest: manifestOf({ id: "no-proof", title: "No Proof", year: 2024, tamilDubVerified: true, platforms: [{ name: "Netflix", available: true, officialUrl: NF_TITLE }], episodes: [{ number: "1" }] })
  });

  assert.equal(catalog.anime.length, 0);
  assert.equal(report.rejected.length, 1);
  assert.equal(report.status, "zero-add");
  assert.equal(manifestUntouched, true);
});

test("previously published entries are all preserved in order when new titles are added", async () => {
  const old = [published(), published({ id: "other", title: "Other" })];
  const { catalog } = await runUpdater({
    catalog: { lastUpdated: "2026-09-01T00:00:00.000Z", anime: structuredClone(old) },
    manifest: manifestOf(entry({ id: "brand-new", title: "Brand New", platforms: [{ name: "Netflix", available: true, officialUrl: NF_TITLE }] }))
  });

  assert.deepEqual(catalog.anime.slice(0, 2), old);
  assert.equal(catalog.anime.length, 3);
  assert.equal(catalog.anime[2].id, "brand-new");
  assert.equal(catalog.anime[2].platforms.find((p) => p.name === "Netflix").tamilDubVerified, false);
});
