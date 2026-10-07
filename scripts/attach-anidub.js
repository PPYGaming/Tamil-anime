'use strict';
const fs=require('node:fs'),path=require('node:path');
const ROOT='https://kuskakuruma.github.io/anidub-india/anime.html?id=';
const ALLOWED=new Set(['Crunchyroll','Netflix','Amazon Prime Video','JioHotstar','Sony LIV','Muse Asia']);
const normalize=t=>String(t||'').normalize('NFKD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();
const clone=x=>JSON.parse(JSON.stringify(x));
function isLocalOrIp(host) {
  return (
    !host.includes('.') ||
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.startsWith('[') ||
    /^\d+\.\d+\.\d+\.\d+$/.test(host)
  );
}

/** Only plain https URLs on a real hostname; otherwise null. */
function safePosterUrl(v) {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  if (!s || s.length > 2048 || /[\s\u0000-\u001f<>"'\\]/.test(s)) return null;
  let u;
  try {
    u = new URL(s);
  } catch {

    return null;
  }
  if (u.protocol !== 'https:' || u.username || u.password || u.port) return null;
  if (isLocalOrIp(u.hostname)) return null;
  return u.href;
}

const safe=safePosterUrl;
const POSTERS=JSON.parse(fs.readFileSync(path.join(__dirname,'..','data','poster-overrides.json'),'utf8')).records;
function applyPosters(records){for(const record of records){const p=POSTERS[record.id];if(p&&safe(p.image)){record.image=p.image;record.posterSourceUrl=p.sourceUrl;record.posterSourceTitle=p.sourceTitle;}}}
function applySnapshot(catalog,snapshot,{now=new Date(),identities={entries:{}}}={}){
 const result={catalog:clone(catalog),added:[],updated:[],skipped:[]};
 const ts=Date.parse(snapshot?.checkedAt),n=+new Date(typeof now==='function'?now():now);
 if(!Array.isArray(catalog?.anime)||!Array.isArray(snapshot?.anime)||!Array.isArray(snapshot?.seasons)||!Array.isArray(snapshot?.dubs)||!snapshot.dubs.length||!Number.isFinite(ts)||ts>n||n-ts>14*864e5){result.skipped.push('invalid-or-stale-snapshot');return result;}
 const anime=new Map(),seasons=new Map();
 for(const a of snapshot.anime){if(!Number.isInteger(a.id)||a.id<=0||!a.title||anime.has(a.id)){result.skipped.push('invalid-anime-identities');return result;}anime.set(a.id,a);}
 for(const s of snapshot.seasons){if(!Number.isInteger(s.id)||!anime.has(s.anime_id)||!s.season_name||seasons.has(s.id)){result.skipped.push('invalid-season-identities');return result;}seasons.set(s.id,s);}
 const rows=snapshot.dubs.filter(r=>r.language==='Tamil'&&ALLOWED.has(r.platform)&&anime.has(r.anime_id)&&seasons.get(r.season_id)?.anime_id===r.anime_id);
 if(!rows.length){result.skipped.push('no-valid-Tamil-rows');return result;}
 const records=result.catalog.anime;
 const confirm=(r,id)=>Object.assign(r,{tamilDubConfirmed:true,tamilDubConfirmationSource:'AniDub India',tamilDubConfirmationUrl:ROOT+id,tamilDubConfirmedAt:snapshot.checkedAt.slice(0,10)});
 const make=(a,ss)=>{
 const seasonal=ss.length===1, s=seasonal?seasons.get(ss[0]):null;
 const title=s?`${a.title} ${s.season_name}`:a.title;
 const id=s?`anidub-${a.id}-season-${s.id}`:`anidub-${a.id}`;
 return {id,title,originalTitle:a.japanese_title||'',description:a.synopsis||'',image:seasonal?'':safe(a.poster_url)||'',backdrop:'',rating:null,likes:null,availability:'Available',status:a.status||'',year:seasonal?null:a.year,firstAirDate:!seasonal&&a.year?`${a.year}-01-01`:'',createdAt:snapshot.checkedAt,updatedAt:snapshot.checkedAt,isNew:false,tags:['Anime'],mediaType:a.type==='Movie'?'movie':'tv',platforms:['Crunchyroll','Netflix','Amazon Prime Video'].map(name=>({name,available:false,officialUrl:null,tamilDubVerified:false})),episodes:[],youtube:[],tamilDubVerified:false,inclusionSource:'anidub-india',anidubId:a.id,anidubSeasonIds:ss};
 };
 const update=(record,a,ids)=>{
 const relevant=rows.filter(r=>r.anime_id===a.id&&ids.includes(r.season_id));if(!relevant.length)return;
 const before=JSON.stringify(record);record.anidubId=a.id;record.anidubSeasonIds=ids;confirm(record,a.id);
 record.platforms=Array.isArray(record.platforms)?record.platforms:[];
 record.seasonDetails=Array.isArray(record.seasonDetails)?record.seasonDetails:[];
 for(const r of relevant){let p=record.platforms.find(p=>p.name===r.platform);if(!p){p={name:r.platform,available:true,officialUrl:null,tamilDubVerified:false};record.platforms.push(p);}p.available=true;confirm(p,a.id);
 const label=seasons.get(r.season_id).season_name;let s=record.seasonDetails.find(s=>s.label===label);if(!s){s={label,rows:[]};record.seasonDetails.push(s);}s.rows=Array.isArray(s.rows)?s.rows:[];let sr=s.rows.find(p=>p.platform===r.platform);if(!sr){sr={platform:r.platform};s.rows.push(sr);}const ep=Number(r.episodes_dubbed);Object.assign(sr,{status:['Complete','Ongoing'].includes(r.status)?r.status:'Unknown',tamilEpisodes:r.episodes_dubbed!==null&&Number.isInteger(ep)&&ep>=0&&ep<=5000?ep:null});confirm(sr,a.id);
 }
 if(JSON.stringify(record)!==before)result.updated.push(record.id);
 };
 for(const a of anime.values()){
 if(/marriagetoxin/i.test(a.title))continue;const ss=[...new Set(rows.filter(r=>r.anime_id===a.id).map(r=>r.season_id))];if(!ss.length)continue;
 const mapped=identities.entries?.[a.id];let targets=[];
 if(mapped&&normalize(mapped.title)===normalize(a.title))targets=(mapped.records||[]).map(m=>({r:records.find(r=>r.id===m.id),ids:m.seasonIds||ss})).filter(x=>x.r);
 if(!targets.length){const matches=records.filter(r=>r.anidubId===a.id&&!r.anidubSeasonIds||normalize(r.title)===normalize(a.title)||normalize(r.originalTitle)===normalize(a.title));if(matches.length>1){result.skipped.push(`ambiguous:${a.id}`);continue;}if(matches.length)targets=[{r:matches[0],ids:ss}];}
 for(const r of records.filter(r=>r.anidubId===a.id&&Array.isArray(r.anidubSeasonIds)&&!targets.some(t=>t.r.id===r.id)))targets.push({r,ids:r.anidubSeasonIds});
 const covered=new Set();for(const t of targets){const ids=t.ids.filter(id=>ss.includes(id));ids.forEach(id=>covered.add(id));update(t.r,a,ids);}
 const left=ss.filter(id=>!covered.has(id));if(!left.length)continue;
 // Uncovered seasons stay separate from existing season-specific records.
 const groups=targets.length?left.map(id=>[id]):[left];
 for(const ids of groups){const fresh=make(a,ids);let r=records.find(r=>r.id===fresh.id);if(!r){r=fresh;records.push(r);result.added.push(r.id);}update(r,a,ids);}
 }
 applyPosters(records);
 result.catalog.anidubSync={source:'AniDub India',checkedAt:snapshot.checkedAt,tamilTitles:new Set(rows.map(r=>r.anime_id)).size,seasonRows:new Set(rows.map(r=>r.season_id)).size};return result;
}
function run(o={}){try{const dir=path.join(__dirname,'..','data');const file=o.animeFile||path.join(dir,'anime.json');const c=JSON.parse(fs.readFileSync(file));const s=JSON.parse(fs.readFileSync(o.snapshotFile||path.join(dir,'anidub-snapshot.json')));let identities=o.identities; if(!identities)try{identities=JSON.parse(fs.readFileSync(path.join(dir,'anidub-identities.json')));}catch{}const r=applySnapshot(c,s,{now:o.now||new Date(),identities});if(!r.skipped.includes('invalid-or-stale-snapshot')){const out=JSON.stringify(r.catalog,null,2)+'\n';if(out!==fs.readFileSync(file,'utf8')){fs.writeFileSync(file+'.tmp',out);fs.renameSync(file+'.tmp',file);}}console.log(`AniDub: ${r.added.length} added, ${r.updated.length} updated, ${r.skipped.length} skipped`);return r;}catch(e){console.warn(`AniDub import skipped: ${e.message}`);return null;}}
module.exports={applySnapshot,run,normalize,safePosterUrl};if(require.main===module)run();
