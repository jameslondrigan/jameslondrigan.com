import React, { useState, useRef, useEffect } from 'react';
import { MpClient } from './mp';
import type { MpEvent, MpStatus } from './mp';

/*
 * Track Record phone controller (/trackrecord/join). Deliberately thin: no song
 * data fetch, no audio playback, no game engine. It joins a room, then submits a
 * year guess when the host opens one. State is on the host screen; the phone is
 * an input device (docs/MULTIPLAYER-ARCHITECTURE.md section 2).
 */

const PLAYER_KEY = 'tr:mp:player:v1';
const ROUND_KEY = 'tr:mp:round:v1';

type SavedPlayer = { code: string; token: string; name: string };
type RoundInfo = { round: number; min: number; max: number; songs: { t: string; a: string }[]; locked: boolean };

const readPlayer = (): SavedPlayer | null => { try { const r = sessionStorage.getItem(PLAYER_KEY); return r ? JSON.parse(r) : null; } catch { return null; } };
const writePlayer = (p: SavedPlayer) => { try { sessionStorage.setItem(PLAYER_KEY, JSON.stringify(p)); } catch { /* */ } };
const clearPlayer = () => { try { sessionStorage.removeItem(PLAYER_KEY); } catch { /* */ } };
const readRound = (): RoundInfo | null => { try { const r = sessionStorage.getItem(ROUND_KEY); return r ? JSON.parse(r) : null; } catch { return null; } };
const writeRound = (r: RoundInfo) => { try { sessionStorage.setItem(ROUND_KEY, JSON.stringify(r)); } catch { /* */ } };
const clearRound = () => { try { sessionStorage.removeItem(ROUND_KEY); } catch { /* */ } };

// Local tick (matches the host dial's feel; no shared engine).
let _ac: AudioContext | null = null;
function tick() {
  try {
    if (!_ac) _ac = new (window.AudioContext || (window as any).webkitAudioContext)();
    if (_ac.state === 'suspended') _ac.resume();
    const o = _ac.createOscillator(), g = _ac.createGain();
    o.type = 'square'; o.frequency.value = 1150;
    g.gain.setValueAtTime(0.06, _ac.currentTime);
    g.gain.exponentialRampToValueAtTime(0.0001, _ac.currentTime + 0.03);
    o.connect(g); g.connect(_ac.destination);
    o.start(); o.stop(_ac.currentTime + 0.035);
    if (navigator.vibrate) navigator.vibrate(8);
  } catch { /* */ }
}

const CSS = `
@import url('https://fonts.googleapis.com/css2?family=Righteous&family=Space+Grotesk:wght@400;500;600;700&family=JetBrains+Mono:wght@500;700&display=swap');
.tc,.tc *{box-sizing:border-box;margin:0;padding:0}
.tc{--bg:#160f08;--panel:#211810;--panel2:#2c2114;--line:#3c2d1c;--amber:#F2A93B;--amberhi:#FFC768;--cream:#F5EAD2;--muted:#a48a67;--green:#93CB58;--red:#E4573C;--maroon:#500000;
  min-height:100vh;background:radial-gradient(1200px 600px at 50% -10%,#2a1d0f 0%,transparent 60%),var(--bg);color:var(--cream);
  font-family:'Space Grotesk',system-ui,sans-serif;display:flex;align-items:center;justify-content:center;padding:22px 16px}
.tc .wrap{width:100%;max-width:460px}
.tc .disp{font-family:'Righteous',sans-serif;letter-spacing:.02em;line-height:.92}
.tc .mono{font-family:'JetBrains Mono',monospace}
.tc .eyebrow{font-family:'JetBrains Mono',monospace;font-size:11px;letter-spacing:.28em;text-transform:uppercase;color:var(--amber)}
.tc .muted{color:var(--muted)}.tc .hint{font-size:13px}
.tc .card{background:linear-gradient(180deg,var(--panel2),var(--panel));border:1px solid var(--line);border-radius:18px;padding:22px}
.tc .btn{font-family:'Space Grotesk',sans-serif;font-weight:600;font-size:16px;border:1px solid var(--line);background:var(--panel2);color:var(--cream);border-radius:12px;padding:14px 16px;cursor:pointer;min-height:48px;width:100%;transition:transform .06s ease,border-color .15s}
.tc .btn:active{transform:scale(.98)}
.tc .btn.primary{background:linear-gradient(180deg,var(--amberhi),var(--amber));color:#2a1a06;border:none;box-shadow:0 6px 24px -8px var(--amber)}
.tc .btn:disabled{opacity:.4}
.tc input.f{width:100%;background:#160f08;border:1px solid var(--line);border-radius:10px;padding:14px 13px;color:var(--cream);font-family:'Space Grotesk',sans-serif;font-size:18px;margin-bottom:10px}
.tc input.f:focus{outline:none;border-color:var(--amber)}
.tc input.code{font-family:'JetBrains Mono',monospace;letter-spacing:.3em;text-transform:uppercase;text-align:center;font-size:26px}
.tc .yearbig{font-family:'JetBrains Mono',monospace;font-weight:700;font-size:72px;color:var(--amberhi);text-shadow:0 0 26px rgba(242,169,59,.45);text-align:center}
.tc .tuner{position:relative;margin:8px 0 2px}
.tc .ticks{position:relative;height:22px;margin-bottom:6px}
.tc .tick{position:absolute;top:0;width:1px;height:9px;background:var(--line)}
.tc .tick.dec{height:16px;background:var(--muted)}
.tc .ticklab{position:absolute;top:12px;transform:translateX(-50%);font-family:'JetBrains Mono',monospace;font-size:10px;color:var(--muted)}
.tc input[type=range].dial{-webkit-appearance:none;appearance:none;width:100%;height:10px;border-radius:6px;background:linear-gradient(90deg,#3a2c1c,#6b5330);outline:none}
.tc input[type=range].dial::-webkit-slider-thumb{-webkit-appearance:none;appearance:none;width:18px;height:44px;border-radius:5px;background:linear-gradient(var(--amberhi),var(--amber));box-shadow:0 0 16px 2px rgba(242,169,59,.6);cursor:pointer}
.tc input[type=range].dial::-moz-range-thumb{width:18px;height:44px;border:none;border-radius:5px;background:var(--amber);box-shadow:0 0 16px 2px rgba(242,169,59,.6)}
.tc .nudge-row{display:flex;gap:8px;align-items:center;margin-top:16px}
.tc .nudge{font-family:'JetBrains Mono',monospace;font-size:22px;font-weight:700;padding:12px 18px;flex-shrink:0;width:auto}
.tc .big{font-family:'Righteous',sans-serif;font-size:40px;line-height:1}
.tc .err{color:var(--red);font-size:13px;margin-bottom:10px}
@media(prefers-reduced-motion:reduce){.tc .btn:active{transform:none}}
`;

type View = 'connecting' | 'join' | 'waiting' | 'guessing' | 'locked' | 'closed' | 'kicked' | 'gmYear' | 'gmSent' | 'gmPick';

const nearestOf = (arr: number[], v: number) => (arr.length ? arr.reduce((b, y) => (Math.abs(y - v) < Math.abs(b - v) ? y : b), arr[0]) : v);
const stepOf = (arr: number[], from: number, dir: number) => {
  if (!arr.length) return from;
  const i = arr.indexOf(from);
  if (i === -1) return nearestOf(arr, from);
  return arr[Math.max(0, Math.min(arr.length - 1, i + dir))];
};

export default function Controller() {
  const [view, setView] = useState<View>('connecting');
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [bounds, setBounds] = useState<RoundInfo | null>(null);
  const [tuner, setTuner] = useState(1990);
  const [hostAway, setHostAway] = useState(false);
  // GM-from-phone stages
  const [gmMin, setGmMin] = useState(1958);
  const [gmMax, setGmMax] = useState(2026);
  const [gmEligible, setGmEligible] = useState<number[]>([]);
  const [gmTuner, setGmTuner] = useState(1990);
  const [gmCandidates, setGmCandidates] = useState<{ t: string; a: string }[]>([]);
  const [gmN, setGmN] = useState(3);
  const [gmPicked, setGmPicked] = useState<number[]>([]);
  const [gmMsg, setGmMsg] = useState('');

  const mpRef = useRef<MpClient | null>(null);
  const evRef = useRef<(e: MpEvent) => void>(() => {});
  const joinNameRef = useRef('');

  const applyBounds = (r: RoundInfo) => { setBounds(r); setTuner(Math.round((r.min + r.max) / 2)); };

  const handleEvent = (e: MpEvent) => {
    if (e.event === 'joined') {
      writePlayer({ code: code || (readPlayer()?.code ?? ''), token: e.token, name: joinNameRef.current || (readPlayer()?.name ?? '') });
      setHostAway(false);
      const ph = e.phase;
      if (ph === 'guessing') {
        const r = readRound();
        if (r && !r.locked) { applyBounds(r); setView('guessing'); }
        else if (r && r.locked) setView('locked');
        else setView('waiting');
      } else if (ph === 'reveal' || ph === 'closed') setView('closed');
      else setView('waiting');
    } else if (e.event === 'phaseChange') {
      if (e.phase === 'openGuess') {
        const p = e.payload || {};
        const r: RoundInfo = { round: p.round ?? 0, min: p.min ?? 1958, max: p.max ?? 2026, songs: p.songs || [], locked: false };
        writeRound(r); applyBounds(r); setHostAway(false); setView('guessing');
      } else if (e.phase === 'closed') { clearRound(); setView('closed'); }
      else if (e.phase === 'hostAway') { setHostAway(true); }
      else if (e.phase === 'kicked') { clearPlayer(); clearRound(); setView('kicked'); }
    } else if (e.event === 'guessLocked') {
      const r = readRound(); if (r) writeRound({ ...r, locked: true });
      setView('locked');
    } else if (e.event === 'gmStage') {
      const p = e.payload || {};
      setHostAway(false);
      if (e.stage === 'year') {
        const el = Array.isArray(p.eligibleYears) ? p.eligibleYears : [];
        setGmEligible(el); setGmMin(p.min ?? 1958); setGmMax(p.max ?? 2026);
        setGmTuner(nearestOf(el, Math.round(((p.min ?? 1958) + (p.max ?? 2026)) / 2)));
        setView('gmYear');
      } else if (e.stage === 'pick') {
        setGmCandidates(Array.isArray(p.candidates) ? p.candidates : []);
        setGmN(p.n || 3); setGmPicked([]); // partial selection cleared on (re)entry
        setView('gmPick');
      } else if (e.stage === 'done') {
        setView('waiting');
      }
    } else if (e.event === 'error') {
      if (e.code === 'name_taken') { setError('That name is taken. Try another.'); setView('join'); }
      else if (e.code === 'no_room') { setError('No room with that code.'); setView('join'); }
      else if (e.code === 'already_guessed') { setView('locked'); }
      // other errors are transient; ignore
    }
  };

  useEffect(() => { evRef.current = handleEvent; });

  useEffect(() => {
    const url = new URL(window.location.href);
    const prefill = (url.searchParams.get('code') || '').toUpperCase();
    const client = new MpClient((ev) => evRef.current(ev), (_s: MpStatus) => { /* status unused in UI */ });
    mpRef.current = client;
    const saved = readPlayer();
    if (saved && saved.code && saved.token) {
      joinNameRef.current = saved.name;
      setCode(saved.code);
      client.connect().then(() => client.rejoinNow(saved.code, saved.token)).catch(() => setView('join'));
    } else {
      if (prefill) setCode(prefill);
      setView('join');
    }
    return () => client.close();
  }, []);

  const doJoin = () => {
    const c = code.trim().toUpperCase(), n = name.trim();
    if (!c || !n) { setError('Enter the room code and your name.'); return; }
    setError(null); joinNameRef.current = n; setCode(c); setView('connecting');
    const client = mpRef.current!;
    const go = () => client.joinRoom(c, n);
    client.connect().then(go).catch(() => { setError('Could not reach the room server.'); setView('join'); });
  };

  const onDial = (v: number) => { if (v !== tuner) { tick(); setTuner(v); } };
  const nudge = (d: number) => { if (!bounds) return; const v = Math.max(bounds.min, Math.min(bounds.max, tuner + d)); if (v !== tuner) { tick(); setTuner(v); } };
  const lockIn = () => { mpRef.current?.submitGuess(tuner); const r = readRound(); if (r) writeRound({ ...r, locked: true }); setView('locked'); };

  // GM year dial: snaps to eligible years only; nudges jump between them.
  const onGmDial = (v: number) => { const s = nearestOf(gmEligible, v); if (s !== gmTuner) { tick(); setGmTuner(s); } };
  const gmNudge = (d: number) => { const s = stepOf(gmEligible, gmTuner, d); if (s !== gmTuner) { tick(); setGmTuner(s); } };
  const lockGmYear = () => { mpRef.current?.gmYear(gmTuner); setGmMsg('Year locked in. Waiting for the song list…'); setView('gmSent'); };
  const toggleGmPick = (i: number) => setGmPicked((cur) => (cur.includes(i) ? cur.filter((x) => x !== i) : (cur.length >= gmN ? cur : [...cur, i])));
  const confirmGmPick = () => { if (gmPicked.length !== gmN) return; mpRef.current?.gmPick(gmPicked); setGmMsg('Songs locked in.'); setView('gmSent'); };

  const ticks: { y: number; pct: number; dec: boolean }[] = [];
  if (bounds) {
    for (let y = Math.ceil(bounds.min / 5) * 5; y <= bounds.max; y += 5) {
      ticks.push({ y, pct: ((y - bounds.min) / (bounds.max - bounds.min)) * 100, dec: y % 10 === 0 });
    }
  }
  const gmTicks: { y: number; pct: number; dec: boolean }[] = [];
  for (let y = Math.ceil(gmMin / 5) * 5; y <= gmMax; y += 5) {
    gmTicks.push({ y, pct: ((y - gmMin) / (gmMax - gmMin)) * 100, dec: y % 10 === 0 });
  }

  return (
    <div className="tc">
      <style>{CSS}</style>
      <div className="wrap">
        <div style={{ textAlign: 'center', marginBottom: 16 }}>
          <div className="disp" style={{ fontSize: 34 }}>TRACK RECORD</div>
          <div className="muted hint mono" style={{ marginTop: 4, letterSpacing: '.1em' }}>CONTROLLER</div>
        </div>

        {view === 'connecting' && (
          <div className="card" style={{ textAlign: 'center' }}><div className="muted">Connecting&hellip;</div></div>
        )}

        {view === 'join' && (
          <div className="card">
            <div className="eyebrow" style={{ marginBottom: 12 }}>Join a room</div>
            {error && <div className="err">{error}</div>}
            <input className="f code" placeholder="CODE" maxLength={4} value={code}
              onChange={(e) => setCode(e.target.value.toUpperCase())} autoCapitalize="characters" autoCorrect="off" />
            <input className="f" placeholder="Your name" maxLength={24} value={name}
              onChange={(e) => setName(e.target.value)} />
            <button className="btn primary" onClick={doJoin}>Join ▶</button>
          </div>
        )}

        {view === 'waiting' && (
          <div className="card" style={{ textAlign: 'center' }}>
            <div className="big" style={{ color: 'var(--green)', marginBottom: 8 }}>You&apos;re in</div>
            <div className="muted">Watch the big screen. Your dial appears when it&apos;s time to guess the year.</div>
            {hostAway && <div className="muted hint" style={{ marginTop: 12 }}>Host reconnecting&hellip;</div>}
          </div>
        )}

        {view === 'guessing' && bounds && (
          <div className="card">
            <div className="eyebrow" style={{ marginBottom: 8, textAlign: 'center' }}>Tune in the year</div>
            <div className="yearbig">{tuner}</div>
            <div className="tuner">
              <div className="ticks">
                {ticks.map((t) => (
                  <React.Fragment key={t.y}>
                    <div className={'tick' + (t.dec ? ' dec' : '')} style={{ left: t.pct + '%' }} />
                    {t.dec && <div className="ticklab" style={{ left: t.pct + '%' }}>&apos;{String(t.y).slice(2)}</div>}
                  </React.Fragment>
                ))}
              </div>
              <input className="dial" type="range" min={bounds.min} max={bounds.max} value={tuner}
                onChange={(e) => onDial(+e.target.value)} />
            </div>
            <div className="nudge-row">
              <button className="btn nudge" onClick={() => nudge(-1)} aria-label="Year minus 1">&minus;</button>
              <button className="btn primary" onClick={lockIn}>Lock in ▶</button>
              <button className="btn nudge" onClick={() => nudge(1)} aria-label="Year plus 1">+</button>
            </div>
            {bounds.songs.length > 0 && (
              <div style={{ marginTop: 16, paddingTop: 14, borderTop: '1px solid var(--line)' }}>
                <div className="eyebrow muted" style={{ marginBottom: 8 }}>This round&apos;s songs</div>
                {bounds.songs.map((s, i) => (
                  <div key={i} className="muted hint" style={{ marginBottom: 4 }}>{s.t} &middot; {s.a}</div>
                ))}
              </div>
            )}
          </div>
        )}

        {view === 'locked' && (
          <div className="card" style={{ textAlign: 'center' }}>
            <div className="big" style={{ color: 'var(--green)', marginBottom: 8 }}>Locked in ✓</div>
            {bounds && <div className="yearbig" style={{ fontSize: 48 }}>{tuner}</div>}
            <div className="muted" style={{ marginTop: 8 }}>Waiting for the others. Watch the big screen.</div>
          </div>
        )}

        {view === 'closed' && (
          <div className="card" style={{ textAlign: 'center' }}>
            <div className="eyebrow" style={{ marginBottom: 8 }}>Guesses are in</div>
            <div className="muted">Watch the big screen for the reveal. Your dial returns next round.</div>
            {hostAway && <div className="muted hint" style={{ marginTop: 12 }}>Host reconnecting&hellip;</div>}
          </div>
        )}

        {view === 'kicked' && (
          <div className="card" style={{ textAlign: 'center' }}>
            <div className="muted">You&apos;ve left the room.</div>
            <button className="btn" style={{ marginTop: 14 }} onClick={() => { setError(null); setView('join'); }}>Join again</button>
          </div>
        )}

        {view === 'gmYear' && (
          <div className="card">
            <div className="eyebrow" style={{ marginBottom: 6, textAlign: 'center', color: 'var(--amberhi)' }}>You&apos;re the Game Master this round</div>
            <div className="muted hint" style={{ textAlign: 'center', marginBottom: 8 }}>Set the year for everyone to guess</div>
            <div className="yearbig">{gmTuner}</div>
            <div className="tuner">
              <div className="ticks">
                {gmTicks.map((t) => (
                  <React.Fragment key={t.y}>
                    <div className={'tick' + (t.dec ? ' dec' : '')} style={{ left: t.pct + '%' }} />
                    {t.dec && <div className="ticklab" style={{ left: t.pct + '%' }}>&apos;{String(t.y).slice(2)}</div>}
                  </React.Fragment>
                ))}
              </div>
              <input className="dial" type="range" min={gmMin} max={gmMax} value={gmTuner}
                onChange={(e) => onGmDial(+e.target.value)} />
            </div>
            <div className="nudge-row">
              <button className="btn nudge" onClick={() => gmNudge(-1)} aria-label="Previous eligible year">&minus;</button>
              <button className="btn primary" onClick={lockGmYear}>Lock in year ▶</button>
              <button className="btn nudge" onClick={() => gmNudge(1)} aria-label="Next eligible year">+</button>
            </div>
            <div className="muted hint" style={{ textAlign: 'center', marginTop: 12 }}>The dial snaps to years with enough songs.</div>
          </div>
        )}

        {view === 'gmPick' && (
          <div className="card">
            <div className="eyebrow" style={{ marginBottom: 6, textAlign: 'center', color: 'var(--amberhi)' }}>You&apos;re the Game Master this round</div>
            <div className="muted hint" style={{ marginBottom: 12 }}>Pick {gmN} songs for this round. ({gmPicked.length}/{gmN})</div>
            {gmCandidates.map((s, i) => {
              const sel = gmPicked.includes(i);
              return (
                <button key={i} className={'btn' + (sel ? ' primary' : '')} style={{ marginBottom: 8, textAlign: 'left' }}
                  onClick={() => toggleGmPick(i)} disabled={!sel && gmPicked.length >= gmN}>
                  <span style={{ fontWeight: 600 }}>{s.t}</span> <span className="muted">&middot; {s.a}</span>
                </button>
              );
            })}
            <button className="btn primary" style={{ marginTop: 6 }} disabled={gmPicked.length !== gmN} onClick={confirmGmPick}>Confirm songs ▶</button>
          </div>
        )}

        {view === 'gmSent' && (
          <div className="card" style={{ textAlign: 'center' }}>
            <div className="eyebrow" style={{ marginBottom: 8, color: 'var(--amberhi)' }}>Game Master</div>
            <div className="big" style={{ color: 'var(--green)', marginBottom: 8 }}>Sent ✓</div>
            <div className="muted">{gmMsg || 'Waiting for the big screen.'}</div>
          </div>
        )}
      </div>
    </div>
  );
}
