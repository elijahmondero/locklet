import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ROOM_THEME_ORDER, ROOM_THEMES, WIRE_COLORS } from '../src/shared/constants';
import { LockletSqliteStore } from '../src/server/db/sqlite';
import { EscapeRoomEngine } from '../src/server/game/escapeEngine';

function createSeqRng(values: number[]): () => number {
  let idx = 0;
  return () => {
    const val = values[idx % values.length];
    idx++;
    return val;
  };
}

describe('EscapeRoomEngine — Procedural Rooms, Dual Modes & Balanced Gifts', () => {
  let store: LockletSqliteStore;

  beforeEach(() => {
    store = new LockletSqliteStore(':memory:');
  });

  afterEach(() => {
    store.close();
  });

  it('rotates through all 4 room themes, shuffles props, generates fresh secrets, and never leaks secrets in snapshots', () => {
    let seed = 1;
    const pseudoRng = () => {
      seed = (seed * 16807) % 2147483647;
      return (seed - 1) / 2147483646;
    };

    const engine = new EscapeRoomEngine({
      rng: pseudoRng,
      stats: store,
      initialMode: 'coop',
      nowMs: 1_000_000,
    });

    const seenThemes: string[] = [];
    const seenPropLayouts: string[] = [];

    for (let r = 0; r < 4; r++) {
      const snap = engine.getSnapshot(1_000_000 + r * 1000);
      seenThemes.push(snap.theme.id);
      const chamber = snap.chambers.coop!;
      seenPropLayouts.push(chamber.props.map((p) => `${p.name}@${p.corner}`).join(','));

      // Anti-cheat: public snapshot must never contain internal secret keys
      const rawJson = JSON.stringify(snap);
      expect(rawJson).not.toContain('secretWire');
      expect(rawJson).not.toContain('secretPin');
      expect(rawJson).not.toContain('secretBridge');

      engine.startNewRound(1_000_000 + (r + 1) * 1000);
    }

    expect(seenThemes).toEqual([...ROOM_THEME_ORDER]);
    expect(new Set(seenPropLayouts).size).toBeGreaterThanOrEqual(2);
  });

  it('solves Co-op Locks 1->2->3 via crowd clues & spotlight turns, then opens 10s Getaway Dash with 3 Chests', () => {
    // Deterministic rng=0 -> wire='red', d1=1, d2=0, d3=0 -> PIN=100, bridge=['L','L','L']
    const engine = new EscapeRoomEngine({
      rng: () => 0,
      stats: store,
      initialMode: 'coop',
      nowMs: 1_000_000,
    });

    engine.handleMember('ClueHunter', 1_000_100);
    engine.handleMember('SpeedRunner', 1_000_200);

    // Non-spotlight player searches all 4 props for clues anytime!
    const propNames = [...ROOM_THEMES.sunken_treasury.props];
    for (const pName of propNames) {
      const res = engine.handleChat('SpeedRunner', pName, 1_000_300);
      expect(res.kind).toBe('prop');
    }

    // Wrong wire eliminates & zaps spotlight to SpeedRunner; cut correct 'red' wire opens Lock 2
    const snapBeforeWire = engine.getSnapshot(1_000_350);
    const wrongWire = WIRE_COLORS.find((w) => w !== 'red')!;
    const active1 = snapBeforeWire.chambers.coop!.spotlightPlayer!;
    engine.handleChat(active1, wrongWire, 1_000_400);
    expect(engine.getSnapshot(1_000_400).chambers.coop!.eliminatedWires).toContain(wrongWire);

    const active2 = engine.getSnapshot(1_000_450).chambers.coop!.spotlightPlayer!;
    const lock1Res = engine.handleChat(active2, 'red', 1_000_500);
    expect(lock1Res.kind).toBe('wire');
    expect(engine.getSnapshot(1_000_500).chambers.coop!.lockStage).toBe(2);

    // Keypad narrows bounds on wrong guess ('LOWER'), then exact '100' opens Lock 3
    const active3 = engine.getSnapshot(1_000_550).chambers.coop!.spotlightPlayer!;
    engine.handleChat(active3, '250', 1_000_600);
    const midSnap = engine.getSnapshot(1_000_600);
    expect(midSnap.chambers.coop!.lastPinHint).toBe('LOWER');
    expect(midSnap.chambers.coop!.maxBound).toBe(249);

    const active4 = midSnap.chambers.coop!.spotlightPlayer!;
    engine.handleChat(active4, '100', 1_000_700);
    expect(engine.getSnapshot(1_000_700).chambers.coop!.lockStage).toBe(3);

    // Bridge 3 steps ('L', 'L', 'L') triggers Co-op Getaway Dash!
    for (let step = 0; step < 3; step++) {
      const sp = engine.getSnapshot(1_000_800 + step * 50).chambers.coop!.spotlightPlayer!;
      engine.handleChat(sp, 'L', 1_000_810 + step * 50);
    }

    const getawaySnap = engine.getSnapshot(1_001_000);
    expect(getawaySnap.phase).toBe('getaway');
    expect(getawaySnap.getawayWinners.clueMvp).toBe('@SpeedRunner');
    expect(getawaySnap.getawayWinners.lockbreaker).not.toBeNull();

    // Runner grabs Chest #3 during the 10s dash!
    engine.handleChat('ClueHunter', 'run', 1_001_100);
    const afterRun = engine.getSnapshot(1_001_100);
    expect(afterRun.getawayWinners.firstRunner).toBe('@ClueHunter');
    expect(afterRun.getawayWinners.runners).toContain('@ClueHunter');

    // Advancing clock past 10s closes Getaway cleanly into round_over
    engine.tick(1_012_000);
    expect(engine.getSnapshot(1_012_000).phase).toBe('round_over');
  });

  it('runs Red vs Blue Versus Race and drops losing room into pit on Lock 3 completion', () => {
    const engine = new EscapeRoomEngine({
      rng: () => 0, // wire='red', pin=100, bridge=['L','L','L']
      stats: store,
      initialMode: 'versus',
      nowMs: 2_000_000,
    });

    engine.handleChat('RedAce', 'red', 2_000_100);
    engine.handleChat('BlueAce', 'blue', 2_000_200);

    const snap = engine.getSnapshot(2_000_250);
    expect(snap.activeMode).toBe('versus');
    expect(snap.chambers.red?.spotlightPlayer).toBe('@RedAce');
    expect(snap.chambers.blue?.spotlightPlayer).toBe('@BlueAce');

    // Red solves all 3 locks first
    engine.handleChat('RedAce', 'red', 2_000_300);
    engine.handleChat('RedAce', '100', 2_000_400);
    engine.handleChat('RedAce', 'L', 2_000_500);
    engine.handleChat('RedAce', 'L', 2_000_600);
    engine.handleChat('RedAce', 'L', 2_000_700);

    const winSnap = engine.getSnapshot(2_000_700);
    expect(winSnap.phase).toBe('round_over');
    expect(winSnap.winnerTeam).toBe('red');
    expect(winSnap.loserPitTeam).toBe('blue');
  });

  it('enforces balanced gifts (UV clue, Cut-Line, 1-per-room Shield cap, Blackout/2x Cursed Pot) & Auto mode alternation', () => {
    const engine = new EscapeRoomEngine({
      rng: createSeqRng([0]),
      stats: store,
      initialMode: 'auto',
      nowMs: 3_000_000,
    });

    // Round 1 in auto -> coop
    expect(engine.getSnapshot(3_000_000).activeMode).toBe('coop');

    // 5💎 UV reveals an unsearched prop
    const uvRes = engine.handleGift('Helper', 5, 3_000_100);
    expect(uvRes.tier).toBe('uv');
    expect(engine.getSnapshot(3_000_100).chambers.coop!.props.some((p) => p.searchedBy === '@Helper (UV)')).toBe(true);

    // 15💎 Pump Shield adds 1-Hit Shield, consumed on wrong wire; second 15💎 in same room does NOT re-grant shield!
    engine.handleMember('VIPOne', 3_000_150);
    engine.handleGift('VIPOne', 10, 3_000_200); // Cut line to spotlight
    expect(engine.getSnapshot(3_000_200).chambers.coop!.spotlightPlayer).toBe('@VIPOne');

    engine.handleGift('VIPOne', 15, 3_000_250);
    expect(engine.getSnapshot(3_000_250).chambers.coop!.shieldedPlayers).toContain('@VIPOne');

    // Wrong wire 'blue' (secret is 'red') consumes shield without kicking @VIPOne out
    engine.handleChat('VIPOne', 'blue', 3_000_300);
    expect(engine.getSnapshot(3_000_300).chambers.coop!.spotlightPlayer).toBe('@VIPOne');
    expect(engine.getSnapshot(3_000_300).chambers.coop!.shieldedPlayers).not.toContain('@VIPOne');

    // Second 15💎 gift from @VIPOne in same room must NOT re-grant shield (1-shield-per-room balance cap)
    engine.handleGift('VIPOne', 15, 3_000_350);
    expect(engine.getSnapshot(3_000_350).chambers.coop!.shieldedPlayers).not.toContain('@VIPOne');

    // 25💎 Cursed Pot in coop doubles bounty & accelerates hazard 1.35x
    engine.handleGift('HighRoller', 25, 3_000_400);
    expect(engine.getSnapshot(3_000_400).cursedDoublePot).toBe(true);
    expect(engine.getSnapshot(3_000_400).potGold).toBe(240);

    // Round 2 in auto -> versus (alternates automatically)
    const r2 = engine.startNewRound(3_010_000);
    expect(r2.activeMode).toBe('versus');

    // 25💎 Blackout from Red player blacks out Blue room
    engine.handleChat('RedBoss', 'red', 3_010_100);
    engine.handleChat('BlueGuy', 'blue', 3_010_150);
    engine.handleGift('RedBoss', 25, 3_010_200);
    const vSnap = engine.getSnapshot(3_010_200);
    expect(vSnap.chambers.blue!.blackoutUntilMs).toBeGreaterThan(3_010_200);
  });
});
