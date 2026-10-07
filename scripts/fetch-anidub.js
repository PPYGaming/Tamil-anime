'use strict';
// Read-only public directory snapshot. No credentials or write endpoints are used.
const fs = require('node:fs');
const path = require('node:path');
const ROOT = 'https://kuskakuruma.github.io/anidub-india/';
async function fetchSnapshot({ fetchImpl = fetch, now = () => new Date() } = {}) {
  const get = async (url, headers = {}) => {
    const r = await fetchImpl(url, { headers, signal: AbortSignal.timeout(30000) });
    if (!r.ok) throw new Error(`Directory HTTP ${r.status}`);
    return r;
  };
  const config = await (await get(ROOT + 'supabase-config.js')).text();
  const base = config.match(/SUPABASE_URL\s*=\s*['"](https:\/\/[^'"]+)['"]/)?.[1];
  const key = config.match(/SUPABASE_ANON_KEY\s*=\s*['"]([^'"]+)['"]/)?.[1];
  if (!base || !/^https:\/\/[a-z0-9]+\.supabase\.co$/.test(base) || !key) throw new Error('Directory configuration unavailable');
  const headers = { apikey: key };
  const read = async (table, suffix = '') => {
    const rows = []; let offset = 0;
    for (let page = 0; page < 20; page++) {
      const url = `${base}/rest/v1/${table}?select=*&order=id.asc&limit=500&offset=${offset}${suffix}`;
      const data = await (await get(url, headers)).json();
      if (!Array.isArray(data)) throw new Error('Invalid directory response');
      rows.push(...data); if (data.length < 500) return rows;
      offset += 500;
    }
    throw new Error('Directory pagination limit reached');
  };
  const anime = await read('anime');
  const seasons = await read('seasons');
  const dubs = await read('dubs', '&language=eq.Tamil');
  if (!anime.length || !seasons.length || !dubs.length) throw new Error('Empty directory snapshot');
  return { checkedAt: now().toISOString(), anime, seasons, dubs };
}
async function run(o = {}) {
  try {
    const snapshot = await fetchSnapshot(o);
    const file = o.snapshotFile || path.join(__dirname, '..', 'data', 'anidub-snapshot.json');
    fs.writeFileSync(file + '.tmp', JSON.stringify(snapshot, null, 2) + '\n');
    fs.renameSync(file + '.tmp', file);
    console.log(`AniDub snapshot: ${new Set(snapshot.dubs.map(r => r.anime_id)).size} Tamil titles`);
    return snapshot;
  } catch (e) { console.warn(`AniDub snapshot skipped: ${e.message}`); return null; }
}
module.exports = { fetchSnapshot, run };
if (require.main === module) run();
