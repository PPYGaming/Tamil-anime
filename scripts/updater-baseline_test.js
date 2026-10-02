"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fsSync = require("fs");
const fsp = require("fs/promises");
const os = require("os");
const path = require("path");

const updater = require("./update-anime.js");

const CHANNEL = "UC" + "a".repeat(22);
const OTHER_CHANNEL = "UC" + "b".repeat(22);
const VIDEO = "dQw4w9WgXcQ";

function baseCatalog() {
  return {
    lastUpdated: "2026-01-01T00:00:00.000Z",
    region: "IN",
    siteBanner: { keep: "me" },
    updateInfo: { automatic: true, customKey: "keep" },
    anime: [
      {
        id: "manual-1",
        title: "Manual Show",
        firstAirDate: "2001-04-01",
        description: "Curated text",
        rating: 9.1,
        tags: ["Curated"],
        mysteryField: { a: 1 },
        tamilDubVerified: true,
        tamilDubVerificationSource: "Muse India curator note",
        platforms: [{ name: "Netflix", available: true, officialUrl: "https://www.netflix.com/title/123", tamilDubVerified: true }]
      },
      {
        id: "tmdb-111",
        title: "Legacy Auto",
        originalTitle: "Legacy Auto",
        description: "No description available.",
        image: null,
        rating: null,
        firstAirDate: "2020-01-01",
        tags: ["Anime"],
        episodes: [],
        tamilDubVerified: false,
        tamilDubVerificationSource: null,
        tmdbId: 111,
        tmdbUrl: "https://www.themoviedb.org/tv/111",
        platforms: [
          { name: "Crunchyroll", available: true, officialUrl: "https://www.crunchyroll.com/search?q=Legacy", tamilDubVerified: false },
          { name: "Netflix", available: false, officialUrl: null, tamilDubVerified: false },
          { name: "Amazon Prime Video", available: false, officialUrl: null, tamilDubVerified: false }
        ]
      }
    ]
  };
}

async function setup(manifest, catalog = baseCatalog()) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "anime-"));
  const catalogFile = path.join(dir, "anime.json");
  const manifestFile = path.join(dir, "manifest.json");
  await fsp.writeFile(catalogFile, JSON.stringify(catalog, null, 2) + "\n");
  if (manifest !== undefined) {
    await fsp.writeFile(manifestFile, typeof manifest === "string" ? manifest : JSON.stringify(manifest));
  }
  return { dir, catalogFile, manifestFile };
}

function exec(paths, extra = {}) {
  return updater.run({
    catalogFile: paths.catalogFile,
    manifestFile: paths.manifestFile,
    tmdbApiKey: "",
    youtubeApiKey: "",
    extraChannelIds: [],
    tmdbDelayMs: 0,
    ...extra
  });
}

const readCatalog = async (paths) => JSON.parse(await fsp.readFile(paths.catalogFile, "utf8"));

const crunchy = (slug = "example") => ({
  url: `https://www.crunchyroll.com/series/GRABC123/${slug}`,
  checkedAt: "2026-09-30"
});

async function withFetch(handler, fn) {
  const original = global.fetch;
  const calls = [];
  global.fetch = async (url) => {
    calls.push(String(url));
    const { status = 200, body = {} } = await handler(String(url));
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText: String(status),
      json: async () => body,
      text: async () => JSON.stringify(body)
    };
  };
  try {
    return await fn(calls);
  } finally {
    global.fetch = original;
  }
}

test("classifyOfficialUrl accepts title pages and rejects search/unknown hosts", () => {
  const ok = (u) => updater.classifyOfficialUrl(u);
  assert.equal(ok("https://www.crunchyroll.com/series/GRABC123/x").platform, "Crunchyroll");
  assert.equal(ok("https://www.netflix.com/title/81234567").platform, "Netflix");
  assert.equal(ok("https://www.primevideo.com/detail/0ABC123/ref=x").platform, "Amazon Prime Video");
  assert.equal(ok("https://www.amazon.in/gp/video/detail/B0ABC12345").platform, "Amazon Prime Video");
  assert.equal(ok(`https://www.youtube.com/watch?v=${VIDEO}`).platform, "YouTube");
  assert.equal(ok(`https://youtu.be/${VIDEO}`).platform, "YouTube");

  for (const bad of [
    "https://www.crunchyroll.com/search?q=tamil",
    "https://www.netflix.com/search?q=tamil",
    "https://www.primevideo.com/search/ref=atv_nb_sr?phrase=x",
    "https://www.youtube.com/results?search_query=tamil+dub",
    "https://www.youtube.com/@MuseIndia",
    "http://www.crunchyroll.com/series/GRABC123/x",
    "https://example.com/tamil-dub",
    "https://crunchyroll.com.evil.example/series/GRABC123/x",
    "not a url",
    ""
  ]) {
    assert.equal(ok(bad).ok, false, bad);
  }
});

test("zero-add scan with no manifest preserves everything and reports why", async () => {
  const paths = await setup(undefined);
  const before = baseCatalog();
  const report = await exec(paths);
  const after = await readCatalog(paths);

  assert.equal(report.status, "zero-add");
  assert.match(report.zeroAddReason, /No official-source manifest found/);
  assert.deepEqual(after.anime, before.anime);
  assert.deepEqual(after.siteBanner, before.siteBanner);
  assert.equal(after.updateInfo.customKey, "keep");
  assert.equal(after.lastUpdated, before.lastUpdated);
  assert.equal(after.updateInfo.lastScan.status, "zero-add");
});

test("adds only entries with tamilDubVerified:true and an acceptable official URL", async () => {
  const paths = await setup({
    version: 1,
    officialYouTubeChannels: [{ name: "Muse India", channelId: CHANNEL }],
    entries: [
      { title: "Good Show", year: 2010, tamilDubVerified: true, verification: crunchy("good-show") },
      { title: "Not Verified", year: 2010, tamilDubVerified: false, verification: crunchy() },
      { title: "Search Evidence", year: 2010, tamilDubVerified: true, verification: { url: "https://www.crunchyroll.com/search?q=x" } },
      { title: "YT Search", year: 2010, tamilDubVerified: true, verification: { url: "https://www.youtube.com/results?search_query=x" } },
      { title: "YT Unknown Channel", year: 2010, tamilDubVerified: true, verification: { url: `https://www.youtube.com/watch?v=${VIDEO}`, channelId: OTHER_CHANNEL } },
      { title: "YT No Channel", year: 2010, tamilDubVerified: true, verification: { url: `https://www.youtube.com/watch?v=${VIDEO}` } },
      { title: "Random Host", year: 2010, tamilDubVerified: true, verification: { url: "https://example.com/x" } },
      { title: "No Evidence", year: 2010, tamilDubVerified: true },
      { title: "No Stable Id", tamilDubVerified: true, verification: crunchy() }
    ]
  });

  const report = await exec(paths);
  const after = await readCatalog(paths);

  assert.equal(report.added, 1);
  assert.equal(report.rejected.length, 8);
  assert.equal(after.anime.length, 3);

  const added = after.anime[2];
  assert.equal(added.id, "official-good-show-2010");
  assert.equal(added.tamilDubVerified, true);
  assert.equal(added.tamilDubVerificationUrl, "https://www.crunchyroll.com/series/GRABC123/good-show");
  assert.equal(added.inclusionSource, "official-source-manifest");
  assert.equal(added.platforms.find((p) => p.name === "Crunchyroll").tamilDubVerified, true);
  assert.equal(added.platforms.find((p) => p.name === "Netflix").tamilDubVerified, false);
  assert.deepEqual(after.anime.slice(0, 2), baseCatalog().anime);
});

test("existing records: curated fields kept, gaps filled, verification evidence never clobbered, idempotent", async () => {
  const manifest = {
    entries: [
      {
        id: "manual-1",
        title: "Manual Show",
        description: "Different text that must NOT replace curated text",
        tags: ["Other"],
        tamilDubVerified: true,
        verification: crunchy("manual-show")
      }
    ]
  };
  const paths = await setup(manifest);
  const first = await exec(paths);
  const afterFirst = await readCatalog(paths);
  const rec = afterFirst.anime[0];

  assert.equal(first.added, 0);
  assert.equal(first.updatedExisting, 1);
  assert.equal(rec.description, "Curated text");
  assert.deepEqual(rec.tags, ["Curated"]);
  assert.equal(rec.rating, 9.1);
  assert.deepEqual(rec.mysteryField, { a: 1 });
  assert.equal(rec.tamilDubVerificationSource, "Muse India curator note");
  assert.equal(rec.tamilDubEvidence.length, 1);
  assert.equal(rec.platforms.find((p) => p.name === "Netflix").officialUrl, "https://www.netflix.com/title/123");

  const second = await exec(paths);
  const afterSecond = await readCatalog(paths);
  assert.equal(second.updatedExisting, 0);
  assert.deepEqual(afterSecond.anime, afterFirst.anime);
  assert.equal(afterSecond.lastUpdated, afterFirst.lastUpdated);
});

test("manifest verifies a legacy unverified TMDB record by tmdbId without replacing its fields", async () => {
  const paths = await setup({
    entries: [{ title: "Legacy Auto", tmdbId: 111, tamilDubVerified: true, verification: crunchy("legacy-auto") }]
  });
  const report = await exec(paths);
  const rec = (await readCatalog(paths)).anime[1];

  assert.equal(report.added, 0);
  assert.equal(rec.tamilDubVerified, true);
  assert.equal(rec.tamilDubVerificationUrl, "https://www.crunchyroll.com/series/GRABC123/legacy-auto");
  const platform = rec.platforms.find((p) => p.name === "Crunchyroll");
  assert.equal(platform.officialUrl, "https://www.crunchyroll.com/search?q=Legacy"); // kept
  assert.equal(platform.tamilDubVerified, true);
  assert.equal(platform.tamilDubVerificationUrl, "https://www.crunchyroll.com/series/GRABC123/legacy-auto");
});

test("an explicit tamilDubVerified:false with its own evidence is not overridden", async () => {
  const catalog = baseCatalog();
  catalog.anime[1].tamilDubVerificationSource = "Checked: no Tamil track";
  const paths = await setup(
    { entries: [{ title: "Legacy Auto", tmdbId: 111, tamilDubVerified: true, verification: crunchy("legacy-auto") }] },
    catalog
  );
  const report = await exec(paths);
  const rec = (await readCatalog(paths)).anime[1];

  assert.equal(rec.tamilDubVerified, false);
  assert.equal(report.needsReview.length, 1);
});

test("title-only matches are unsafe unless release years prove it", async () => {
  // unknown entry year + existing 2001 record -> review, nothing added
  const unsure = await setup({ entries: [{ title: "Manual Show", tmdbId: 222, tamilDubVerified: true, verification: crunchy() }] });
  const r1 = await exec(unsure);
  assert.equal(r1.added, 0);
  assert.equal(r1.needsReview.length, 1);
  assert.equal((await readCatalog(unsure)).anime.length, 2);

  // same year -> safe merge
  const same = await setup({ entries: [{ title: "Manual Show", year: 2001, tamilDubVerified: true, verification: crunchy("manual-show") }] });
  const r2 = await exec(same);
  assert.equal(r2.added, 0);
  assert.equal(r2.updatedExisting, 1);

  // years 2+ apart -> a different production with the same title
  const remake = await setup({ entries: [{ title: "Manual Show", year: 2019, tamilDubVerified: true, verification: crunchy("manual-show-2019") }] });
  const r3 = await exec(remake);
  assert.equal(r3.added, 1);

  // off by one year -> ambiguous, review
  const near = await setup({ entries: [{ title: "Manual Show", year: 2002, tamilDubVerified: true, verification: crunchy() }] });
  const r4 = await exec(near);
  assert.equal(r4.added, 0);
  assert.equal(r4.needsReview.length, 1);
});

test("tmdb key never matches across tv/movie or bare numbers", () => {
  assert.equal(updater.recordTmdbKey({ id: "tmdb-5" }), "tv:5");
  assert.equal(updater.recordTmdbKey({ id: "tmdb-movie-5" }), "movie:5");
  assert.equal(updater.recordTmdbKey({ tmdbId: 5 }), null);
  assert.equal(updater.recordTmdbKey({ tmdbId: 5, tmdbUrl: "https://www.themoviedb.org/movie/5" }), "movie:5");
});

test("TMDB enriches only verified titles, only missing fields; discovery never adds", async () => {
  const tmdb = {
    333: { id: 333, name: "Enriched Show", original_name: "Enriched Original", overview: "TMDB overview", poster_path: "/p.jpg", backdrop_path: "/b.jpg", vote_average: 8.26, first_air_date: "2015-05-05", status: "Ended", genres: [{ name: "Action" }], seasons: [{ season_number: 1, episode_count: 2 }] },
    444: { id: 444, name: "Totally Different", original_name: "Totally Different", first_air_date: "2015-05-05" },
    111: { id: 111, name: "Legacy Auto", overview: "should never be fetched", first_air_date: "2020-01-01" }
  };

  await withFetch(
    (url) => {
      const match = /\/3\/(tv|movie)\/(\d+)/.exec(url);
      if (url.includes("themoviedb.org") && match && tmdb[match[2]]) return { body: tmdb[match[2]] };
      return { status: 404, body: { status_message: "nope" } };
    },
    async (calls) => {
      const paths = await setup({
        entries: [
          { title: "Enriched Show", tmdbId: 333, description: "Curated manifest text", tamilDubVerified: true, verification: crunchy("enriched") },
          { title: "Wrong Id Show", tmdbId: 444, tamilDubVerified: true, verification: crunchy("wrong") },
          { title: "Missing On Tmdb", tmdbId: 555, tamilDubVerified: true, verification: crunchy("missing") }
        ]
      });

      const report = await exec(paths, { tmdbApiKey: "SECRET_TMDB_KEY" });
      const after = await readCatalog(paths);
      const added = after.anime.find((r) => r.id === "tmdb-333");

      assert.equal(report.added, 1);
      assert.equal(report.needsReview.length, 2);
      assert.equal(added.title, "Enriched Show");
      assert.equal(added.description, "Curated manifest text");
      assert.equal(added.image, "https://image.tmdb.org/t/p/w500/p.jpg");
      assert.equal(added.rating, 8.3);
      assert.equal(added.firstAirDate, "2015-05-05");
      assert.equal(added.availability, "Completed");
      assert.deepEqual(added.tags, ["Anime", "Action"]);
      assert.equal(added.episodes.length, 2);
      assert.equal(added.tmdbUrl, "https://www.themoviedb.org/tv/333");
      assert.ok(!calls.some((u) => u.includes("/tv/111")), "unverified legacy record must not be enriched");
      assert.ok(!JSON.stringify(after).includes("SECRET_TMDB_KEY"));
      assert.equal(after.anime.find((r) => r.id === "tmdb-111").description, "No description available.");
    }
  );
});

test("TMDB outage is non-destructive and still adds the verified title", async () => {
  await withFetch(
    () => ({ status: 500, body: {} }),
    async () => {
      const paths = await setup({ entries: [{ title: "Outage Show", tmdbId: 777, tamilDubVerified: true, verification: crunchy("outage") }] });
      const report = await exec(paths, { tmdbApiKey: "k" });
      const after = await readCatalog(paths);
      assert.equal(report.added, 1);
      assert.equal(after.anime.length, 3);
      assert.equal(after.anime[2].description, "No description available.");
    }
  );
});

test("YouTube evidence needs an allow-listed channel; API confirms, rejects, or defers", async () => {
  const manifest = {
    officialYouTubeChannels: [{ name: "Muse India", channelId: CHANNEL }],
    entries: [{ title: "Muse Show", year: 2012, tamilDubVerified: true, verification: { url: `https://www.youtube.com/watch?v=${VIDEO}`, channelId: CHANNEL } }]
  };

  const asserted = await setup(manifest);
  await exec(asserted);
  const rec = (await readCatalog(asserted)).anime[2];
  assert.equal(rec.tamilDubEvidence[0].channelCheck, "manifest-asserted");
  assert.equal(rec.tamilDubVerificationSource, "Muse India (YouTube)");
  assert.equal(rec.youtube[0].url, `https://www.youtube.com/watch?v=${VIDEO}`);

  await withFetch(() => ({ body: { items: [{ snippet: { channelId: CHANNEL } }] } }), async () => {
    const paths = await setup(manifest);
    await exec(paths, { youtubeApiKey: "SECRET_YT_KEY" });
    assert.equal((await readCatalog(paths)).anime[2].tamilDubEvidence[0].channelCheck, "api-confirmed");
  });

  await withFetch(() => ({ body: { items: [{ snippet: { channelId: OTHER_CHANNEL } }] } }), async () => {
    const paths = await setup(manifest);
    const report = await exec(paths, { youtubeApiKey: "k" });
    assert.equal(report.added, 0);
    assert.equal(report.rejected.length, 1);
  });

  await withFetch(() => ({ status: 503, body: {} }), async () => {
    const paths = await setup(manifest);
    const report = await exec(paths, { youtubeApiKey: "k" });
    assert.equal(report.added, 0);
    assert.equal(report.deferred.length, 1);
  });
});

test("invalid manifest or malformed catalog aborts with the catalog byte-identical", async () => {
  const paths = await setup("{ not json");
  const before = await fsp.readFile(paths.catalogFile, "utf8");
  await assert.rejects(exec(paths), /Manifest is not valid JSON/);
  assert.equal(await fsp.readFile(paths.catalogFile, "utf8"), before);

  const bad = await setup({ entries: [] }, { anime: "oops", keep: 1 });
  const badBefore = await fsp.readFile(bad.catalogFile, "utf8");
  await assert.rejects(exec(bad), /not an array/);
  assert.equal(await fsp.readFile(bad.catalogFile, "utf8"), badBefore);
});

test("a failed rename leaves the original catalog and no temp file behind", async () => {
  const paths = await setup({ entries: [{ title: "Good Show", year: 2010, tamilDubVerified: true, verification: crunchy() }] });
  const before = await fsp.readFile(paths.catalogFile, "utf8");
  const original = fsp.rename;
  fsp.rename = async () => {
    throw new Error("simulated rename failure");
  };

  try {
    await assert.rejects(exec(paths), /simulated rename failure/);
  } finally {
    fsp.rename = original;
  }

  assert.equal(await fsp.readFile(paths.catalogFile, "utf8"), before);
  assert.deepEqual(fsApi(paths.dir), ["anime.json", "manifest.json"]);
});

function fsApi(dir) {
  return fsSync.readdirSync(dir).sort();
}

test("duplicate manifest entries and repeat runs never create duplicate records", async () => {
  const entry = { title: "Twice Listed", year: 2008, tamilDubVerified: true, verification: crunchy("twice") };
  const paths = await setup({ entries: [entry, { ...entry, verification: [crunchy("twice"), { url: "https://www.netflix.com/title/80000001" }] }] });

  const first = await exec(paths);
  const afterFirst = await readCatalog(paths);
  assert.equal(first.added, 1);
  assert.equal(afterFirst.anime.length, 3);
  assert.equal(afterFirst.anime[2].tamilDubEvidence.length, 2); // second entry only added evidence

  const second = await exec(paths);
  assert.equal(second.added, 0);
  assert.equal(second.updatedExisting, 0);
  assert.equal(second.status, "zero-add");
  assert.match(second.zeroAddReason, /already in the catalog/);
  assert.deepEqual((await readCatalog(paths)).anime, afterFirst.anime);
});

test("movies get their own ID space and Tamil-script titles get a stable hashed ID", async () => {
  const paths = await setup({
    entries: [
      { title: "A Film", tmdbId: 111, mediaType: "movie", tamilDubVerified: true, verification: crunchy("film") },
      { title: "தமிழ் தலைப்பு", year: 1999, tamilDubVerified: true, verification: crunchy("tamil-title") }
    ]
  });

  const report = await exec(paths);
  const after = await readCatalog(paths);

  assert.equal(report.added, 2); // movie 111 must not match the existing tv "tmdb-111"
  assert.equal(after.anime[2].id, "tmdb-movie-111");
  assert.match(after.anime[3].id, /^official-[0-9a-f]{12}-1999$/);
  assert.equal(after.anime[1].tamilDubVerified, false);
});

test("an officially verified record outside the manifest is enriched; an unofficial one is not", async () => {
  const catalog = baseCatalog();
  Object.assign(catalog.anime[1], {
    tamilDubVerified: true,
    tamilDubVerificationSource: "Crunchyroll official listing/announcement",
    tamilDubVerificationUrl: "https://www.crunchyroll.com/series/GRABC123/legacy-auto"
  });
  catalog.anime[0].tmdbId = 999; // manual record: verified, but only by a free-text note

  await withFetch(
    () => ({ body: { id: 111, name: "Legacy Auto", overview: "Filled overview", poster_path: "/x.jpg", vote_average: 7, first_air_date: "2020-01-01", status: "Returning Series", genres: [{ name: "Drama" }], seasons: [] } }),
    async (calls) => {
      const paths = await setup({ entries: [] }, catalog);
      const report = await exec(paths, { tmdbApiKey: "k" });
      const rec = (await readCatalog(paths)).anime[1];

      assert.equal(report.updatedExisting, 1);
      assert.equal(rec.description, "Filled overview");
      assert.equal(rec.availability, "Ongoing"); // missing metadata derived from TMDB status
      assert.equal(rec.image, "https://image.tmdb.org/t/p/w500/x.jpg");
      assert.equal(calls.length, 1);
    }
  );
});

test("API keys are redacted from logs and never written to the catalog", async () => {
  const logs = [];
  const originals = { log: console.log, warn: console.warn };
  console.log = (...a) => logs.push(a.join(" "));
  console.warn = (...a) => logs.push(a.join(" "));

  try {
    await withFetch(
      () => ({ status: 401, body: { status_message: "Invalid API key: SECRET_TMDB_KEY" } }),
      async () => {
        const paths = await setup({ entries: [{ title: "Keyed", tmdbId: 5, tamilDubVerified: true, verification: crunchy("keyed") }] });
        await exec(paths, { tmdbApiKey: "SECRET_TMDB_KEY" });
        assert.ok(!(await fsp.readFile(paths.catalogFile, "utf8")).includes("SECRET_TMDB_KEY"));
      }
    );
  } finally {
    Object.assign(console, originals);
  }

  assert.ok(logs.some((line) => line.includes("TMDB tv/5 lookup failed")));
  assert.ok(!logs.join("\n").includes("SECRET_TMDB_KEY"));
});

test("a catalog edited on disk mid-scan aborts instead of being overwritten", async () => {
  const paths = await setup({ entries: [{ title: "Racy", tmdbId: 6, tamilDubVerified: true, verification: crunchy("racy") }] });

  await withFetch(
    async () => {
      const edited = baseCatalog();
      edited.anime.push({ id: "someone-elses-edit", title: "Added by a human meanwhile" });
      await fsp.writeFile(paths.catalogFile, JSON.stringify(edited));
      return { body: { id: 6, name: "Racy" } };
    },
    async () => {
      await assert.rejects(exec(paths, { tmdbApiKey: "k" }), /changed on disk/);
      assert.ok((await fsp.readFile(paths.catalogFile, "utf8")).includes("someone-elses-edit"));
      assert.deepEqual(fsApi(paths.dir), ["anime.json", "manifest.json"]);
    }
  );
});

test("CLI: zero-add exits 0 by default, exits 3 with FAIL_ON_ZERO_ADD, and keeps file mode", async () => {
  const { spawnSync } = require("child_process");
  const cwd = await fsp.mkdtemp(path.join(os.tmpdir(), "cli-"));
  await fsp.mkdir(path.join(cwd, "data"));
  const file = path.join(cwd, "data", "anime.json");
  await fsp.writeFile(file, JSON.stringify(baseCatalog()));
  await fsp.chmod(file, 0o600);

  const env = { ...process.env, TMDB_API_KEY: "", YOUTUBE_API_KEY: "" };
  delete env.FAIL_ON_ZERO_ADD;
  const script = path.join(__dirname, "update-anime.js");

  const plain = spawnSync(process.execPath, [script], { cwd, env, encoding: "utf8" });
  assert.equal(plain.status, 0);
  assert.match(plain.stdout, /SCAN RESULT: ZERO-ADD/);
  assert.equal(fsSync.statSync(file).mode & 0o777, 0o600);

  const strict = spawnSync(process.execPath, [script], { cwd, env: { ...env, FAIL_ON_ZERO_ADD: "true" }, encoding: "utf8" });
  assert.equal(strict.status, 3);

  await fsp.writeFile(file, "{ broken");
  const broken = spawnSync(process.execPath, [script], { cwd, env, encoding: "utf8" });
  assert.equal(broken.status, 1);
  assert.equal(await fsp.readFile(file, "utf8"), "{ broken");
});
