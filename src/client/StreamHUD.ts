import { WIRE_COLORS } from '../shared/constants.js';
import type {
  ChamberPublicState,
  GameModeSetting,
  RoomSnapshotMessage,
  TeamId,
  WireColor,
} from '../shared/types.js';

export type ConnectionStatus = 'connecting' | 'live' | 'reconnecting';

export interface StreamHudOptions {
  apiBaseUrl?: string;
  obsMode?: boolean;
  onSnapshot?: (snapshot: RoomSnapshotMessage) => void;
}

const HUD_STYLES = `
:root {
  --lk-bg: #070b14;
  --lk-panel: rgba(15, 23, 42, 0.9);
  --lk-border: rgba(148, 163, 184, 0.25);
  --lk-text: #f8fafc;
  --lk-muted: #94a3b8;
  --lk-gold: #fbbf24;
  --lk-mint: #34d399;
  --lk-sky: #38bdf8;
  --lk-rose: #fb7185;
  --lk-violet: #a78bfa;
}
* { box-sizing: border-box; margin: 0; padding: 0; }
body {
  font-family: 'Segoe UI', system-ui, -apple-system, sans-serif;
  background: var(--lk-bg);
  color: var(--lk-text);
  min-height: 100vh;
}
.locklet-shell {
  display: flex;
  justify-content: center;
  align-items: flex-start;
  gap: 16px;
  padding: 12px;
  min-height: 100vh;
}
.locklet-shell.obs-mode { padding: 0; background: #000; }
.obs-mode .side-panel,
.obs-mode .play-dock { display: none; }
.phone-frame {
  position: relative;
  height: calc(100vh - 24px);
  max-height: 1920px;
  aspect-ratio: 9 / 16;
  background: #0f172a;
  border-radius: 22px;
  border: 3px solid #334155;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  flex: 0 0 auto;
  box-shadow: 0 22px 60px rgba(0, 0, 0, 0.75);
}
.obs-mode .phone-frame {
  height: 100vh;
  border: none;
  border-radius: 0;
  box-shadow: none;
}
.world-stage {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
}
.hud-overlay {
  position: relative;
  z-index: 10;
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  height: 100%;
  padding: 7px 8px;
  pointer-events: none;
}
.hud-top {
  display: flex;
  flex-direction: column;
  gap: 4px;
  pointer-events: auto;
}
.hazard-card {
  background: var(--lk-panel);
  backdrop-filter: blur(8px);
  border: 1.5px solid rgba(56, 189, 248, 0.55);
  border-radius: 12px;
  padding: 5px 8px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.hazard-card.cursed { border-color: #c084fc; background: rgba(59, 7, 100, 0.88); }
.hazard-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 6px;
}
.theme-title { font-size: 12px; font-weight: 900; color: #f8fafc; }
.timer-badge {
  background: rgba(15, 23, 42, 0.9);
  border: 1px solid var(--lk-border);
  padding: 2px 8px;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 800;
  color: #fde68a;
  white-space: nowrap;
}
.hazard-track {
  width: 100%;
  height: 6px;
  background: rgba(0, 0, 0, 0.5);
  border-radius: 999px;
  overflow: hidden;
}
.hazard-fill {
  height: 100%;
  background: linear-gradient(90deg, #38bdf8, #fb7185);
  transition: width 0.25s ease;
}
.mode-bar {
  display: flex;
  gap: 5px;
  align-items: center;
  justify-content: space-between;
}
.mode-group { display: flex; gap: 4px; }
.lk-btn {
  background: rgba(30, 41, 59, 0.92);
  border: 1px solid rgba(148, 163, 184, 0.35);
  color: #e2e8f0;
  border-radius: 8px;
  padding: 3px 7px;
  font-size: 10px;
  font-weight: 800;
  cursor: pointer;
}
.lk-btn:hover { background: #334155; }
.lk-btn.active { background: #0284c7; border-color: #7dd3fc; color: #fff; }
.lk-btn.gold { background: #b45309; border-color: #fbbf24; color: #fff; }
.lk-btn.mint { background: #047857; border-color: #34d399; color: #fff; }
.lk-btn.rose { background: #be123c; border-color: #fb7185; color: #fff; }
.lk-btn.violet { background: #6d28d9; border-color: #c4b5fd; color: #fff; }
.lk-btn.chalk { background: #e2e8f0; border-color: #ffffff; color: #0f172a; }
.lk-btn:disabled { opacity: 0.4; cursor: default; }

.banner-toast {
  background: rgba(15, 23, 42, 0.9);
  border: 1px solid rgba(251, 191, 36, 0.55);
  border-radius: 10px;
  padding: 4px 8px;
  font-size: 10.5px;
  font-weight: 800;
  color: #fde68a;
  text-align: center;
}
.lock-panel {
  background: rgba(15, 23, 42, 0.86);
  backdrop-filter: blur(8px);
  border: 1px solid var(--lk-border);
  border-radius: 11px;
  padding: 5px 8px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.versus-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 6px;
}
.team-card {
  background: rgba(15, 23, 42, 0.86);
  border: 1.5px solid var(--lk-border);
  border-radius: 10px;
  padding: 4px 6px;
  display: flex;
  flex-direction: column;
  gap: 2px;
  font-size: 9.5px;
}
.team-card.red { border-color: rgba(251, 113, 133, 0.7); }
.team-card.blue { border-color: rgba(56, 189, 248, 0.7); }
.spotlight-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 6px;
  font-size: 10.5px;
  font-weight: 800;
}
.stage-pill {
  background: rgba(52, 211, 153, 0.18);
  color: #6ee7b7;
  padding: 2px 7px;
  border-radius: 999px;
  font-size: 10px;
}
.lock-readout {
  font-size: 11px;
  font-weight: 900;
  color: #ffffff;
  text-align: center;
  background: rgba(2, 6, 23, 0.55);
  border-radius: 8px;
  padding: 3px 5px;
}
.clues-row {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}
.clue-chip {
  font-size: 9px;
  font-weight: 700;
  background: rgba(255, 255, 255, 0.08);
  color: #cbd5e1;
  padding: 1.5px 5px;
  border-radius: 6px;
}
.clue-chip.found { background: rgba(16, 185, 129, 0.25); color: #a7f3d0; }

.hud-bottom {
  display: flex;
  flex-direction: column;
  gap: 4px;
  pointer-events: auto;
}
.play-dock {
  background: rgba(15, 23, 42, 0.93);
  backdrop-filter: blur(10px);
  border: 1.5px solid rgba(52, 211, 153, 0.45);
  border-radius: 13px;
  padding: 6px 7px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.dock-row { display: flex; flex-wrap: wrap; gap: 4px; align-items: center; }
.lk-input {
  background: #020617;
  border: 1px solid #334155;
  color: #f8fafc;
  border-radius: 7px;
  padding: 5px 8px;
  font-size: 11px;
}
.lk-grow { flex: 1; min-width: 90px; }
.user-tag { width: 92px; font-weight: 700; color: #7dd3fc; }

.safe-guide-line {
  position: absolute;
  left: 0; right: 0;
  bottom: 35%;
  border-top: 1.5px dashed rgba(251, 191, 36, 0.65);
  pointer-events: none;
  z-index: 15;
}
.safe-guide-line.hidden { display: none; }
.safe-guide-tag {
  position: absolute;
  right: 8px;
  top: -16px;
  font-size: 9px;
  font-weight: 800;
  color: #fde68a;
  background: rgba(0, 0, 0, 0.72);
  padding: 1px 6px;
  border-radius: 5px;
}

.outcome-banner {
  position: absolute;
  top: 46%;
  left: 12px;
  right: 12px;
  transform: translateY(-50%);
  z-index: 14;
  pointer-events: none;
  padding: 11px 14px;
  border-radius: 14px;
  text-align: center;
  font-size: 13px;
  font-weight: 900;
  color: #fff;
  box-shadow: 0 10px 30px rgba(0, 0, 0, 0.72);
  backdrop-filter: blur(8px);
}
.outcome-banner.hidden { display: none; }
.outcome-banner.win {
  background: linear-gradient(135deg, rgba(6, 95, 70, 0.94), rgba(180, 83, 9, 0.94));
  border: 2px solid #fde047;
  color: #fef08a;
}
.outcome-banner.loss {
  background: rgba(127, 29, 29, 0.94);
  border: 2px solid #fb7185;
  color: #fecdd3;
}

/* Side Leaderboard & Rules Panel */
.side-panel {
  width: 320px;
  background: #111827;
  border: 1px solid var(--lk-border);
  border-radius: 16px;
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.side-panel.collapsed { width: 210px; }
.side-panel.collapsed .side-body { display: none; }
.side-header { display: flex; justify-content: space-between; align-items: center; gap: 6px; }
.side-title { font-size: 14px; font-weight: 900; color: #fde68a; }
.side-status { font-size: 11px; color: var(--lk-muted); }
.lb-list { display: flex; flex-direction: column; gap: 4px; }
.lb-row {
  display: flex;
  justify-content: space-between;
  font-size: 11.5px;
  background: rgba(255, 255, 255, 0.05);
  padding: 5px 8px;
  border-radius: 7px;
}
`;

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

let hudStyleRefs = 0;

function injectHudStyles(): void {
  if (typeof document === 'undefined') return;
  hudStyleRefs++;
  if (document.getElementById('locklet-hud-styles')) return;
  const s = document.createElement('style');
  s.id = 'locklet-hud-styles';
  s.textContent = HUD_STYLES;
  document.head.appendChild(s);
}

function cleanupHudStyles(): void {
  if (typeof document === 'undefined') return;
  hudStyleRefs = Math.max(0, hudStyleRefs - 1);
  if (hudStyleRefs === 0) {
    document.getElementById('locklet-hud-styles')?.remove();
  }
}

/**
 * XSS-safe 9:16 Locklet Escape Room HUD with Direct On-Screen Play Bar + Leaderboard Panel.
 */
export class StreamHUD {
  private readonly root: HTMLElement;
  private readonly apiBaseUrl: string;
  private readonly onSnapshot?: (snapshot: RoomSnapshotMessage) => void;

  private readonly shellEl: HTMLDivElement;
  private readonly worldStageEl: HTMLDivElement;
  private readonly hazardCardEl: HTMLDivElement;
  private readonly themeTitleEl: HTMLSpanElement;
  private readonly timerBadgeEl: HTMLSpanElement;
  private readonly hazardFillEl: HTMLDivElement;
  private readonly bannerEl: HTMLDivElement;
  private readonly centerPanelEl: HTMLDivElement;
  private readonly quickActionRowEl: HTMLDivElement;
  private readonly propSearchRowEl: HTMLDivElement;
  private readonly modeButtons = new Map<GameModeSetting, HTMLButtonElement>();
  private readonly safeGuideLineEl: HTMLDivElement;
  private readonly outcomeBannerEl: HTMLDivElement;
  private readonly wsStatusEl: HTMLDivElement;
  private readonly lbListEl: HTMLDivElement;
  private readonly userInputEl: HTMLInputElement;

  private guidesVisible = false;
  private disposed = false;
  private lastSnapshot: RoomSnapshotMessage | null = null;
  private giftSeq = 1;

  constructor(root: HTMLElement, options: StreamHudOptions = {}) {
    this.root = root;
    this.apiBaseUrl = (options.apiBaseUrl ?? 'http://127.0.0.1:8080').replace(/\/$/, '');
    this.onSnapshot = options.onSnapshot;

    injectHudStyles();

    this.shellEl = el('div', 'locklet-shell');
    if (options.obsMode) this.shellEl.classList.add('obs-mode');

    // 1. 9:16 PHONE STREAM FRAME
    const phoneFrame = el('div', 'phone-frame');
    this.worldStageEl = el('div', 'world-stage');
    phoneFrame.appendChild(this.worldStageEl);

    this.safeGuideLineEl = el('div', 'safe-guide-line hidden');
    this.safeGuideLineEl.appendChild(
      el('span', 'safe-guide-tag', 'TikTok Bottom 35% Chat Safe Floor')
    );
    phoneFrame.appendChild(this.safeGuideLineEl);

    this.outcomeBannerEl = el('div', 'outcome-banner hidden');
    phoneFrame.appendChild(this.outcomeBannerEl);

    const hudOverlay = el('div', 'hud-overlay');

    // TOP STACK
    const hudTop = el('div', 'hud-top');
    this.hazardCardEl = el('div', 'hazard-card');
    const hazardRow = el('div', 'hazard-row');
    this.themeTitleEl = el('span', 'theme-title', '🌊 Sunken Treasury · Rising Water');
    this.timerBadgeEl = el('span', 'timer-badge', '90s · 🏆 120g');
    hazardRow.append(this.themeTitleEl, this.timerBadgeEl);
    const track = el('div', 'hazard-track');
    this.hazardFillEl = el('div', 'hazard-fill');
    this.hazardFillEl.style.width = '0%';
    track.appendChild(this.hazardFillEl);
    this.hazardCardEl.append(hazardRow, track);

    // MODE BAR
    const modeBar = el('div', 'mode-bar');
    const modeGroup = el('div', 'mode-group');
    const modes: Array<{ id: GameModeSetting; label: string }> = [
      { id: 'coop', label: '🤝 Co-op' },
      { id: 'versus', label: '⚔️ Red vs Blue' },
      { id: 'auto', label: '🔄 Auto' },
    ];
    for (const m of modes) {
      const btn = el('button', 'lk-btn', m.label);
      btn.type = 'button';
      btn.addEventListener('click', () => {
        void this.postApi('/sim/mode', { mode: m.id });
      });
      this.modeButtons.set(m.id, btn);
      modeGroup.appendChild(btn);
    }
    const newRoomBtn = el('button', 'lk-btn mint', '🔀 New Room');
    newRoomBtn.type = 'button';
    newRoomBtn.addEventListener('click', () => {
      void this.postApi('/sim/next-room');
    });
    modeBar.append(modeGroup, newRoomBtn);

    this.bannerEl = el('div', 'banner-toast', 'Comment a prop name or cut a wire to begin!');
    this.centerPanelEl = el('div');

    hudTop.append(this.hazardCardEl, modeBar, this.bannerEl, this.centerPanelEl);

    // BOTTOM DIRECT PLAY DOCK (INSIDE PHONE FRAME)
    const hudBottom = el('div', 'hud-bottom');
    const playDock = el('div', 'play-dock');

    this.propSearchRowEl = el('div', 'dock-row');
    this.quickActionRowEl = el('div', 'dock-row');

    // Chat bar inside the screen
    const chatRow = el('div', 'dock-row');
    this.userInputEl = el('input', 'lk-input user-tag');
    this.userInputEl.value = '@Player1';
    this.userInputEl.placeholder = '@user';
    this.userInputEl.addEventListener('input', () => {
      if (this.lastSnapshot) this.updateSnapshot(this.lastSnapshot);
    });
    const chatInput = el('input', 'lk-input lk-grow');
    chatInput.placeholder = 'Type prop, wire, 3-digit PIN, L/R, or "run"...';
    const sendBtn = el('button', 'lk-btn mint', 'Send');
    sendBtn.type = 'button';
    const submitChat = () => {
      const comment = chatInput.value.trim();
      if (!comment) return;
      chatInput.value = '';
      void this.sendChat(comment);
    };
    sendBtn.addEventListener('click', submitChat);
    chatInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') submitChat();
    });
    chatRow.append(this.userInputEl, chatInput, sendBtn);

    // Balanced Gift + Tap Row
    const giftRow = el('div', 'dock-row');
    const gifts: Array<{ label: string; cls: string; diamonds: number }> = [
      { label: '🔦 5💎 UV', cls: 'lk-btn', diamonds: 5 },
      { label: '🏃 10💎 Cut', cls: 'lk-btn active', diamonds: 10 },
      { label: '🛟 15💎 Shield', cls: 'lk-btn gold', diamonds: 15 },
      { label: '😈 25💎 Chaos', cls: 'lk-btn violet', diamonds: 25 },
    ];
    for (const g of gifts) {
      const b = el('button', g.cls, g.label);
      b.type = 'button';
      b.addEventListener('click', () => {
        void this.postApi('/sim/gift', {
          username: this.getActiveUsername(),
          giftId: `locklet_${g.diamonds}`,
          repeatCount: 1,
          diamondEach: g.diamonds,
          repeatEnd: true,
          msgId: `g_${Date.now()}_${this.giftSeq++}`,
        });
      });
      giftRow.appendChild(b);
    }
    const tapBtn = el('button', 'lk-btn rose', '👏 +25 Taps');
    tapBtn.type = 'button';
    tapBtn.addEventListener('click', () => {
      void this.postApi('/sim/like', { username: this.getActiveUsername(), likeCount: 25 });
    });
    const crowdBtn = el('button', 'lk-btn', '🤖 +100 Crowd');
    crowdBtn.type = 'button';
    crowdBtn.addEventListener('click', () => {
      void this.postApi('/sim/crowd', { count: 100 });
    });
    giftRow.append(tapBtn, crowdBtn);

    playDock.append(this.propSearchRowEl, this.quickActionRowEl, chatRow, giftRow);
    hudBottom.appendChild(playDock);

    hudOverlay.append(hudTop, hudBottom);
    phoneFrame.appendChild(hudOverlay);

    // 2. SIDE LEADERBOARD & STREAM INFO DRAWER
    const sidePanel = el('aside', 'side-panel');
    const sideHeader = el('div', 'side-header');
    const sideTitleBox = el('div');
    sideTitleBox.appendChild(el('div', 'side-title', '🔐 Locklet Stream Panel'));
    this.wsStatusEl = el('div', 'side-status', '🟡 Connecting...');
    sideTitleBox.appendChild(this.wsStatusEl);

    const sideBtns = el('div', 'dock-row');
    const guidesBtn = el('button', 'lk-btn', '👁️ Guides');
    guidesBtn.type = 'button';
    guidesBtn.addEventListener('click', () => this.toggleGuides());
    const collapseBtn = el('button', 'lk-btn', '⇄');
    collapseBtn.type = 'button';
    collapseBtn.addEventListener('click', () => sidePanel.classList.toggle('collapsed'));
    sideBtns.append(guidesBtn, collapseBtn);
    sideHeader.append(sideTitleBox, sideBtns);

    const sideBody = el('div', 'side-body');
    sideBody.appendChild(el('div', 'side-status', '🏆 Top Escape Artists (SQLite):'));
    this.lbListEl = el('div', 'lb-list');
    sideBody.appendChild(this.lbListEl);
    sidePanel.append(sideHeader, sideBody);

    this.shellEl.append(phoneFrame, sidePanel);
    this.root.appendChild(this.shellEl);
  }

  public getWorldStageElement(): HTMLDivElement {
    return this.worldStageEl;
  }

  public setConnectionStatus(status: ConnectionStatus): void {
    this.wsStatusEl.textContent =
      status === 'live'
        ? '🟢 WS Live'
        : status === 'connecting'
          ? '🟡 Connecting...'
          : '🔴 Reconnecting...';
  }

  public toggleGuides(force?: boolean): boolean {
    this.guidesVisible = force !== undefined ? force : !this.guidesVisible;
    this.safeGuideLineEl.classList.toggle('hidden', !this.guidesVisible);
    return this.guidesVisible;
  }

  private getActiveUsername(): string {
    return this.userInputEl.value.trim() || '@Player1';
  }

  private async postApi(endpoint: string, body?: unknown): Promise<void> {
    try {
      const res = await fetch(`${this.apiBaseUrl}${endpoint}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body ?? {}),
      });
      if (res.ok && endpoint !== '/api/snapshot') {
        const snapRes = await fetch(`${this.apiBaseUrl}/api/snapshot`);
        if (snapRes.ok) {
          const snap = (await snapRes.json()) as RoomSnapshotMessage;
          this.updateSnapshot(snap);
          this.onSnapshot?.(snap);
        }
      }
    } catch {
      // Non-fatal offline UI fallback
    }
  }

  private sendChat(comment: string): Promise<void> {
    return this.postApi('/sim/chat', { username: this.getActiveUsername(), comment });
  }

  public updateSnapshot(snapshot: RoomSnapshotMessage): void {
    this.lastSnapshot = snapshot;

    // 1. Header Hazard & Mode State
    const clock =
      snapshot.phase === 'getaway'
        ? `🏃 DASH ${snapshot.getawayRemainingSec}s`
        : `${snapshot.remainingSec}s`;
    const potText = snapshot.cursedDoublePot ? `😈 2x ${snapshot.potGold}g` : `🏆 ${snapshot.potGold}g`;
    this.themeTitleEl.textContent = `${snapshot.theme.emoji} ${snapshot.theme.label} · ${snapshot.theme.hazardName}`;
    this.timerBadgeEl.textContent = `${clock} · ${potText} · 👥 ${snapshot.activePlayersCount}`;
    this.hazardCardEl.classList.toggle('cursed', snapshot.cursedDoublePot);
    this.hazardFillEl.style.width = `${Math.round(snapshot.hazardRatio * 100)}%`;

    for (const [mId, btn] of this.modeButtons.entries()) {
      btn.classList.toggle('active', mId === snapshot.modeSetting);
    }

    this.bannerEl.textContent = snapshot.latestBanner;

    if (snapshot.phase === 'getaway') {
      this.outcomeBannerEl.className = 'outcome-banner win';
      this.outcomeBannerEl.textContent =
        `🚪🔓 VAULT OPEN (${snapshot.getawayRemainingSec}s)! TYPE "RUN" NOW! · ` +
        `🔓 ${snapshot.getawayWinners.lockbreaker ?? 'Crew'} · 🏃 ${snapshot.getawayWinners.firstRunner ?? 'Open!'}`;
    } else if (snapshot.phase === 'round_over' && snapshot.winnerTeam !== null) {
      this.outcomeBannerEl.className = 'outcome-banner win';
      this.outcomeBannerEl.textContent =
        snapshot.activeMode === 'versus'
          ? `🏆 TEAM ${snapshot.winnerTeam.toUpperCase()} WINS THE RACE! Losing cell dropped into the pit!`
          : `🏆 VAULT ESCAPED! Winners: 🔓 ${snapshot.getawayWinners.lockbreaker ?? '-'} · 🔍 ${snapshot.getawayWinners.clueMvp ?? '-'} · 🏃 ${snapshot.getawayWinners.firstRunner ?? '-'}`;
    } else if (snapshot.phase === 'round_over' && snapshot.winnerTeam === null) {
      this.outcomeBannerEl.className = 'outcome-banner loss';
      this.outcomeBannerEl.textContent = `💀 DOOMED! ${snapshot.theme.hazardName} flooded the chamber! Next room loading...`;
    } else {
      this.outcomeBannerEl.className = 'outcome-banner hidden';
      this.outcomeBannerEl.textContent = '';
    }

    // 2. Center Lock Display (Co-op OR Red vs Blue Split)
    if (snapshot.activeMode === 'coop' && snapshot.chambers.coop) {
      this.centerPanelEl.replaceChildren(this.buildCoopPanel(snapshot.chambers.coop));
      this.renderQuickControls(snapshot, snapshot.chambers.coop);
    } else if (snapshot.chambers.red && snapshot.chambers.blue) {
      const grid = el('div', 'versus-grid');
      grid.append(
        this.buildVersusCard('🔴 RED CELL (TOP)', 'red', snapshot.chambers.red),
        this.buildVersusCard('🔵 BLUE CELL (BOT)', 'blue', snapshot.chambers.blue)
      );
      this.centerPanelEl.replaceChildren(grid);

      const user = this.getActiveUsername();
      const target =
        snapshot.chambers.blue.spotlightPlayer === user ||
        snapshot.chambers.blue.upNext.includes(user)
          ? snapshot.chambers.blue
          : snapshot.chambers.red;
      this.renderQuickControls(snapshot, target);
    }

    // 3. Leaderboard Drawer
    const lbRows = snapshot.leaderboard.slice(0, 8).map((p, idx) => {
      const row = el('div', 'lb-row');
      row.append(
        el('span', undefined, `#${idx + 1} ${p.username}`),
        el('span', undefined, `🏆${p.wins} · 🔓${p.locksCracked} · ${p.gold}g`)
      );
      return row;
    });
    if (lbRows.length === 0) {
      lbRows.push(el('div', 'side-status', 'No escapes recorded yet — be the first!'));
    }
    this.lbListEl.replaceChildren(...lbRows);
  }

  private formatLockReadout(ch: ChamberPublicState): string {
    if (ch.lockStage === 1) {
      const wires = WIRE_COLORS.map((w) =>
        ch.eliminatedWires.includes(w) ? `✖${w.toUpperCase()}` : w.toUpperCase()
      ).join(' · ');
      return `🔌 WIRES (⚡${ch.wireStrikes ?? 0}/2): ${wires}`;
    }
    if (ch.lockStage === 2) {
      const pin = ch.knownDigits.join(' ');
      const hint = ch.lastPinHint ? ` · Last ${ch.lastPinGuess} (${ch.lastPinHint})` : '';
      return `🔢 PIN [ ${pin} ] · Range ${ch.minBound}–${ch.maxBound}${hint}`;
    }
    const steps = [0, 1, 2, 3].map((i) => {
      if (ch.revealedSteps[i]) return `✅${ch.revealedSteps[i]}`;
      if (i < ch.bridgeStep) return '🔵';
      return `S${i + 1}:?`;
    });
    return `🌉 BRIDGE (Step ${ch.bridgeStep + 1}/4): ${steps.join(' → ')} → 🔑`;
  }

  private buildCoopPanel(ch: ChamberPublicState): HTMLElement {
    const panel = el('div', 'lock-panel');
    const spotRow = el('div', 'spotlight-row');
    const shownNext = ch.upNext.slice(0, 3);
    const extraCount = (ch.poolCount ?? 0) > 4 ? ` (+${(ch.poolCount ?? 0) - 4} more)` : '';
    const queueStr = shownNext.length > 0 ? ` · Next: ${shownNext.join(', ')}${extraCount}` : '';
    spotRow.append(
      el('span', undefined, `🎯 Lock: ${ch.spotlightPlayer ?? 'Open (Type now!)'}${queueStr}`),
      el('span', 'stage-pill', `Lock ${ch.lockStage}/3`)
    );
    const readout = el('div', 'lock-readout', this.formatLockReadout(ch));

    const discovered = ch.discoveredClues ?? [];
    const clues = el('div', 'clues-row');
    for (const clueText of discovered) {
      clues.appendChild(el('span', 'clue-chip found', clueText));
    }
    if (discovered.length < 3) {
      clues.appendChild(
        el(
          'span',
          'clue-chip',
          '🔦 Search props (1 battery/lock) — watch out for 2 Booby-Traps (-5s)!'
        )
      );
    }

    panel.append(spotRow, readout, clues);
    return panel;
  }

  private buildVersusCard(title: string, team: TeamId, ch: ChamberPublicState): HTMLElement {
    const card = el('div', `team-card ${team}`);
    const head = el('div', 'spotlight-row');
    head.append(el('span', undefined, title), el('span', 'stage-pill', `L${ch.lockStage}/3`));
    const inCell = (ch.poolCount ?? 0) > 1 ? ` (+${(ch.poolCount ?? 0) - 1} in cell)` : '';
    const spot = el('div', undefined, `🎯 ${ch.spotlightPlayer ?? 'Join team!'}${inCell}`);
    const lock = el('div', 'lock-readout', this.formatLockReadout(ch));
    card.append(head, spot, lock);
    return card;
  }

  private renderQuickControls(snapshot: RoomSnapshotMessage, ch: ChamberPublicState): void {
    const rawUser = this.getActiveUsername().replace(/^@+/, '');
    const normalizedUser = rawUser ? `@${rawUser}` : '@Player1';
    const isExhausted = (ch.exhaustedSearchers ?? []).includes(normalizedUser);

    // Prop search buttons
    const propBtns: HTMLElement[] = [];
    if (snapshot.activeMode === 'versus') {
      const rBtn = el('button', 'lk-btn rose', '🔴 Red');
      rBtn.type = 'button';
      rBtn.addEventListener('click', () => void this.sendChat('team red'));
      const bBtn = el('button', 'lk-btn active', '🔵 Blue');
      bBtn.type = 'button';
      bBtn.addEventListener('click', () => void this.sendChat('team blue'));
      propBtns.push(rBtn, bBtn);
    }
    for (const p of ch.props) {
      const statusPrefix = p.searchedBy ? (p.isTrap ? '💥' : '✓') : '';
      const cls = p.searchedBy
        ? p.isTrap
          ? 'lk-btn rose'
          : 'lk-btn mint'
        : p.uvOnly
          ? 'lk-btn violet'
          : 'lk-btn';
      const b = el('button', cls, `${p.emoji} ${statusPrefix}${p.name}`);
      b.type = 'button';
      b.disabled = Boolean(p.searchedBy) || (isExhausted && !p.uvOnly);
      b.addEventListener('click', () => void this.sendChat(p.name));
      propBtns.push(b);
    }
    this.propSearchRowEl.replaceChildren(...propBtns);

    // Phase/Lock-specific action buttons
    const actBtns: HTMLElement[] = [];
    if (snapshot.phase === 'getaway') {
      const runBtn = el('button', 'lk-btn gold lk-grow', '🏃💨 SPRINT OUT THE VAULT DOOR ("run")!');
      runBtn.type = 'button';
      runBtn.addEventListener('click', () => void this.sendChat('run'));
      actBtns.push(runBtn);
    } else if (ch.lockStage === 1) {
      const styles: Record<WireColor, string> = {
        red: 'lk-btn rose',
        blue: 'lk-btn active',
        gold: 'lk-btn gold',
        green: 'lk-btn mint',
        purple: 'lk-btn violet',
        white: 'lk-btn chalk',
      };
      for (const w of WIRE_COLORS) {
        const b = el('button', styles[w], `✂️ ${w.toUpperCase()}`);
        b.type = 'button';
        b.disabled = ch.eliminatedWires.includes(w);
        b.addEventListener('click', () => void this.sendChat(w));
        actBtns.push(b);
      }
    } else if (ch.lockStage === 2) {
      const pinInput = el('input', 'lk-input');
      pinInput.type = 'text';
      pinInput.maxLength = 3;
      pinInput.placeholder = '100–999';
      pinInput.style.width = '78px';
      const tryPinBtn = el('button', 'lk-btn gold lk-grow', '🔢 Crack PIN (-6s if wrong)');
      tryPinBtn.type = 'button';
      const submitPin = () => {
        const code = pinInput.value.trim();
        if (/^\d{3}$/.test(code)) {
          void this.sendChat(code);
        }
      };
      tryPinBtn.addEventListener('click', submitPin);
      pinInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') submitPin();
      });
      actBtns.push(pinInput, tryPinBtn);
    } else {
      const lBtn = el('button', 'lk-btn active lk-grow', '⬅️ Step LEFT (L)');
      lBtn.type = 'button';
      lBtn.addEventListener('click', () => void this.sendChat('L'));
      const rBtn = el('button', 'lk-btn gold lk-grow', '➡️ Step RIGHT (R)');
      rBtn.type = 'button';
      rBtn.addEventListener('click', () => void this.sendChat('R'));
      actBtns.push(lBtn, rBtn);
    }
    this.quickActionRowEl.replaceChildren(...actBtns);
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.shellEl.remove();
    cleanupHudStyles();
  }
}
