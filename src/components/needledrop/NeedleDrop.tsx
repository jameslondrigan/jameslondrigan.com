import React, { useState, useMemo, useRef, useEffect } from 'react';
import SONGS_DATA from '../../data/needledrop-songs.json';

/*
 * Track Record: music year-guessing party game
 * Enriched data: songs with baked preview URLs play instantly.
 * JSONP live-resolution (iTunes API) is the fallback for unenriched songs.
 */

type SongData = { y: number; t: string; a: string; p: number; w?: number; preview: string | null; art: string | null; g: string };
type Track = SongData & { preview: string };

const SONGS = SONGS_DATA as SongData[];

const GENRES = ['Any', 'Rock', 'Pop', 'Country', 'Hip-Hop/R&B', 'Dance/Electronic', 'Other'] as const;
type Genre = typeof GENRES[number];

const YEARS = [...new Set(SONGS.map((s) => s.y))].sort((a, b) => a - b);
const YMIN = YEARS[0], YMAX = YEARS[YEARS.length - 1];

const clampYear = (y: number) => Math.max(YMIN, Math.min(YMAX, y));
const preset = (label: string, min: number, max: number) => ({ label, min: clampYear(min), max: clampYear(max) });
const ERA_PRESETS = [
  preset('Everything', YMIN, YMAX),
  preset("'50s–'60s", 1958, 1969),
  preset("'70s–'80s", 1970, 1989),
  preset("'90s–'00s", 1990, 2009),
  preset("'10s+", 2010, YMAX),
];

const MIN_WEEKS = 12;
const MIN_SPAN = 10; // minimum range width in years (inclusive), so end - start >= 9

const yearPts = (d: number) => (d === 0 ? 5 : d <= 1 ? 3 : d <= 3 ? 1 : 0);
const shuffle = <T,>(a: T[]): T[] => {
  const r = [...a];
  for (let i = r.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [r[i], r[j]] = [r[j], r[i]];
  }
  return r;
};

/* ---------- iTunes resolution (JSONP; works in-browser, no CORS) ---------- */
const norm = (s: string) => (s || '').toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim();
const stripParens = (s: string) => (s || '').replace(/\(.*?\)|\[.*?\]/g, ' ').trim();
const primaryArtist = (a: string) => (a || '').split(/,|&|\bfeat\.?\b|\bfeaturing\b|\bwith\b/i)[0].trim() || a;
function sim(a: string, b: string): number {
  const na = norm(a), nb = norm(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  if (nb.includes(na) || na.includes(nb)) return 0.9;
  const A = new Set(na.split(' ')), B = new Set(nb.split(' '));
  let inter = 0; A.forEach((t) => { if (B.has(t)) inter++; });
  return inter / (A.size + B.size - inter);
}

function jsonp(url: string, timeoutMs = 8000): Promise<any> {
  return new Promise((resolve, reject) => {
    const cb = 'trcb_' + Date.now() + '_' + Math.floor(Math.random() * 1e5);
    const s = document.createElement('script');
    let done = false;
    const cleanup = () => { try { delete (window as any)[cb]; } catch { (window as any)[cb] = undefined; } s.remove(); };
    (window as any)[cb] = (d: any) => { done = true; cleanup(); resolve(d); };
    s.onerror = () => { if (!done) { cleanup(); reject(new Error('net')); } };
    s.src = url + (url.includes('?') ? '&' : '?') + 'callback=' + cb;
    document.body.appendChild(s);
    setTimeout(() => { if (!done) { cleanup(); reject(new Error('timeout')); } }, timeoutMs);
  });
}

const resolveCache: Record<string, Track | null> = {};
async function resolveTrack(s: SongData): Promise<Track | null> {
  if (s.preview) return { ...s, preview: s.preview } as Track;
  const key = s.t + '|' + s.a;
  if (key in resolveCache) return resolveCache[key];
  let out: Track | null = null;
  try {
    const term = encodeURIComponent(stripParens(s.t) + ' ' + primaryArtist(s.a));
    const data = await jsonp('https://itunes.apple.com/search?media=music&entity=song&limit=6&term=' + term);
    const results: any[] = (data && data.results) || [];
    let best: any = null, bestRank = -1;
    for (const r of results) {
      if (!r.previewUrl) continue;
      const ts = sim(stripParens(s.t), stripParens(r.trackName || ''));
      const as = sim(primaryArtist(s.a), r.artistName || '');
      const rank = ts * 2 + as;
      if (rank > bestRank) { bestRank = rank; best = { r, ts, as }; }
    }
    if (best && best.ts >= 0.6 && best.as >= 0.55) {
      out = { ...s, preview: best.r.previewUrl, art: (best.r.artworkUrl100 || '').replace('100x100', '300x300') || null } as Track;
    }
  } catch { }
  resolveCache[key] = out;
  return out;
}

async function resolveRound(candidates: SongData[], want = 3): Promise<Track[]> {
  const found: Track[] = [];
  for (const c of candidates) {
    if (found.length >= want) break;
    if (c.preview) found.push({ ...c, preview: c.preview } as Track);
  }
  if (found.length < want) {
    for (const c of candidates) {
      if (found.length >= want) break;
      if (c.preview) continue;
      const t = await resolveTrack(c);
      if (t) found.push(t);
    }
  }
  return found;
}

/* ---------- Shared audio context (all sounds share one per page) ---------- */
const _ac = { current: null as AudioContext | null };
function getAC(): AudioContext | null {
  try {
    if (!_ac.current) _ac.current = new (window.AudioContext || (window as any).webkitAudioContext)();
    if (_ac.current.state === 'suspended') _ac.current.resume();
    return _ac.current;
  } catch { return null; }
}

function playTick() {
  const ctx = getAC(); if (!ctx) return;
  const o = ctx.createOscillator(), g = ctx.createGain();
  o.type = 'square'; o.frequency.value = 1150;
  g.gain.setValueAtTime(0.06, ctx.currentTime);
  g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.03);
  o.connect(g); g.connect(ctx.destination);
  o.start(); o.stop(ctx.currentTime + 0.035);
  if (navigator.vibrate) navigator.vibrate(8);
}

function playTonearmClick() {
  const ctx = getAC(); if (!ctx) return;
  const o = ctx.createOscillator(), g = ctx.createGain();
  o.type = 'sine'; o.frequency.value = 380;
  o.frequency.exponentialRampToValueAtTime(140, ctx.currentTime + 0.06);
  g.gain.setValueAtTime(0.14, ctx.currentTime);
  g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.12);
  o.connect(g); g.connect(ctx.destination);
  o.start(); o.stop(ctx.currentTime + 0.13);
}

function playRevealTick(gap: number) {
  const ctx = getAC(); if (!ctx) return;
  const o = ctx.createOscillator(), g = ctx.createGain();
  o.type = 'square'; o.frequency.value = 700 + (15 - Math.min(gap, 15)) * 60;
  g.gain.setValueAtTime(0.04, ctx.currentTime);
  g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.025);
  o.connect(g); g.connect(ctx.destination);
  o.start(); o.stop(ctx.currentTime + 0.03);
}

function playRevealSting() {
  const ctx = getAC(); if (!ctx) return;
  const now = ctx.currentTime;
  const mk = (freq: number, vol: number, dur: number) => {
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = 'sine'; o.frequency.value = freq;
    g.gain.setValueAtTime(vol, now);
    g.gain.setValueAtTime(vol * 0.85, now + 0.04);
    g.gain.exponentialRampToValueAtTime(0.001, now + dur);
    o.connect(g); g.connect(ctx.destination);
    o.start(now); o.stop(now + dur);
  };
  mk(880, 0.12, 0.38);
  mk(1320, 0.07, 0.32);
  mk(440, 0.05, 0.22);
}

function useTick() { return playTick; }

/* ------------------------------ styles ------------------------------ */
const CSS = `
@import url('https://fonts.googleapis.com/css2?family=Righteous&family=Space+Grotesk:wght@400;500;600;700&family=JetBrains+Mono:wght@500;700&display=swap');
.nd,.nd *{box-sizing:border-box;margin:0;padding:0}
.nd{
  --bg:#160f08;--panel:#211810;--panel2:#2c2114;--line:#3c2d1c;
  --amber:#F2A93B;--amberhi:#FFC768;--cream:#F5EAD2;--muted:#a48a67;
  --green:#93CB58;--red:#E4573C;--maroon:#500000;
  min-height:100vh;
  background:radial-gradient(1200px 600px at 50% -10%,#2a1d0f 0%,transparent 60%),var(--bg);
  color:var(--cream);font-family:'Space Grotesk',system-ui,sans-serif;
  display:flex;align-items:flex-start;justify-content:center;padding:22px 16px 60px;
}
.nd .wrap{width:100%;max-width:560px}
.nd .disp{font-family:'Righteous',sans-serif;letter-spacing:.02em;line-height:.92}
.nd .mono{font-family:'JetBrains Mono',monospace}
.nd .eyebrow{font-family:'JetBrains Mono',monospace;font-size:11px;letter-spacing:.28em;text-transform:uppercase;color:var(--amber)}
.nd .muted{color:var(--muted)}
.nd .hint{font-size:13px}
.nd .card{background:linear-gradient(180deg,var(--panel2),var(--panel));border:1px solid var(--line);border-radius:18px;padding:22px}
.nd .btn{font-family:'Space Grotesk',sans-serif;font-weight:600;font-size:15px;border:1px solid var(--line);background:var(--panel2);color:var(--cream);border-radius:12px;padding:12px 16px;cursor:pointer;transition:transform .06s ease,border-color .15s,background .15s;min-height:44px}
.nd .btn:hover{border-color:var(--amber)}
.nd .btn:active{transform:translateY(1px)}
.nd .btn:disabled{opacity:.4;cursor:default;transform:none}
.nd .btn.primary{background:linear-gradient(180deg,var(--amberhi),var(--amber));color:#2a1a06;border:none;box-shadow:0 6px 24px -8px var(--amber)}
.nd .btn.wide{width:100%}
.nd .btn.sm{font-size:13px;padding:10px 14px;border-radius:10px}
.nd .chip{font-family:'JetBrains Mono',monospace;font-size:12px;letter-spacing:.12em;text-transform:uppercase;padding:9px 13px;border-radius:999px;border:1px solid var(--line);background:transparent;color:var(--muted);cursor:pointer;min-height:38px}
.nd .chip.on{color:#2a1a06;background:var(--amber);border-color:var(--amber);font-weight:700}
.nd .row{display:flex;gap:8px;flex-wrap:wrap}
.nd input.name{flex:1;background:#160f08;border:1px solid var(--line);border-radius:10px;padding:12px 13px;color:var(--cream);font-family:'Space Grotesk',sans-serif;font-size:16px;min-width:0}
.nd input.name:focus{outline:none;border-color:var(--amber)}
.nd .nd-tt{position:relative;width:240px;height:240px;margin:0 auto 20px}
.nd .nd-platter{position:absolute;inset:0;border-radius:50%;background:#0e0908;border:2px solid #241a10;box-shadow:0 0 0 5px #160f08,0 8px 28px rgba(0,0,0,.7)}
.nd .nd-record{position:absolute;inset:20px;border-radius:50%}
.nd .nd-spinning{animation:nd-vspin 1.8s linear infinite}
@keyframes nd-vspin{to{transform:rotate(360deg)}}
.nd .nd-arm{position:absolute;top:-5px;right:-20px;pointer-events:none;transform-origin:60px 15px;transform:rotate(28deg);transition:transform .9s cubic-bezier(.4,0,.2,1)}
.nd .nd-arm.nd-arm-play{transform:rotate(-2deg)}
.nd .vu{display:flex;align-items:flex-end;gap:4px;height:44px}
.nd .vu b{width:7px;border-radius:2px 2px 1px 1px;background:var(--amber);height:6px;display:block}
.nd .vu b.on{animation:nd-vu var(--d,700ms) ease-in-out infinite;animation-delay:var(--ad,0ms)}
.nd .vu b.hi{background:#e06030}
@keyframes nd-vu{0%,100%{height:6px}50%{height:44px}}
.nd .gate{text-align:center;padding:46px 22px}
.nd .dots{display:flex;gap:6px;justify-content:center}
.nd .dot{width:8px;height:8px;border-radius:50%;background:var(--line)}
.nd .dot.on{background:var(--amber)}
.nd .dot.done{background:var(--muted)}
.nd .yearbig{font-family:'JetBrains Mono',monospace;font-weight:700;font-size:64px;color:var(--amberhi);text-shadow:0 0 26px rgba(242,169,59,.45);text-align:center}
.nd .tuner{position:relative;margin:6px 0 2px}
.nd .ticks{position:relative;height:22px;margin-bottom:6px}
.nd .tick{position:absolute;top:0;width:1px;height:9px;background:var(--line)}
.nd .tick.dec{height:16px;background:var(--muted)}
.nd .ticklab{position:absolute;top:12px;transform:translateX(-50%);font-family:'JetBrains Mono',monospace;font-size:10px;color:var(--muted)}
.nd input[type=range].dial{-webkit-appearance:none;appearance:none;width:100%;height:8px;border-radius:6px;background:linear-gradient(90deg,#3a2c1c,#6b5330);outline:none}
.nd input[type=range].dial::-webkit-slider-thumb{-webkit-appearance:none;appearance:none;width:14px;height:38px;border-radius:4px;background:linear-gradient(var(--amberhi),var(--amber));box-shadow:0 0 16px 2px rgba(242,169,59,.6);cursor:pointer}
.nd input[type=range].dial::-moz-range-thumb{width:14px;height:38px;border:none;border-radius:4px;background:var(--amber);box-shadow:0 0 16px 2px rgba(242,169,59,.6);cursor:pointer}
.nd .nudge-row{display:flex;gap:8px;align-items:center;margin-top:14px}
.nd .nd-nudge{font-family:'JetBrains Mono',monospace;font-size:20px;font-weight:700;padding:10px 16px;flex-shrink:0}
.nd .reveal-yr{font-family:'Righteous',sans-serif;font-size:88px;line-height:1;color:var(--amberhi);text-shadow:0 0 40px rgba(242,169,59,.5);text-align:center}
.nd .reveal-sweep{height:4px;border-radius:2px;background:var(--panel2);margin:10px 0 22px;overflow:hidden}
.nd .reveal-sweep-fill{height:100%;background:linear-gradient(90deg,var(--amber),var(--amberhi));border-radius:2px;transition:width .06s linear}
.nd .standing{display:flex;align-items:center;justify-content:space-between;padding:13px 15px;border-radius:12px;background:var(--panel2);border:1px solid var(--line);margin-bottom:8px}
.nd .standing.lead{border-color:var(--amber);background:linear-gradient(180deg,#33260f,var(--panel2))}
.nd .pts{font-family:'Righteous',sans-serif;font-size:22px}
.nd .pts.win{color:var(--green)}
.nd .pts.zero{color:var(--muted)}
.nd .title2{font-family:'Righteous',sans-serif;font-size:32px;line-height:1}
.nd .revealart{width:72px;height:72px;border-radius:10px;border:1px solid var(--line);object-fit:cover}
.nd .chart-row{display:flex;align-items:center;gap:10px;padding:12px 14px;border-radius:12px;background:var(--panel2);border:1px solid var(--line);margin-bottom:8px}
.nd .chart-row.lead{border-color:var(--amber);background:linear-gradient(180deg,#33260f,var(--panel2))}
.nd .chart-pos{font-family:'Righteous',sans-serif;font-size:22px;width:36px;text-align:center;color:var(--muted);flex-shrink:0}
.nd .chart-pos-1{display:inline-flex;align-items:center;justify-content:center;width:32px;height:32px;border-radius:6px;background:var(--maroon);color:var(--cream);font-size:18px}
.nd .chart-move{font-family:'JetBrains Mono',monospace;font-size:12px;font-weight:700;flex-shrink:0;min-width:30px;text-align:right}
.nd .nd-up{color:var(--green)}
.nd .nd-down{color:var(--red)}
.nd .nd-hold{color:var(--muted)}
.nd .chart-delta{font-family:'JetBrains Mono',monospace;font-size:13px;font-weight:700;flex-shrink:0;min-width:26px;text-align:right}
.nd .chart-delta.up{color:var(--green)}
.nd .chart-delta.zero{color:var(--muted)}
.nd .chart-score{font-family:'Righteous',sans-serif;font-size:26px;color:var(--amberhi)}
@media(prefers-reduced-motion:reduce){
  .nd .nd-spinning{animation:none!important}
  .nd .nd-arm{transition:none!important}
  .nd .vu b.on{animation:none!important;height:24px}
  .nd .flip-card{transition:none!important}
}
.nd .flip-scene{perspective:900px}
.nd .flip-card{position:relative;transform-style:preserve-3d;transition:transform .55s ease}
.nd .flip-card.nd-flipped{transform:rotateY(180deg)}
.nd .flip-front{backface-visibility:hidden;-webkit-backface-visibility:hidden}
.nd .flip-back{position:absolute;top:0;left:0;width:100%;backface-visibility:hidden;-webkit-backface-visibility:hidden;transform:rotateY(180deg)}
.nd .tl-item{display:flex;align-items:baseline;gap:12px;padding:11px 0;border-bottom:1px solid var(--line)}
.nd .tl-item:last-child{border-bottom:none;padding-bottom:0}
.nd .tl-num{font-family:'Righteous',sans-serif;font-size:22px;color:var(--maroon);flex-shrink:0;width:30px;line-height:1}
.nd .tl-text{font-size:15px;line-height:1.4}
.nd .tl-sub{font-family:'JetBrains Mono',monospace;font-size:11px;color:var(--amber);letter-spacing:.1em;display:block;margin-top:3px}
.nd .score-hint{font-family:'JetBrains Mono',monospace;font-size:11px;letter-spacing:.14em;color:var(--muted);text-align:center;margin-top:12px}
.nd select.yr{font-family:'JetBrains Mono',monospace;font-size:15px;background:#160f08;border:1px solid var(--line);border-radius:10px;padding:11px 12px;color:var(--cream);min-height:44px;cursor:pointer;flex:1;min-width:0}
.nd select.yr:focus{outline:none;border-color:var(--amber)}
`;

/* ---- 7-bar VU meter (replaces EQ bars) ---- */
const VuMeter = ({ active }: { active: boolean }) => {
  const bars = [
    { d: '600ms', ad: '0ms' },
    { d: '800ms', ad: '120ms' },
    { d: '700ms', ad: '240ms' },
    { d: '900ms', ad: '80ms' },
    { d: '650ms', ad: '300ms' },
    { d: '750ms', ad: '180ms' },
    { d: '850ms', ad: '40ms' },
  ];
  return (
    <div className="vu" aria-hidden="true">
      {bars.map((bar, i) => (
        <b
          key={i}
          className={[active ? 'on' : '', i >= 5 ? 'hi' : ''].filter(Boolean).join(' ')}
          style={{ '--d': bar.d, '--ad': bar.ad } as React.CSSProperties}
        />
      ))}
    </div>
  );
};

/* ---- Vinyl turntable with tonearm ---- */
const Turntable = ({ playing }: { playing: boolean }) => (
  <div className="nd-tt">
    <div className="nd-platter" />
    <div className={'nd-record' + (playing ? ' nd-spinning' : '')}>
      <svg viewBox="0 0 200 200" style={{ display: 'block', width: '100%', height: '100%', borderRadius: '50%' }}>
        <circle cx="100" cy="100" r="99" fill="#111214" />
        {/* Groove rings */}
        {Array.from({ length: 16 }, (_, i) => 32 + i * 3.8).map((r, i) => (
          <circle key={i} cx="100" cy="100" r={r} fill="none" stroke="rgba(255,255,255,0.04)" strokeWidth="0.7" />
        ))}
        <circle cx="100" cy="100" r="98" fill="none" stroke="rgba(255,255,255,0.06)" strokeWidth="1.2" />
        {/* Center label */}
        <circle cx="100" cy="100" r="28" fill="#500000" />
        <circle cx="100" cy="100" r="27" fill="none" stroke="#6a0000" strokeWidth="1" />
        <circle cx="100" cy="100" r="3" fill="#160f08" />
        <text x="100" y="97" textAnchor="middle" fontFamily="Righteous,sans-serif" fontSize="8.5" fill="#F5EAD2" letterSpacing="0.6">TRACK</text>
        <text x="100" y="109" textAnchor="middle" fontFamily="Righteous,sans-serif" fontSize="8.5" fill="#F5EAD2" letterSpacing="0.6">RECORD</text>
      </svg>
    </div>
    {/* Tonearm: pivot at (60,15) in SVG coords, rotates around that point */}
    <svg
      width="70" height="170"
      viewBox="0 0 70 170"
      className={'nd-arm' + (playing ? ' nd-arm-play' : '')}
      aria-hidden="true"
    >
      <line x1="60" y1="15" x2="67" y2="4" stroke="#a48a67" strokeWidth="3" strokeLinecap="round" />
      <circle cx="67" cy="2" r="5.5" fill="#2e221a" stroke="#8a7455" strokeWidth="1.5" />
      <circle cx="60" cy="15" r="7.5" fill="#2e221a" stroke="#a48a67" strokeWidth="1.5" />
      <circle cx="60" cy="15" r="3" fill="#c8a878" />
      <line x1="60" y1="15" x2="8" y2="155" stroke="#b09870" strokeWidth="3.2" strokeLinecap="round" />
      <line x1="8" y1="155" x2="1" y2="145" stroke="#b09870" strokeWidth="2.5" strokeLinecap="round" />
      <line x1="8" y1="155" x2="14" y2="148" stroke="#8a7455" strokeWidth="1.5" strokeLinecap="round" />
      <circle cx="1" cy="144" r="2" fill="#d4aa70" />
    </svg>
  </div>
);

type Player = { id: string; name: string; score: number };
type Phase = 'setup' | 'song' | 'handoff' | 'year' | 'reveal' | 'board' | 'end';

export default function NeedleDrop() {
  const [phase, setPhase] = useState<Phase>('setup');
  const [names, setNames] = useState<string[]>(['', '']);
  const [players, setPlayers] = useState<Player[]>([]);
  const [range, setRange] = useState<[number, number]>([YMIN, YMAX]);
  const [customActive, setCustomActive] = useState(false);
  const [lastCustom, setLastCustom] = useState<[number, number] | null>(null);
  const [spanWarn, setSpanWarn] = useState(false);
  const [tier, setTier] = useState<3 | 5 | 10>(5);
  const [genre, setGenre] = useState<Genre>('Any');
  const [round, setRound] = useState(0);

  const [tracks, setTracks] = useState<Track[]>([]);
  const [loadState, setLoadState] = useState<'loading' | 'ready' | 'failed'>('loading');
  const [target, setTarget] = useState<number | null>(null);
  const [sIdx, setSIdx] = useState(0);
  const [revealed, setRevealed] = useState(false);
  const [tClosed, setTClosed] = useState(false);
  const [aClosed, setAClosed] = useState(false);
  const [tAwarded, setTAwarded] = useState(new Set<string>());
  const [aAwarded, setAAwarded] = useState(new Set<string>());

  const [gIdx, setGIdx] = useState(0);
  const [tuner, setTuner] = useState(YMIN);
  const [guesses, setGuesses] = useState<Record<string, number>>({});
  const [yRes, setYRes] = useState<{ pid: string; name: string; guess: number; pts: number }[]>([]);

  const [prevRanks, setPrevRanks] = useState<Record<string, number>>({});
  const [roundStartScores, setRoundStartScores] = useState<Record<string, number>>({});
  const [revealYear, setRevealYear] = useState(0);
  const [revealDone, setRevealDone] = useState(false);
  const [showHowToPlay, setShowHowToPlay] = useState(false);

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const roundSeq = useRef(0);
  const [playing, setPlaying] = useState(false);
  const tick = useTick();

  const [rMin, rMax] = range;
  const activePreset = ERA_PRESETS.findIndex((p) => p.min === rMin && p.max === rMax);
  const pool = useMemo(
    () => SONGS.filter((s) =>
      s.y >= rMin && s.y <= rMax && s.p <= tier && (genre === 'Any' || s.g === genre) && (s.w ?? 0) >= MIN_WEEKS
    ),
    [rMin, rMax, tier, genre]
  );
  const poolYears = useMemo(() => {
    const m: Record<number, number> = {};
    pool.forEach((s) => { m[s.y] = (m[s.y] || 0) + 1; });
    return Object.keys(m).map(Number).filter((y) => m[y] >= 3);
  }, [pool]);
  const emptySuggestion = useMemo((): string | null => {
    if (poolYears.length > 0) return null;
    const playable = (songs: SongData[]) => {
      const m: Record<number, number> = {};
      songs.forEach((s) => { m[s.y] = (m[s.y] || 0) + 1; });
      return Object.values(m).some((n) => n >= 3);
    };
    if (genre !== 'Any') {
      if (playable(SONGS.filter((s) => s.y >= rMin && s.y <= rMax && s.p <= tier && (s.w ?? 0) >= MIN_WEEKS)))
        return `Try Any genre instead of ${genre}.`;
    }
    if (tier !== 10) {
      if (playable(SONGS.filter((s) => s.y >= rMin && s.y <= rMax && s.p <= 10 && (genre === 'Any' || s.g === genre) && (s.w ?? 0) >= MIN_WEEKS)))
        return `Try Top 10 instead of Top ${tier}.`;
    }
    if (rMin !== YMIN || rMax !== YMAX) {
      if (playable(SONGS.filter((s) => s.p <= tier && (genre === 'Any' || s.g === genre) && (s.w ?? 0) >= MIN_WEEKS)))
        return 'Try Everything instead of this range.';
    }
    return 'Try loosening all filters.';
  }, [poolYears, genre, tier, rMin, rMax]);
  const midYear = Math.round((rMin + rMax) / 2);

  /* Reveal count-up: accelerating ticks then landing sting */
  useEffect(() => {
    if (phase !== 'reveal' || target === null) return;
    setRevealDone(false);
    const reduced = typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduced) { setRevealYear(target); setRevealDone(true); return; }
    const startYear = target - 15;
    setRevealYear(startYear);
    let curr = startYear;
    let cancelled = false;
    let tid: ReturnType<typeof setTimeout>;
    const step = () => {
      if (cancelled) return;
      if (curr >= target) { setRevealDone(true); playRevealSting(); return; }
      curr++;
      setRevealYear(curr);
      playRevealTick(target - curr);
      tid = setTimeout(step, Math.max(25, 20 + (target - curr) * 7));
    };
    tid = setTimeout(step, 450);
    return () => { cancelled = true; clearTimeout(tid); };
  }, [phase, target]);

  function startRound() {
    const seq = ++roundSeq.current;
    setLoadState('loading'); setTracks([]);
    setSIdx(0); setRevealed(false);
    setTClosed(false); setAClosed(false);
    setTAwarded(new Set()); setAAwarded(new Set());
    const yr = poolYears[Math.floor(Math.random() * poolYears.length)];
    setTarget(yr);
    const yearPool = pool.filter((s) => s.y === yr);
    const weighted = [...yearPool].sort((a, b) => ((b.w ?? 0) + Math.random() * 8) - ((a.w ?? 0) + Math.random() * 8));
    const candidates = [...weighted.filter((s) => s.preview !== null), ...weighted.filter((s) => s.preview === null)];
    resolveRound(candidates, 3).then((found) => {
      if (roundSeq.current !== seq) return;
      if (found.length >= 3) { setTracks(found.slice(0, 3)); setLoadState('ready'); }
      else if (found.length > 0) { setTracks(found); setLoadState('ready'); }
      else setLoadState('failed');
    });
  }

  const pickPreset = (min: number, max: number) => {
    setRange([min, max]); setCustomActive(false); setSpanWarn(false);
  };
  const openCustom = () => {
    const c = lastCustom ?? range;
    setRange(c); setLastCustom(c); setCustomActive(true); setSpanWarn(false);
  };
  const applyCustom = (a: number, b: number, warn: boolean) => {
    const pair: [number, number] = [a, b];
    setRange(pair); setLastCustom(pair); setSpanWarn(warn);
  };
  const setCustomStart = (raw: number) => {
    if (Number.isNaN(raw)) return;
    const v = Math.min(clampYear(raw), YMAX - (MIN_SPAN - 1));
    let end = rMax, warn = false;
    if (end < v + (MIN_SPAN - 1)) { end = v + (MIN_SPAN - 1); warn = true; }
    applyCustom(v, end, warn);
  };
  const setCustomEnd = (raw: number) => {
    if (Number.isNaN(raw)) return;
    const v = Math.max(clampYear(raw), YMIN + (MIN_SPAN - 1));
    let start = rMin, warn = false;
    if (start > v - (MIN_SPAN - 1)) { start = v - (MIN_SPAN - 1); warn = true; }
    applyCustom(start, v, warn);
  };

  function start() {
    const ps = names.map((n) => n.trim()).filter(Boolean).map((n, i) => ({ id: i + ':' + n, name: n, score: 0 }));
    if (ps.length === 0) return;
    setPlayers(ps); setPrevRanks({});
    setRoundStartScores(Object.fromEntries(ps.map((p) => [p.id, 0])));
    setRound(1); startRound(); setPhase('song');
  }

  function stopAudio() { const a = audioRef.current; if (a) a.pause(); setPlaying(false); }

  async function togglePlay(t: Track) {
    const a = audioRef.current; if (!a) return;
    if (playing) { a.pause(); setPlaying(false); return; }
    try {
      if (!a.src || !a.src.includes(t.preview)) { a.src = t.preview; a.currentTime = 0; }
      await a.play();
      setPlaying(true);
      playTonearmClick();
    } catch { setPlaying(false); }
  }

  const awardPlayer = (pid: string, kind: 't' | 'a') => {
    setPlayers((ps) => ps.map((p) => p.id === pid ? { ...p, score: p.score + 1 } : p));
    if (kind === 't') setTAwarded((s) => new Set([...s, pid]));
    else setAAwarded((s) => new Set([...s, pid]));
  };

  const closeCategory = (kind: 't' | 'a') => {
    if (kind === 't') setTClosed(true); else setAClosed(true);
  };

  function nextSong() {
    stopAudio();
    if (sIdx < tracks.length - 1) {
      setSIdx((i) => i + 1); setRevealed(false);
      setTClosed(false); setAClosed(false);
      setTAwarded(new Set()); setAAwarded(new Set());
    } else { setGIdx(0); setGuesses({}); setPhase('handoff'); }
  }

  function beginGuess() { setTuner(midYear); setPhase('year'); }

  function lockYear() {
    const p = players[gIdx];
    const g = { ...guesses, [p.id]: tuner };
    setGuesses(g);
    if (gIdx < players.length - 1) { setGIdx((i) => i + 1); setPhase('handoff'); }
    else {
      const res = players.map((pl) => ({
        pid: pl.id, name: pl.name, guess: g[pl.id],
        pts: yearPts(Math.abs(g[pl.id] - (target as number))),
      }));
      setYRes(res);
      setPlayers((ps) => ps.map((pl) => { const r = res.find((x) => x.pid === pl.id); return { ...pl, score: pl.score + (r ? r.pts : 0) }; }));
      setPhase('reveal');
    }
  }

  const nextRound = () => {
    const currentSorted = [...players].sort((a, b) => b.score - a.score);
    const ranks: Record<string, number> = {};
    currentSorted.forEach((p, i) => { ranks[p.id] = i + 1; });
    setPrevRanks(ranks);
    setRoundStartScores(Object.fromEntries(players.map((p) => [p.id, p.score])));
    setRound((r) => r + 1); startRound(); setPhase('song');
  };

  const playAgain = () => {
    setPrevRanks({});
    setPlayers((ps) => ps.map((p) => ({ ...p, score: 0 })));
    setRoundStartScores(Object.fromEntries(players.map((p) => [p.id, 0])));
    setRound(1); startRound(); setPhase('song');
  };

  const sorted = [...players].sort((a, b) => b.score - a.score);
  const song = tracks[sIdx];
  const onDial = (v: number) => { if (v !== tuner) { tick(); setTuner(v); } };
  const nudge = (delta: number) => {
    const v = Math.max(rMin, Math.min(rMax, tuner + delta));
    if (v !== tuner) { tick(); setTuner(v); }
  };

  useEffect(() => () => stopAudio(), []);

  const ticks: { y: number; pct: number; dec: boolean }[] = [];
  for (let y = Math.ceil(rMin / 5) * 5; y <= rMax; y += 5) {
    ticks.push({ y, pct: ((y - rMin) / (rMax - rMin)) * 100, dec: y % 10 === 0 });
  }

  const revealProgress = target !== null
    ? (revealDone ? 1 : Math.max(0, (revealYear - (target - 15)) / 15))
    : 0;

  const ChartRow = ({ p, rank }: { p: Player; rank: number }) => {
    const prev = prevRanks[p.id];
    const move = prev !== undefined ? prev - rank : null;
    const delta = p.score - (roundStartScores[p.id] ?? 0);
    return (
      <div className={'chart-row' + (rank === 1 ? ' lead' : '')}>
        <div className="chart-pos">
          {rank === 1 ? <span className="chart-pos-1">1</span> : rank}
        </div>
        <div style={{ flex: 1, fontWeight: 600 }}>{p.name}</div>
        {move !== null && (
          <div className={'chart-move ' + (move > 0 ? 'nd-up' : move < 0 ? 'nd-down' : 'nd-hold')}>
            {move > 0 ? `▲${move}` : move < 0 ? `▼${Math.abs(move)}` : '='}
          </div>
        )}
        <div className={'chart-delta ' + (delta > 0 ? 'up' : 'zero')}>+{delta}</div>
        <div className="chart-score">{p.score}</div>
      </div>
    );
  };

  return (
    <div className="nd">
      <style>{CSS}</style>
      <audio ref={audioRef} onEnded={() => setPlaying(false)} />
      <div className="wrap">

        {/* ===== SETUP ===== */}
        {phase === 'setup' && (
          <>
            <div style={{ textAlign: 'center', marginBottom: 6 }}>
              <div className="eyebrow" style={{ marginBottom: 10 }}>Top chart hits &middot; {YMIN}&ndash;{YMAX}</div>
              <div className="disp" style={{ fontSize: 76 }}>TRACK<br />RECORD</div>
              <div className="muted" style={{ marginTop: 10 }}>Name the song. Tune in the year.</div>
            </div>
            <div className="flip-scene" style={{ marginTop: 20 }}>
              <div className={'flip-card' + (showHowToPlay ? ' nd-flipped' : '')}>

                {/* Front: setup form */}
                <div className="flip-front card">
                  <div className="eyebrow" style={{ marginBottom: 12 }}>Players</div>
                  {names.map((n, i) => (
                    <div className="row" key={i} style={{ marginBottom: 8, flexWrap: 'nowrap' }}>
                      <input className="name" placeholder={'Player ' + (i + 1)} value={n}
                        onChange={(e) => setNames((a) => a.map((x, k) => (k === i ? e.target.value : x)))} />
                      {names.length > 1 && (
                        <button className="btn sm" onClick={() => setNames((a) => a.filter((_, k) => k !== i))}>&times;</button>
                      )}
                    </div>
                  ))}
                  {names.length < 8 && (
                    <button className="btn sm" style={{ marginTop: 4 }} onClick={() => setNames((a) => [...a, ''])}>+ Add player</button>
                  )}

                  <div className="eyebrow" style={{ margin: '20px 0 10px' }}>Era</div>
                  <div className="row">
                    {ERA_PRESETS.map((e, i) => (
                      <button key={i} className={'chip' + (!customActive && activePreset === i ? ' on' : '')} onClick={() => pickPreset(e.min, e.max)}>{e.label}</button>
                    ))}
                    <button className={'chip' + (customActive ? ' on' : '')} onClick={openCustom}>Custom</button>
                  </div>
                  {customActive && (
                    <div style={{ marginTop: 12 }}>
                      <div className="row" style={{ alignItems: 'center', gap: 10, flexWrap: 'nowrap' }}>
                        <select className="yr" value={rMin} onChange={(e) => setCustomStart(+e.target.value)} aria-label="Start year">
                          {YEARS.map((y) => <option key={y} value={y}>{y}</option>)}
                        </select>
                        <span className="muted mono" style={{ fontSize: 13 }}>to</span>
                        <select className="yr" value={rMax} onChange={(e) => setCustomEnd(+e.target.value)} aria-label="End year">
                          {YEARS.map((y) => <option key={y} value={y}>{y}</option>)}
                        </select>
                      </div>
                      {spanWarn && (
                        <div className="hint" style={{ color: 'var(--red)', marginTop: 8 }}>
                          Track Record needs at least a decade to keep the guessing honest.
                        </div>
                      )}
                    </div>
                  )}

                  <div className="eyebrow" style={{ margin: '20px 0 10px' }}>Peak tier</div>
                  <div className="row">
                    {([3, 5, 10] as const).map((t) => (
                      <button key={t} className={'chip' + (tier === t ? ' on' : '')} onClick={() => setTier(t)}>Top {t}</button>
                    ))}
                  </div>
                  {tier === 3 && (
                    <div className="muted hint" style={{ marginTop: 6, fontSize: 12 }}>Strictest pool. Fewer years in play.</div>
                  )}

                  <div className="eyebrow" style={{ margin: '20px 0 10px' }}>Genre</div>
                  <div className="row">
                    {GENRES.map((g) => (
                      <button key={g} className={'chip' + (genre === g ? ' on' : '')} onClick={() => setGenre(g)}>{g}</button>
                    ))}
                  </div>

                  {!poolYears.length && emptySuggestion && (
                    <div className="hint" style={{ color: 'var(--red)', marginTop: 12, textAlign: 'center' }}>
                      No years match. {emptySuggestion}
                    </div>
                  )}
                  <button className="btn primary wide" style={{ marginTop: 22 }} disabled={!poolYears.length} onClick={start}>
                    Start game &#9654;
                  </button>
                  <button className="btn wide" style={{ marginTop: 8 }} onClick={() => setShowHowToPlay(true)}>
                    How to play
                  </button>
                </div>

                {/* Back: rules as numbered tracklist */}
                <div className="flip-back card">
                  <div className="eyebrow" style={{ marginBottom: 14 }}>Side B &middot; How to play</div>
                  <div>
                    {[
                      { text: 'Three songs from the same year play back-to-back.' },
                      { text: 'Name the song.', sub: '+1 point per player who gets it' },
                      { text: 'Name the artist.', sub: '+1 point per player who gets it' },
                      { text: 'Each player tunes the dial to guess the year.' },
                      { text: 'Year scoring.', sub: 'Exact +5 · within 1 yr +3 · within 3 yrs +1' },
                    ].map((item, i) => (
                      <div key={i} className="tl-item">
                        <div className="tl-num">{String(i + 1).padStart(2, '0')}</div>
                        <div className="tl-text">
                          {item.text}
                          {item.sub && <span className="tl-sub">{item.sub}</span>}
                        </div>
                      </div>
                    ))}
                  </div>
                  <button className="btn wide" style={{ marginTop: 20 }} onClick={() => setShowHowToPlay(false)}>
                    &#8592; Back
                  </button>
                </div>

              </div>
            </div>
            <div className="muted hint" style={{ textAlign: 'center', marginTop: 14, lineHeight: 1.5 }}>
              Song +1 &middot; Artist +1 &middot; Year: exact <b style={{ color: 'var(--cream)' }}>5</b>, within 1 yr <b style={{ color: 'var(--cream)' }}>3</b>, within 3 yrs <b style={{ color: 'var(--cream)' }}>1</b>
            </div>
          </>
        )}

        {/* ===== SONG ===== */}
        {phase === 'song' && (
          <>
            <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
              <div className="eyebrow">Round {round} &middot; Song {Math.min(sIdx + 1, 3)} of {tracks.length || 3}</div>
              <div className="eyebrow muted">Year: ????</div>
            </div>

            <Turntable playing={playing} />

            <div className="card" style={{ textAlign: 'center' }}>
              {loadState === 'loading' && (
                <>
                  <div style={{ display: 'flex', justifyContent: 'center', margin: '6px 0 16px' }}>
                    <VuMeter active={false} />
                  </div>
                  <div className="muted">Dropping the needle&hellip;</div>
                </>
              )}
              {loadState === 'failed' && (
                <>
                  <div className="muted" style={{ marginBottom: 14 }}>Couldn&apos;t tune in that year. Likely a network hiccup.</div>
                  <button className="btn primary" onClick={startRound}>Spin again &#8635;</button>
                </>
              )}
              {loadState === 'ready' && song && (
                <>
                  <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 16 }}>
                    <VuMeter active={playing} />
                  </div>
                  <button className="btn primary" onClick={() => togglePlay(song)} style={{ fontSize: 17, padding: '14px 26px' }}>
                    {playing ? '⏸ Pause' : '▶ Play clip'}
                  </button>

                  {!revealed ? (
                    <button className="btn wide" style={{ marginTop: 22 }} onClick={() => setRevealed(true)}>
                      Reveal answer
                    </button>
                  ) : (
                    <div style={{ marginTop: 22, textAlign: 'left' }}>
                      <div>
                        <div className="title2">{song.t}</div>
                        <div style={{ color: 'var(--amber)', fontWeight: 600, marginTop: 2 }}>{song.a}</div>
                        <div className="muted hint mono" style={{ marginTop: 4 }}>hit #{song.p}</div>
                      </div>

                      <div className="muted hint" style={{ marginTop: 18, textAlign: 'center' }}>Tap who called it</div>
                      <div className="eyebrow" style={{ margin: '6px 0 8px' }}>Who named the song? +1</div>
                      <div className="row">
                        {players.map((p) => (
                          <button key={p.id} className="btn sm" disabled={tClosed || tAwarded.has(p.id)}
                            onClick={() => awardPlayer(p.id, 't')}>
                            {tAwarded.has(p.id) ? '✓ ' + p.name : p.name}
                          </button>
                        ))}
                        {tAwarded.size === 0 && (
                          <button className="btn sm" disabled={tClosed} onClick={() => closeCategory('t')}>Nobody</button>
                        )}
                        {tAwarded.size > 0 && !tClosed && (
                          <button className="btn sm" onClick={() => closeCategory('t')}>Done</button>
                        )}
                      </div>

                      <div className="eyebrow" style={{ margin: '16px 0 8px' }}>Who named the artist? +1</div>
                      <div className="row">
                        {players.map((p) => (
                          <button key={p.id} className="btn sm" disabled={aClosed || aAwarded.has(p.id)}
                            onClick={() => awardPlayer(p.id, 'a')}>
                            {aAwarded.has(p.id) ? '✓ ' + p.name : p.name}
                          </button>
                        ))}
                        {aAwarded.size === 0 && (
                          <button className="btn sm" disabled={aClosed} onClick={() => closeCategory('a')}>Nobody</button>
                        )}
                        {aAwarded.size > 0 && !aClosed && (
                          <button className="btn sm" onClick={() => closeCategory('a')}>Done</button>
                        )}
                      </div>

                      <button className="btn primary wide" style={{ marginTop: 22 }} disabled={!(tClosed && aClosed)}
                        onClick={nextSong}>
                        {sIdx < tracks.length - 1 ? 'Next song ▶' : 'Tune in the year ▶'}
                      </button>
                    </div>
                  )}
                </>
              )}
            </div>
          </>
        )}

        {/* ===== HANDOFF ===== */}
        {phase === 'handoff' && (
          <div className="card gate">
            <div className="eyebrow" style={{ marginBottom: 14 }}>Round {round} &middot; Year guess</div>
            <div className="muted">Pass the phone to</div>
            <div className="disp" style={{ fontSize: 56, margin: '6px 0 18px', color: 'var(--amberhi)' }}>
              {players[gIdx].name}
            </div>
            <div className="muted hint" style={{ marginBottom: 22 }}>Everyone else, eyes up. Guesses stay secret.</div>
            <button className="btn primary wide" onClick={beginGuess}>
              I&apos;m {players[gIdx].name}, show the dial ▶
            </button>
            <div className="dots" style={{ marginTop: 18 }}>
              {players.map((p, i) => (
                <div key={p.id} className={'dot' + (i === gIdx ? ' on' : i < gIdx ? ' done' : '')} />
              ))}
            </div>
          </div>
        )}

        {/* ===== YEAR ===== */}
        {phase === 'year' && (
          <>
            <div className="eyebrow" style={{ marginBottom: 16 }}>Round {round} &middot; Tune in the year</div>
            <div className="card">
              <div style={{ textAlign: 'center' }}>
                <div className="title2" style={{ margin: '2px 0 14px' }}>{players[gIdx].name}</div>
              </div>
              <div className="yearbig">{tuner}</div>
              <div className="tuner">
                <div className="ticks">
                  {ticks.map((t) => (
                    <React.Fragment key={t.y}>
                      <div className={'tick' + (t.dec ? ' dec' : '')} style={{ left: t.pct + '%' }} />
                      {t.dec && (
                        <div className="ticklab" style={{ left: t.pct + '%' }}>&apos;{String(t.y).slice(2)}</div>
                      )}
                    </React.Fragment>
                  ))}
                </div>
                <input className="dial" type="range" min={rMin} max={rMax} value={tuner}
                  onChange={(e) => onDial(+e.target.value)} />
              </div>
              <div className="nudge-row">
                <button className="btn nd-nudge" onClick={() => nudge(-1)} aria-label="Year minus 1">&minus;</button>
                <button className="btn primary" style={{ flex: 1 }} onClick={lockYear}>Lock in ▶</button>
                <button className="btn nd-nudge" onClick={() => nudge(+1)} aria-label="Year plus 1">+</button>
              </div>
              <div className="score-hint">Exact 5 &middot; &plusmn;1 yr 3 &middot; &plusmn;3 yrs 1</div>
              <div style={{ marginTop: 16, paddingTop: 14, borderTop: '1px solid var(--line)' }}>
                <div className="eyebrow muted" style={{ marginBottom: 8 }}>This round&apos;s songs</div>
                {tracks.map((s, i) => (
                  <div key={i} className="muted hint" style={{ marginBottom: 4 }}>
                    {s.t} &middot; {s.a}
                  </div>
                ))}
              </div>
            </div>
          </>
        )}

        {/* ===== REVEAL ===== */}
        {phase === 'reveal' && (
          <>
            <div className="eyebrow" style={{ textAlign: 'center', marginBottom: 8 }}>
              {revealDone ? 'The year was' : 'Tuning in the year…'}
            </div>
            <div className="reveal-yr">{revealYear || target}</div>
            {!revealDone && (
              <div className="reveal-sweep">
                <div className="reveal-sweep-fill" style={{ width: Math.round(revealProgress * 100) + '%' }} />
              </div>
            )}
            {revealDone && (
              <div className="card" style={{ marginTop: 20 }}>
                <div className="eyebrow" style={{ marginBottom: 10 }}>The songs</div>
                {tracks.map((s, i) => (
                  <div key={i} className="row" style={{ alignItems: 'center', flexWrap: 'nowrap', gap: 12, marginBottom: 10 }}>
                    {s.art && <img className="revealart" src={s.art} alt="" style={{ width: 48, height: 48 }} />}
                    <div>
                      <span style={{ fontWeight: 600 }}>{s.t}</span>{' '}
                      <span className="muted">&middot; {s.a}</span>
                    </div>
                  </div>
                ))}
                <div className="eyebrow" style={{ margin: '18px 0 10px' }}>Year scoring</div>
                {yRes.map((r) => (
                  <div className="standing" key={r.pid}>
                    <div><b>{r.name}</b> <span className="muted mono" style={{ fontSize: 13 }}>guessed {r.guess}</span></div>
                    <div className={'pts ' + (r.pts > 0 ? 'win' : 'zero')}>+{r.pts}</div>
                  </div>
                ))}
                <button className="btn primary wide" style={{ marginTop: 14 }} onClick={() => setPhase('board')}>
                  Continue ▶
                </button>
              </div>
            )}
          </>
        )}

        {/* ===== BOARD ===== */}
        {phase === 'board' && (
          <>
            <div className="eyebrow" style={{ marginBottom: 16 }}>After round {round}</div>
            <div className="card">
              {sorted.map((p, i) => <ChartRow key={p.id} p={p} rank={i + 1} />)}
              <button className="btn primary wide" style={{ marginTop: 14 }} onClick={nextRound}>Next round ▶</button>
              <button className="btn wide" style={{ marginTop: 8 }} onClick={() => setPhase('end')}>End game</button>
            </div>
          </>
        )}

        {/* ===== END ===== */}
        {phase === 'end' && (
          <>
            <div className="eyebrow" style={{ textAlign: 'center', marginBottom: 6 }}>#1 on the chart</div>
            <div className="disp" style={{ fontSize: 60, textAlign: 'center', color: 'var(--amberhi)', marginBottom: 4 }}>
              {sorted[0].name}
            </div>
            <div style={{ display: 'flex', justifyContent: 'center', margin: '8px 0 20px' }}>
              <VuMeter active={true} />
            </div>
            <div className="card">
              <div className="eyebrow" style={{ marginBottom: 12 }}>Final standings</div>
              {sorted.map((p, i) => <ChartRow key={p.id} p={p} rank={i + 1} />)}
              <button className="btn primary wide" style={{ marginTop: 14 }} onClick={playAgain}>
                Play again (same crew) ▶
              </button>
              <button className="btn wide" style={{ marginTop: 8 }} onClick={() => setPhase('setup')}>
                New game
              </button>
            </div>
          </>
        )}

      </div>
    </div>
  );
}
