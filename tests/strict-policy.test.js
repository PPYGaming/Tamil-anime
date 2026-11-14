'use strict';
// STRICT CONFIRMED-ONLY POLICY tests.
// Policy: a title is public only with official evidence of a Tamil dub
// (Crunchyroll announcement, Crunchyroll series/episode page listing Tamil
// audio, or an official-channel YouTube upload). Third-party-reported titles
// (AniDub rows, free-site listings) are internal discovery leads and must
// never enter the public catalog. Evidence is season-scoped: proof of one
// season never promotes another season.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const data = require('../data/anime.json');
const { validateEntry } = require('../scripts/update-anime.js');

const SEASON_RECORD = /season\s*\d+|s\d+\b|part\s*\d+|final season|\d+(st|nd|rd|th)\s+season/i;

test('every public record carries official Tamil proof with source, quote and scope', () => {
  assert.ok(data.anime.length >= 100, 'strict confirmed catalog must keep the verified set');
  for (const r of data.anime) {
    const row = (r.platforms || []).find(p => p && p.tamilDubVerified === true);
    assert.ok(row, `no verified platform row: ${r.id}`);
    assert.ok(/^https:\/\//.test(row.tamilDubVerificationUrl || ''), `verified row without evidence URL: ${r.id}`);
    assert.ok(/^https:\/\//.test(r.tamilDubVerificationUrl || ''), `record without verification URL: ${r.id}`);
    assert.ok(typeof r.tamilDubVerificationSource === 'string' && r.tamilDubVerificationSource, `record without evidence source: ${r.id}`);
    assert.ok(typeof r.tamilDubEvidenceQuote === 'string' && r.tamilDubEvidenceQuote.length > 10, `record without evidence quote: ${r.id}`);
    assert.ok(typeof r.tamilDubEvidenceScope === 'string' && r.tamilDubEvidenceScope.length >= 3, `record without evidence scope: ${r.id}`);
  }
});

test('season-numbered records have season-specific proof, never series-level inference', () => {
  for (const r of data.anime) {
    if (!SEASON_RECORD.test(r.title)) continue;
    assert.ok(r.tamilDubEvidenceScope && !/^series-level/i.test(r.tamilDubEvidenceScope),
      `season record backed only by series-level proof: ${r.id} (${r.title})`);
  }
});

test('no public record is third-party-reported-only', () => {
  for (const r of data.anime) {
    const verified = (r.platforms || []).some(p => p && p.tamilDubVerified === true);
    const onlyReported = !verified && (r.platforms || []).some(p => p && p.tamilDubReported === true);
    assert.ok(!onlyReported, `reported-only record is public: ${r.id}`);
    assert.notStrictEqual(r.inclusionSource, 'anidub-india-unverified', r.id);
  }
});

test('automation never runs reported-title promotion steps', () => {
  const dir = path.join(__dirname, '..', '.github', 'workflows');
  for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.yml') || f.endsWith('.yaml'))) {
    const yml = fs.readFileSync(path.join(dir, f), 'utf8');
    assert.ok(!/add-reported\.js/.test(yml), `${f} still runs add-reported.js`);
    assert.ok(!/attach-anidub\.js/.test(yml), `${f} still runs attach-anidub.js (promotes AniDub rows into the public catalog)`);
  }
});

test('manifest entries all carry official verification (no stale tier promotions)', () => {
  const manifest = require('../data/official-tamil-dub-manifest.json');
  for (const e of manifest.entries) {
    assert.strictEqual(e.tamilDubVerified, true, `manifest entry not verified: ${e.id}`);
    const list = Array.isArray(e.verification) ? e.verification : [e.verification];
    assert.ok(list.some(v => /^https:\/\//.test(v?.url || '')), `manifest entry without verification URL: ${e.id}`);
  }
});

test('writer rejects entries without official verification', () => {
  const base = { title: 'Imaginary Show Season 9', tamilDubVerified: true, mediaType: 'tv' };
  assert.strictEqual(validateEntry({ ...base }, []).ok, false, 'no verification must reject');
  assert.strictEqual(validateEntry({ ...base, verification: { url: 'https://random-blog.example.com/rumour' } }, []).ok, false,
    'non-official source must reject');
  assert.strictEqual(validateEntry({ title: 'Imaginary Show', mediaType: 'tv', platforms: [{ name: 'Crunchyroll', available: true, tamilDubVerified: true, officialUrl: 'https://www.crunchyroll.com/series/GXXXX/imaginary' }], verification: { url: 'https://www.crunchyroll.com/news/x' } }, []).ok, false,
    'tamilDubVerified only on a platforms row (no top-level true) must reject');
  assert.strictEqual(validateEntry({ ...base, tamilDubVerified: false, verification: { url: 'https://www.crunchyroll.com/news/announcements/2024/1/1/x' } }, []).ok, false,
    'explicitly unverified entry must reject even with a URL');
});

test('writer never merges an unverified season onto a verified Tamil series', () => {
  // A Season 2 entry for a series whose Season 1 is verified still needs its own
  // season-specific official evidence; without it the writer must reject it.
  const s2 = { title: 'Imaginary Tamil Show Season 2', tamilDubVerified: true, mediaType: 'tv', tmdbId: 12345, tmdbSeason: 2 };
  assert.strictEqual(validateEntry(s2, []).ok, false, 'unverified season must not enter via the writer');
});
