const state={anime:[],filter:"all",search:"",sort:"newest"};
const grid=document.querySelector("#animeGrid");
const statusEl=document.querySelector("#status");
const searchInput=document.querySelector("#searchInput");
const refreshButton=document.querySelector("#refreshButton");
const sortSelect=document.querySelector("#sortSelect");
const filterButtons=[...document.querySelectorAll("[data-filter]")];

function esc(v){return String(v??"").replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;").replaceAll('"',"&quot;").replaceAll("'","&#039;")}
function safeUrl(v){try{const u=new URL(v,location.href);return ["https:","http:"].includes(u.protocol)?u.href:"#"}catch{return "#"}}

function platformHtml(platforms=[]){
  const names=["Crunchyroll","Netflix","Amazon Prime Video"];
  const map=new Map(platforms.map(p=>[String(p.name).toLowerCase(),p]));
  return names.map(name=>{
    const p=map.get(name.toLowerCase());
    if(!p||!p.available)return `<div class="platform-row"><span>${esc(name)}</span><span class="muted">Not available</span></div>`;
    const dub=p.tamilDubVerified?"Tamil dub verified":"Tamil dub not verified";
    const link=p.officialUrl?`<a href="${esc(safeUrl(p.officialUrl))}" target="_blank" rel="noopener noreferrer">Open official service</a>`:`<span class="muted">Official link not configured</span>`;
    return `<div class="platform-row"><span>${esc(name)}</span><span>${dub}</span>${link}</div>`;
  }).join("");
}

function episodesHtml(episodes=[]){
  if(!episodes.length)return `<span class="muted">No episode links available</span>`;
  return episodes.map(e=>e.url?`<a class="episode-link" href="${esc(safeUrl(e.url))}" target="_blank" rel="noopener noreferrer">Episode ${esc(e.number)}</a>`:`<span class="episode-link">Episode ${esc(e.number)}</span>`).join("");
}

function youtubeHtml(videos=[]){
  if(!videos.length)return "";
  return `<div class="youtube-list"><strong>Official YouTube videos</strong>${videos.slice(0,10).map(v=>`<a href="${esc(safeUrl(v.url))}" target="_blank" rel="noopener noreferrer">${esc(v.title)}</a>`).join("")}</div>`;
}

function card(a){
  const tags=(a.tags||[]).map(t=>`<span class="tag">${esc(t)}</span>`).join("");
  return `<article class="anime-card">
    <img src="${esc(safeUrl(a.image))}" alt="${esc(a.title)} poster" loading="lazy">
    <div class="anime-content">
      <h2>${esc(a.title)}</h2>
      <p>${esc(a.description||"No description available.")}</p>
      <div class="tags">${tags}</div>
      <div class="meta">
        <span>Rating: ${a.rating==null?"Not available":esc(a.rating)}</span>
        <span>Likes: ${a.likes==null?"Not available":esc(a.likes)}</span>
        <span>Availability: ${esc(a.availability||"Not available")}</span>
      </div>
      <div class="platforms">${platformHtml(a.platforms)}</div>
      <div class="episodes">${episodesHtml(a.episodes)}</div>
      ${youtubeHtml(a.youtube)}
    </div>
  </article>`;
}

function render(){
  const q=state.search.trim().toLowerCase();
  let list=state.anime.filter(a=>{
    const text=[a.title,a.description,...(a.tags||[])].join(" ").toLowerCase();
    const filterOk=state.filter==="all"||(state.filter==="new"&&a.isNew)||(state.filter==="updated"&&a.updatedAt);
    return (!q||text.includes(q))&&filterOk;
  });
  list.sort((a,b)=>{
    if(state.sort==="alpha")return String(a.title).localeCompare(String(b.title));
    if(state.sort==="rating")return (Number(b.rating)||0)-(Number(a.rating)||0);
    if(state.sort==="updated")return String(b.updatedAt||"").localeCompare(String(a.updatedAt||""));
    return String(b.createdAt||b.updatedAt||"").localeCompare(String(a.createdAt||a.updatedAt||""));
  });
  grid.innerHTML=list.length?list.map(card).join(""):`<div class="empty">No matching anime found.</div>`;
}

async function loadCatalog(message="Loading catalog..."){
  statusEl.textContent=message;
  refreshButton.disabled=true;
  try{
    const res=await fetch(`data/anime.json?t=${Date.now()}`,{cache:"no-store"});
    if(!res.ok)throw new Error(`HTTP ${res.status}`);
    const data=await res.json();
    state.anime=Array.isArray(data.anime)?data.anime:[];
    render();
    statusEl.textContent=data.lastUpdated?`Catalog updated: ${new Date(data.lastUpdated).toLocaleString()}`:"Catalog loaded.";
  }catch(err){
    console.error(err);
    statusEl.textContent="Unable to load the latest catalog.";
    if(!state.anime.length)grid.innerHTML=`<div class="empty">The catalog is temporarily unavailable.</div>`;
  }finally{refreshButton.disabled=false}
}

searchInput.addEventListener("input",e=>{state.search=e.target.value;render()});
sortSelect.addEventListener("change",e=>{state.sort=e.target.value;render()});
filterButtons.forEach(b=>b.addEventListener("click",()=>{state.filter=b.dataset.filter;filterButtons.forEach(x=>x.classList.toggle("active",x===b));render()}));
refreshButton.addEventListener("click",()=>loadCatalog("Refreshing catalog..."));
loadCatalog();
