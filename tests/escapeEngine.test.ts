import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  BRIDGE_STEPS,
  ROOM_DURATION_SEC,
  ROOM_THEME_ORDER,
  ROOM_THEMES,
  TRAP_PENALTY_SEC,
  WIRE_COLORS,
  ZAP_PENALTY_SEC,
} from '../src/shared/constants';
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

describe('EscapeRoomEngine — Procedural 6-Prop Rooms, High-Stakes Locks, Memory Bridge & Gifts', () => {
  let store: LockletSqliteStore;

  beforeEach(() => {
    store = new LockletSqliteStore(':memory:');
  });

  afterEach(() => {
    store.close();
  });

  it('rotates through all 4 room themes with 6 props, 6 wires, 4 bridge slots, and zero secret leaks', () => {
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

    expect(WIRE_COLORS).toHaveLength(6);
    expect(BRIDGE_STEPS).toBe(4);

    const seenThemes: string[] = [];
    const seenPropLayouts: string[] = [];

    for (let r = 0; r < 4; r++) {
      const snap = engine.getSnapshot(1_000_000 + r * 1000);
      seenThemes.push(snap.theme.id);
      const chamber = snap.chambers.coop!;
      expect(chamber.props).toHaveLength(6);
      expect(chamber.props.map((p) => p.corner)).toEqual(['nw', 'ne', 'mw', 'me', 'sw', 'se']);
      expect(chamber.revealedSteps).toHaveLength(4);
      // Anti-cheat: unsearched traps must not leak isTrap=true before searching
      expect(chamber.props.every((p) => p.isTrap === false)).toBe(true);
      expect(chamber.props.filter((p) => p.uvOnly).length).toBe(1);

      seenPropLayouts.push(chamber.props.map((p) => `${p.name}@${p.corner}`).join(','));

      const rawJson = JSON.stringify(snap);
      expect(rawJson).not.toContain('secretWire');
      expect(rawJson).not.toContain('wireExclude');
      expect(rawJson).not.toContain('secretPin');
      expect(rawJson).not.toContain('secretBridge');

      engine.startNewRound(1_000_000 + (r + 1) * 1000);
    }

    expect(seenThemes).toEqual([...ROOM_THEME_ORDER]);
    expect(new Set(seenPropLayouts).size).toBeGreaterThanOrEqual(2);
  });

  it('enforces 1-search battery per stage, invisible-ink UV lock, booby-trap -5s & riddle deductions', () => {
    // With rng=0 on sunken_treasury:
    // wire_riddle='chest', pin_riddle_a='statue', pin_riddle_b='barrel', uv_secret='compass', traps=['helm','anchor']
    const engine = new EscapeRoomEngine({
      rng: () => 0,
      stats: store,
      initialMode: 'coop',
      nowMs: 1_000_000,
    });

    engine.handleMember('PlayerOne', 1_000_100);
    engine.handleMember('PlayerTwo', 1_000_200);
    engine.handleMember('PlayerThree', 1_000_300);

    // Clicking invisible-ink prop without UV gift refuses to reveal & does NOT burn battery
    const uvDenied = engine.handleChat('PlayerOne', 'compass', 1_000_350);
    expect(uvDenied.message).toContain('Invisible Ink');
    expect(engine.getSnapshot(1_000_350).chambers.coop!.exhaustedSearchers).not.toContain('@PlayerOne');

    // Searching a riddle clue succeeds and consumes PlayerOne's 1 battery for Lock 1
    const riddleRes = engine.handleChat('PlayerOne', 'chest', 1_000_400);
    expect(riddleRes.kind).toBe('prop');
    expect(riddleRes.message).toContain('WARM');
    expect(engine.getSnapshot(1_000_400).chambers.coop!.discoveredClues.length).toBe(1);
    expect(engine.getSnapshot(1_000_400).chambers.coop!.exhaustedSearchers).toContain('@PlayerOne');

    // Second search in same Lock stage by PlayerOne is blocked
    const secondTry = engine.handleChat('PlayerOne', 'statue', 1_000_450);
    expect(secondTry.message).toContain('already used their 1 search');

    // PlayerTwo triggers a Booby-Trap ('helm') -> loses -5s off the room timer!
    const beforeTrapSec = engine.getSnapshot(1_000_500).remainingSec;
    const trapRes = engine.handleChat('PlayerTwo', 'helm', 1_000_500);
    expect(trapRes.message).toContain('BOOBY TRAP');
    const afterTrapSnap = engine.getSnapshot(1_000_500);
    expect(afterTrapSnap.remainingSec).toBe(beforeTrapSec - TRAP_PENALTY_SEC);
    expect(afterTrapSnap.chambers.coop!.props.find((p) => p.name === 'helm')?.isTrap).toBe(true);

    // PlayerThree finds Keypad Math riddle ('statue') & verifies no raw digits leak in clueText
    const mathRes = engine.handleChat('PlayerThree', 'statue', 1_000_600);
    expect(mathRes.message).toContain('Keypad Math');
    expect(mathRes.message).toContain('sum to 1');

    // 5💎 UV from PlayerOne recharges PlayerOne's battery, decrypts 'compass', and scans Lock 1
    const uvGift = engine.handleGift('PlayerOne', 5, 1_000_700);
    expect(uvGift.tier).toBe('uv');
    const afterUvSnap = engine.getSnapshot(1_000_700);
    expect(afterUvSnap.chambers.coop!.exhaustedSearchers).not.toContain('@PlayerOne');
    expect(afterUvSnap.chambers.coop!.props.find((p) => p.name === 'compass')?.searchedBy).toBe(
      '@PlayerOne (UV)'
    );
    // Solving Lock 1 ('red') refreshes everyone's search batteries for Lock 2
    const active1 = afterUvSnap.chambers.coop!.spotlightPlayer!;
    engine.handleChat(active1, 'red', 1_000_800);
    const lock2Snap = engine.getSnapshot(1_000_800);
    expect(lock2Snap.chambers.coop!.lockStage).toBe(2);
    expect(lock2Snap.chambers.coop!.exhaustedSearchers).toHaveLength(0);
  });

  it('penalizes -6s per wrong guess, triggers 2-strike Fuse Overload, and resets 4-step Memory Bridge', () => {
    // rng=0 -> initially wire='red' (WARM, excludes 'gold'), pin=100, bridge=['L','L','L','L']
    const engine = new EscapeRoomEngine({
      rng: () => 0,
      stats: store,
      initialMode: 'coop',
      nowMs: 1_000_000,
    });

    engine.handleMember('ClueHunter', 1_000_100);
    engine.handleMember('SpeedRunner', 1_000_200);
    engine.handleChat('SpeedRunner', 'chest', 1_000_250); // Search wire_riddle ('NOT GOLD')

    // Strike 1: wrong wire 'blue' -> -6s penalty, wireStrikes=1
    const s0 = engine.getSnapshot(1_000_300);
    expect(s0.remainingSec).toBe(ROOM_DURATION_SEC);
    engine.handleChat(s0.chambers.coop!.spotlightPlayer!, 'blue', 1_000_300);
    const s1 = engine.getSnapshot(1_000_300);
    expect(s1.remainingSec).toBe(ROOM_DURATION_SEC - ZAP_PENALTY_SEC);
    expect(s1.chambers.coop!.wireStrikes).toBe(1);

    // Strike 2: wrong wire 'purple' -> -6s & Fuse Overload scrambles secretWire from 'red' to 'white'!
    const overloadRes = engine.handleChat(s1.chambers.coop!.spotlightPlayer!, 'purple', 1_000_400);
    expect(overloadRes.message).toContain('FUSE OVERLOAD');
    const s2 = engine.getSnapshot(1_000_400);
    expect(s2.remainingSec).toBe(ROOM_DURATION_SEC - ZAP_PENALTY_SEC * 2);
    expect(s2.chambers.coop!.wireStrikes).toBe(0);
    // Crossed-out riddle wire 'gold' stays eliminated; wrong attempts cleared
    expect(s2.chambers.coop!.eliminatedWires).toEqual(['gold']);

    // Now 'red' is wrong (scrambled!) and 'white' cracks Lock 1!
    const wirePass = engine.handleChat(s2.chambers.coop!.spotlightPlayer!, 'white', 1_000_500);
    expect(wirePass.message).toContain('LOCK 1 OPEN');

    // Lock 2 wrong guess deducts -6s; exact '100' cracks Lock 2
    const activePin1 = engine.getSnapshot(1_000_550).chambers.coop!.spotlightPlayer!;
    engine.handleChat(activePin1, '250', 1_000_600);
    expect(engine.getSnapshot(1_000_600).remainingSec).toBe(ROOM_DURATION_SEC - ZAP_PENALTY_SEC * 3);

    const activePin2 = engine.getSnapshot(1_000_650).chambers.coop!.spotlightPlayer!;
    engine.handleChat(activePin2, '100', 1_000_700);
    expect(engine.getSnapshot(1_000_700).chambers.coop!.lockStage).toBe(3);

    // Lock 3 Memory Bridge: advance 2 steps ('L', 'L'), then fall on Step 3 ('R') -> resets to Step 0, stays dark!
    for (let step = 0; step < 2; step++) {
      const sp = engine.getSnapshot(1_000_800 + step * 50).chambers.coop!.spotlightPlayer!;
      engine.handleChat(sp, 'L', 1_000_810 + step * 50);
    }
    expect(engine.getSnapshot(1_000_870).chambers.coop!.bridgeStep).toBe(2);

    const fallPlayer = engine.getSnapshot(1_000_900).chambers.coop!.spotlightPlayer!;
    const fallRes = engine.handleChat(fallPlayer, 'R', 1_000_910);
    expect(fallRes.message).toContain('Bridge reset to Step 1');
    const afterFall = engine.getSnapshot(1_000_910);
    expect(afterFall.chambers.coop!.bridgeStep).toBe(0);
    expect(afterFall.chambers.coop!.revealedSteps).toEqual([null, null, null, null]);
    expect(afterFall.remainingSec).toBe(ROOM_DURATION_SEC - ZAP_PENALTY_SEC * 4);

    // Complete all 4 Memory Bridge steps ('L' x 4) -> opens 10s Getaway Dash!
    for (let step = 0; step < 4; step++) {
      const sp = engine.getSnapshot(1_001_000 + step * 50).chambers.coop!.spotlightPlayer!;
      engine.handleChat(sp, 'L', 1_001_010 + step * 50);
    }
    const getawaySnap = engine.getSnapshot(1_001_200);
    expect(getawaySnap.phase).toBe('getaway');
    expect(getawaySnap.getawayWinners.clueMvp).toBe('@SpeedRunner');

    engine.handleChat('ClueHunter', 'run', 1_001_300);
    expect(engine.getSnapshot(1_001_300).getawayWinners.firstRunner).toBe('@ClueHunter');

    engine.tick(1_012_000);
    expect(engine.getSnapshot(1_012_000).phase).toBe('round_over');
  });

  it('runs Red vs Blue Versus Race (4-step bridge) and enforces balanced gifts + Auto mode', () => {
    const versusEngine = new EscapeRoomEngine({
      rng: () => 0,
      stats: store,
      initialMode: 'versus',
      nowMs: 2_000_000,
    });

    versusEngine.handleChat('RedAce', 'red', 2_000_100);
    versusEngine.handleChat('BlueAce', 'blue', 2_000_200);

    versusEngine.handleChat('RedAce', 'red', 2_000_300);
    versusEngine.handleChat('RedAce', '100', 2_000_400);
    versusEngine.handleChat('RedAce', 'L', 2_000_500);
    versusEngine.handleChat('RedAce', 'L', 2_000_600);
    versusEngine.handleChat('RedAce', 'L', 2_000_700);
    versusEngine.handleChat('RedAce', 'L', 2_000_800);

    const winSnap = versusEngine.getSnapshot(2_000_800);
    expect(winSnap.phase).toBe('round_over');
    expect(winSnap.winnerTeam).toBe('red');
    expect(winSnap.loserPitTeam).toBe('blue');

    // Auto mode + balanced 1-shield cap + 25💎 Blackout / Cursed Pot
    const autoEngine = new EscapeRoomEngine({
      rng: createSeqRng([0]),
      stats: store,
      initialMode: 'auto',
      nowMs: 3_000_000,
    });
    expect(autoEngine.getSnapshot(3_000_000).activeMode).toBe('coop');

    autoEngine.handleMember('VIPOne', 3_000_100);
    autoEngine.handleGift('VIPOne', 10, 3_000_150);
    autoEngine.handleGift('VIPOne', 15, 3_000_200);
    expect(autoEngine.getSnapshot(3_000_200).chambers.coop!.shieldedPlayers).toContain('@VIPOne');

    // Wrong wire consumes Shield with 0s time penalty & 0 wire strikes!
    autoEngine.handleChat('VIPOne', 'blue', 3_000_250);
    const shieldedSnap = autoEngine.getSnapshot(3_000_250);
    expect(shieldedSnap.remainingSec).toBe(ROOM_DURATION_SEC);
    expect(shieldedSnap.chambers.coop!.wireStrikes).toBe(0);
    expect(shieldedSnap.chambers.coop!.spotlightPlayer).toBe('@VIPOne');

    // Second 15💎 in same room does NOT re-grant shield
    autoEngine.handleGift('VIPOne', 15, 3_000_300);
    expect(autoEngine.getSnapshot(3_000_300).chambers.coop!.shieldedPlayers).not.toContain('@VIPOne');

    // 25💎 Cursed Pot in coop
    autoEngine.handleGift('HighRoller', 25, 3_000_350);
    expect(autoEngine.getSnapshot(3_000_350).cursedDoublePot).toBe(true);
    expect(autoEngine.getSnapshot(3_000_350).potGold).toBe(240);

    // Round 2 switches automatically to versus & 25💎 triggers Blackout
    const r2 = autoEngine.startNewRound(3_010_000);
    expect(r2.activeMode).toBe('versus');
    autoEngine.handleChat('RedBoss', 'red', 3_010_100);
    autoEngine.handleChat('BlueGuy', 'blue', 3_010_150);
    autoEngine.handleGift('RedBoss', 25, 3_010_200);
    expect(autoEngine.getSnapshot(3_010_200).chambers.blue!.blackoutUntilMs).toBeGreaterThan(3_010_200);
  });
});
