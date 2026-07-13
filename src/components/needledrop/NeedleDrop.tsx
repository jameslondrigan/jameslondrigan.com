import React, { useState, useMemo, useRef, useEffect } from 'react';
import SONGS_DATA from '../../data/needledrop-songs.json';

/* ============================================================
   Needle Drop — production island (client:only="react")
   - Enriched data: songs with baked preview URLs play instantly.
   - JSONP live-resolution (iTunes API) is the fallback for songs
     without a baked preview, preserving the auto-swap behavior.
   - Handoff gate before each year guess; tick sound + vibration
     on the tuner dial.
   CSP note: allow script-src itunes.apple.com (JSONP) and
   media-src *.itunes.apple.com / *.mzstatic.com (clips + art).
   ============================================================ */

type SongData = { y: number; t: string; a: string; p: number; w?: number; preview: string | null; art: string | null; g: string };
type Track = SongData & { preview: string };

const SONGS = SONGS_DATA as SongData[];

const GENRES = ['Any', 'Rock', 'Pop', 'Country', 'Hip-Hop/R&B', 'Dance/Electronic', 'Other'] as const;
type Genre = typeof GENRES[number];
const YEARS = [...new Set(SONGS.map((s) => s.y))].sort((a, b) => a - b);
const YMIN = YEARS[0], YMAX = YEARS[YEARS.length - 1];

const ERAS = [
  { label: 'Everything', min: YMIN, max: YMAX },
  { label: "'60s\u2013'70s", min: 1960, max: 1979 },
  { label: "'80s\u2013'90s", min: 1980, max: 1999 },
  { label: '2000s on', min: 2000, max: YMAX },
];

const yearPts = (d: number) => (d === 0 ? 5 : d <= 1 ? 3 : d <= 3 ? 1 : 0);
const shuffle = <T,>(a: T[]): T[] => { const r = [...a]; for (let i = r.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [r[i], r[j]] = [r[j], r[i]]; } return r; };

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
    const cb = 'ndcb_' + Date.now() + '_' + Math.floor(Math.random() * 1e5);
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
  // Baked preview from enriched data — instant, no network
  if (s.preview) return { ...s, preview: s.preview } as Track;
  // JSONP live-resolution fallback for unenriched songs
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
  } catch { /* treated as unresolved; caller swaps in another song */ }
  resolveCache[key] = out;
  return out;
}

/** Build a round: baked-preview songs first (instant), JSONP fallback for null-preview songs. */
async function resolveRound(candidates: SongData[], want = 3): Promise<Track[]> {
  const found: Track[] = [];
  // Pass 1: baked previews (instant, no network)
  for (const c of candidates) {
    if (found.length >= want) break;
    if (c.preview) found.push({ ...c, preview: c.preview } as Track);
  }
  // Pass 2: JSONP live-resolution for remaining slots
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

/* ---------- tuner feedback: tick sound (all phones) + vibration (bonus) ---------- */
function useTick() {
  const ctxRef = useRef<AudioContext | null>(null);
  return () => {
    try {
      if (!ctxRef.current) ctxRef.current = new (window.AudioContext || (window as any).webkitAudioContext)();
      const ctx = ctxRef.current;
      if (ctx.state === 'suspended') ctx.resume();
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.type = 'square'; o.frequency.value = 1150;
      g.gain.setValueAtTime(0.06, ctx.currentTime);
      g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.03);
      o.connect(g); g.connect(ctx.destination);
      o.start(); o.stop(ctx.currentTime + 0.035);
    } catch { /* audio not available; silent fallback */ }
    if (navigator.vibrate) navigator.vibrate(8); // Android bonus; iOS Safari has no Vibration API
  };
}

/* ------------------------------ styles ------------------------------ */
const CSS = `
@import url('https://fonts.googleapis.com/css2?family=Bebas+Neue&family=Space+Grotesk:wght@400;500;600;700&family=JetBrains+Mono:wght@500;700&display=swap');
.nd, .nd * { box-sizing: border-box; margin: 0; padding: 0; }
.nd {
  --bg:#160f08; --panel:#211810; --panel2:#2c2114; --line:#3c2d1c;
  --amber:#F2A93B; --amberhi:#FFC768; --cream:#F5EAD2; --muted:#a48a67;
  --green:#93CB58; --red:#E4573C;
  min-height:100vh; background:
    radial-gradient(1200px 600px at 50% -10%, #2a1d0f 0%, transparent 60%),
    var(--bg);
  color:var(--cream); font-family:'Space Grotesk',system-ui,sans-serif;
  display:flex; align-items:flex-start; justify-content:center; padding:22px 16px 60px;
}
.nd .wrap { width:100%; max-width:560px; }
.nd .disp { font-family:'Bebas Neue',Impact,sans-serif; letter-spacing:.02em; line-height:.92; }
.nd .mono { font-family:'JetBrains Mono',monospace; }
.nd .eyebrow { font-family:'JetBrains Mono',monospace; font-size:11px; letter-spacing:.28em; text-transform:uppercase; color:var(--amber); }
.nd .muted { color:var(--muted); }
.nd .card { background:linear-gradient(180deg,var(--panel2),var(--panel)); border:1px solid var(--line); border-radius:18px; padding:22px; }
.nd .btn { font-family:'Space Grotesk',sans-serif; font-weight:600; font-size:15px; border:1px solid var(--line); background:var(--panel2); color:var(--cream); border-radius:12px; padding:12px 16px; cursor:pointer; transition:transform .06s ease, border-color .15s, background .15s; min-height:44px; }
.nd .btn:hover { border-color:var(--amber); }
.nd .btn:active { transform:translateY(1px); }
.nd .btn:disabled { opacity:.4; cursor:default; }
.nd .btn.primary { background:linear-gradient(180deg,var(--amberhi),var(--amber)); color:#2a1a06; border:none; box-shadow:0 6px 24px -8px var(--amber); }
.nd .btn.wide { width:100%; }
.nd .btn.sm { font-size:13px; padding:10px 14px; border-radius:10px; }
.nd .chip { font-family:'JetBrains Mono',monospace; font-size:12px; letter-spacing:.12em; text-transform:uppercase; padding:9px 13px; border-radius:999px; border:1px solid var(--line); background:transparent; color:var(--muted); cursor:pointer; min-height:38px; }
.nd .chip.on { color:#2a1a06; background:var(--amber); border-color:var(--amber); font-weight:700; }
.nd .row { display:flex; gap:8px; flex-wrap:wrap; }
.nd input.name { flex:1; background:#160f08; border:1px solid var(--line); border-radius:10px; padding:12px 13px; color:var(--cream); font-family:'Space Grotesk',sans-serif; font-size:16px; min-width:0; }
.nd input.name:focus { outline:none; border-color:var(--amber); }
.nd .eq { display:flex; align-items:flex-end; gap:5px; height:46px; }
.nd .eq span { width:6px; background:linear-gradient(var(--amberhi),var(--amber)); border-radius:3px; animation:ndbounce 900ms ease-in-out infinite; }
.nd .eq span:nth-child(1){animation-delay:0ms} .nd .eq span:nth-child(2){animation-delay:120ms} .nd .eq span:nth-child(3){animation-delay:240ms} .nd .eq span:nth-child(4){animation-delay:80ms} .nd .eq span:nth-child(5){animation-delay:300ms} .nd .eq span:nth-child(6){animation-delay:180ms} .nd .eq span:nth-child(7){animation-delay:40ms}
@keyframes ndbounce { 0%,100%{height:12px} 50%{height:46px} }
.nd .eq.idle span { animation-play-state:paused; height:14px; }
.nd .yearbig { font-family:'JetBrains Mono',monospace; font-weight:700; font-size:64px; color:var(--amberhi); text-shadow:0 0 26px rgba(242,169,59,.45); text-align:center; }
.nd .tuner { position:relative; margin:6px 0 2px; }
.nd .ticks { position:relative; height:22px; margin-bottom:6px; }
.nd .tick { position:absolute; top:0; width:1px; height:9px; background:var(--line); }
.nd .tick.dec { height:16px; background:var(--muted); }
.nd .ticklab { position:absolute; top:12px; transform:translateX(-50%); font-family:'JetBrains Mono',monospace; font-size:10px; color:var(--muted); }
.nd input[type=range].dial { -webkit-appearance:none; appearance:none; width:100%; height:8px; border-radius:6px; background:linear-gradient(90deg,#3a2c1c,#6b5330); outline:none; }
.nd input[type=range].dial::-webkit-slider-thumb { -webkit-appearance:none; appearance:none; width:14px; height:38px; border-radius:4px; background:linear-gradient(var(--amberhi),var(--amber)); box-shadow:0 0 16px 2px rgba(242,169,59,.6); cursor:pointer; }
.nd input[type=range].dial::-moz-range-thumb { width:14px; height:38px; border:none; border-radius:4px; background:var(--amber); box-shadow:0 0 16px 2px rgba(242,169,59,.6); cursor:pointer; }
.nd .standing { display:flex; align-items:center; justify-content:space-between; padding:13px 15px; border-radius:12px; background:var(--panel2); border:1px solid var(--line); margin-bottom:8px; }
.nd .standing.lead { border-color:var(--amber); background:linear-gradient(180deg,#33260f,var(--panel2)); }
.nd .score { font-family:'Bebas Neue',sans-serif; font-size:30px; color:var(--amberhi); }
.nd .pts { font-family:'Bebas Neue',sans-serif; font-size:22px; }
.nd .pts.win { color:var(--green); } .nd .pts.zero { color:var(--muted); }
.nd .dots { display:flex; gap:6px; justify-content:center; }
.nd .dot { width:8px; height:8px; border-radius:50%; background:var(--line); }
.nd .dot.on { background:var(--amber); }
.nd .dot.done { background:var(--muted); }
.nd .title2 { font-family:'Bebas Neue',sans-serif; font-size:34px; line-height:1; letter-spacing:.01em; }
.nd .hint { font-size:13px; }
.nd .revealart { width:72px; height:72px; border-radius:10px; border:1px solid var(--line); object-fit:cover; }
.nd .gate { text-align:center; padding:46px 22px; }
@media (prefers-reduced-motion: reduce){ .nd .eq span{ animation:none; height:30px; } }
`;

const Eq = ({ idle = false }: { idle?: boolean }) => (
  <div className={'eq' + (idle ? ' idle' : '')} aria-hidden="true">
    {Array.from({ length: 7 }).map((_, i) => <span key={i} />)}
  </div>
);

type Player = { id: string; name: string; score: number };
type Phase = 'setup' | 'song' | 'handoff' | 'year' | 'reveal' | 'board' | 'end';

export default function NeedleDrop() {
  const [phase, setPhase] = useState<Phase>('setup');
  const [names, setNames] = useState<string[]>(['', '']);
  const [players, setPlayers] = useState<Player[]>([]);
  const [eraIdx, setEraIdx] = useState(0);
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

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const roundSeq = useRef(0);
  const [playing, setPlaying] = useState(false);
  const tick = useTick();

  const era = ERAS[eraIdx];
  const pool = useMemo(
    () => SONGS.filter((s) =>
      s.y >= era.min && s.y <= era.max && s.p <= tier && (genre === 'Any' || s.g === genre)
    ),
    [eraIdx, tier, genre]
  );
  const poolYears = useMemo(() => {
    const m: Record<number, number> = {};
    pool.forEach((s) => { m[s.y] = (m[s.y] || 0) + 1; });
    return Object.keys(m).map(Number).filter((y) => m[y] >= 3);
  }, [pool]);
  const midYear = Math.round((era.min + era.max) / 2);

  /** Start a round: pick a year, resolve clips — baked previews first, JSONP fallback for nulls. */
  function startRound() {
    const seq = ++roundSeq.current;
    setLoadState('loading'); setTracks([]);
    setSIdx(0); setRevealed(false);
    setTClosed(false); setAClosed(false);
    setTAwarded(new Set()); setAAwarded(new Set());
    const yr = poolYears[Math.floor(Math.random() * poolYears.length)];
    setTarget(yr);
    const shuffled = shuffle(pool.filter((s) => s.y === yr));
    // Baked previews first so rounds start instantly when data is enriched
    const candidates = [...shuffled.filter(s => s.preview !== null), ...shuffled.filter(s => s.preview === null)];
    resolveRound(candidates, 3).then((found) => {
      if (roundSeq.current !== seq) return;
      if (found.length >= 3) { setTracks(found.slice(0, 3)); setLoadState('ready'); }
      else if (found.length > 0) { setTracks(found); setLoadState('ready'); }
      else setLoadState('failed');
    });
  }

  function start() {
    const ps = names.map((n) => n.trim()).filter(Boolean).map((n, i) => ({ id: i + ':' + n, name: n, score: 0 }));
    if (ps.length === 0) return;
    setPlayers(ps); setRound(1); startRound(); setPhase('song');
  }

  function stopAudio() { const a = audioRef.current; if (a) a.pause(); setPlaying(false); }

  async function togglePlay(t: Track) {
    const a = audioRef.current; if (!a) return;
    if (playing) { a.pause(); setPlaying(false); return; }
    try {
      if (!a.src || !a.src.includes(t.preview)) { a.src = t.preview; a.currentTime = 0; }
      await a.play(); setPlaying(true);
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
      const res = players.map((pl) => ({ pid: pl.id, name: pl.name, guess: g[pl.id], pts: yearPts(Math.abs(g[pl.id] - (target as number))) }));
      setYRes(res);
      setPlayers((ps) => ps.map((pl) => { const r = res.find((x) => x.pid === pl.id); return { ...pl, score: pl.score + (r ? r.pts : 0) }; }));
      setPhase('reveal');
    }
  }

  const nextRound = () => { setRound((r) => r + 1); startRound(); setPhase('song'); };
  const playAgain = () => { setPlayers((ps) => ps.map((p) => ({ ...p, score: 0 }))); setRound(1); startRound(); setPhase('song'); };
  const sorted = [...players].sort((a, b) => b.score - a.score);
  const song = tracks[sIdx];

  const onDial = (v: number) => { if (v !== tuner) { tick(); setTuner(v); } };

  useEffect(() => () => stopAudio(), []);

  const ticks: { y: number; pct: number; dec: boolean }[] = [];
  for (let y = Math.ceil(era.min / 5) * 5; y <= era.max; y += 5) {
    ticks.push({ y, pct: ((y - era.min) / (era.max - era.min)) * 100, dec: y % 10 === 0 });
  }

  return (
    <div className="nd">
      <style>{CSS}</style>
      <audio ref={audioRef} onEnded={() => setPlaying(false)} />
      <div className="wrap">

        {phase === 'setup' && (
          <>
            <div style={{ textAlign: 'center', marginBottom: 6 }}>
              <div className="eyebrow" style={{ marginBottom: 10 }}>Billboard Hot 100 · {YMIN}–{YMAX}</div>
              <div className="disp" style={{ fontSize: 78 }}>NEEDLE<br />DROP</div>
              <div className="muted" style={{ marginTop: 8 }}>Name the song, then tune in the year it hit the top 10.</div>
            </div>
            <div className="card" style={{ marginTop: 20 }}>
              <div className="eyebrow" style={{ marginBottom: 12 }}>Players</div>
              {names.map((n, i) => (
                <div className="row" key={i} style={{ marginBottom: 8, flexWrap: 'nowrap' }}>
                  <input className="name" placeholder={'Player ' + (i + 1)} value={n}
                    onChange={(e) => setNames((a) => a.map((x, k) => (k === i ? e.target.value : x)))} />
                  {names.length > 1 && <button className="btn sm" onClick={() => setNames((a) => a.filter((_, k) => k !== i))}>✕</button>}
                </div>
              ))}
              {names.length < 8 && <button className="btn sm" style={{ marginTop: 4 }} onClick={() => setNames((a) => [...a, ''])}>+ Add player</button>}

              <div className="eyebrow" style={{ margin: '20px 0 10px' }}>Era</div>
              <div className="row">
                {ERAS.map((e, i) => (
                  <button key={i} className={'chip' + (eraIdx === i ? ' on' : '')} onClick={() => setEraIdx(i)}>{e.label}</button>
                ))}
              </div>

              <div className="eyebrow" style={{ margin: '20px 0 10px' }}>Peak tier</div>
              <div className="row">
                {([3, 5, 10] as const).map((t) => (
                  <button key={t} className={'chip' + (tier === t ? ' on' : '')} onClick={() => setTier(t)}>Top {t}</button>
                ))}
              </div>
              {tier === 3 && (
                <div className="muted hint" style={{ marginTop: 6, fontSize: 12 }}>Strictest pool — fewer years in play.</div>
              )}

              <div className="eyebrow" style={{ margin: '20px 0 10px' }}>Genre</div>
              <div className="row">
                {GENRES.map((g) => (
                  <button key={g} className={'chip' + (genre === g ? ' on' : '')} onClick={() => setGenre(g)}>{g}</button>
                ))}
              </div>

              {!poolYears.length && (
                <div className="hint" style={{ color: 'var(--red)', marginTop: 12, textAlign: 'center' }}>
                  No years match these filters — loosen one.
                </div>
              )}
              <button className="btn primary wide" style={{ marginTop: 22 }} disabled={!poolYears.length} onClick={start}>Start game ▶</button>
            </div>
            <div className="muted hint" style={{ textAlign: 'center', marginTop: 14, lineHeight: 1.5 }}>
              Song +1 · Artist +1 · Year: exact <b style={{ color: 'var(--cream)' }}>5</b>, within 1 yr <b style={{ color: 'var(--cream)' }}>3</b>, within 3 yrs <b style={{ color: 'var(--cream)' }}>1</b>
            </div>
          </>
        )}

        {phase === 'song' && (
          <>
            <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
              <div className="eyebrow">Round {round} · Song {Math.min(sIdx + 1, 3)} of {tracks.length || 3}</div>
              <div className="eyebrow muted">Year: ????</div>
            </div>
            <div className="card" style={{ textAlign: 'center' }}>
              {loadState === 'loading' && (
                <>
                  <div style={{ display: 'flex', justifyContent: 'center', margin: '6px 0 16px' }}><Eq /></div>
                  <div className="muted">Dropping the needle…</div>
                </>
              )}
              {loadState === 'failed' && (
                <>
                  <div className="muted" style={{ marginBottom: 14 }}>Couldn't tune in that year — likely a network hiccup.</div>
                  <button className="btn primary" onClick={startRound}>Spin again ↻</button>
                </>
              )}
              {loadState === 'ready' && song && (
                <>
                  <div style={{ display: 'flex', justifyContent: 'center', margin: '6px 0 20px' }}><Eq idle={!playing} /></div>
                  <button className="btn primary" onClick={() => togglePlay(song)} style={{ fontSize: 17, padding: '14px 26px' }}>
                    {playing ? '⏸ Pause' : '▶ Play clip'}
                  </button>

                  {!revealed ? (
                    <button className="btn wide" style={{ marginTop: 22 }} onClick={() => setRevealed(true)}>Reveal answer</button>
                  ) : (
                    <div style={{ marginTop: 22, textAlign: 'left' }}>
                      <div className="row" style={{ alignItems: 'center', flexWrap: 'nowrap', gap: 14 }}>
                        {song.art && <img className="revealart" src={song.art} alt="" />}
                        <div>
                          <div className="title2">{song.t}</div>
                          <div style={{ color: 'var(--amber)', fontWeight: 600, marginTop: 2 }}>{song.a}</div>
                          <div className="muted hint mono" style={{ marginTop: 4 }}>hit #{song.p} · {song.y}</div>
                        </div>
                      </div>

                      <div className="eyebrow" style={{ margin: '18px 0 8px' }}>Who named the song? +1</div>
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
                        onClick={nextSong}>{sIdx < tracks.length - 1 ? 'Next song ▶' : 'Tune in the year ▶'}</button>
                    </div>
                  )}
                </>
              )}
            </div>
          </>
        )}

        {phase === 'handoff' && (
          <div className="card gate">
            <div className="eyebrow" style={{ marginBottom: 14 }}>Round {round} · Year guess</div>
            <div className="muted">Pass the phone to</div>
            <div className="disp" style={{ fontSize: 56, margin: '6px 0 18px', color: 'var(--amberhi)' }}>{players[gIdx].name}</div>
            <div className="muted hint" style={{ marginBottom: 22 }}>Everyone else, eyes up — guesses stay secret.</div>
            <button className="btn primary wide" onClick={beginGuess}>I'm {players[gIdx].name} — show the dial ▶</button>
            <div className="dots" style={{ marginTop: 18 }}>
              {players.map((p, i) => <div key={p.id} className={'dot' + (i === gIdx ? ' on' : i < gIdx ? ' done' : '')} />)}
            </div>
          </div>
        )}

        {phase === 'year' && (
          <>
            <div className="eyebrow" style={{ marginBottom: 16 }}>Round {round} · Tune in the year</div>
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
                      {t.dec && <div className="ticklab" style={{ left: t.pct + '%' }}>{"'" + String(t.y).slice(2)}</div>}
                    </React.Fragment>
                  ))}
                </div>
                <input className="dial" type="range" min={era.min} max={era.max} value={tuner}
                  onChange={(e) => onDial(+e.target.value)} />
              </div>
              <button className="btn primary wide" style={{ marginTop: 22 }} onClick={lockYear}>Lock in ▶</button>
            </div>
          </>
        )}

        {phase === 'reveal' && (
          <>
            <div className="eyebrow" style={{ textAlign: 'center', marginBottom: 8 }}>The year was</div>
            <div className="yearbig" style={{ fontSize: 80 }}>{target}</div>
            <div style={{ display: 'flex', justifyContent: 'center', margin: '4px 0 20px' }}><Eq /></div>
            <div className="card">
              <div className="eyebrow" style={{ marginBottom: 10 }}>The songs</div>
              {tracks.map((s, i) => (
                <div key={i} style={{ marginBottom: 8 }}>
                  <span style={{ fontWeight: 600 }}>{s.t}</span> <span className="muted">— {s.a}</span>
                </div>
              ))}
              <div className="eyebrow" style={{ margin: '18px 0 10px' }}>Year scoring</div>
              {yRes.map((r) => (
                <div className="standing" key={r.pid}>
                  <div><b>{r.name}</b> <span className="muted mono" style={{ fontSize: 13 }}>guessed {r.guess}</span></div>
                  <div className={'pts ' + (r.pts > 0 ? 'win' : 'zero')}>+{r.pts}</div>
                </div>
              ))}
              <button className="btn primary wide" style={{ marginTop: 14 }} onClick={() => setPhase('board')}>Continue ▶</button>
            </div>
          </>
        )}

        {phase === 'board' && (
          <>
            <div className="eyebrow" style={{ marginBottom: 16 }}>After round {round}</div>
            <div className="card">
              {sorted.map((p, i) => (
                <div key={p.id} className={'standing' + (i === 0 ? ' lead' : '')}>
                  <div><b>{i === 0 ? '♛ ' : (i + 1) + '. '}{p.name}</b></div>
                  <div className="score">{p.score}</div>
                </div>
              ))}
              <button className="btn primary wide" style={{ marginTop: 14 }} onClick={nextRound}>Next round ▶</button>
              <button className="btn wide" style={{ marginTop: 8 }} onClick={() => setPhase('end')}>End game</button>
            </div>
          </>
        )}

        {phase === 'end' && (
          <>
            <div className="eyebrow" style={{ textAlign: 'center', marginBottom: 6 }}>Final standings</div>
            <div className="disp" style={{ fontSize: 52, textAlign: 'center', color: 'var(--amberhi)', marginBottom: 4 }}>{sorted[0].name} wins</div>
            <div style={{ display: 'flex', justifyContent: 'center', margin: '4px 0 20px' }}><Eq /></div>
            <div className="card">
              {sorted.map((p, i) => (
                <div key={p.id} className={'standing' + (i === 0 ? ' lead' : '')}>
                  <div><b>{i === 0 ? '♛ ' : (i + 1) + '. '}{p.name}</b></div>
                  <div className="score">{p.score}</div>
                </div>
              ))}
              <button className="btn primary wide" style={{ marginTop: 14 }} onClick={playAgain}>Play again (same crew) ▶</button>
              <button className="btn wide" style={{ marginTop: 8 }} onClick={() => setPhase('setup')}>New game</button>
            </div>
          </>
        )}

      </div>
    </div>
  );
}
