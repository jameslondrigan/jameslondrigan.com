// tr-mp-router logic (transport-agnostic, dependency-injected for unit testing).
//
// Implements the protocol in docs/MULTIPLAYER-ARCHITECTURE.md section 6 over the
// single tr-rooms table (section 5). Host-authoritative (ADR-4): the server is a
// room registry + message router that enforces only structural rules (room
// exists, name unique, one guess per player per round, guesses hidden until the
// host reveals). It never runs game logic or scoring.
//
// Item types in tr-rooms:
//   ROOM#{code} / META                     room registry + phase
//   ROOM#{code} / PLAYER#{token}           one per joined phone
//   ROOM#{code} / GUESS#{roundNo}#{token}  one guess per player per round
//   CONN#{connectionId} / META             connection -> identity index (added to
//                                          support $disconnect + connection binding)
//
// `deps` is injected so tests run with an in-memory fake and no AWS SDK:
//   { table, now(), random(), get(), put(), update(), del(), query(), send() }

// 4-char room codes. Alphabet excludes visually ambiguous chars: no O/0/I/1
// (per doc) and also L, for good measure. ~31^4 ≈ 920K combinations.
export const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_LEN = 4;
const TOKEN_BYTES = 16;
const TTL_SECONDS = 24 * 60 * 60;
const MAX_BODY = 4096;
const CODE_ATTEMPTS = 8;

export function genCode(random = Math.random) {
  let s = '';
  for (let i = 0; i < CODE_LEN; i++) s += ALPHABET[Math.floor(random() * ALPHABET.length)];
  return s;
}

export function genToken(random = Math.random) {
  let s = '';
  const hex = '0123456789abcdef';
  for (let i = 0; i < TOKEN_BYTES * 2; i++) s += hex[Math.floor(random() * 16)];
  return s;
}

const roomPk = (code) => `ROOM#${code}`;
const connPk = (id) => `CONN#${id}`;
const playerSk = (token) => `PLAYER#${token}`;
const guessSk = (round, token) => `GUESS#${round}#${token}`;
const ttlValue = (nowMs) => Math.floor(nowMs / 1000) + TTL_SECONDS;

function log(fields) {
  // Structured logs. Never include guess values.
  try { console.log(JSON.stringify(fields)); } catch { /* ignore */ }
}

async function send(deps, connectionId, obj) {
  if (!connectionId) return;
  try { await deps.send(connectionId, obj); }
  catch (err) {
    // Stale/gone connection: ignore for broadcasts.
    if (err && (err.name === 'GoneException' || err.statusCode === 410)) return;
    log({ action: 'send', outcome: 'error', error: err && err.name });
  }
}

function err(deps, connectionId, code, msg) {
  return send(deps, connectionId, { event: 'error', code, msg });
}

async function loadRoom(deps, code) {
  const items = await deps.query(roomPk(code));
  const meta = items.find((i) => i.SK === 'META') || null;
  const players = items.filter((i) => i.SK.startsWith('PLAYER#'));
  const guesses = items.filter((i) => i.SK.startsWith('GUESS#'));
  return { meta, players, guesses };
}

function rosterFor(players, { withTokens }) {
  return players.map((p) => ({
    name: p.name,
    connected: !!p.connected,
    score: p.score || 0,
    ...(withTokens ? { token: p.SK.slice('PLAYER#'.length) } : {}),
  }));
}

async function broadcastRoster(deps, code) {
  const { meta, players } = await loadRoom(deps, code);
  if (!meta) return;
  // Host gets tokens (so it can host:kick); players get name-only entries.
  await send(deps, meta.hostConnectionId, { event: 'rosterUpdate', roster: rosterFor(players, { withTokens: true }) });
  const playerRoster = rosterFor(players, { withTokens: false });
  for (const p of players) {
    if (p.connected && p.connectionId) {
      await send(deps, p.connectionId, { event: 'rosterUpdate', roster: playerRoster });
    }
  }
}

async function touchRoom(deps, code) {
  await deps.update(roomPk(code), 'META', { ttl: ttlValue(deps.now()) });
}

// ── Action handlers ───────────────────────────────────────────────────────────

async function createRoom(deps, connectionId) {
  let code = null;
  for (let i = 0; i < CODE_ATTEMPTS; i++) {
    const candidate = genCode(deps.random);
    const existing = await deps.get(roomPk(candidate), 'META');
    if (!existing) { code = candidate; break; }
  }
  if (!code) { log({ action: 'createRoom', outcome: 'code_exhausted' }); return err(deps, connectionId, 'server_busy', 'Could not allocate a room code, try again'); }

  const hostToken = genToken(deps.random);
  const now = deps.now();
  await deps.put({
    PK: roomPk(code), SK: 'META',
    hostToken, hostConnectionId: connectionId,
    phase: 'lobby', roundNo: 0, gmIndex: 0, settings: {},
    createdAt: now, ttl: ttlValue(now),
  });
  await deps.put({ PK: connPk(connectionId), SK: 'META', roomCode: code, token: hostToken, role: 'host', ttl: ttlValue(now) });
  log({ roomCode: code, action: 'createRoom', outcome: 'ok' });
  return send(deps, connectionId, { event: 'roomCreated', code, hostToken });
}

async function joinRoom(deps, connectionId, msg) {
  const code = String(msg.code || '').toUpperCase();
  const name = String(msg.name || '').trim();
  if (!code || !name) return err(deps, connectionId, 'bad_request', 'code and name are required');
  if (name.length > 24) return err(deps, connectionId, 'bad_request', 'name too long');

  const { meta, players } = await loadRoom(deps, code);
  if (!meta) return err(deps, connectionId, 'no_room', 'No room with that code');
  if (players.some((p) => p.name.toLowerCase() === name.toLowerCase())) {
    log({ roomCode: code, action: 'joinRoom', outcome: 'dup_name' });
    return err(deps, connectionId, 'name_taken', 'That name is taken in this room');
  }

  const token = genToken(deps.random);
  const now = deps.now();
  await deps.put({
    PK: roomPk(code), SK: playerSk(token),
    name, connectionId, score: 0, joinedAt: now, connected: true,
  });
  await deps.put({ PK: connPk(connectionId), SK: 'META', roomCode: code, token, role: 'player', ttl: ttlValue(now) });
  await touchRoom(deps, code);

  const { players: after } = await loadRoom(deps, code);
  log({ roomCode: code, action: 'joinRoom', outcome: 'ok' });
  await send(deps, connectionId, { event: 'joined', token, roster: rosterFor(after, { withTokens: false }) });
  await broadcastRoster(deps, code);
}

async function rejoin(deps, connectionId, msg) {
  const code = String(msg.code || '').toUpperCase();
  const token = String(msg.token || '');
  if (!code || !token) return err(deps, connectionId, 'bad_request', 'code and token are required');

  const { meta, players } = await loadRoom(deps, code);
  if (!meta) return err(deps, connectionId, 'no_room', 'No room with that code');
  const now = deps.now();

  if (token === meta.hostToken) {
    // hostToken displaces the old host connection (recovery path, ADR-5).
    await deps.update(roomPk(code), 'META', { hostConnectionId: connectionId, ttl: ttlValue(now) });
    await deps.put({ PK: connPk(connectionId), SK: 'META', roomCode: code, token, role: 'host', ttl: ttlValue(now) });
    log({ roomCode: code, action: 'rejoin', outcome: 'host' });
    await send(deps, connectionId, { event: 'joined', token, host: true, phase: meta.phase, roundNo: meta.roundNo, roster: rosterFor(players, { withTokens: true }) });
    return;
  }

  const player = players.find((p) => p.SK === playerSk(token));
  if (!player) return err(deps, connectionId, 'bad_token', 'Unknown player token for this room');
  await deps.update(roomPk(code), playerSk(token), { connectionId, connected: true });
  await deps.put({ PK: connPk(connectionId), SK: 'META', roomCode: code, token, role: 'player', ttl: ttlValue(now) });
  await touchRoom(deps, code);
  log({ roomCode: code, action: 'rejoin', outcome: 'player' });
  await send(deps, connectionId, { event: 'joined', token, phase: meta.phase, roundNo: meta.roundNo, roster: rosterFor(players, { withTokens: false }) });
  await broadcastRoster(deps, code);
  // If the reconnecting player is mid-GM-selection, flag the host to re-send the
  // current stage (the host holds the stage state; the server only relays).
  if (meta.gmToken && token === meta.gmToken) {
    await send(deps, meta.hostConnectionId, { event: 'gmRejoined', token });
  }
}

async function submitGuess(deps, connectionId, msg, conn) {
  if (!conn || conn.role !== 'player') return err(deps, connectionId, 'not_bound', 'Join a room before guessing');
  const code = conn.roomCode;
  const { meta } = await loadRoom(deps, code);
  if (!meta) return err(deps, connectionId, 'no_room', 'Room is gone');
  if (meta.phase !== 'guessing') return err(deps, connectionId, 'not_open', 'Guessing is not open');

  const year = Number(msg.year);
  if (!Number.isFinite(year)) return err(deps, connectionId, 'bad_request', 'year must be a number');

  try {
    await deps.put(
      { PK: roomPk(code), SK: guessSk(meta.roundNo, conn.token), year, submittedAt: deps.now() },
      { ifNotExists: true },
    );
  } catch (e) {
    if (e && e.name === 'ConditionalCheckFailedException') {
      log({ roomCode: code, action: 'submitGuess', outcome: 'duplicate' });
      return err(deps, connectionId, 'already_guessed', 'You already locked in this round');
    }
    throw e;
  }
  await touchRoom(deps, code);
  log({ roomCode: code, action: 'submitGuess', outcome: 'ok' }); // never log the year

  // guessProgress: per-name status to the host (with hybrid gone, every player is
  // a phone player, so in/waiting is complete). Guess VALUES stay server-side
  // until reveal. The round's GM (if any) does not guess and is excluded.
  const { meta: m2, players, guesses } = await loadRoom(deps, code);
  const gmTok = m2.gmToken || null;
  const submittedTokens = new Set(
    guesses.filter((g) => g.SK.startsWith(`GUESS#${m2.roundNo}#`)).map((g) => g.SK.split('#')[2]),
  );
  const inNames = [], waitingNames = [];
  for (const p of players) {
    const tok = p.SK.slice('PLAYER#'.length);
    if (tok === gmTok || !p.connected) continue;
    if (submittedTokens.has(tok)) inNames.push(p.name); else waitingNames.push(p.name);
  }
  await send(deps, connectionId, { event: 'guessLocked' });
  await send(deps, m2.hostConnectionId, {
    event: 'guessProgress', submitted: inNames.length, total: inNames.length + waitingNames.length,
    in: inNames, waiting: waitingNames,
  });
}

async function hostPhase(deps, connectionId, msg, conn) {
  const code = conn && conn.roomCode;
  const { meta, players, guesses } = code ? await loadRoom(deps, code) : { meta: null };
  if (!conn || conn.role !== 'host' || !meta || conn.token !== meta.hostToken) {
    log({ roomCode: code, action: 'host:phase', outcome: 'rejected_not_host' });
    return err(deps, connectionId, 'not_host', 'Host-only action');
  }
  const payload = (msg.payload && typeof msg.payload === 'object') ? msg.payload : {};
  const phaseName = String(msg.phase || payload.phase || '');
  const now = deps.now();

  if (phaseName === 'openGuess') {
    const roundNo = Number(payload.round ?? meta.roundNo ?? 0);
    await deps.update(roomPk(code), 'META', { phase: 'guessing', roundNo, ttl: ttlValue(now) });
    log({ roomCode: code, action: 'host:phase', outcome: 'openGuess', roundNo });
    for (const p of players) {
      if (p.connected && p.connectionId) {
        await send(deps, p.connectionId, { event: 'phaseChange', phase: 'openGuess', payload });
      }
    }
    return;
  }

  if (phaseName === 'closeGuess') {
    await deps.update(roomPk(code), 'META', { phase: 'reveal', ttl: ttlValue(now) });
    const byToken = Object.fromEntries(players.map((p) => [p.SK.slice('PLAYER#'.length), p.name]));
    const reveal = guesses
      .filter((g) => g.SK.startsWith(`GUESS#${meta.roundNo}#`))
      .map((g) => ({ name: byToken[g.SK.split('#')[2]] || '?', year: g.year }));
    log({ roomCode: code, action: 'host:phase', outcome: 'closeGuess', count: reveal.length });
    await send(deps, meta.hostConnectionId, { event: 'revealGuesses', guesses: reveal });
    for (const p of players) {
      if (p.connected && p.connectionId) await send(deps, p.connectionId, { event: 'phaseChange', phase: 'closed', payload: {} });
    }
    return;
  }

  // Generic phase passthrough (host stays authoritative for game rules).
  await deps.update(roomPk(code), 'META', { phase: phaseName || meta.phase, ttl: ttlValue(now) });
  log({ roomCode: code, action: 'host:phase', outcome: 'passthrough', phase: phaseName });
  for (const p of players) {
    if (p.connected && p.connectionId) await send(deps, p.connectionId, { event: 'phaseChange', phase: phaseName, payload });
  }
}

async function hostKick(deps, connectionId, msg, conn) {
  const code = conn && conn.roomCode;
  const { meta, players } = code ? await loadRoom(deps, code) : { meta: null };
  if (!conn || conn.role !== 'host' || !meta || conn.token !== meta.hostToken) {
    return err(deps, connectionId, 'not_host', 'Host-only action');
  }
  const token = String(msg.token || '');
  const player = players.find((p) => p.SK === playerSk(token));
  if (!player) return err(deps, connectionId, 'no_player', 'No such player');
  await deps.del(roomPk(code), playerSk(token));
  if (player.connectionId) await deps.del(connPk(player.connectionId), 'META');
  await touchRoom(deps, code);
  log({ roomCode: code, action: 'host:kick', outcome: 'ok' });
  if (player.connectionId) await send(deps, player.connectionId, { event: 'phaseChange', phase: 'kicked', payload: {} });
  await broadcastRoster(deps, code);
}

// GM-from-phone (Phase B). The server only validates STRUCTURE + that the sender
// holds the room's current GM token; game validity (snapping, candidate math) is
// the host's job. gm:year / gm:pick are relayed to the host only.
async function gmRelay(deps, connectionId, msg, conn, kind) {
  const code = conn && conn.roomCode;
  const { meta } = code ? await loadRoom(deps, code) : { meta: null };
  if (!conn || conn.role !== 'player' || !meta) return err(deps, connectionId, 'not_bound', 'Not in a room');
  if (!meta.gmToken || conn.token !== meta.gmToken) {
    log({ roomCode: code, action: 'gm:' + kind, outcome: 'rejected_not_gm' });
    return err(deps, connectionId, 'not_gm', 'You are not the Game Master');
  }
  if (kind === 'year') {
    const year = Number(msg.year);
    if (!Number.isFinite(year)) return err(deps, connectionId, 'bad_request', 'year must be a number');
    await touchRoom(deps, code);
    log({ roomCode: code, action: 'gm:year', outcome: 'relayed' });
    await send(deps, meta.hostConnectionId, { event: 'gmYear', year });
  } else {
    const indices = Array.isArray(msg.indices) ? msg.indices.filter((n) => Number.isInteger(n)) : null;
    if (!indices || indices.length === 0) return err(deps, connectionId, 'bad_request', 'indices must be a non-empty array of integers');
    await touchRoom(deps, code);
    log({ roomCode: code, action: 'gm:pick', outcome: 'relayed' });
    await send(deps, meta.hostConnectionId, { event: 'gmPick', indices });
  }
}

// Host sets the room's current GM and relays a stage to that player only.
// Stages: year (bounds + eligibleYears), pick (candidate title/artist pairs), done.
async function hostGm(deps, connectionId, msg, conn) {
  const code = conn && conn.roomCode;
  const { meta, players } = code ? await loadRoom(deps, code) : { meta: null };
  if (!conn || conn.role !== 'host' || !meta || conn.token !== meta.hostToken) {
    return err(deps, connectionId, 'not_host', 'Host-only action');
  }
  const token = String(msg.token || '');
  const stage = String(msg.stage || '');
  const payload = (msg.payload && typeof msg.payload === 'object') ? msg.payload : {};
  await deps.update(roomPk(code), 'META', { gmToken: token, ttl: ttlValue(deps.now()) });
  const gmPlayer = players.find((p) => p.SK === playerSk(token));
  log({ roomCode: code, action: 'host:gm', outcome: gmPlayer && gmPlayer.connectionId ? 'delivered' : 'no_target', stage });
  if (gmPlayer && gmPlayer.connectionId) {
    await send(deps, gmPlayer.connectionId, { event: 'gmStage', stage, payload });
  }
}

async function heartbeat(deps, connectionId, msg, conn) {
  if (conn && conn.roomCode) await touchRoom(deps, conn.roomCode);
  return send(deps, connectionId, { event: 'pong' });
}

async function onDisconnect(deps, connectionId) {
  const conn = await deps.get(connPk(connectionId), 'META');
  if (!conn) return;
  await deps.del(connPk(connectionId), 'META');
  if (conn.role === 'player') {
    await deps.update(roomPk(conn.roomCode), playerSk(conn.token), { connected: false });
    log({ roomCode: conn.roomCode, action: 'disconnect', outcome: 'player' });
    await broadcastRoster(deps, conn.roomCode);
  } else if (conn.role === 'host') {
    // Room persists in DynamoDB; host reclaims with hostToken (ADR-5).
    log({ roomCode: conn.roomCode, action: 'disconnect', outcome: 'host' });
    const { players } = await loadRoom(deps, conn.roomCode);
    for (const p of players) {
      if (p.connected && p.connectionId) await send(deps, p.connectionId, { event: 'phaseChange', phase: 'hostAway', payload: {} });
    }
  }
}

// ── Router ────────────────────────────────────────────────────────────────────

// Token-bound actions require the connection to already be in a room.
const BOUND_ACTIONS = new Set(['submitGuess', 'host:phase', 'host:kick', 'heartbeat', 'gm:year', 'gm:pick', 'host:gm']);

export async function route(event, deps) {
  const rc = event.requestContext || {};
  const connectionId = rc.connectionId;
  const routeKey = rc.routeKey;

  if (routeKey === '$connect') return { statusCode: 200 };
  if (routeKey === '$disconnect') { await onDisconnect(deps, connectionId); return { statusCode: 200 }; }

  // $default
  const body = event.body || '';
  if (body.length > MAX_BODY) { await err(deps, connectionId, 'payload_too_large', 'Message too large'); return { statusCode: 200 }; }
  let msg;
  try { msg = JSON.parse(body); } catch { await err(deps, connectionId, 'bad_json', 'Invalid JSON'); return { statusCode: 200 }; }
  if (!msg || typeof msg.action !== 'string') { await err(deps, connectionId, 'bad_request', 'Missing action'); return { statusCode: 200 }; }

  const action = msg.action;
  try {
    if (action === 'createRoom') { await createRoom(deps, connectionId); return { statusCode: 200 }; }
    if (action === 'joinRoom') { await joinRoom(deps, connectionId, msg); return { statusCode: 200 }; }
    if (action === 'rejoin') { await rejoin(deps, connectionId, msg); return { statusCode: 200 }; }

    if (!BOUND_ACTIONS.has(action)) {
      log({ action, outcome: 'unknown_action' });
      await err(deps, connectionId, 'unknown_action', `Unknown action: ${action}`);
      return { statusCode: 200 };
    }

    // Token-bound actions: the connection must be bound to a room (a valid token
    // was presented at join/rejoin). Look up the connection index.
    const conn = await deps.get(connPk(connectionId), 'META');
    if (!conn) { await err(deps, connectionId, 'not_bound', 'Connection is not in a room'); return { statusCode: 200 }; }

    if (action === 'submitGuess') { await submitGuess(deps, connectionId, msg, conn); return { statusCode: 200 }; }
    if (action === 'host:phase') { await hostPhase(deps, connectionId, msg, conn); return { statusCode: 200 }; }
    if (action === 'host:kick') { await hostKick(deps, connectionId, msg, conn); return { statusCode: 200 }; }
    if (action === 'heartbeat') { await heartbeat(deps, connectionId, msg, conn); return { statusCode: 200 }; }
    if (action === 'gm:year') { await gmRelay(deps, connectionId, msg, conn, 'year'); return { statusCode: 200 }; }
    if (action === 'gm:pick') { await gmRelay(deps, connectionId, msg, conn, 'pick'); return { statusCode: 200 }; }
    if (action === 'host:gm') { await hostGm(deps, connectionId, msg, conn); return { statusCode: 200 }; }

    // Unreachable (BOUND_ACTIONS is exhaustive), but keep a safe default.
    await err(deps, connectionId, 'unknown_action', `Unknown action: ${action}`);
    return { statusCode: 200 };
  } catch (e) {
    log({ action, outcome: 'handler_error', error: e && e.name });
    await err(deps, connectionId, 'server_error', 'Something went wrong');
    return { statusCode: 200 };
  }
}
