'use strict';
const fs=require('node:fs'),path=require('node:path');
const {normalize}=require('./attach-anidub');
function decode(s){return String(s).replace(/&amp;/g,'&').replace(/&#039;|&apos;/g,"'").replace(/&quot;/g,'"').replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim();}
function parseEpisode(html,url,source){
 const title=decode(html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i)?.[1]||'');let season,episode,base;
 if(source==='Toon Stream'){const m=title.match(/^(.*?)\s+(\d+)x(\d+)$/i);if(!m)return null;[,base,season,episode]=m;}
 else {const m=decode(html).match(/Season\s+(\d+)\s+Episode\s+(\d+)/i);if(!m)return null;[,season,episode]=m;base=title;}
 let tamil=false;
 if(source==='Animesalt')for(const src of html.matchAll(/(?:src|data-src)=["']([^"']*player\.php\?data=[^"']+)["']/gi))try{const value=new URL(src[1].replace(/&amp;/g,'&')).searchParams.get('data');const rows=JSON.parse(Buffer.from(value,'base64').toString());if(rows.some(r=>r.language==='Tamil'))tamil=true;}catch{}
 if(source==='Toon Stream'){const genre=html.match(/<span\b[^>]*class=["']genres["'][^>]*>([\s\S]*?)<\/span>/i)?.[1]||'';tamil=/\bTamil\b/i.test(decode(genre));}
 return {source,title:base,season:+season,episode:+episode,tamil,url};
}
function episodeLinks(html,base){return [...new Set([...html.matchAll(/href=["']([^"']*\/episode\/[^"']+)["']/gi)].map(m=>{try{const u=new URL(m[1],base);return u.origin===new URL(base).origin&&u.protocol==='https:'?u.href:null;}catch{return null;}}).filter(Boolean))];}
function seasonUrls(html,base){const out=[];for(const m of html.matchAll(/<a\b[^>]*class=["'][^"']*season-btn[^"']*["'][^>]*>/gi)){const tag=m[0],n=tag.match(/data-season=["'](\d+)["']/)?.[1],u=tag.match(/data-url=["']([^"']+)["']/)?.[1],post=tag.match(/data-post=["'](\d+)["']/)?.[1];if(u){const link=new URL(u,base);if(link.origin===new URL(base).origin&&link.protocol==='https:')out.push(link.href);}else if(n&&post)out.push(new URL(`/wp-admin/admin-ajax.php?action=action_select_season&season=${n}&post=${post}`,base).href);}return out;}
async function run(o={}){const dir=path.join(__dirname,'..','data'),file=o.file||path.join(dir,'free-season-evidence.json');let data;try{data=JSON.parse(fs.readFileSync(file));}catch{data={version:1,series:[],evidence:[]};}const fetchImpl=o.fetchImpl||fetch;let requests=0;const sleep=o.sleep||((ms)=>new Promise(r=>setTimeout(r,ms)));const get=async(url)=>{const u=new URL(url);if(!['animesalt.cx','toonstream.us'].includes(u.hostname)||u.protocol!=='https:'||u.username||u.password)throw new Error('source-url-rejected');if(++requests>40)throw new Error('request-budget');const r=await fetchImpl(url,{signal:AbortSignal.timeout(15000)});if([403,429,503].includes(r.status)||!r.ok)throw new Error(`HTTP-${r.status}`);const h=await r.text();if(/cf-chl|Just a moment/i.test(h))throw new Error('challenge');await sleep(1500);return h;};

 try{
  const listings=JSON.parse(fs.readFileSync(path.join(dir,'free-site-listings.json')));
  const catalog=JSON.parse(fs.readFileSync(path.join(dir,'anime.json')));
  const priority=new Set(catalog.anime.filter(a=>a.anidubId).map(a=>normalize(a.title.replace(/\s+Season\s+\d+.*$/i,''))));
  const keys=new Set(catalog.anime.flatMap(a=>[a.title,a.originalTitle]).filter(Boolean).map(t=>normalize(t.replace(/\s+Season\s+\d+.*$/i,''))));
  for(const site of listings.sites||[])for(const route of site.routes||[]){
   if(!keys.has(normalize(route.title)))continue;
   const host=new URL(route.url).hostname;
   if(!['animesalt.cx','toonstream.us'].includes(host))continue;
   const existing=data.series.find(s=>s.url===route.url);if(existing)existing.priority=priority.has(normalize(route.title));
   if(!existing)data.series.push({source:site.name,title:route.title,url:route.url,priority:priority.has(normalize(route.title))});
  }
 }catch{}
 const now=new Date().toISOString();
 for(const s of data.series.filter(s=>!s.checkedAt||Date.now()-Date.parse(s.checkedAt)>864e5).sort((a,b)=>Number(!b.checkedAt)-Number(!a.checkedAt)||Number(Boolean(b.priority))-Number(Boolean(a.priority))||(Date.parse(a.checkedAt)||0)-(Date.parse(b.checkedAt)||0)).slice(0,5)){
  try{
   const html=await get(s.url), urls=seasonUrls(html,s.url);
   const selectors=urls.length?urls:[s.url];
   const start=s.seasonCursor||0;
   for(let i=start;i<Math.min(start+8,selectors.length);i++){
    if(requests+2>40)throw new Error('request-budget');
    const group=selectors[i]===s.url?html:await get(selectors[i]);
    const links=episodeLinks(group,s.url);
    if(links.length){
     const u=links[0],ep=parseEpisode(await get(u),u,s.source);
     if(ep&&normalize(ep.title)===normalize(s.title)&&ep.tamil){
      const old=data.evidence.findIndex(e=>e.source===ep.source&&normalize(e.title)===normalize(ep.title)&&e.season===ep.season);
      const e={...ep,checkedAt:now};if(old>=0)data.evidence[old]=e;else data.evidence.push(e);
     }
    }
    s.seasonCursor=i+1;
   }
   if(s.seasonCursor>=selectors.length){s.checkedAt=now;s.seasonCursor=0;}else{s.checkedAt=null;}
   delete s.error;

  }catch(e){s.error=e.message;if(/budget|HTTP-429|challenge/.test(e.message))break;}
 }
 fs.writeFileSync(file+'.tmp',JSON.stringify(data,null,2)+'\n');fs.renameSync(file+'.tmp',file);return data;
}
module.exports={parseEpisode,episodeLinks,seasonUrls,run};if(require.main===module)run().catch(e=>console.log('Season evidence skipped: '+e.message));
