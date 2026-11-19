import {
  BLACKOUT_DURATION_MS,
  BRIDGE_STEPS,
  COOL_WIRES,
  CUT_LINE_GIFT_MIN_DIAMONDS,
  GETAWAY_DURATION_SEC,
  HERO_CLASSES,
  MAX_WIRE_STRIKES,
  PROP_EMOJIS,
  ROOM_DURATION_SEC,
  ROOM_THEMES,
  ROOM_THEME_ORDER,
  ROUND_OVER_PAUSE_SEC,
  SABOTAGE_GIFT_MIN_DIAMONDS,
  SHIELD_GIFT_MIN_DIAMONDS,
  TAP_BONUS_SEC,
  TAPS_PER_BOOST,
  TRAP_PENALTY_SEC,
  TURN_DURATION_SEC,
  UV_GIFT_MIN_DIAMONDS,
  WARM_WIRES,
  WIRE_COLORS,
  ZAP_PENALTY_SEC,
} from '../../shared/constants.js';
import type {
  ActiveMode,
  BridgeSide,
  ChamberPublicState,
  GameModeSetting,
  HeroClass,
  PlayerStatsRecord,
  PropCorner,
  RoomPropView,
  RoomSnapshotMessage,
  RoomThemeId,
  RoundPhase,
  TeamId,
  WireColor,
} from '../../shared/types.js';

interface InternalProp {
  id: string;
  name: string;
  emoji: string;
  corner: PropCorner;
  clueType: 'wire_riddle' | 'pin_riddle_a' | 'pin_riddle_b' | 'uv_secret' | 'trap';
  clueText: string;
  payloadValue: unknown;
  searchedBy: string | null;
}

interface InternalChamber {
  team: TeamId;
  lockStage: 1 | 2 | 3;
  // Secret answers (never serialized into RoomSnapshotMessage!)
  secretWire: WireColor;
  wireExclude: WireColor;
  secretPin: number; // 100..999
  secretBridge: [BridgeSide, BridgeSide, BridgeSide, BridgeSide];
  // Public state
  eliminatedWires: WireColor[];
  wireStrikes: number;
  knownDigits: [string, string, string];
  minBound: number;
  maxBound: number;
  lastPinGuess: number | null;
  lastPinHint: 'HIGHER' | 'LOWER' | null;
  bridgeStep: number;
  revealedSteps: [BridgeSide | null, BridgeSide | null, BridgeSide | null, BridgeSide | null];
  props: InternalProp[];
  discoveredClues: string[];
  searchedPlayersThisStage: Set<string>;
  spotlightPlayer: string | null;
  spotlightClass: HeroClass;
  turnExpiresAtMs: number;
  pool: string[];
  vipQueue: string[];
  shieldedPlayers: Set<string>;
  usedShieldPlayers: Set<string>;
  blackoutUntilMs: number;
  lastEffect: ChamberPublicState['lastEffect'];
  lastEffectPlayer: string | null;
  lastEffectAtMs: number;
}

export interface StatsStore {
  recordAction(
    username: string,
    delta: Partial<{
      cls: HeroClass;
      wins: number;
      escapes: number;
      locksCracked: number;
      cluesFound: number;
      gold: number;
      lifetimeDiamonds: number;
    }>,
    nowMs: number
  ): void;
  getLeaderboard(limit?: number): PlayerStatsRecord[];
}

export interface ChatActionResult {
  handled: boolean;
  kind: 'team' | 'prop' | 'wire' | 'pin' | 'bridge' | 'run' | 'joined' | 'ignored';
  message: string;
}

export interface GiftActionResult {
  tier: 'uv' | 'cut_line' | 'shield' | 'sabotage' | 'cheer';
  message: string;
}

function normalizeHandle(raw: string): string {
  const clean = raw.trim().replace(/^@+/, '');
  return clean ? `@${clean}` : '@Guest';
}

function pickClassForUser(username: string): HeroClass {
  let h = 0;
  for (let i = 0; i < username.length; i++) {
    h = (h * 31 + username.charCodeAt(i)) >>> 0;
  }
  return HERO_CLASSES[h % HERO_CLASSES.length];
}

function clampUnit(n: number): number {
  if (!Number.isFinite(n) || n < 0) return 0;
  if (n >= 1) return 0.999999;
  return n;
}

/**
 * Pure core Locklet state machine driving procedural Escape Rooms,
 * 5-slot On-Deck queues, Co-op Vault + 10s Getaway Dash, Red vs. Blue team races,
 * and balanced crowd/gift mechanics.
 */
export class EscapeRoomEngine {
  private readonly rng: () => number;
  private readonly stats?: StatsStore;

  private roundId = 0;
  private themeIdx = -1;
  private modeSetting: GameModeSetting = 'auto';
  private activeMode: ActiveMode = 'coop';
  private phase: RoundPhase = 'playing';
  private themeId: RoomThemeId = 'sunken_treasury';

  private roundEndsAtMs = 0;
  private getawayEndsAtMs = 0;
  private roundOverEndsAtMs = 0;
  private lastTickMs = 0;
  private cursedDoublePot = false;
  private potGold = 120;
  private communityTaps = 0;
  private latestBanner = 'Comment a prop name or cut a wire to begin!';

  private winnerTeam: TeamId | null = null;
  private loserPitTeam: TeamId | null = null;

  private readonly playerTeams = new Map<string, 'red' | 'blue'>();
  private readonly clueScoresThisRound = new Map<string, number>();
  private getawayWinners: RoomSnapshotMessage['getawayWinners'] = {
    lockbreaker: null,
    clueMvp: null,
    firstRunner: null,
    runners: [],
  };

  private chambers: Partial<Record<TeamId, InternalChamber>> = {};
  private readonly activeViewers = new Map<string, number>();

  constructor(options: {
    rng?: () => number;
    stats?: StatsStore;
    initialMode?: GameModeSetting;
    nowMs?: number;
  } = {}) {
    this.rng = options.rng ?? Math.random;
    this.stats = options.stats;
    this.modeSetting = options.initialMode ?? 'auto';
    this.startNewRound(options.nowMs ?? Date.now());
  }

  public setModeSetting(setting: GameModeSetting, restartNowMs?: number): void {
    this.modeSetting = setting;
    if (restartNowMs !== undefined) {
      this.startNewRound(restartNowMs);
    }
  }

  public getModeSetting(): GameModeSetting {
    return this.modeSetting;
  }

  public startNewRound(nowMs = Date.now(), forcedTheme?: RoomThemeId): RoomSnapshotMessage {
    this.roundId++;
    if (forcedTheme && ROOM_THEMES[forcedTheme]) {
      this.themeId = forcedTheme;
      this.themeIdx = ROOM_THEME_ORDER.indexOf(forcedTheme);
    } else {
      this.themeIdx = (this.themeIdx + 1) % ROOM_THEME_ORDER.length;
      this.themeId = ROOM_THEME_ORDER[this.themeIdx];
    }

    if (this.modeSetting === 'auto') {
      this.activeMode = this.roundId % 2 === 1 ? 'coop' : 'versus';
    } else {
      this.activeMode = this.modeSetting;
    }

    this.phase = 'playing';
    this.lastTickMs = nowMs;
    this.roundEndsAtMs = nowMs + ROOM_DURATION_SEC * 1000;
    this.getawayEndsAtMs = 0;
    this.roundOverEndsAtMs = 0;
    this.cursedDoublePot = false;
    this.potGold = 120;
    this.communityTaps = 0;
    this.winnerTeam = null;
    this.loserPitTeam = null;
    this.clueScoresThisRound.clear();
    this.getawayWinners = { lockbreaker: null, clueMvp: null, firstRunner: null, runners: [] };

    const activeHandles = Array.from(this.activeViewers.keys());
    this.chambers = {};

    if (this.activeMode === 'coop') {
      const coopChamber = this.createRandomizedChamber('coop', nowMs);
      for (const h of activeHandles) this.enqueueViewer(coopChamber, h, nowMs);
      this.chambers.coop = coopChamber;
      const theme = ROOM_THEMES[this.themeId];
      this.latestBanner = `${theme.emoji} New Room: ${theme.label}! Search ${theme.props.join(', ')} or cut a wire!`;
    } else {
      const redChamber = this.createRandomizedChamber('red', nowMs);
      const blueChamber = this.createRandomizedChamber('blue', nowMs);
      for (const h of activeHandles) {
        const team = this.assignOrGetTeam(h, redChamber, blueChamber);
        this.enqueueViewer(team === 'red' ? redChamber : blueChamber, h, nowMs);
      }
      this.chambers.red = redChamber;
      this.chambers.blue = blueChamber;
      const theme = ROOM_THEMES[this.themeId];
      this.latestBanner = `⚔️ Red vs Blue Race in ${theme.label}! Type "red" or "blue" to join a cell!`;
    }

    return this.getSnapshot(nowMs);
  }

  private createRandomizedChamber(team: TeamId, nowMs: number): InternalChamber {
    const theme = ROOM_THEMES[this.themeId];
    const secretWire = WIRE_COLORS[Math.floor(clampUnit(this.rng()) * WIRE_COLORS.length)];
    const d1 = 1 + Math.floor(clampUnit(this.rng()) * 9); // 1..9
    const d2 = Math.floor(clampUnit(this.rng()) * 10); // 0..9
    const d3 = Math.floor(clampUnit(this.rng()) * 10); // 0..9
    const secretPin = d1 * 100 + d2 * 10 + d3;

    const secretBridge: [BridgeSide, BridgeSide, BridgeSide, BridgeSide] = [
      this.rng() < 0.5 ? 'L' : 'R',
      this.rng() < 0.5 ? 'L' : 'R',
      this.rng() < 0.5 ? 'L' : 'R',
      this.rng() < 0.5 ? 'L' : 'R',
    ];

    const isWarm = (WARM_WIRES as readonly WireColor[]).includes(secretWire);
    const wireGroup = isWarm ? WARM_WIRES : COOL_WIRES;
    const groupWrong = wireGroup.filter((w) => w !== secretWire);
    const wireExclude = groupWrong[Math.floor(clampUnit(this.rng()) * groupWrong.length)];

    const digitSum = d1 + d2 + d3;
    const altD1 = d1 === 9 ? 8 : d1 + 1;
    const d1Pair = [d1, altD1].sort((a, b) => a - b);

    // Shuffle all 6 prop positions across nw/ne/mw/me/sw/se every round
    const propNames = [...theme.props];
    const corners: PropCorner[] = ['nw', 'ne', 'mw', 'me', 'sw', 'se'];
    for (let i = propNames.length - 1; i > 0; i--) {
      const j = Math.floor(clampUnit(this.rng()) * (i + 1));
      [propNames[i], propNames[j]] = [propNames[j], propNames[i]];
    }

    const clueTemplates: Array<{
      clueType: InternalProp['clueType'];
      clueText: string;
      payloadValue: unknown;
    }> = [
      {
        clueType: 'wire_riddle',
        clueText: `Fuse Riddle: Live wire is ${isWarm ? 'WARM (RED/GOLD/WHITE)' : 'COOL (BLUE/GREEN/PURPLE)'} & NOT ${wireExclude.toUpperCase()}`,
        payloadValue: wireExclude,
      },
      {
        clueType: 'pin_riddle_a',
        clueText: `Keypad Math: 3 digits sum to ${digitSum} · 3rd digit is ${d3 % 2 === 0 ? 'EVEN' : 'ODD'}`,
        payloadValue: { sum: digitSum },
      },
      {
        clueType: 'pin_riddle_b',
        clueText: `Keypad Note: 1st digit is ${d1Pair[0]} or ${d1Pair[1]} · 2nd digit is ${d2 >= 5 ? 'HIGH (5–9)' : 'LOW (0–4)'}`,
        payloadValue: { min: d1Pair[0] * 100, max: d1Pair[1] * 100 + 99 },
      },
      {
        clueType: 'uv_secret',
        clueText: `UV Secret: Keypad 2nd digit = ${d2} & Bridge Step 1 = ${secretBridge[0]}`,
        payloadValue: { d2: String(d2), step0: secretBridge[0] },
      },
      {
        clueType: 'trap',
        clueText: `💥 BOOBY TRAP! Poison dart drained -${TRAP_PENALTY_SEC}s!`,
        payloadValue: TRAP_PENALTY_SEC,
      },
      {
        clueType: 'trap',
        clueText: `💥 CURSED MIMIC! Spark surge drained -${TRAP_PENALTY_SEC}s!`,
        payloadValue: TRAP_PENALTY_SEC,
      },
    ];

    const props: InternalProp[] = propNames.map((name, idx) => ({
      id: name,
      name,
      emoji: PROP_EMOJIS[name] ?? '🔍',
      corner: corners[idx],
      clueType: clueTemplates[idx].clueType,
      clueText: clueTemplates[idx].clueText,
      payloadValue: clueTemplates[idx].payloadValue,
      searchedBy: null,
    }));

    return {
      team,
      lockStage: 1,
      secretWire,
      wireExclude,
      secretPin,
      secretBridge,
      eliminatedWires: [],
      wireStrikes: 0,
      knownDigits: ['?', '?', '?'],
      minBound: 100,
      maxBound: 999,
      lastPinGuess: null,
      lastPinHint: null,
      bridgeStep: 0,
      revealedSteps: [null, null, null, null],
      props,
      discoveredClues: [],
      searchedPlayersThisStage: new Set(),
      spotlightPlayer: null,
      spotlightClass: 'knight',
      turnExpiresAtMs: nowMs + TURN_DURATION_SEC * 1000,
      pool: [],
      vipQueue: [],
      shieldedPlayers: new Set(),
      usedShieldPlayers: new Set(),
      blackoutUntilMs: 0,
      lastEffect: 'none',
      lastEffectPlayer: null,
      lastEffectAtMs: 0,
    };
  }

  private assignOrGetTeam(
    handle: string,
    red: InternalChamber,
    blue: InternalChamber
  ): 'red' | 'blue' {
    const existing = this.playerTeams.get(handle);
    if (existing) return existing;
    const pick: 'red' | 'blue' = red.pool.length <= blue.pool.length ? 'red' : 'blue';
    this.playerTeams.set(handle, pick);
    return pick;
  }

  private enqueueViewer(chamber: InternalChamber, handle: string, nowMs: number): void {
    if (!chamber.pool.includes(handle)) {
      chamber.pool.push(handle);
    }
    if (!chamber.spotlightPlayer) {
      chamber.spotlightPlayer = handle;
      chamber.spotlightClass = pickClassForUser(handle);
      chamber.turnExpiresAtMs = nowMs + TURN_DURATION_SEC * 1000;
    }
  }

  private resolveChamberForUser(handle: string): InternalChamber | undefined {
    if (this.activeMode === 'coop') {
      return this.chambers.coop;
    }
    const red = this.chambers.red;
    const blue = this.chambers.blue;
    if (!red || !blue) return red ?? blue;
    const team = this.assignOrGetTeam(handle, red, blue);
    return team === 'red' ? red : blue;
  }

  private advanceSpotlight(chamber: InternalChamber, nowMs: number): void {
    // VIP Cut-the-Line queue takes top priority
    while (chamber.vipQueue.length > 0) {
      const nextVip = chamber.vipQueue.shift()!;
      if (nextVip !== chamber.spotlightPlayer || chamber.pool.length <= 1) {
        chamber.spotlightPlayer = nextVip;
        chamber.spotlightClass = pickClassForUser(nextVip);
        chamber.turnExpiresAtMs = nowMs + TURN_DURATION_SEC * 1000;
        return;
      }
    }

    if (chamber.pool.length === 0) {
      chamber.spotlightPlayer = null;
      chamber.turnExpiresAtMs = nowMs + TURN_DURATION_SEC * 1000;
      return;
    }

    if (chamber.pool.length === 1) {
      chamber.spotlightPlayer = chamber.pool[0];
      chamber.spotlightClass = pickClassForUser(chamber.pool[0]);
      chamber.turnExpiresAtMs = nowMs + TURN_DURATION_SEC * 1000;
      return;
    }

    const curIdx = chamber.spotlightPlayer ? chamber.pool.indexOf(chamber.spotlightPlayer) : -1;
    const nextIdx = (curIdx + 1) % chamber.pool.length;
    const nextUser = chamber.pool[nextIdx];
    chamber.spotlightPlayer = nextUser;
    chamber.spotlightClass = pickClassForUser(nextUser);
    chamber.turnExpiresAtMs = nowMs + TURN_DURATION_SEC * 1000;
  }

  private applyTimePenalty(sec: number, nowMs: number): void {
    if (this.phase !== 'playing') return;
    this.roundEndsAtMs = Math.max(nowMs + 1000, this.roundEndsAtMs - sec * 1000);
  }

  private applyPropReveal(
    chamber: InternalChamber,
    prop: InternalProp,
    finder: string,
    _isUv = false,
    nowMs = Date.now()
  ): void {
    prop.searchedBy = finder;
    if (prop.clueType === 'wire_riddle') {
      const excluded = prop.payloadValue as WireColor;
      if (!chamber.eliminatedWires.includes(excluded)) {
        chamber.eliminatedWires.push(excluded);
      }
      if (!chamber.discoveredClues.includes(prop.clueText)) {
        chamber.discoveredClues.push(prop.clueText);
      }
    } else if (prop.clueType === 'pin_riddle_a') {
      if (!chamber.discoveredClues.includes(prop.clueText)) {
        chamber.discoveredClues.push(prop.clueText);
      }
    } else if (prop.clueType === 'pin_riddle_b') {
      const info = prop.payloadValue as { min: number; max: number };
      chamber.minBound = Math.max(chamber.minBound, info.min);
      chamber.maxBound = Math.min(chamber.maxBound, info.max);
      if (!chamber.discoveredClues.includes(prop.clueText)) {
        chamber.discoveredClues.push(prop.clueText);
      }
    } else if (prop.clueType === 'uv_secret') {
      const info = prop.payloadValue as { d2: string; step0: BridgeSide };
      chamber.knownDigits[1] = info.d2;
      chamber.revealedSteps[0] = info.step0;
      if (!chamber.discoveredClues.includes(prop.clueText)) {
        chamber.discoveredClues.push(prop.clueText);
      }
    } else if (prop.clueType === 'trap') {
      this.applyTimePenalty(TRAP_PENALTY_SEC, nowMs);
    }
  }

  public tick(nowMs = Date.now()): boolean {
    const dtMs = Math.max(0, nowMs - this.lastTickMs);
    this.lastTickMs = nowMs;
    let changed = false;

    if (this.phase === 'playing') {
      if (this.cursedDoublePot && dtMs > 0) {
        // Cursed 2x Double Pot drains the remaining time 35% faster
        this.roundEndsAtMs -= Math.round(dtMs * 0.35);
      }

      if (nowMs >= this.roundEndsAtMs) {
        this.phase = 'round_over';
        this.roundOverEndsAtMs = nowMs + ROUND_OVER_PAUSE_SEC * 1000;
        const theme = ROOM_THEMES[this.themeId];
        this.latestBanner = `💀 ${theme.hazardName} overwhelmed the vault! Next room loading...`;
        return true;
      }

      for (const chamber of Object.values(this.chambers)) {
        if (!chamber) continue;
        if (chamber.pool.length > 0 && nowMs >= chamber.turnExpiresAtMs) {
          this.advanceSpotlight(chamber, nowMs);
          changed = true;
        }
      }
    } else if (this.phase === 'getaway') {
      if (nowMs >= this.getawayEndsAtMs) {
        this.phase = 'round_over';
        this.roundOverEndsAtMs = nowMs + ROUND_OVER_PAUSE_SEC * 1000;
        this.latestBanner = `🏆 Getaway Closed! Winners: ${this.formatGetawaySummary()}`;
        return true;
      }
    } else if (this.phase === 'round_over') {
      if (nowMs >= this.roundOverEndsAtMs) {
        this.startNewRound(nowMs);
        return true;
      }
    }

    return changed;
  }

  public handleMember(rawUsername: string, nowMs = Date.now()): void {
    const handle = normalizeHandle(rawUsername);
    this.activeViewers.set(handle, nowMs);
    const chamber = this.resolveChamberForUser(handle);
    if (chamber) {
      this.enqueueViewer(chamber, handle, nowMs);
    }
    this.stats?.recordAction(handle, { cls: pickClassForUser(handle) }, nowMs);
  }

  public handleLikes(rawUsername: string, count: number, nowMs = Date.now()): boolean {
    const handle = normalizeHandle(rawUsername);
    this.activeViewers.set(handle, nowMs);
    const safeCount = Math.max(1, Math.floor(count || 1));
    const prevBuckets = Math.floor(this.communityTaps / TAPS_PER_BOOST);
    this.communityTaps += safeCount;
    const nextBuckets = Math.floor(this.communityTaps / TAPS_PER_BOOST);

    if (this.phase === 'playing' && nextBuckets > prevBuckets) {
      const bonusSec = (nextBuckets - prevBuckets) * TAP_BONUS_SEC;
      this.roundEndsAtMs = Math.min(nowMs + ROOM_DURATION_SEC * 1000, this.roundEndsAtMs + bonusSec * 1000);
      this.latestBanner = `💧 Crowd Taps pumped back +${bonusSec}s!`;
      return true;
    }
    return false;
  }

  public handleGift(
    rawUsername: string,
    diamonds: number,
    nowMs = Date.now()
  ): GiftActionResult {
    const handle = normalizeHandle(rawUsername);
    const safeDiamonds = Math.max(1, Math.floor(diamonds || 1));
    this.activeViewers.set(handle, nowMs);
    this.stats?.recordAction(
      handle,
      { cls: pickClassForUser(handle), lifetimeDiamonds: safeDiamonds },
      nowMs
    );

    const chamber = this.resolveChamberForUser(handle);
    if (chamber) {
      this.enqueueViewer(chamber, handle, nowMs);
    }

    if (safeDiamonds >= SABOTAGE_GIFT_MIN_DIAMONDS) {
      if (this.activeMode === 'versus' && chamber) {
        const rival = chamber.team === 'red' ? this.chambers.blue : this.chambers.red;
        if (rival) {
          rival.blackoutUntilMs = nowMs + BLACKOUT_DURATION_MS;
          const idx =
            rival.lockStage === 3 ? Math.min(BRIDGE_STEPS - 1, rival.bridgeStep) : BRIDGE_STEPS - 1;
          rival.secretBridge[idx] = rival.secretBridge[idx] === 'L' ? 'R' : 'L';
          rival.revealedSteps[idx] = null;
        }
        this.latestBanner = `😈 ${handle} triggered BLACKOUT & scrambled rival bridge!`;
      } else {
        this.cursedDoublePot = true;
        this.potGold = Math.round(this.potGold * 2);
        this.latestBanner = `😈 ${handle} activated 2x CURSED BOUNTY (${this.potGold}g)! Hazard 1.35x faster!`;
      }
      return { tier: 'sabotage', message: this.latestBanner };
    }

    if (safeDiamonds >= SHIELD_GIFT_MIN_DIAMONDS) {
      if (this.phase === 'playing') {
        this.roundEndsAtMs = Math.min(nowMs + ROOM_DURATION_SEC * 1000, this.roundEndsAtMs + 15_000);
      }
      let shieldNote = '+15s Pump';
      if (chamber && !chamber.usedShieldPlayers.has(handle)) {
        chamber.shieldedPlayers.add(handle);
        chamber.usedShieldPlayers.add(handle);
        shieldNote = '+15s & 1-Hit Rubber Shield';
      }
      this.latestBanner = `🛟 ${handle} gifted Pump Shield (${shieldNote})!`;
      return { tier: 'shield', message: this.latestBanner };
    }

    if (safeDiamonds >= CUT_LINE_GIFT_MIN_DIAMONDS) {
      if (chamber) {
        if (!chamber.pool.includes(handle)) chamber.pool.push(handle);
        if (!chamber.vipQueue.includes(handle)) {
          chamber.vipQueue.unshift(handle);
        }
        // Step straight into spotlight if current slot isn't another VIP
        chamber.spotlightPlayer = handle;
        chamber.spotlightClass = pickClassForUser(handle);
        chamber.turnExpiresAtMs = nowMs + TURN_DURATION_SEC * 1000;
      }
      this.latestBanner = `🏃 ${handle} cut to the front of the lock!`;
      return { tier: 'cut_line', message: this.latestBanner };
    }

    if (safeDiamonds >= UV_GIFT_MIN_DIAMONDS) {
      if (chamber) {
        chamber.searchedPlayersThisStage.delete(handle);
        const uvProp =
          chamber.props.find((p) => !p.searchedBy && p.clueType === 'uv_secret') ??
          chamber.props.find((p) => !p.searchedBy && p.clueType !== 'trap');
        let propNote = '';
        if (uvProp) {
          this.applyPropReveal(chamber, uvProp, `${handle} (UV)`, true, nowMs);
          propNote = `${uvProp.name.toUpperCase()}: ${uvProp.clueText}`;
        }

        let scanNote = '';
        if (chamber.lockStage === 1) {
          const badWire = WIRE_COLORS.find(
            (w) => w !== chamber.secretWire && !chamber.eliminatedWires.includes(w)
          );
          if (badWire) {
            chamber.eliminatedWires.push(badWire);
            scanNote = `NOT ${badWire.toUpperCase()}`;
          }
        } else if (chamber.lockStage === 2) {
          const dIdx = ([1, 2, 0] as const).find((i) => chamber.knownDigits[i] === '?');
          if (dIdx !== undefined) {
            const dChar = String(chamber.secretPin)[dIdx];
            chamber.knownDigits[dIdx] = dChar;
            scanNote = `PIN digit #${dIdx + 1} = ${dChar}`;
          }
        } else {
          const sIdx = ([0, 1, 2, 3] as const).find((i) => chamber.revealedSteps[i] === null);
          if (sIdx !== undefined) {
            chamber.revealedSteps[sIdx] = chamber.secretBridge[sIdx];
            scanNote = `Bridge Step ${sIdx + 1} = ${chamber.secretBridge[sIdx]}`;
          }
        }

        chamber.lastEffect = 'clue';
        chamber.lastEffectPlayer = handle;
        chamber.lastEffectAtMs = nowMs;
        const details = [propNote, scanNote].filter(Boolean).join(' · ');
        this.latestBanner = details
          ? `🔦 ${handle}'s UV Blacklight revealed ${details}`
          : `🔦 ${handle} recharged flashlight with UV Blacklight!`;
        return { tier: 'uv', message: this.latestBanner };
      }
      this.latestBanner = `🔦 ${handle} scanned the room with a UV Blacklight!`;
      return { tier: 'uv', message: this.latestBanner };
    }

    this.potGold += 10;
    this.latestBanner = `✨ ${handle} tossed coins into the escape pot (+10g)!`;
    return { tier: 'cheer', message: this.latestBanner };
  }

  public handleChat(rawUsername: string, rawComment: string, nowMs = Date.now()): ChatActionResult {
    const handle = normalizeHandle(rawUsername);
    const trimmed = (rawComment ?? '').trim();
    if (!trimmed) {
      return { handled: false, kind: 'ignored', message: '' };
    }

    this.activeViewers.set(handle, nowMs);
    const lower = trimmed.toLowerCase();

    // 1. Versus Team Join / Switch (`team red`, `join blue`, `!red`, or bare `red`/`blue` if unassigned)
    const explicitTeamMatch = /^(?:team\s+|join\s+|!)(red|blue)$/i.exec(lower);
    const implicitTeamMatch =
      !this.playerTeams.has(handle) && /^(red|blue)$/i.test(lower)
        ? (lower as 'red' | 'blue')
        : null;
    const targetTeam = explicitTeamMatch
      ? (explicitTeamMatch[1].toLowerCase() as 'red' | 'blue')
      : implicitTeamMatch;

    if (this.activeMode === 'versus' && targetTeam) {
      this.playerTeams.set(handle, targetTeam);
      const oldTeam = targetTeam === 'red' ? this.chambers.blue : this.chambers.red;
      const nextTeam = this.chambers[targetTeam];
      if (oldTeam) {
        oldTeam.pool = oldTeam.pool.filter((u) => u !== handle);
        if (oldTeam.spotlightPlayer === handle) {
          this.advanceSpotlight(oldTeam, nowMs);
        }
      }
      if (nextTeam) {
        this.enqueueViewer(nextTeam, handle, nowMs);
      }
      this.latestBanner = `${targetTeam === 'red' ? '🔴' : '🔵'} ${handle} joined Team ${targetTeam.toUpperCase()}!`;
      return { handled: true, kind: 'team', message: this.latestBanner };
    }

    const chamber = this.resolveChamberForUser(handle);
    if (!chamber) {
      return { handled: false, kind: 'ignored', message: '' };
    }
    this.enqueueViewer(chamber, handle, nowMs);

    // 2. Co-op 10-Second Getaway Dash (`run` / `escape` / `grab`)
    if (this.phase === 'getaway') {
      if (/\b(?:run|escape|dash|grab|go)\b/i.test(lower)) {
        if (!this.getawayWinners.runners.includes(handle)) {
          this.getawayWinners.runners.push(handle);
          const isFirst = !this.getawayWinners.firstRunner;
          const bonus = isFirst ? Math.round(this.potGold * 0.8) : 25;
          if (isFirst) {
            this.getawayWinners.firstRunner = handle;
            this.stats?.recordAction(handle, { escapes: 1, wins: 1, gold: bonus }, nowMs);
            this.latestBanner = `🏃💨 ${handle} grabbed Chest #3 (+${bonus}g)!`;
          } else {
            this.stats?.recordAction(handle, { escapes: 1, gold: bonus }, nowMs);
            this.latestBanner = `🏃 ${handle} escaped through the Vault Door (+${bonus}g)!`;
          }
          chamber.lastEffect = 'dash';
          chamber.lastEffectPlayer = handle;
          chamber.lastEffectAtMs = nowMs;
          return { handled: true, kind: 'run', message: this.latestBanner };
        }
      }
      return { handled: false, kind: 'joined', message: '' };
    }

    if (this.phase !== 'playing') {
      return { handled: false, kind: 'joined', message: '' };
    }

    // 3. Crowd Prop Clue Search (Anyone can search props anytime!)
    const matchedProp = chamber.props.find((p) => {
      const re = new RegExp(`\\b${p.name}\\b`, 'i');
      return re.test(lower);
    });
    if (matchedProp) {
      if (matchedProp.searchedBy) {
        this.latestBanner = `${matchedProp.emoji} ${matchedProp.name.toUpperCase()} already checked (${matchedProp.clueText})`;
      } else if (matchedProp.clueType === 'uv_secret') {
        this.latestBanner = `🔒 ${matchedProp.name.toUpperCase()} is written in Invisible Ink! Gift 🔦 5💎 UV to decrypt it!`;
      } else if (chamber.searchedPlayersThisStage.has(handle)) {
        this.latestBanner = `🔋 ${handle} already used their 1 search for Lock ${chamber.lockStage}! Crack Lock ${chamber.lockStage}, switch player, or gift 🔦 5💎 UV!`;
      } else {
        chamber.searchedPlayersThisStage.add(handle);
        this.applyPropReveal(chamber, matchedProp, handle, false, nowMs);
        chamber.lastEffectPlayer = handle;
        chamber.lastEffectAtMs = nowMs;
        if (matchedProp.clueType === 'trap') {
          chamber.lastEffect = 'zap';
          this.latestBanner = `💥 BOOBY TRAP in ${matchedProp.name.toUpperCase()}! ${handle} triggered a -${TRAP_PENALTY_SEC}s surge!`;
        } else {
          this.clueScoresThisRound.set(handle, (this.clueScoresThisRound.get(handle) ?? 0) + 1);
          this.stats?.recordAction(handle, { cluesFound: 1, gold: 15 }, nowMs);
          chamber.lastEffect = 'clue';
          this.latestBanner = `🔍 ${handle} searched ${matchedProp.name.toUpperCase()}: ${matchedProp.clueText}`;
        }
      }
      return { handled: true, kind: 'prop', message: this.latestBanner };
    }

    // 4. Active Lock Attempt (1 Spotlight at a time, auto-promoted if same or solo/unclaimed)
    if (chamber.spotlightPlayer && chamber.spotlightPlayer !== handle) {
      // Allow quiet-stream responsiveness ONLY when spotlight hasn't acted or if VIP/sole entrant; otherwise remind they are On Deck
      if (chamber.pool.length > 1) {
        return {
          handled: true,
          kind: 'joined',
          message: `⏳ ${handle} is queued behind ${chamber.spotlightPlayer}! Search props or tip 10💎 to Cut the Line!`,
        };
      }
    }

    chamber.spotlightPlayer = handle;
    chamber.spotlightClass = pickClassForUser(handle);

    if (chamber.lockStage === 1) {
      const wireMatch = /\b(red|blue|gold|green|purple|white)\b/i.exec(lower);
      if (wireMatch) {
        const guess = wireMatch[1].toLowerCase() as WireColor;
        return this.attemptWire(chamber, handle, guess, nowMs);
      }
    } else if (chamber.lockStage === 2) {
      const pinMatch = /\b(\d{3})\b/.exec(lower);
      if (pinMatch) {
        return this.attemptPin(chamber, handle, Number(pinMatch[1]), nowMs);
      }
    } else if (chamber.lockStage === 3) {
      let side: BridgeSide | null = null;
      if (/^(?:l|left)$/i.test(lower) || /\b(?:go|step|jump)\s+left\b/i.test(lower)) {
        side = 'L';
      } else if (/^(?:r|right)$/i.test(lower) || /\b(?:go|step|jump)\s+right\b/i.test(lower)) {
        side = 'R';
      }
      if (side) {
        return this.attemptBridge(chamber, handle, side, nowMs);
      }
    }

    // Casual comment keeps player warm & in queue
    this.stats?.recordAction(handle, { cls: chamber.spotlightClass }, nowMs);
    return { handled: true, kind: 'joined', message: '' };
  }

  private attemptWire(
    chamber: InternalChamber,
    handle: string,
    guess: WireColor,
    nowMs: number
  ): ChatActionResult {
    if (guess === chamber.secretWire) {
      chamber.lockStage = 2;
      chamber.wireStrikes = 0;
      chamber.searchedPlayersThisStage.clear();
      chamber.lastEffect = 'unlock';
      chamber.lastEffectPlayer = handle;
      chamber.lastEffectAtMs = nowMs;
      this.stats?.recordAction(handle, { locksCracked: 1, gold: 40 }, nowMs);
      this.advanceSpotlight(chamber, nowMs);
      this.latestBanner = `⚡ ${handle} cut the ${guess.toUpperCase()} wire — LOCK 1 OPEN! Enter the 3-Digit PIN!`;
      return { handled: true, kind: 'wire', message: this.latestBanner };
    }

    if (chamber.shieldedPlayers.has(handle)) {
      if (!chamber.eliminatedWires.includes(guess)) {
        chamber.eliminatedWires.push(guess);
      }
      chamber.shieldedPlayers.delete(handle);
      chamber.lastEffect = 'shield';
      chamber.lastEffectPlayer = handle;
      chamber.lastEffectAtMs = nowMs;
      chamber.turnExpiresAtMs = nowMs + TURN_DURATION_SEC * 1000;
      this.latestBanner = `🛟 ${handle}'s Rubber Shield blocked the ${guess.toUpperCase()} shock! Try again!`;
      return { handled: true, kind: 'wire', message: this.latestBanner };
    }

    this.applyTimePenalty(ZAP_PENALTY_SEC, nowMs);
    chamber.wireStrikes++;
    chamber.lastEffect = 'zap';
    chamber.lastEffectPlayer = handle;
    chamber.lastEffectAtMs = nowMs;

    if (chamber.wireStrikes >= MAX_WIRE_STRIKES) {
      chamber.wireStrikes = 0;
      chamber.eliminatedWires = [];
      const riddleRevealed = chamber.props.some(
        (p) => p.clueType === 'wire_riddle' && Boolean(p.searchedBy)
      );
      if (riddleRevealed) {
        chamber.eliminatedWires.push(chamber.wireExclude);
      }
      const isWarm = (WARM_WIRES as readonly WireColor[]).includes(chamber.secretWire);
      const wireGroup = isWarm ? WARM_WIRES : COOL_WIRES;
      const altWires = wireGroup.filter(
        (w) => w !== chamber.wireExclude && w !== chamber.secretWire
      );
      if (altWires.length > 0) {
        chamber.secretWire = altWires[Math.floor(clampUnit(this.rng()) * altWires.length)];
      }
      this.advanceSpotlight(chamber, nowMs);
      this.latestBanner = `⚡ FUSE OVERLOAD (${MAX_WIRE_STRIKES}/${MAX_WIRE_STRIKES})! -${ZAP_PENALTY_SEC}s & wires re-scrambled! Next: ${chamber.spotlightPlayer ?? 'Open'}`;
      return { handled: true, kind: 'wire', message: this.latestBanner };
    }

    if (!chamber.eliminatedWires.includes(guess)) {
      chamber.eliminatedWires.push(guess);
    }
    this.advanceSpotlight(chamber, nowMs);
    this.latestBanner = `💥 ZAP (-${ZAP_PENALTY_SEC}s)! ${guess.toUpperCase()} fried ${handle} (Overload ${chamber.wireStrikes}/${MAX_WIRE_STRIKES})! Next: ${chamber.spotlightPlayer ?? 'Open'}!`;
    return { handled: true, kind: 'wire', message: this.latestBanner };
  }

  private attemptPin(
    chamber: InternalChamber,
    handle: string,
    guess: number,
    nowMs: number
  ): ChatActionResult {
    if (guess === chamber.secretPin) {
      chamber.lockStage = 3;
      chamber.searchedPlayersThisStage.clear();
      const digits = String(chamber.secretPin).split('') as [string, string, string];
      chamber.knownDigits = digits;
      chamber.lastPinGuess = guess;
      chamber.lastPinHint = null;
      chamber.lastEffect = 'unlock';
      chamber.lastEffectPlayer = handle;
      chamber.lastEffectAtMs = nowMs;
      this.stats?.recordAction(handle, { locksCracked: 1, gold: 50 }, nowMs);
      this.advanceSpotlight(chamber, nowMs);
      this.latestBanner = `🔓 ${handle} cracked Keypad (${guess}) — LOCK 2 OPEN! Cross the ${BRIDGE_STEPS}-Step Memory Bridge!`;
      return { handled: true, kind: 'pin', message: this.latestBanner };
    }

    chamber.lastPinGuess = guess;
    if (guess < chamber.secretPin) {
      chamber.lastPinHint = 'HIGHER';
      chamber.minBound = Math.max(chamber.minBound, guess + 1);
    } else {
      chamber.lastPinHint = 'LOWER';
      chamber.maxBound = Math.min(chamber.maxBound, guess - 1);
    }

    if (chamber.shieldedPlayers.has(handle)) {
      chamber.shieldedPlayers.delete(handle);
      chamber.lastEffect = 'shield';
      chamber.lastEffectPlayer = handle;
      chamber.lastEffectAtMs = nowMs;
      chamber.turnExpiresAtMs = nowMs + TURN_DURATION_SEC * 1000;
      this.latestBanner = `🛟 ${handle}'s Shield tanked PIN ${guess}! Hint: ${chamber.lastPinHint} (${chamber.minBound}–${chamber.maxBound})!`;
      return { handled: true, kind: 'pin', message: this.latestBanner };
    }

    this.applyTimePenalty(ZAP_PENALTY_SEC, nowMs);
    chamber.lastEffect = 'zap';
    chamber.lastEffectPlayer = handle;
    chamber.lastEffectAtMs = nowMs;
    this.advanceSpotlight(chamber, nowMs);
    this.latestBanner = `🚨 ${guess} → ${chamber.lastPinHint} (-${ZAP_PENALTY_SEC}s)! Range [${chamber.minBound}–${chamber.maxBound}] · Up next: ${chamber.spotlightPlayer ?? 'Open'}`;
    return { handled: true, kind: 'pin', message: this.latestBanner };
  }

  private attemptBridge(
    chamber: InternalChamber,
    handle: string,
    side: BridgeSide,
    nowMs: number
  ): ChatActionResult {
    const idx = chamber.bridgeStep;
    const expected = chamber.secretBridge[idx];

    if (side === expected) {
      chamber.bridgeStep++;
      chamber.turnExpiresAtMs = nowMs + TURN_DURATION_SEC * 1000;

      if (chamber.bridgeStep >= BRIDGE_STEPS) {
        return this.completeRoomEscape(chamber, handle, nowMs);
      }

      this.latestBanner = `✅ ${handle} cleared Step ${idx + 1} (${side})! Pick L or R for Step ${chamber.bridgeStep + 1}/${BRIDGE_STEPS}!`;
      return { handled: true, kind: 'bridge', message: this.latestBanner };
    }

    if (chamber.shieldedPlayers.has(handle)) {
      chamber.revealedSteps[idx] = expected;
      chamber.shieldedPlayers.delete(handle);
      chamber.lastEffect = 'shield';
      chamber.lastEffectPlayer = handle;
      chamber.lastEffectAtMs = nowMs;
      chamber.turnExpiresAtMs = nowMs + TURN_DURATION_SEC * 1000;
      this.latestBanner = `🛟 ${handle}'s Rubber Suit caught Step ${idx + 1}! Safe side revealed: ${expected}!`;
      return { handled: true, kind: 'bridge', message: this.latestBanner };
    }

    this.applyTimePenalty(ZAP_PENALTY_SEC, nowMs);
    chamber.bridgeStep = 0;
    chamber.lastEffect = 'zap';
    chamber.lastEffectPlayer = handle;
    chamber.lastEffectAtMs = nowMs;
    this.advanceSpotlight(chamber, nowMs);
    this.latestBanner = `🕳️ ${handle} fell at Step ${idx + 1} (${side} was a trap)! -${ZAP_PENALTY_SEC}s & Bridge reset to Step 1! Next: ${chamber.spotlightPlayer ?? 'Open'}`;
    return { handled: true, kind: 'bridge', message: this.latestBanner };
  }

  private completeRoomEscape(
    chamber: InternalChamber,
    lockbreaker: string,
    nowMs: number
  ): ChatActionResult {
    chamber.lastEffect = 'unlock';
    chamber.lastEffectPlayer = lockbreaker;
    chamber.lastEffectAtMs = nowMs;

    if (this.activeMode === 'versus') {
      this.winnerTeam = chamber.team;
      this.loserPitTeam = chamber.team === 'red' ? 'blue' : 'red';
      this.phase = 'round_over';
      this.roundOverEndsAtMs = nowMs + ROUND_OVER_PAUSE_SEC * 1000;

      this.stats?.recordAction(lockbreaker, { wins: 1, escapes: 1, locksCracked: 1, gold: this.potGold }, nowMs);
      for (const teammate of chamber.pool) {
        if (teammate !== lockbreaker) {
          this.stats?.recordAction(teammate, { wins: 1, gold: 40 }, nowMs);
        }
      }
      this.latestBanner = `🏆 TEAM ${chamber.team.toUpperCase()} WINS! ${lockbreaker} pulled the trap lever on Team ${this.loserPitTeam.toUpperCase()}!`;
      return { handled: true, kind: 'bridge', message: this.latestBanner };
    }

    // Co-op Vault -> Open 10-Second Getaway Dash!
    this.phase = 'getaway';
    this.getawayEndsAtMs = nowMs + GETAWAY_DURATION_SEC * 1000;

    let clueMvp: string | null = null;
    let bestClues = 0;
    for (const [user, count] of this.clueScoresThisRound.entries()) {
      if (count > bestClues) {
        bestClues = count;
        clueMvp = user;
      }
    }

    this.getawayWinners.lockbreaker = lockbreaker;
    this.getawayWinners.clueMvp = clueMvp;
    this.stats?.recordAction(lockbreaker, { wins: 1, escapes: 1, locksCracked: 1, gold: this.potGold }, nowMs);
    if (clueMvp && clueMvp !== lockbreaker) {
      this.stats?.recordAction(clueMvp, { escapes: 1, gold: Math.round(this.potGold * 0.8) }, nowMs);
    }

    this.latestBanner = `🚪 VAULT OPEN (10s)! ${lockbreaker} won Chest #1! TYPE "RUN" RIGHT NOW for Chest #3!`;
    return { handled: true, kind: 'bridge', message: this.latestBanner };
  }

  private formatGetawaySummary(): string {
    const parts: string[] = [];
    if (this.getawayWinners.lockbreaker) parts.push(`🔓 ${this.getawayWinners.lockbreaker}`);
    if (this.getawayWinners.clueMvp) parts.push(`🔍 ${this.getawayWinners.clueMvp}`);
    if (this.getawayWinners.firstRunner) parts.push(`🏃 ${this.getawayWinners.firstRunner}`);
    return parts.length > 0 ? parts.join(' · ') : 'The Vault Crew!';
  }

  private toPublicChamber(chamber: InternalChamber): ChamberPublicState {
    const idx = chamber.spotlightPlayer ? chamber.pool.indexOf(chamber.spotlightPlayer) : -1;
    const rotatingQueue: string[] = [];
    if (chamber.pool.length > 1 && idx >= 0) {
      for (let i = 1; i < chamber.pool.length && rotatingQueue.length < 10; i++) {
        rotatingQueue.push(chamber.pool[(idx + i) % chamber.pool.length]);
      }
    }
    const mergedUpNext = Array.from(new Set([...chamber.vipQueue, ...rotatingQueue])).slice(0, 10);

    return {
      team: chamber.team,
      lockStage: chamber.lockStage,
      eliminatedWires: [...chamber.eliminatedWires],
      wireStrikes: chamber.wireStrikes,
      knownDigits: [...chamber.knownDigits] as [string, string, string],
      minBound: chamber.minBound,
      maxBound: chamber.maxBound,
      lastPinGuess: chamber.lastPinGuess,
      lastPinHint: chamber.lastPinHint,
      bridgeStep: chamber.bridgeStep,
      revealedSteps: [...chamber.revealedSteps] as [
        BridgeSide | null,
        BridgeSide | null,
        BridgeSide | null,
        BridgeSide | null,
      ],
      props: chamber.props.map((p) => ({
        id: p.id,
        name: p.name,
        emoji: p.emoji,
        corner: p.corner,
        searchedBy: p.searchedBy,
        clueText: p.searchedBy ? p.clueText : null,
        isTrap: Boolean(p.searchedBy && p.clueType === 'trap'),
        uvOnly: p.clueType === 'uv_secret',
      })),
      discoveredClues: [...chamber.discoveredClues],
      exhaustedSearchers: Array.from(chamber.searchedPlayersThisStage),
      spotlightPlayer: chamber.spotlightPlayer,
      spotlightClass: chamber.spotlightClass,
      turnExpiresAtMs: chamber.turnExpiresAtMs,
      upNext: mergedUpNext,
      poolCount: chamber.pool.length,
      vipQueue: [...chamber.vipQueue],
      shieldedPlayers: Array.from(chamber.shieldedPlayers),
      blackoutUntilMs: chamber.blackoutUntilMs,
      lastEffect: chamber.lastEffect,
      lastEffectPlayer: chamber.lastEffectPlayer,
      lastEffectAtMs: chamber.lastEffectAtMs,
    };
  }

  public getSnapshot(nowMs = Date.now()): RoomSnapshotMessage {
    const remainingSec =
      this.phase === 'playing'
        ? Math.max(0, Math.ceil((this.roundEndsAtMs - nowMs) / 1000))
        : 0;
    const getawayRemainingSec =
      this.phase === 'getaway'
        ? Math.max(0, Math.ceil((this.getawayEndsAtMs - nowMs) / 1000))
        : 0;

    const hazardRatio =
      this.phase === 'playing'
        ? Math.max(0, Math.min(1, 1 - remainingSec / ROOM_DURATION_SEC))
        : this.phase === 'getaway'
          ? 0.25
          : 1;

    return {
      type: 'snapshot',
      timestamp: nowMs,
      roundId: this.roundId,
      modeSetting: this.modeSetting,
      activeMode: this.activeMode,
      phase: this.phase,
      theme: ROOM_THEMES[this.themeId],
      hazardRatio,
      remainingSec,
      getawayRemainingSec,
      cursedDoublePot: this.cursedDoublePot,
      potGold: this.potGold,
      communityTaps: this.communityTaps,
      tapGoal: TAPS_PER_BOOST,
      chambers: {
        coop: this.chambers.coop ? this.toPublicChamber(this.chambers.coop) : undefined,
        red: this.chambers.red ? this.toPublicChamber(this.chambers.red) : undefined,
        blue: this.chambers.blue ? this.toPublicChamber(this.chambers.blue) : undefined,
      },
      winnerTeam: this.winnerTeam,
      loserPitTeam: this.loserPitTeam,
      getawayWinners: {
        ...this.getawayWinners,
        runners: [...this.getawayWinners.runners],
      },
      latestBanner: this.latestBanner,
      leaderboard: this.stats ? this.stats.getLeaderboard(15) : [],
      activePlayersCount: this.activeViewers.size,
    };
  }
}
