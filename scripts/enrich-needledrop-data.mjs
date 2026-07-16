#!/usr/bin/env node
// Enriches needledrop-seed.json with iTunes preview URLs, art, and genre.
//
// Usage:
//   node scripts/enrich-needledrop-data.mjs [--limit N] [--rate MS] [--force]
//
// Outputs:
//   public/data/tr-songs.json   — all songs, enriched where resolved
//   scripts/enrich-report.json  — unresolved + low-confidence entries
// Cache (resumable):
//   scripts/.enrich-cache.json
//
// Single source of truth: this script writes the enriched data DIRECTLY to
// public/data/tr-songs.json, which the game fetches at runtime as a static
// asset (see src/components/needledrop/NeedleDrop.tsx -> SONGS_URL). There is
// no src/data/needledrop-songs.json copy and the JSON is never bundled into
// the app, so re-running enrichment updates the served file in one step.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

const SEED_PATH   = path.join(ROOT, 'src/data/needledrop-seed.json');
const OUT_PATH    = path.join(ROOT, 'public/data/tr-songs.json');
const CACHE_PATH  = path.join(__dirname, '.enrich-cache.json');
const REPORT_PATH = path.join(__dirname, 'enrich-report.json');

/* ---- CLI args ---- */
const args = process.argv.slice(2);
const arg  = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : null; };
const LIMIT   = arg('--limit')  ? parseInt(arg('--limit'),  10) : 0;
const RATE_MS = arg('--rate')   ? parseInt(arg('--rate'),   10) : 3500;
const FORCE   = args.includes('--force');

/* ---- Genre bucketing (case-insensitive substring match) ---- */
const GENRE_RULES = [
  ['Rock',             ['rock', 'metal', 'punk', 'alternative', 'grunge', 'hard rock']],
  ['Pop',              ['pop', 'adult contemporary', 'teen pop', 'vocal', 'easy listening', 'new wave', 'singer/songwriter']],
  ['Country',          ['country', 'folk', 'americana']],
  ['Hip-Hop/R&B',      ['hip-hop', 'r&b', 'funk', 'motown', 'disco']],
  ['Dance/Electronic', ['dance', 'electronic', 'house', 'techno']],
];

function genreBucket(raw) {
  if (!raw) return 'Other';
  const lower = raw.toLowerCase();
  for (const [bucket, kws] of GENRE_RULES) {
    if (kws.some(kw => lower.includes(kw))) return bucket;
  }
  return 'Other';
}

/* ---- Match logic — mirrors NeedleDrop.tsx exactly ---- */
const norm         = s => (s || '').toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim();
const stripParens  = s => (s || '').replace(/\(.*?\)|\[.*?\]/g, ' ').trim();
const primaryArtist = a => (a || '').split(/,|&|\bfeat\.?\b|\bfeaturing\b|\bwith\b/i)[0].trim() || a;
function sim(a, b) {
  const na = norm(a), nb = norm(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  if (nb.includes(na) || na.includes(nb)) return 0.9;
  const A = new Set(na.split(' ')), B = new Set(nb.split(' '));
  let inter = 0; A.forEach(t => { if (B.has(t)) inter++; });
  return inter / (A.size + B.size - inter);
}

/* ---- Utilities ---- */
const sleep  = ms => new Promise(r => setTimeout(r, ms));
const fmtMs  = ms => { const s = Math.round(ms / 1000); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };

/* ---- Fetch with exponential backoff on 403/429 ---- */
async function fetchBacked(url) {
  let delay = 60_000;
  for (let attempt = 0; attempt <= 3; attempt++) {
    let resp;
    try { resp = await fetch(url); } catch (e) { return { ok: false, networkError: e.message }; }
    if (resp.ok) return resp;
    if (resp.status === 403 || resp.status === 429) {
      if (attempt < 3) {
        console.log(`\n  HTTP ${resp.status} — backing off ${fmtMs(delay)} (retry ${attempt + 1}/3)`);
        await sleep(delay);
        delay *= 2;
      } else {
        return { ok: false, deferred: true, status: resp.status };
      }
    } else {
      return { ok: false, status: resp.status };
    }
  }
  return { ok: false };
}

/* ---- Cache helpers ---- */
function loadCache() {
  try { return JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8')); } catch { return {}; }
}
function saveCache(cache) {
  fs.writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2));
}
const isComplete = e => e && (e.status === 'resolved' || e.status === 'failed');

/* ---- Main ---- */
async function main() {
  const songs = JSON.parse(fs.readFileSync(SEED_PATH, 'utf8'));
  const cache = FORCE ? {} : loadCache();

  const todo   = LIMIT > 0 ? songs.slice(0, LIMIT) : songs;
  const toRun  = todo.filter(s => !isComplete(cache[s.t + '|' + s.a]));
  const skipped = todo.length - toRun.length;

  const verbose = LIMIT > 0 && LIMIT <= 100;
  const fullRunEta = fmtMs(songs.length * RATE_MS);

  console.log(`\nNeedle Drop enrichment script`);
  console.log(`  Seed songs      : ${songs.length}`);
  console.log(`  Batch limit     : ${LIMIT || 'none (full run)'}`);
  console.log(`  To process      : ${toRun.length}  (${skipped} skipped — already cached)`);
  console.log(`  Rate            : ${RATE_MS}ms between requests`);
  if (!LIMIT) console.log(`  Full-run ETA    : ~${fullRunEta} (~${Math.round(songs.length * RATE_MS / 60000)} min)`);
  console.log('');

  let resolved = 0, failed = 0, deferred = 0;
  let lastReqTime = 0;
  const startTime = Date.now();
  const rawGenreCounts = {};

  for (let i = 0; i < toRun.length; i++) {
    const s    = toRun[i];
    const key  = s.t + '|' + s.a;
    const proc = i + 1;

    /* rate limit */
    const wait = RATE_MS - (Date.now() - lastReqTime);
    if (lastReqTime > 0 && wait > 0) await sleep(wait);

    const term = encodeURIComponent(stripParens(s.t) + ' ' + primaryArtist(s.a));
    const url  = `https://itunes.apple.com/search?media=music&entity=song&limit=6&term=${term}`;

    let entry;
    try {
      lastReqTime = Date.now();
      const resp = await fetchBacked(url);

      if (!resp.ok) {
        if (resp.deferred) {
          entry = { status: 'deferred', preview: null, art: null, g: 'Other', rawGenre: null };
          deferred++;
        } else {
          entry = { status: 'failed', preview: null, art: null, g: 'Other', rawGenre: null, httpStatus: resp.status };
          failed++;
        }
      } else {
        const data    = await resp.json();
        const results = (data && data.results) || [];
        let best = null, bestRank = -1;
        for (const r of results) {
          if (!r.previewUrl) continue;
          const ts = sim(stripParens(s.t), stripParens(r.trackName || ''));
          const as = sim(primaryArtist(s.a), r.artistName || '');
          const rank = ts * 2 + as;
          if (rank > bestRank) { bestRank = rank; best = { r, ts, as }; }
        }

        if (best && best.ts >= 0.6 && best.as >= 0.55) {
          const rawGenre = best.r.primaryGenreName || null;
          const g = genreBucket(rawGenre);
          rawGenreCounts[rawGenre || '(none)'] = (rawGenreCounts[rawGenre || '(none)'] || 0) + 1;
          const artRaw = best.r.artworkUrl100 || '';
          const art = artRaw.replace('100x100bb', '300x300bb').replace('100x100', '300x300') || null;
          entry = { status: 'resolved', preview: best.r.previewUrl, art, g, rawGenre };
          resolved++;
        } else {
          entry = {
            status: 'failed', preview: null, art: null, g: 'Other', rawGenre: null,
            conf: best ? { ts: best.ts.toFixed(2), as: best.as.toFixed(2) } : null,
          };
          failed++;
        }
      }
    } catch (e) {
      entry = { status: 'failed', preview: null, art: null, g: 'Other', rawGenre: null, error: e.message };
      failed++;
    }

    cache[key] = entry;

    if (verbose) {
      const icon = entry.status === 'resolved' ? '✓' : entry.status === 'deferred' ? '⏸' : '✗';
      console.log(`  ${icon} ${s.y}  ${s.t.slice(0, 46).padEnd(46)}  ${entry.status === 'resolved' ? entry.g : entry.status}`);
    }

    if (proc % 25 === 0 || proc === toRun.length) {
      const elapsed   = Date.now() - startTime;
      const remaining = toRun.length - proc;
      const eta       = proc > 0 ? fmtMs((elapsed / proc) * remaining) : '?';
      saveCache(cache);
      if (!verbose) {
        console.log(`${proc}/${toRun.length}  resolved:${resolved}  failed:${failed}  deferred:${deferred} — ETA ${eta}`);
      }
    }
  }

  if (!verbose && toRun.length > 0) console.log('');

  /* ---- Write public/data/tr-songs.json (all 1725 songs) ---- */
  const out = songs
    .map(s => {
      const e = cache[s.t + '|' + s.a];
      return { ...s, preview: e?.preview ?? null, art: e?.art ?? null, g: e?.g ?? 'Other' };
    })
    .sort((a, b) => a.y !== b.y ? a.y - b.y : a.p - b.p);

  const totalBaked = out.filter(s => s.preview).length;
  fs.writeFileSync(OUT_PATH, JSON.stringify(out, null, 2));
  console.log(`Wrote ${path.relative(ROOT, OUT_PATH)} (${out.length} songs, ${totalBaked} with baked previews)`);

  /* ---- Write enrich-report.json ---- */
  const report = {
    generatedAt: new Date().toISOString(),
    counts: { resolved, failed, deferred, total: todo.length },
    unresolved: songs
      .filter(s => { const e = cache[s.t + '|' + s.a]; return !e || e.status !== 'resolved'; })
      .map(s => ({ ...s, _status: cache[s.t + '|' + s.a]?.status || 'unprocessed', _conf: cache[s.t + '|' + s.a]?.conf })),
  };
  fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2));
  console.log(`Wrote ${path.relative(ROOT, REPORT_PATH)} (${report.unresolved.length} unresolved)\n`);

  /* ---- Genre summary ---- */
  if (Object.keys(rawGenreCounts).length > 0) {
    console.log('Raw iTunes genre → bucket:');
    Object.entries(rawGenreCounts)
      .sort((a, b) => b[1] - a[1])
      .forEach(([g, n]) => console.log(`  ${String(n).padStart(4)}  ${g.padEnd(32)}  →  ${genreBucket(g)}`));

    const bucketTotals = {};
    out.forEach(s => { if (s.preview) bucketTotals[s.g] = (bucketTotals[s.g] || 0) + 1; });
    console.log('\nBucket totals (songs with baked previews):');
    Object.entries(bucketTotals).sort((a, b) => b[1] - a[1])
      .forEach(([b, n]) => console.log(`  ${String(n).padStart(4)}  ${b}`));
    console.log('');
  }

  /* ---- Pool thinning check ---- */
  console.log('Years with <3 resolved-preview songs per tier:');
  const allYears = [...new Set(out.map(s => s.y))].sort((a, b) => a - b);
  let warned = 0;
  for (const yr of allYears) {
    for (const tier of [3, 5, 10]) {
      const n = out.filter(s => s.y === yr && s.p <= tier && s.preview).length;
      if (n < 3) { console.log(`  ${yr}  top-${tier}: ${n} playable`); warned++; }
    }
  }
  if (warned === 0) console.log('  None — all tiers fully playable.');

  console.log('\nDone. Run with no --limit to enrich all 1,725 songs (~100 min at default rate).');
  if (deferred > 0) console.log(`  ${deferred} songs deferred (rate-limited); re-run to retry them.`);
}

main().catch(e => { console.error(e); process.exit(1); });
