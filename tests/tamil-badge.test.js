const test=require('node:test'),assert=require('node:assert/strict');const ui=require('../app');
// STRICT CONFIRMED-ONLY POLICY: the title badge reflects official Tamil-dub evidence only
// (record-level flag or any platform row, including group variants). Free-site rows are
// reference extras and never affect the badge. Replaces the old dual-signal semantics.
const free={name:'Animesalt',available:true,tamilDubConfirmed:true,tamilEvidenceUrl:'https://animesalt.ro/language/tamil/'};
const reported={name:'Netflix',available:true,tamilDubReported:true};
const off={name:'Crunchyroll',available:true,tamilDubVerified:true};
test('badge follows official evidence only',()=>{
 assert.match(ui.verifiedBadge({tamilDubVerified:true}),/Tamil dub verified/);
 assert.match(ui.verifiedBadge({platforms:[off]}),/Tamil dub verified/);
 assert.match(ui.verifiedBadge({tamilDubVerified:true,platforms:[off]}),/Tamil dub verified/);
 assert.match(ui.verifiedBadge({title:'S',variants:[{platforms:[off]}]}),/Tamil dub verified/);
 assert.match(ui.verifiedBadge({tamilDubVerified:true,freeSites:[free]}),/Tamil dub verified/);
});
test('free-site corroboration alone never verifies',()=>{
 assert.match(ui.verifiedBadge({freeSites:[free]}),/Tamil dub not confirmed/);
 assert.match(ui.verifiedBadge({platforms:[reported],freeSites:[free]}),/Tamil dub not confirmed/);
 assert.match(ui.verifiedBadge({freeSites:[{name:'Animesalt',available:true}]}),/Tamil dub not confirmed/);
});
test('reported-only and empty records are not confirmed',()=>{
 assert.match(ui.verifiedBadge({platforms:[reported]}),/Tamil dub not confirmed/);
 assert.match(ui.verifiedBadge({}),/Tamil dub not confirmed/);
 assert.match(ui.verifiedBadge({tamilDubConfirmed:true,tamilDubConfirmationSource:'AniDub India',platforms:[],freeSites:[free]}),/Tamil dub not confirmed/);
 assert.doesNotMatch(ui.verifiedBadge({platforms:[reported]}),/badge-verified|badge-confirmed|badge-reported/);
});
test('freeTamilConfirmed helper unchanged',()=>{
 assert.equal(ui.freeTamilConfirmed({freeSites:[free]}),true);
 assert.equal(ui.freeTamilConfirmed({freeSites:[{name:'x',available:true}]}),false);
});
test('corroboratedPlatforms still marks reported rows confirmed by free proof without mutating input',()=>{
 const a={platforms:[reported],freeSites:[free]};const row=ui.corroboratedPlatforms(a)[0];
 assert.equal(row.tamilDubConfirmed,true);assert.notEqual(row.tamilDubVerified,true);assert.equal(reported.tamilDubConfirmed,undefined);
});
