import Database from 'better-sqlite3';
import type { StatsStore } from '../game/escapeEngine.js';
import type { HeroClass, PlayerStatsRecord } from '../../shared/types.js';

function normalizeKey(username: string): string {
  const clean = username.trim().replace(/^@+/, '');
  return clean ? `@${clean}` : '@Guest';
}

export class LockletSqliteStore implements StatsStore {
  public readonly db: Database.Database;

  constructor(dbPath = 'locklet.db') {
    this.db = new Database(dbPath);
    if (dbPath !== ':memory:') {
      this.db.pragma('journal_mode = WAL');
      this.db.pragma('synchronous = NORMAL');
    }
    this.db.pragma('busy_timeout = 5000');
    this.initTables();
  }

  private initTables(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS players (
        username TEXT PRIMARY KEY,
        cls TEXT NOT NULL DEFAULT 'knight',
        wins INTEGER NOT NULL DEFAULT 0,
        escapes INTEGER NOT NULL DEFAULT 0,
        locks_cracked INTEGER NOT NULL DEFAULT 0,
        clues_found INTEGER NOT NULL DEFAULT 0,
        gold INTEGER NOT NULL DEFAULT 0,
        lifetime_diamonds INTEGER NOT NULL DEFAULT 0,
        last_active_at INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_players_gold ON players (gold DESC, wins DESC);
      CREATE INDEX IF NOT EXISTS idx_players_username_lower ON players (LOWER(username));
    `);
  }

  public getPlayer(rawUsername: string): PlayerStatsRecord | null {
    const norm = normalizeKey(rawUsername);
    const bare = norm.replace(/^@/, '');
    const row = this.db
      .prepare(
        `SELECT * FROM players WHERE LOWER(username) IN (LOWER(?), LOWER(?)) LIMIT 1`
      )
      .get(norm, bare) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      username: String(row.username),
      cls: (row.cls as HeroClass) || 'knight',
      wins: Number(row.wins ?? 0),
      escapes: Number(row.escapes ?? 0),
      locksCracked: Number(row.locks_cracked ?? 0),
      cluesFound: Number(row.clues_found ?? 0),
      gold: Number(row.gold ?? 0),
      lifetimeDiamonds: Number(row.lifetime_diamonds ?? 0),
      lastActiveAt: Number(row.last_active_at ?? 0),
    };
  }

  public recordAction(
    rawUsername: string,
    delta: Partial<{
      cls: HeroClass;
      wins: number;
      escapes: number;
      locksCracked: number;
      cluesFound: number;
      gold: number;
      lifetimeDiamonds: number;
    }>,
    nowMs = Date.now()
  ): void {
    const existing = this.getPlayer(rawUsername);
    const targetName = existing ? existing.username : normalizeKey(rawUsername);

    if (!existing) {
      this.db
        .prepare(
          `INSERT INTO players (
            username, cls, wins, escapes, locks_cracked, clues_found, gold, lifetime_diamonds, last_active_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          targetName,
          delta.cls ?? 'knight',
          Math.max(0, delta.wins ?? 0),
          Math.max(0, delta.escapes ?? 0),
          Math.max(0, delta.locksCracked ?? 0),
          Math.max(0, delta.cluesFound ?? 0),
          Math.max(0, delta.gold ?? 0),
          Math.max(0, delta.lifetimeDiamonds ?? 0),
          nowMs
        );
      return;
    }

    this.db
      .prepare(
        `UPDATE players SET
          cls = COALESCE(?, cls),
          wins = wins + ?,
          escapes = escapes + ?,
          locks_cracked = locks_cracked + ?,
          clues_found = clues_found + ?,
          gold = gold + ?,
          lifetime_diamonds = lifetime_diamonds + ?,
          last_active_at = MAX(last_active_at, ?)
        WHERE username = ?`
      )
      .run(
        delta.cls ?? null,
        delta.wins ?? 0,
        delta.escapes ?? 0,
        delta.locksCracked ?? 0,
        delta.cluesFound ?? 0,
        delta.gold ?? 0,
        delta.lifetimeDiamonds ?? 0,
        nowMs,
        targetName
      );
  }

  public getLeaderboard(limit = 15): PlayerStatsRecord[] {
    const rows = this.db
      .prepare(`SELECT * FROM players ORDER BY wins DESC, gold DESC, clues_found DESC LIMIT ?`)
      .all(Math.max(1, limit)) as Array<Record<string, unknown>>;

    return rows.map((row) => ({
      username: String(row.username),
      cls: (row.cls as HeroClass) || 'knight',
      wins: Number(row.wins ?? 0),
      escapes: Number(row.escapes ?? 0),
      locksCracked: Number(row.locks_cracked ?? 0),
      cluesFound: Number(row.clues_found ?? 0),
      gold: Number(row.gold ?? 0),
      lifetimeDiamonds: Number(row.lifetime_diamonds ?? 0),
      lastActiveAt: Number(row.last_active_at ?? 0),
    }));
  }

  public close(): void {
    this.db.close();
  }
}
