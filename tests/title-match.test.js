'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { matchTitle, resolveListing } = require('../scripts/title-match');

const R = (id, title, extra = {}) => ({ id, title, originalTitle: title, ...extra });

test('exact season title matches through Tamil/dub decoration', () => {
  const rec = R('s2', 'Jujutsu Kaisen Season 2');
  for (const site of ['Jujutsu Kaisen Season 2 (Tamil)', 'jujutsu kaisen: season 2 - Tamil Dub', 'Jujutsu Kaisen Season 2']) {
    const m = matchTitle(site, rec);
    assert.equal(m.match, 'exact', site);
    assert.equal(m.setsAvailable, true, site);
  }
});

test('generic series listing never claims a specific season', () => {
  const m = matchTitle('Jujutsu Kaisen', R('s2', 'Jujutsu Kaisen Season 2'));
  assert.equal(m.match, 'series');
  assert.equal(m.setsAvailable, false);
  assert.equal(m.reason, 'generic-listing-no-season-claim');
});

test('Season 1 never matches Season 2; cour and part must match exactly', () => {
  assert.equal(matchTitle('Jujutsu Kaisen Season 1 (Tamil)', R('s2', 'Jujutsu Kaisen Season 2')).match, 'none');
  assert.equal(matchTitle('Jujutsu Kaisen Season 2', R('s1', 'Jujutsu Kaisen Season 1')).match, 'none');
  const cour2 = R('c2', 'Fire Force Season 3 Cour 2');
  assert.equal(matchTitle('Fire Force Season 3 Cour 1', cour2).match, 'none');
  assert.equal(matchTitle('Fire Force Season 3', cour2).match, 'none');
  assert.equal(matchTitle('Fire Force Season 3 Part 2', cour2).match, 'none');
  assert.equal(matchTitle('Fire Force Season 3 Cour 2 (Tamil Dub)', cour2).match, 'exact');

});

test('aggregate series record: a season listing implies the series, not every season', () => {
  const m = matchTitle('Fire Force Season 3 (Tamil Dub)', R('agg', 'Fire Force'));
  assert.equal(m.match, 'series');
  assert.equal(m.setsAvailable, true);
  assert.equal(m.reason, 'season-listing-implies-series');
});

test('arc and subtitle titles require exact matching', () => {
  const arc = R('arc', 'Demon Slayer: Entertainment District Arc');
  assert.equal(matchTitle('Demon Slayer', arc).match, 'none');
  assert.equal(matchTitle('Demon Slayer Entertainment District Arc (Tamil)', arc).match, 'exact');
  assert.equal(matchTitle('Demon Slayer: Entertainment District Arc', R('agg', 'Demon Slayer')).match, 'none');
});

test('resolveListing prefers the exact season and never fans out to sibling seasons', () => {
  const agg = R('agg', 'Jujutsu Kaisen');
  const [s1, s2, s3] = [1, 2, 3].map((n) => R(`s${n}`, `Jujutsu Kaisen Season ${n}`));
  const all = [agg, s1, s2, s3];

  const exact = resolveListing('Jujutsu Kaisen Season 2 (Tamil)', all);
  assert.equal(exact.level, 'exact');
  assert.deepEqual(exact.records.map((r) => r.id), ['s2']);

  const seriesOnly = resolveListing('Jujutsu Kaisen Season 2 (Tamil)', [agg, s1, s3]);
  assert.equal(seriesOnly.level, 'series');
  assert.deepEqual(seriesOnly.records.map((r) => r.id), ['agg']);

  const generic = resolveListing('Jujutsu Kaisen', [s1, s2, s3]);
  assert.equal(generic.level, 'series');
  assert.deepEqual(generic.records, []);

});test('generic originalTitle cannot override a season-specific title',()=>{assert.equal(matchTitle('Example',{title:'Example Season 2',originalTitle:'Example'}).setsAvailable,false);});
test('explicit English-sub listing never proves Tamil',()=>assert.equal(matchTitle('Example (Eng Sub)',R('x','Example')).setsAvailable,false));
