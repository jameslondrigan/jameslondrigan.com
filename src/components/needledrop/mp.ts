/*
 * Track Record multiplayer client (host + controller share this).
 * Thin wrapper over one WebSocket to the router (docs/MULTIPLAYER-ARCHITECTURE.md
 * section 6). Auto-reconnects and re-presents the stored token (ADR-5), so a
 * dropped phone-wifi socket or a page reload is refresh-proof.
 *
 * Build-time endpoint constant.
 */
export const WS_URL = 'wss://ws.jameslondrigan.com';

export type RosterEntry = { name: string; connected: boolean; score: number; token?: string };

export type MpEvent =
  | { event: 'roomCreated'; code: string; hostToken: string }
  | { event: 'joined'; token: string; roster: RosterEntry[]; host?: boolean; phase?: string; roundNo?: number }
  | { event: 'rosterUpdate'; roster: RosterEntry[] }
  | { event: 'phaseChange'; phase: string; payload?: any }
  | { event: 'guessProgress'; submitted: number; total: number; in?: string[]; waiting?: string[] }
  | { event: 'revealGuesses'; guesses: { name: string; year: number }[] }
  | { event: 'guessLocked' }
  // Phase B GM-from-phone
  | { event: 'gmStage'; stage: string; payload?: any }  // to the GM's phone
  | { event: 'gmYear'; year: number }                   // to the host
  | { event: 'gmPick'; indices: number[] }              // to the host
  | { event: 'gmRejoined'; token: string }              // to the host
  | { event: 'pong' }
  | { event: 'error'; code: string; msg: string };

export type MpStatus = 'idle' | 'connecting' | 'open' | 'closed';

type RejoinArgs = { code: string; token: string };

export class MpClient {
  private ws: WebSocket | null = null;
  private readonly url: string;
  private readonly onEvent: (e: MpEvent) => void;
  private readonly onStatus: (s: MpStatus) => void;
  private hb: ReturnType<typeof setInterval> | null = null;
  private reconnectT: ReturnType<typeof setTimeout> | null = null;
  private wantOpen = false;
  private rejoin: RejoinArgs | null = null;
  private backoff = 1000;

  constructor(onEvent: (e: MpEvent) => void, onStatus: (s: MpStatus) => void, url: string = WS_URL) {
    this.onEvent = onEvent;
    this.onStatus = onStatus;
    this.url = url;
  }

  /** Resolves once the socket is open; rejects on early close/timeout (graceful-fallback path). */
  connect(timeoutMs = 7000): Promise<void> {
    this.wantOpen = true;
    this.onStatus('connecting');
    return new Promise((resolve, reject) => {
      let settled = false;
      let ws: WebSocket;
      try { ws = new WebSocket(this.url); } catch (e) { reject(e); return; }
      this.ws = ws;
      const to = setTimeout(() => { if (!settled) { settled = true; try { ws.close(); } catch { /* */ } reject(new Error('timeout')); } }, timeoutMs);

      ws.onopen = () => {
        clearTimeout(to);
        this.backoff = 1000;
        this.onStatus('open');
        this.startHeartbeat();
        if (this.rejoin) this.raw({ action: 'rejoin', ...this.rejoin });
        if (!settled) { settled = true; resolve(); }
      };
      ws.onmessage = (m) => {
        let data: MpEvent | null = null;
        try { data = JSON.parse(typeof m.data === 'string' ? m.data : ''); } catch { data = null; }
        if (data && (data as any).event) this.onEvent(data);
      };
      ws.onerror = () => { /* surfaced via onclose */ };
      ws.onclose = () => {
        clearTimeout(to);
        this.stopHeartbeat();
        this.onStatus('closed');
        if (!settled) { settled = true; reject(new Error('closed')); }
        if (this.wantOpen) this.scheduleReconnect();
      };
    });
  }

  private scheduleReconnect() {
    if (this.reconnectT) return;
    const delay = this.backoff;
    this.backoff = Math.min(this.backoff * 2, 15000);
    this.reconnectT = setTimeout(() => {
      this.reconnectT = null;
      if (this.wantOpen) this.connect().catch(() => { /* onclose reschedules */ });
    }, delay);
  }

  private startHeartbeat() {
    this.stopHeartbeat();
    this.hb = setInterval(() => this.raw({ action: 'heartbeat' }), 30000);
  }
  private stopHeartbeat() { if (this.hb) { clearInterval(this.hb); this.hb = null; } }

  private raw(obj: object) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      try { this.ws.send(JSON.stringify(obj)); } catch { /* dropped; reconnect will re-sync */ }
    }
  }

  /** Store the identity used to auto-rejoin after a drop/reload. */
  setRejoin(code: string, token: string) { this.rejoin = { code, token }; }

  createRoom() { this.raw({ action: 'createRoom' }); }
  joinRoom(code: string, name: string) { this.raw({ action: 'joinRoom', code, name }); }
  rejoinNow(code: string, token: string) { this.rejoin = { code, token }; this.raw({ action: 'rejoin', code, token }); }
  hostPhase(phase: string, payload?: object) { this.raw({ action: 'host:phase', phase, payload: payload || {} }); }
  submitGuess(year: number) { this.raw({ action: 'submitGuess', year }); }
  kick(token: string) { this.raw({ action: 'host:kick', token }); }
  // Phase B GM-from-phone
  hostGm(token: string, stage: string, payload?: object) { this.raw({ action: 'host:gm', token, stage, payload: payload || {} }); }
  gmYear(year: number) { this.raw({ action: 'gm:year', year }); }
  gmPick(indices: number[]) { this.raw({ action: 'gm:pick', indices }); }

  close() {
    this.wantOpen = false;
    if (this.reconnectT) { clearTimeout(this.reconnectT); this.reconnectT = null; }
    this.stopHeartbeat();
    if (this.ws) { try { this.ws.close(); } catch { /* */ } this.ws = null; }
  }
}
