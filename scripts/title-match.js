'use strict';

// Swap in your existing normalizer if it does the same thing (lowercase, strip diacritics/punctuation).
function norm(v) {
  if (typeof v !== 'string') return '';
  return v
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

// Language/dub decoration only. Season, part, cour and arc text is NEVER stripped here.
const DECOR_TAIL = /(?: in)? (?:tamil|dubbed|dub)(?: (?:tamil|dubbed|dub|language|audio))*$/;
// Trailing season-ish marker run, e.g. "season 3", "season 3 cour 2", "2nd season", "final season".
const SEASON_TAIL = /(?: (?:(?:season|part|cour) \d{1,2}|\d{1,2}(?:st|nd|rd|th) season|final season))+$/;

function parseTitle(value) {
  const full = norm(value).replace(DECOR_TAIL, '').trim();
  const m = SEASON_TAIL.exec(full);
  const base = m ? full.slice(0, m.index).trim() : full;
  if (!m || !base) return { full, base: full, marker: '' };
  return { full, base, marker: m[0].trim() };
}

const NONE = Object.freeze({ match: 'none', setsAvailable: false, reason: 'no-match' });
const RANK = { none: 0, series: 1, exact: 2 };

function compare(site, rec) {
  if (site.full === rec.full) {
    return { match: 'exact', setsAvailable: true, reason: rec.marker ? 'exact-season-title' : 'exact-title' };

  }
  if (site.base !== rec.base) return NONE; // arcs/subtitles land here: exact only
  if (site.marker && rec.marker) return { ...NONE, reason: 'season-mismatch' }; // S1 vs S2, Cour 1 vs Cour 2
  if (site.marker && !rec.marker) {
    // "X Season 2" listed, catalog has aggregate "X": series is available, not every season
    return { match: 'series', setsAvailable: true, reason: 'season-listing-implies-series' };
  }
  // generic "X" listed, catalog record is a specific season: proves nothing about that season
  return { match: 'series', setsAvailable: false, reason: 'generic-listing-no-season-claim' };
}

/**
 * Pure. Returns { match: 'exact' | 'series' | 'none', setsAvailable, reason }.
 * Only setsAvailable === true may flip the record's own free-site availability.
 */
function matchTitle(siteTitle, record) {
  const site = parseTitle(siteTitle);
  if (!site.full || !record || /eng(?:lish)? sub|subbed/i.test(siteTitle)) return NONE;
  let best = NONE;
  for (const key of [record.title, ...(parseTitle(record.title).marker ? [] : [record.originalTitle])]) {
    const rec = parseTitle(key);
    if (!rec.full) continue;
    const r = compare(site, rec);
    if (RANK[r.match] > RANK[best.match]) best = r;
  }
  return best;
}

/**
 * Pure. Exact-season hits win; series-level hits are used only when no exact hit exists.
 * Returns { level, records } with only the records allowed to be marked available.
 */

function resolveListing(siteTitle, records) {
  const hits = [];
  for (const r of records) {
    const m = matchTitle(siteTitle, r);
    if (m.match !== 'none') hits.push({ r, m });
  }
  const exact = hits.filter((h) => h.m.match === 'exact');
  const pool = exact.length ? exact : hits;
  return {
    level: exact.length ? 'exact' : hits.length ? 'series' : 'none',
    records: pool.filter((h) => h.m.setsAvailable).map((h) => h.r),
  };
}

module.exports = { matchTitle, resolveListing, parseTitle, norm };
