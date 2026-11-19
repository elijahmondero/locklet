import { EventEmitter } from 'node:events';
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server as HttpServer,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebcastPushConnection } from 'tiktok-live-connector';
import { WebSocketServer, WebSocket } from 'ws';
import type { GameModeSetting, RoomSnapshotMessage, RoomThemeId } from '../../shared/types.js';
import { LockletSqliteStore } from '../db/sqlite.js';
import {
  EscapeRoomEngine,
  type ChatActionResult,
  type GiftActionResult,
} from '../game/escapeEngine.js';

export interface TikTokConnectorLike extends EventEmitter {
  connect: () => Promise<unknown>;
  disconnect: () => void;
}

export interface LockletServerOptions {
  dbPath?: string;
  port?: number;
  host?: string;
  tiktokUsername?: string;
  allowSimRoutes?: boolean;
  simSecret?: string;
  corsOrigin?: string;
  connectorFactory?: (username: string) => TikTokConnectorLike;
  initialMode?: GameModeSetting;
  tickIntervalMs?: number;
  rng?: () => number;
  now?: () => number;
}

export interface LockletStartInfo {
  port: number;
  host: string;
  httpUrl: string;
  wsUrl: string;
  liveMode: boolean;
}

interface RawGiftEvent {
  uniqueId?: unknown;
  username?: unknown;
  giftId?: unknown;
  giftName?: unknown;
  repeatCount?: unknown;
  diamondCount?: unknown;
  diamondEach?: unknown;
  repeatEnd?: unknown;
  msgId?: unknown;
}

function extractName(evt: { uniqueId?: unknown; username?: unknown; nickname?: unknown }): string {
  if (typeof evt.uniqueId === 'string' && evt.uniqueId.trim()) return evt.uniqueId;
  if (typeof evt.username === 'string' && evt.username.trim()) return evt.username;
  if (typeof evt.nickname === 'string' && evt.nickname.trim()) return evt.nickname;
  return 'Player';
}

export class LockletGameServer {
  private readonly store: LockletSqliteStore;
  private readonly engine: EscapeRoomEngine;
  private readonly tiktokUsername: string;
  private readonly connectorFactory?: (username: string) => TikTokConnectorLike;
  private readonly port: number;
  private readonly host: string;
  private readonly liveModeConfigured: boolean;
  private readonly allowSimRoutes: boolean;
  private readonly simSecret: string;
  private readonly corsOrigin: string;
  private readonly tickIntervalMs: number;
  private readonly now: () => number;

  private httpServer: HttpServer | null = null;
  private wss: WebSocketServer | null = null;
  private connector: TikTokConnectorLike | null = null;
  private startInfo: LockletStartInfo | null = null;
  private tickTimer: ReturnType<typeof setInterval> | null = null;

  private readonly activeGiftStreaks = new Map<string, number>();
  private readonly seenMsgIds: string[] = [];
  private readonly seenMsgIdSet = new Set<string>();

  constructor(options: LockletServerOptions = {}) {
    this.now = options.now ?? Date.now;
    this.store = new LockletSqliteStore(options.dbPath ?? 'locklet.db');
    this.engine = new EscapeRoomEngine({
      rng: options.rng,
      stats: this.store,
      initialMode: options.initialMode ?? 'auto',
      nowMs: this.now(),
    });

    this.tiktokUsername = (options.tiktokUsername ?? process.env.TIKTOK_USERNAME ?? '')
      .trim()
      .replace(/^@/, '');
    this.connectorFactory = options.connectorFactory;
    this.port = options.port ?? Number(process.env.PORT ?? 8080);
    this.host = options.host ?? (process.env.HOST?.trim() || '127.0.0.1');
    this.liveModeConfigured = Boolean(this.tiktokUsername);

    const envAllowSim =
      process.env.ALLOW_SIM_ROUTES === 'true' || process.env.LOCKLET_ALLOW_SIM_ROUTES === 'true';
    this.allowSimRoutes = options.allowSimRoutes ?? (this.liveModeConfigured ? envAllowSim : true);
    this.simSecret = (options.simSecret ?? process.env.LOCKLET_SIM_SECRET ?? '').trim();
    this.corsOrigin = options.corsOrigin ?? (process.env.CORS_ORIGIN?.trim() || '');
    this.tickIntervalMs = options.tickIntervalMs ?? 1000;
  }

  public getEngine(): EscapeRoomEngine {
    return this.engine;
  }

  public getStore(): LockletSqliteStore {
    return this.store;
  }

  public getSnapshot(nowMs = this.now()): RoomSnapshotMessage {
    return this.engine.getSnapshot(nowMs);
  }

  public broadcastSnapshot(nowMs = this.now()): RoomSnapshotMessage {
    const snap = this.engine.getSnapshot(nowMs);
    if (this.wss && this.wss.clients.size > 0) {
      const payload = JSON.stringify(snap);
      for (const client of this.wss.clients) {
        if (client.readyState === WebSocket.OPEN) {
          client.send(payload);
        }
      }
    }
    return snap;
  }

  public handleMember(evt: { uniqueId?: unknown; username?: unknown }, nowMs = this.now()): void {
    this.engine.handleMember(extractName(evt), nowMs);
    this.broadcastSnapshot(nowMs);
  }

  public handleChat(
    evt: { uniqueId?: unknown; username?: unknown; comment?: unknown; text?: unknown; message?: unknown },
    nowMs = this.now()
  ): ChatActionResult {
    const comment =
      typeof evt.comment === 'string'
        ? evt.comment
        : typeof evt.text === 'string'
          ? evt.text
          : typeof evt.message === 'string'
            ? evt.message
            : '';
    const res = this.engine.handleChat(extractName(evt), comment, nowMs);
    if (res.handled) {
      this.broadcastSnapshot(nowMs);
    }
    return res;
  }

  public handleLike(
    evt: { uniqueId?: unknown; username?: unknown; likeCount?: unknown },
    nowMs = this.now()
  ): boolean {
    const count =
      typeof evt.likeCount === 'number' && Number.isFinite(evt.likeCount)
        ? Math.max(1, Math.floor(evt.likeCount))
        : 1;
    const boosted = this.engine.handleLikes(extractName(evt), count, nowMs);
    this.broadcastSnapshot(nowMs);
    return boosted;
  }

  public handleGift(evt: RawGiftEvent, nowMs = this.now()): GiftActionResult | null {
    const msgId = typeof evt.msgId === 'string' ? evt.msgId.trim() : '';
    if (msgId && this.seenMsgIdSet.has(msgId)) {
      return null;
    }

    const user = extractName(evt);
    const giftId = String(evt.giftId ?? evt.giftName ?? 'gift');
    const streakKey = `${user.toLowerCase()}::${giftId}`;
    const repeatCount =
      typeof evt.repeatCount === 'number' && Number.isFinite(evt.repeatCount)
        ? Math.max(1, Math.floor(evt.repeatCount))
        : 1;
    const unitDiamonds =
      typeof evt.diamondCount === 'number' && Number.isFinite(evt.diamondCount)
        ? Math.max(1, Math.floor(evt.diamondCount))
        : typeof evt.diamondEach === 'number' && Number.isFinite(evt.diamondEach)
          ? Math.max(1, Math.floor(evt.diamondEach))
          : 1;

    const prevCount = this.activeGiftStreaks.get(streakKey) ?? 0;
    const deltaCount = Math.max(0, repeatCount - prevCount);
    if (evt.repeatEnd === true) {
      this.activeGiftStreaks.delete(streakKey);
    } else {
      this.activeGiftStreaks.set(streakKey, Math.max(prevCount, repeatCount));
    }

    if (msgId) {
      this.seenMsgIdSet.add(msgId);
      this.seenMsgIds.push(msgId);
      if (this.seenMsgIds.length > 2000) {
        const oldest = this.seenMsgIds.shift();
        if (oldest) this.seenMsgIdSet.delete(oldest);
      }
    }

    if (deltaCount <= 0) return null;
    const res = this.engine.handleGift(user, deltaCount * unitDiamonds, nowMs);
    this.broadcastSnapshot(nowMs);
    return res;
  }

  public async start(): Promise<LockletStartInfo> {
    if (this.startInfo) return this.startInfo;

    const httpServer = createHttpServer((req, res) => {
      void this.handleHttpRequest(req, res);
    });
    const wss = new WebSocketServer({ server: httpServer });

    wss.on('connection', (socket) => {
      socket.on('error', () => {});
      try {
        socket.send(JSON.stringify(this.getSnapshot()));
      } catch {}
    });

    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error) => {
        httpServer.off('listening', onListening);
        reject(err);
      };
      const onListening = () => {
        httpServer.off('error', onError);
        resolve();
      };
      httpServer.once('error', onError);
      httpServer.once('listening', onListening);
      httpServer.listen(this.port, this.host);
    });

    this.httpServer = httpServer;
    this.wss = wss;

    if (this.tickIntervalMs > 0) {
      this.tickTimer = setInterval(() => {
        const nowMs = this.now();
        this.engine.tick(nowMs);
        if (this.wss && this.wss.clients.size > 0) {
          this.broadcastSnapshot(nowMs);
        }
      }, this.tickIntervalMs);
    }

    const liveMode = await this.connectTikTokIfConfigured();
    const addr = httpServer.address() as AddressInfo;
    const boundHost = addr.address === '::' || addr.address === '0.0.0.0' ? '127.0.0.1' : addr.address;
    this.startInfo = {
      port: addr.port,
      host: boundHost,
      httpUrl: `http://${boundHost}:${addr.port}`,
      wsUrl: `ws://${boundHost}:${addr.port}`,
      liveMode,
    };
    return this.startInfo;
  }

  public async stop(): Promise<void> {
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
    if (this.connector) {
      try {
        this.connector.removeAllListeners();
        this.connector.disconnect();
      } catch {}
      this.connector = null;
    }
    if (this.wss) {
      const w = this.wss;
      this.wss = null;
      for (const client of w.clients) {
        try {
          client.terminate();
        } catch {}
      }
      await new Promise<void>((resolve) => w.close(() => resolve()));
    }
    if (this.httpServer) {
      const srv = this.httpServer;
      this.httpServer = null;
      await new Promise<void>((resolve) => srv.close(() => resolve()));
    }
    this.startInfo = null;
    this.store.close();
  }

  private async connectTikTokIfConfigured(): Promise<boolean> {
    if (!this.tiktokUsername) return false;
    const connector = this.connectorFactory
      ? this.connectorFactory(this.tiktokUsername)
      : (new WebcastPushConnection(this.tiktokUsername, {
          processInitialData: false,
          enableExtendedGiftInfo: true,
        }) as unknown as TikTokConnectorLike);

    this.connector = connector;
    connector.on('member', (d) => this.handleMember(d));
    connector.on('chat', (d) => this.handleChat(d));
    connector.on('like', (d) => this.handleLike(d));
    connector.on('gift', (d) => this.handleGift(d));
    connector.on('error', (err) => console.error('TikTok connector error:', err));

    try {
      await connector.connect();
      return true;
    } catch (err) {
      console.error('TikTok Live connect failed (staying in simulator/WS mode):', err);
      return false;
    }
  }

  private applyCorsHeaders(req: IncomingMessage, res: ServerResponse): void {
    const origin = typeof req.headers.origin === 'string' ? req.headers.origin : '';
    if (this.corsOrigin) {
      res.setHeader('Access-Control-Allow-Origin', this.corsOrigin);
    } else if (!this.liveModeConfigured) {
      res.setHeader('Access-Control-Allow-Origin', '*');
    } else if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
    }
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Locklet-Sim-Secret');
  }

  private isSimAuthorized(req: IncomingMessage): boolean {
    if (this.simSecret) {
      const headerSecret = req.headers['x-locklet-sim-secret'];
      const authHeader =
        typeof req.headers.authorization === 'string' ? req.headers.authorization : '';
      const bearer = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
      return headerSecret === this.simSecret || bearer === this.simSecret;
    }
    return this.allowSimRoutes;
  }

  private sendJson(res: ServerResponse, status: number, data: unknown): void {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(data));
  }

  private readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let totalBytes = 0;
      req.on('data', (chunk: Buffer) => {
        totalBytes += chunk.length;
        if (totalBytes > 64 * 1024) {
          req.destroy();
          reject(new Error('Body too large'));
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8').trim();
        if (!raw) {
          resolve({});
          return;
        }
        try {
          resolve(JSON.parse(raw) as Record<string, unknown>);
        } catch {
          reject(new Error('Invalid JSON'));
        }
      });
      req.on('error', reject);
    });
  }

  private async handleHttpRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    this.applyCorsHeaders(req, res);
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const parsed = new URL(req.url ?? '/', 'http://127.0.0.1');
    const pathname = parsed.pathname;

    if (req.method === 'GET' && pathname === '/health') {
      this.sendJson(res, 200, {
        ok: true,
        mode: this.liveModeConfigured ? 'live' : 'simulator',
        activePlayers: this.getSnapshot().activePlayersCount,
      });
      return;
    }

    if (req.method === 'GET' && pathname === '/api/snapshot') {
      this.sendJson(res, 200, this.getSnapshot());
      return;
    }

    if (req.method === 'GET' && pathname === '/api/leaderboard') {
      this.sendJson(res, 200, { leaderboard: this.store.getLeaderboard(25) });
      return;
    }

    if (req.method === 'POST' && pathname.startsWith('/sim/')) {
      if (!this.isSimAuthorized(req)) {
        this.sendJson(res, 403, { ok: false, error: 'Simulator routes disabled in live mode' });
        return;
      }
      let body: Record<string, unknown> = {};
      try {
        body = await this.readJsonBody(req);
      } catch (err) {
        this.sendJson(res, 400, { ok: false, error: err instanceof Error ? err.message : 'Bad request' });
        return;
      }

      if (pathname === '/sim/member') {
        this.handleMember(body);
        this.sendJson(res, 200, { ok: true });
        return;
      }
      if (pathname === '/sim/chat') {
        const result = this.handleChat(body);
        this.sendJson(res, 200, { ok: true, result });
        return;
      }
      if (pathname === '/sim/like') {
        this.handleLike(body);
        this.sendJson(res, 200, { ok: true });
        return;
      }
      if (pathname === '/sim/gift') {
        const result = this.handleGift(body);
        this.sendJson(res, 200, { ok: true, result });
        return;
      }
      if (pathname === '/sim/mode') {
        const mode = String(body.mode ?? 'auto') as GameModeSetting;
        if (mode === 'coop' || mode === 'versus' || mode === 'auto') {
          this.engine.setModeSetting(mode, this.now());
          this.broadcastSnapshot();
          this.sendJson(res, 200, { ok: true, mode });
          return;
        }
        this.sendJson(res, 400, { ok: false, error: 'Invalid mode' });
        return;
      }
      if (pathname === '/sim/next-room') {
        const forced = typeof body.theme === 'string' ? (body.theme as RoomThemeId) : undefined;
        this.engine.startNewRound(this.now(), forced);
        this.broadcastSnapshot();
        this.sendJson(res, 200, { ok: true });
        return;
      }
      if (pathname === '/sim/crowd') {
        const rawCount = Number(body.count ?? 100);
        const count = Math.max(1, Math.min(500, Number.isFinite(rawCount) ? Math.floor(rawCount) : 100));
        const nowMs = this.now();
        for (let i = 1; i <= count; i++) {
          this.engine.handleMember(`Viewer${i}`, nowMs);
        }
        this.broadcastSnapshot();
        const snap = this.getSnapshot(nowMs);
        this.sendJson(res, 200, { ok: true, added: count, activePlayersCount: snap.activePlayersCount });
        return;
      }
    }

    this.sendJson(res, 404, { ok: false, error: 'Not found' });
  }
}
