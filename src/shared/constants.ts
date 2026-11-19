import type { HeroClass, RoomThemeId, RoomThemeMeta, WireColor } from './types.js';

export const WIRE_COLORS: readonly WireColor[] = ['red', 'blue', 'gold', 'green'] as const;

export const HERO_CLASSES: readonly HeroClass[] = ['knight', 'wizard', 'rogue', 'bard'] as const;

export const ROOM_DURATION_SEC = 90;
export const GETAWAY_DURATION_SEC = 10;
export const ROUND_OVER_PAUSE_SEC = 6;
export const TURN_DURATION_SEC = 6;
export const BLACKOUT_DURATION_MS = 6000;
export const TAPS_PER_BOOST = 100;
export const TAP_BONUS_SEC = 5;
export const UV_GIFT_MIN_DIAMONDS = 5;
export const CUT_LINE_GIFT_MIN_DIAMONDS = 10;
export const SHIELD_GIFT_MIN_DIAMONDS = 15;
export const SABOTAGE_GIFT_MIN_DIAMONDS = 25;

export const ROOM_THEMES: Record<RoomThemeId, RoomThemeMeta> = {
  sunken_treasury: {
    id: 'sunken_treasury',
    label: 'Sunken Treasury',
    emoji: '🌊',
    hazardName: 'Rising Water',
    wallColor: 0x164e63,
    floorColor: 0x0e7490,
    hazardColor: 0x0ea5e9,
    ambientSkyTop: 0x082f49,
    ambientSkyBottom: 0x0284c7,
    props: ['anchor', 'chest', 'statue', 'barrel'],
  },
  magma_forge: {
    id: 'magma_forge',
    label: 'Magma Forge',
    emoji: '🌋',
    hazardName: 'Rising Lava',
    wallColor: 0x450a0a,
    floorColor: 0x7c2d12,
    hazardColor: 0xf97316,
    ambientSkyTop: 0x2b0707,
    ambientSkyBottom: 0xb91c1c,
    props: ['anvil', 'furnace', 'shield', 'crate'],
  },
  haunted_study: {
    id: 'haunted_study',
    label: 'Haunted Study',
    emoji: '👻',
    hazardName: 'Toxic Mist',
    wallColor: 0x2e1065,
    floorColor: 0x4c1d95,
    hazardColor: 0xa855f7,
    ambientSkyTop: 0x1e1b4b,
    ambientSkyBottom: 0x6d28d9,
    props: ['book', 'painting', 'coffin', 'mirror'],
  },
  clockwork_vault: {
    id: 'clockwork_vault',
    label: 'Clockwork Vault',
    emoji: '⚙️',
    hazardName: 'Acid Fog',
    wallColor: 0x422006,
    floorColor: 0x78350f,
    hazardColor: 0x84cc16,
    ambientSkyTop: 0x1c1917,
    ambientSkyBottom: 0x65a30d,
    props: ['clock', 'safe', 'desk', 'globe'],
  },
};

export const ROOM_THEME_ORDER: readonly RoomThemeId[] = [
  'sunken_treasury',
  'magma_forge',
  'haunted_study',
  'clockwork_vault',
] as const;

export const PROP_EMOJIS: Record<string, string> = {
  anchor: '⚓',
  chest: '🧰',
  statue: '🗿',
  barrel: '🛢️',
  anvil: '🔨',
  furnace: '🔥',
  shield: '🛡️',
  crate: '📦',
  book: '📖',
  painting: '🖼️',
  coffin: '⚰️',
  mirror: '🪞',
  clock: '🕰️',
  safe: '🗄️',
  desk: '🪵',
  globe: '🌐',
};
