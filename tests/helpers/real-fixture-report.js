"use strict";

// Prints the real-fixture sandbox outcome: before/after counts, appended ids, and deep-equality of the 25
// original records, for a no-key run and a second run. Not a test; run it by hand:
//
//   node tests/helpers/real-fixture-report.js                      # the revised updater
//   UPDATER_PATH=/path/to/old/update-anime.js node tests/helpers/real-fixture-report.js   # a control run
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { FIXTURE_MANIFEST, FIXTURE_CATALOG, runUpdater, rerun, withNoNetwork, clone } = require("./harness");

const MISSING = ["verified-jujutsu-kaisen-season-2", "verified-spy-x-family-season-2"];

function deepEquals(a, b) {
  try {
    assert.deepStrictEqual(a, b);
    return true;
  } catch {
    return false;
  }
}

(async () => {
  for (const file of [FIXTURE_MANIFEST, FIXTURE_CATALOG]) {
    if (!fs.existsSync(file)) {
      console.log(`FIXTURE MISSING: ${file}`);
      process.exitCode = 1;
      return;
    }
  }

  const manifest = JSON.parse(fs.readFileSync(FIXTURE_MANIFEST, "utf8"));
  const catalog = JSON.parse(fs.readFileSync(FIXTURE_CATALOG, "utf8"));
  const originals = clone(catalog.anime);

  let firstCalls = [];
  let secondCalls = [];
  const first = await withNoNetwork((calls) => {
    firstCalls = calls;
    return runUpdater({ catalog: clone(catalog), manifest });
  });
  const second = await withNoNetwork((calls) => {
    secondCalls = calls;
    return rerun(first, manifest);
  });

  const describeRun = (label, run, calls) => {
    const after = run.catalog.anime;
    const sameIds = originals.filter((original, index) => after[index] && after[index].id === original.id).length;
    const deepEqual = originals.filter((original, index) => after[index] && deepEquals(after[index], original)).length;
    const byteEqual = originals.filter((original, index) => after[index] && JSON.stringify(after[index]) === JSON.stringify(original)).length;

    console.log(`${label}`);
    console.log(`  manifest entries          : ${manifest.entries.length}`);
    console.log(`  catalog records before    : ${label.startsWith("RUN 1") ? originals.length : first.catalog.anime.length}`);
    console.log(`  catalog records after     : ${after.length}`);
    console.log(`  report.added              : ${run.report.added}`);
    console.log(`  report.addedIds           : ${JSON.stringify(run.report.addedIds)}`);
    console.log(`  report.alreadyInCatalog   : ${run.report.alreadyInCatalog}`);
    console.log(`  report.updatedExisting    : ${run.report.updatedExisting}`);
    console.log(`  report.needsReview/rejected: ${run.report.needsReview.length} / ${run.report.rejected.length}`);
    console.log(`  report.status             : ${run.report.status}`);
    console.log(`  original 25: same id+position ${sameIds}/25 | deepStrictEqual ${deepEqual}/25 | byte-identical JSON (key order too) ${byteEqual}/25`);
    for (const id of MISSING) console.log(`  ${id}: present ${after.filter((item) => item.id === id).length}x`);
    console.log(`  network calls attempted   : ${calls.length}`);
    console.log(`  tmdb note                 : ${run.report.tmdb.note}`);
  };

  describeRun("RUN 1 (no API keys, fresh copy of the 25-record catalog)", first, firstCalls);
  console.log("");
  describeRun("RUN 2 (same manifest, on RUN 1's output)", second, secondCalls);
  console.log("");
  console.log(`  RUN 2 anime[] deepStrictEqual RUN 1 anime[]: ${deepEquals(second.catalog.anime, first.catalog.anime)}`);
  console.log(`  manifest file untouched by both runs     : ${first.manifestUntouched && second.manifestUntouched}`);
  console.log(`  legacy season-1 records stamped with tmdbSeason: ${first.catalog.anime.filter((item) => item.tmdbSeason !== undefined && !MISSING.includes(item.id)).length} (expected 0)`);
})();
