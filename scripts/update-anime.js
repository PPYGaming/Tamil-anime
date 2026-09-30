const fs=require("fs/promises");
const path=require("path");

const file=path.join(process.cwd(),"data","anime.json");
const TMDB_API_KEY=process.env.TMDB_API_KEY||"";
const YOUTUBE_API_KEY=process.env.YOUTUBE_API_KEY||"";
const REGION=process.env.CONTENT_REGION||"IN";

async function getJson(url){
  const r=await fetch(url,{headers:{"User-Agent":"Tamil-Dub-Anime-Catalog/1.0"}});
  if(!r.ok)throw new Error(`HTTP ${r.status} ${new URL(url).hostname}`);
  return r.json();
}

async function main(){
  const catalog=JSON.parse(await fs.readFile(file,"utf8"));
  const existing=Array.isArray(catalog.anime)?catalog.anime:[];
  console.log(`Existing catalog: ${existing.length} titles`);

  // This updater intentionally preserves the existing catalog.
  // Add/expand discovery queries here using only APIs and sources you are
  // authorized to use. Never put API keys into generated frontend files.
  if(TMDB_API_KEY){
    console.log("TMDB API key configured.");
  }else{
    console.warn("TMDB_API_KEY is not configured.");
  }
  if(YOUTUBE_API_KEY){
    console.log("YouTube API key configured.");
  }else{
    console.warn("YOUTUBE_API_KEY is not configured.");
  }

  catalog.lastUpdated=new Date().toISOString();
  catalog.region=REGION;
  catalog.updateInfo={
    automatic:true,
    tmdbConfigured:Boolean(TMDB_API_KEY),
    youtubeConfigured:Boolean(YOUTUBE_API_KEY),
    note:"Provider availability and Tamil-audio verification must remain separate."
  };

  await fs.writeFile(file,JSON.stringify(catalog,null,2)+"\n");
  console.log("Catalog timestamp updated.");
}
main().catch(e=>{console.error(e);process.exit(1)});
