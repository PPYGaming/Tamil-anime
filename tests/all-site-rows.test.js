const test=require('node:test'),assert=require('node:assert/strict'),ui=require('../app');
// Strict policy: free-site rows render only when a fresh check found the title available;
// unknown/stale rows are hidden instead of showing a false "Not available".
test('empty free-site data renders no rows and does not mutate data',()=>{const a={id:'season',title:'Season',freeSites:[]};const html=ui.freeSiteSectionHtml(a);assert.equal(html,'');assert.deepEqual(a.freeSites,[]);});
test('only the available row renders; missing site stays hidden',()=>{const a={freeSites:[{name:'Animesalt',available:true}]};const html=ui.freeSiteSectionHtml(a);assert.equal((html.match(/pill-free-yes/g)||[]).length,1);assert.ok(!html.includes('Not available'));assert.ok(!html.includes('Toon Stream'));});
