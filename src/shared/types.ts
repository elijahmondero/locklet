export type GameModeSetting = 'coop' | 'versus' | 'auto';
export type ActiveMode = 'coop' | 'versus';
export type TeamId = 'coop' | 'red' | 'blue';
export type RoomThemeId =
  | 'sunken_treasury'
  | 'magma_forge'
  | 'haunted_study'
  | 'clockwork_vault';
export type RoundPhase = 'playing' | 'getaway' | 'round_over';
export type WireColor = 'red' | 'blue' | 'gold' | 'green';
export type BridgeSide = 'L' | 'R';
export type HeroClass = 'knight' | 'wizard' | 'rogue' | 'bard';

export interface RoomThemeMeta {
  id: RoomThemeId;
  label: string;
  emoji: string;
  hazardName: string;
  wallColor: number;
  floorColor: number;
  hazardColor: number;
  ambientSkyTop: number;
  ambientSkyBottom: number;
  props: [string, string, string, string];
}

export interface RoomPropView {
  id: string;
  name: string;
  emoji: string;
  corner: 'nw' | 'ne' | 'sw' | 'se';
  searchedBy: string | null;
  clueText: string | null;
}

export interface ChamberPublicState {
  team: TeamId;
  lockStage: 1 | 2 | 3;
  // Lock 1 (4-wire fuse box)
  eliminatedWires: WireColor[];
  // Lock 2 (3-digit keypad)
  knownDigits: [string, string, string];
  minBound: number;
  maxBound: number;
  lastPinGuess: number | null;
  lastPinHint: 'HIGHER' | 'LOWER' | null;
  // Lock 3 (3-step L/R trap bridge)
  bridgeStep: number; // 0..3
  revealedSteps: [BridgeSide | null, BridgeSide | null, BridgeSide | null];
  // Room props & spotlight queue
  props: RoomPropView[];
  spotlightPlayer: string | null;
  spotlightClass: HeroClass;
  turnExpiresAtMs: number;
  upNext: string[];
  vipQueue: string[];
  shieldedPlayers: string[];
  blackoutUntilMs: number;
  lastEffect: 'none' | 'zap' | 'unlock' | 'shield' | 'clue' | 'dash';
  lastEffectPlayer: string | null;
  lastEffectAtMs: number;
}

export interface PlayerStatsRecord {
  username: string;
  cls: HeroClass;
  wins: number;
  escapes: number;
  locksCracked: number;
  cluesFound: number;
  gold: number;
  lifetimeDiamonds: number;
  lastActiveAt: number;
}

export interface RoomSnapshotMessage {
  type: 'snapshot';
  timestamp: number;
  roundId: number;
  modeSetting: GameModeSetting;
  activeMode: ActiveMode;
  phase: RoundPhase;
  theme: RoomThemeMeta;
  hazardRatio: number; // 0 (safe) .. 1 (flooded/deadly)
  remainingSec: number;
  getawayRemainingSec: number;
  cursedDoublePot: boolean;
  potGold: number;
  communityTaps: number;
  tapGoal: number;
  chambers: {
    coop?: ChamberPublicState;
    red?: ChamberPublicState;
    blue?: ChamberPublicState;
  };
  winnerTeam: TeamId | null;
  loserPitTeam: TeamId | null;
  getawayWinners: {
    lockbreaker: string | null;
    clueMvp: string | null;
    firstRunner: string | null;
    runners: string[];
  };
  latestBanner: string;
  leaderboard: PlayerStatsRecord[];
  activePlayersCount: number;
}
