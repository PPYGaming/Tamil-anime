'use strict';
// DISABLED for catalog additions. A free-site category page or a third-party lead is not Tamil dub evidence, so this
// script never adds a record. Only official-manifest, AniDub India or allow-listed official YouTube evidence may add a title.
const fs=require('node:fs'),path=require('node:path');
const {normalize}=require('./attach-anidub');
const MAX=12,AGE=14*864e5;
async function identify(title,key,fetchImpl){
 for(const type of ['tv','movie']){
  const url=`https://api.themoviedb.org/3/search/${type}?api_key=${encodeURIComponent(key)}&query=${encodeURIComponent(title)}`;
  const r=await fetchImpl(url,{signal:AbortSignal.timeout(15000)});if(!r.ok)throw new Error(`Identity HTTP ${r.status}`);
  const d=await r.json();const hits=(d.results||[]).filter(h=>h.original_language==='ja'&&h.genre_ids?.includes(16)&&[h.name,h.title,h.original_name,h.original_title].some(t=>t&&normalize(t)===normalize(title)));
  if(hits.length>1)return null;if(hits.length===1)return {hit:hits[0],type};
 }return null;
}
function baseRecord(title,id,now){const h=id.hit;return {id:`fallback-${id.type}-${h.id}`,title,originalTitle:h.original_name||h.original_title||'',tmdbId:h.id,mediaType:id.type,description:h.overview||'',image:h.poster_path?`https://image.tmdb.org/t/p/w500${h.poster_path}`:'',backdrop:'',rating:h.vote_average||null,createdAt:now,updatedAt:now,firstAirDate:h.first_air_date||h.release_date||'',availability:'Available',status:'',tags:['Anime'],platforms:['Crunchyroll','Netflix','Amazon Prime Video'].map(name=>({name,available:false,officialUrl:null,tamilDubVerified:false})),episodes:[],youtube:[],tamilDubVerified:false};}
async function run(o={}){const dir=path.join(__dirname,'..','data'),get=(name)=>{try{return JSON.parse(fs.readFileSync(path.join(dir,name)));}catch{return null;}};if(!o.allowUnconfirmedForTests)return {checked:0,added:0,skipped:'tamil-evidence-required',catalog:o.catalog};
 const now=o.now||new Date().toISOString(),key=o.key||process.env.TMDB_API_KEY,fetchImpl=o.fetchImpl||fetch;
 if(!key)return {skipped:'missing-identity-key'};
 const catalog=o.catalog||get('anime.json'),listings=o.listings||get('free-site-listings.json'),leads=o.leads||get('discovery-leads.json');if(!Array.isArray(catalog?.anime))return {skipped:'invalid-catalog'};
 const state=o.state||get('fallback-state.json')||{version:1,checked:{}};state.checked??={};
 const records=catalog.anime,known=new Set(records.flatMap(a=>[normalize(a.title),normalize(a.originalTitle)]).filter(Boolean));
 const candidates=[],seen=new Set();
 for(const site of (o.tier===3?[]:listings?.sites)||[]){const age=Date.parse(now)-Date.parse(site.checkedAt);if(!site.ok||age<0||age>AGE)continue;for(const title of site.titles||[]){const nt=normalize(title);if(!nt||known.has(nt)||seen.has(nt)||/marriagetoxin|eng(?:lish)? sub|subbed/i.test(title))continue;seen.add(nt);candidates.push({title,tier:2,source:site.name});}}
 for(const lead of (o.tier===2?[]:leads?.leads)||[]){const title=lead.title,nt=normalize(title);if(!nt||known.has(nt)||seen.has(nt)||/marriagetoxin|eng(?:lish)? sub|subbed/i.test(title))continue;if(lead.status==='notConfirmed'&&lead.reason==='not-anime')continue;seen.add(nt);candidates.push({title,tier:3,source:lead.platform,url:lead.pageUrl});}
 let checked=0,added=0;
 for(const c of candidates){const k=`${c.tier}:${normalize(c.title)}`;if(state.checked[k]&&Date.parse(now)-Date.parse(state.checked[k])<7*864e5)continue;if(checked>=MAX)break;
 try{checked++;const id=await identify(c.title,key,fetchImpl);state.checked[k]=now;if(!id)continue;
 if(records.some(a=>a.tmdbId===id.hit.id&&a.mediaType===id.type))continue;
 const r=baseRecord(c.title,id,now);r.inclusionSource=c.tier===2?'free-site-tamil-listing':'third-party-unconfirmed';r.discoverySource=c.source;if(c.url)r.discoveryUrl=c.url;
 if(c.tier===2){r.tamilDubConfirmed=true;r.tamilDubConfirmationSource=c.source;r.freeSites=[{name:c.source,available:true}];r.freeSitesCheckedAt=now.slice(0,10);}else{r.tamilDubConfirmed=false;r.tamilDubUnconfirmed=true;}
 records.push(r);known.add(normalize(c.title));added++;
 }catch(e){console.warn(`Fallback identity check stopped: ${e.message}`);break;}}
 if(!o.catalog){for(const [name,data] of [['anime.json',catalog],['fallback-state.json',state]]){const f=path.join(dir,name);fs.writeFileSync(f+'.tmp',JSON.stringify(data,null,2)+'\n');fs.renameSync(f+'.tmp',f);}}
 return {checked,added,state,catalog};
}
module.exports={identify,run};if(require.main===module)run({tier:process.argv.includes("--third-party")?3:2}).then(r=>console.log(`Fallbacks: ${r.added||0} added`)).catch(()=>console.log('Fallbacks skipped'));
