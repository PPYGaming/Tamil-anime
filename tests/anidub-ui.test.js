'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),app=require('../app');
test('trusted directory tier is separate from official verified',()=>{
 const a={id:'x',title:'Example',tamilDubConfirmed:true,platforms:[{name:'Crunchyroll',available:true,tamilDubVerified:false,tamilDubConfirmed:true,tamilDubConfirmationUrl:'https://kuskakuruma.github.io/anidub-india/anime.html?id=4'}],seasonDetails:[{label:'Season 1',rows:[{platform:'Crunchyroll',status:'Complete',tamilEpisodes:12,tamilDubConfirmed:true}]}]};
 const html=app.detailHtml(a);assert.match(html,/Tamil dub confirmed/);assert.doesNotMatch(html,/AniDub India|kuskakuruma/);assert.match(html,/season-chip--confirmed/);assert.doesNotMatch(html,/pill-verified/);
});
test('Muse Asia is shown only on listed rows',()=>{const html=app.platformRows({platforms:[{name:'Muse Asia',available:true,tamilDubConfirmed:true}]});assert.match(html,/Muse Asia/);assert.doesNotMatch(app.platformRows({platforms:[]}),/Muse Asia/);});
