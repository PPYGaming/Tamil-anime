'use strict';
// Evidence-gate semantics for auto-discovered seasons (2026-11-15 SPY x FAMILY S3 incident):
// an official upload promotes a NEW season only when the upload title itself carries the season.
// Series-level Tamil proof must never promote another season; ambiguous identity is held for review.
const test = require('node:test'), assert = require('node:assert/strict');
const { createSeriesResolver } = require('../scripts/discovery/resolve.js');
const { normalizeTitle, recordTmdbKey } = require('../scripts/update-anime.js');

const helpers = { normalizeTitle, recordTmdbKey };

// Catalog knows SPY x FAMILY with S1 verified (series has 3 regular seasons on TMDB).
const catalog = [{
  id: 'tmdb-120089-s1', title: 'SPY x FAMILY Season 1', mediaType: 'tv', tmdbId: 120089, tmdbSeason: 1,
  aliases: ['SPY x FAMILY'], tamilDubVerified: true
}];

const tmdbDetails3Seasons = {
  seasons: [
    { season_number: 1, episode_count: 12 },
    { season_number: 2, episode_count: 13 },
    { season_number: 3, episode_count: 13 }
  ],
  status: 'Returning Series', first_air_date: '2022-04-09', original_name: 'SPY×FAMILY'
};

const tmdb = {
  enabled: true,
  details: async () => ({ status: 'ok', details: tmdbDetails3Seasons }),
  search: async () => ({ status: 'ok', results: [] })
};

test('explicit season in the official upload title resolves that season (allowed)', async () => {
  const resolver = createSeriesResolver({ anime: catalog, tmdb, helpers });
  const out = await resolver.resolve({ nameCandidates: ['SPY x FAMILY'], season: 3, episode: 1, yearHint: null });
  assert.strictEqual(out.status, 'resolved');
  assert.strictEqual(out.season, 3);
  assert.strictEqual(out.seasonSource, 'explicit-in-title');
});

test('generic series title with no season is held when the series has several seasons (blocked)', async () => {
  const resolver = createSeriesResolver({ anime: catalog, tmdb, helpers });
  const out = await resolver.resolve({ nameCandidates: ['SPY x FAMILY'], season: null, episode: 1, yearHint: null });
  assert.strictEqual(out.status, 'review');
  assert.match(out.reason, /not guessed/);
});

test('a season the title claims but TMDB does not list is held (ambiguity never promotes)', async () => {
  const resolver = createSeriesResolver({ anime: catalog, tmdb, helpers });
  const out = await resolver.resolve({ nameCandidates: ['SPY x FAMILY'], season: 7, episode: 1, yearHint: null });
  assert.strictEqual(out.status, 'review');
  assert.match(out.reason, /TMDB lists no season 7/);
});

test('writer scope follows the entry season, never invents one: series-level entries stay Series-level', () => {
  const { validateEntry, buildManifestPatch } = require('../scripts/update-anime.js');
  const channels = new Map([['UCabc123official', { name: 'Muse Asia' }]]);
  const seriesLevel = {
    origin: 'discovery', title: 'One Season Show', mediaType: 'tv', tmdbId: 777001,
    tamilDubVerified: true,
    verification: [{ url: 'https://www.youtube.com/watch?v=qqqqqqqqqq1', channelId: 'UCabc123official', checkedAt: '2026-11-15', quote: '[Tamil Dub] One Season Show - Episode 1 | Official' }]
  };
  const v = validateEntry(seriesLevel, channels, { discovery: true });
  assert.ok(v.ok, v.reason);
  const patch = buildManifestPatch(v.entry, 'IN');
  assert.strictEqual(patch.tamilDubEvidenceScope, 'Series-level');
  assert.match(patch.tamilDubEvidenceQuote, /Tamil Dub/);
});
