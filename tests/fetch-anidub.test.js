'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const {fetchSnapshot}=require('../scripts/fetch-anidub');
test('public directory snapshot uses read-only GETs and Tamil-only query',async()=>{
 const calls=[];
 const fetchImpl=async(url,opts)=>{calls.push({url,opts});return {ok:true,text:async()=>"const SUPABASE_URL='https://abc.supabase.co';const SUPABASE_ANON_KEY='public-test';",json:async()=>[{id:1,anime_id:1,language:'Tamil'}]};};
 const s=await fetchSnapshot({fetchImpl,now:()=>new Date('2026-10-07T00:00:00Z')});
 assert.equal(s.checkedAt,'2026-10-07T00:00:00.000Z');assert.equal(calls.length,4);assert.ok(calls.at(-1).url.endsWith('&language=eq.Tamil'));assert.ok(calls.every(c=>!c.opts.method));
});
test('directory fetch refuses unexpected config host',async()=>{
 const fetchImpl=async()=>({ok:true,text:async()=>"SUPABASE_URL='https://evil.example';SUPABASE_ANON_KEY='public-test';"});
 await assert.rejects(fetchSnapshot({fetchImpl}),/configuration/);
});
test('directory errors never produce empty successful snapshot',async()=>{
 const fetchImpl=async()=>({ok:false,status:503});await assert.rejects(fetchSnapshot({fetchImpl}),/503/);
});
