#!/usr/bin/env node
// 10-second sanity check for YOUR machine (sandboxes may block Apple's API).
// Run: node local-test.mjs   -> should print 3 resolved clips for a random year.
import fs from 'node:fs';
const SONGS = JSON.parse(fs.readFileSync(new URL('./needledrop-seed.json', import.meta.url),'utf8'));
const norm=(s)=>(s||'').toLowerCase().replace(/&/g,' and ').replace(/[^a-z0-9]+/g,' ').trim();
const stripParens=(s)=>(s||'').replace(/\(.*?\)|\[.*?\]/g,' ').trim();
const primaryArtist=(a)=>(a||'').split(/,|&|\bfeat\.?\b|\bfeaturing\b|\bwith\b/i)[0].trim()||a;
function sim(a,b){const na=norm(a),nb=norm(b);if(!na||!nb)return 0;if(na===nb)return 1;if(nb.includes(na)||na.includes(nb))return .9;const A=new Set(na.split(' ')),B=new Set(nb.split(' '));let i=0;A.forEach(t=>{if(B.has(t))i++});return i/(A.size+B.size-i);}
const yr = SONGS[Math.floor(Math.random()*SONGS.length)].y;
const cands = SONGS.filter(s=>s.y===yr).sort(()=>Math.random()-.5);
console.log('Testing year', yr, '—', cands.length, 'candidates');
const found=[];
for(const s of cands){
  if(found.length>=3) break;
  const term=encodeURIComponent(stripParens(s.t)+' '+primaryArtist(s.a));
  const res=await fetch('https://itunes.apple.com/search?media=music&entity=song&limit=6&term='+term);
  if(!res.ok){ console.log('  !',s.t,'HTTP',res.status); continue; }
  const data=await res.json(); let best=null,rank=-1;
  for(const x of (data.results||[])){ if(!x.previewUrl)continue;
    const ts=sim(stripParens(s.t),stripParens(x.trackName||'')),as=sim(primaryArtist(s.a),x.artistName||'');
    if(ts*2+as>rank){rank=ts*2+as;best={x,ts,as};}}
  if(best&&best.ts>=.6&&best.as>=.55){found.push(s);console.log('  ✓',s.t,'—',s.a);}
  else console.log('  ~ swap:',s.t);
  await new Promise(r=>setTimeout(r,400));
}
console.log(found.length>=3?'\nPASS — a round resolves 3 playable clips.':'\nCheck network / try again.');
