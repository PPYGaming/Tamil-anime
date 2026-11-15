'use strict';
// Regression: every NEW record the writer creates (manifest or YouTube discovery) must carry a
// record-level evidence quote and scope. The 2026-11-15 scheduled run created SPY x FAMILY Season 3
// (tmdb-120089-s3) from the official-channel scan without them and the strict gate blocked the commit.
const test = require('node:test'), assert = require('node:assert/strict');
const { validateEntry, buildManifestPatch, mergeRecord } = require('../scripts/update-anime.js');

const CHANNEL_ID = 'UCabc123official';
const channels = new Map([[CHANNEL_ID, { name: 'Muse Asia' }]]);

const discoverySeasonEntry = {
  origin: 'discovery',
  inclusionSource: 'youtube-official-channel-discovery',
  title: 'Imaginary Anime Season 3',
  mediaType: 'tv',
  tmdbId: 120089,
  tmdbSeason: 3,
  tamilDubVerified: true,
  verification: [{
    url: 'https://www.youtube.com/watch?v=abc123xyz99',
    channelId: CHANNEL_ID,
    checkedAt: '2026-11-15',
    note: 'Official channel video; its title begins with "Tamil Dub" (YouTube channel and ownership confirmed through the API).'
  }]
};

const manifestSeriesEntry = {
  id: 'verified-imaginary-movie',
  title: 'Imaginary Movie',
  mediaType: 'movie',
  tmdbId: 555001,
  tamilDubVerified: true,
  verification: {
    url: 'https://www.crunchyroll.com/news/announcements/2026/1/1/imaginary-movie-tamil-dub',
    checkedAt: '2026-11-15',
    note: 'Official Crunchyroll article confirms the Tamil dub of Imaginary Movie.'
  },
  platforms: [{ name: 'Crunchyroll', available: true, officialUrl: 'https://www.crunchyroll.com/series/GXYZ/imaginary' }]
};

test('discovery season entry creates a record with quote and season scope', () => {
  const v = validateEntry(discoverySeasonEntry, channels, { discovery: true });
  assert.ok(v.ok, v.reason);
  const patch = buildManifestPatch(v.entry, 'IN');
  assert.ok(patch.tamilDubEvidenceQuote.length > 10, 'quote must come from the official-video evidence note');
  assert.strictEqual(patch.tamilDubEvidenceScope, 'Season 3');
  const record = {};
  mergeRecord(record, patch);
  // merge alone must NOT stamp proof text; the writer's creation path copies it from the patch.
  assert.strictEqual(record.tamilDubEvidenceQuote, undefined);
  record.tamilDubEvidenceQuote = patch.tamilDubEvidenceQuote;
  record.tamilDubEvidenceScope = patch.tamilDubEvidenceScope;
  assert.ok(record.tamilDubEvidenceQuote.length > 10);
  assert.strictEqual(record.tamilDubEvidenceScope, 'Season 3');
});

test('manifest series entry creates a record with quote and series-level scope', () => {
  const v = validateEntry(manifestSeriesEntry, channels);
  assert.ok(v.ok, v.reason);
  const patch = buildManifestPatch(v.entry, 'IN');
  assert.ok(patch.tamilDubEvidenceQuote.length > 10, 'quote must come from the verification note');
  assert.strictEqual(patch.tamilDubEvidenceScope, 'Series-level');
});

test('merging into an existing record never rewrites its quote or scope (byte-stable curated records)', () => {
  const v = validateEntry(discoverySeasonEntry, channels, { discovery: true });
  const patch = buildManifestPatch(v.entry, 'IN');
  const legacy = { title: 'Old Record', tamilDubVerified: true };
  mergeRecord(legacy, patch);
  assert.strictEqual(legacy.tamilDubEvidenceQuote, undefined);
  assert.strictEqual(legacy.tamilDubEvidenceScope, undefined);
  const curated = { tamilDubEvidenceQuote: 'Hand-checked quote from the official page', tamilDubEvidenceScope: 'Season 1' };
  mergeRecord(curated, patch);
  assert.strictEqual(curated.tamilDubEvidenceQuote, 'Hand-checked quote from the official page');
  assert.strictEqual(curated.tamilDubEvidenceScope, 'Season 1');
});
