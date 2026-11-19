import type { RoomSnapshotMessage } from '../shared/types.js';
import { StreamHUD } from './StreamHUD.js';
import { WorldRenderer } from './WorldRenderer.js';

export function resolveWsUrl(): string {
  if (typeof window === 'undefined') return 'ws://127.0.0.1:8080';
  const params = new URLSearchParams(window.location.search);
  const explicit = params.get('ws');
  if (explicit) return explicit;
  const host = window.location.hostname || '127.0.0.1';
  const port = params.get('serverPort') || '8080';
  const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${host}:${port}`;
}

export function deriveHttpBase(wsUrl: string): string {
  return wsUrl.replace(/^ws(s?):\/\//i, 'http$1://').replace(/\/$/, '');
}

export function bootstrapLocklet(root: HTMLElement): () => void {
  const wsUrl = resolveWsUrl();
  const apiBaseUrl = deriveHttpBase(wsUrl);
  const params =
    typeof window !== 'undefined' ? new URLSearchParams(window.location.search) : new URLSearchParams();
  const obsMode = params.get('obs') === '1' || params.get('obs') === 'true';

  let worldRenderer: WorldRenderer | null = null;
  const hud = new StreamHUD(root, {
    apiBaseUrl,
    obsMode,
    onSnapshot: (snap) => worldRenderer?.updateSnapshot(snap),
  });
  worldRenderer = new WorldRenderer(hud.getWorldStageElement());

  const applySnapshot = (snap: RoomSnapshotMessage) => {
    hud.updateSnapshot(snap);
    worldRenderer?.updateSnapshot(snap);
  };

  fetch(`${apiBaseUrl}/api/snapshot`)
    .then((res) => (res.ok ? res.json() : null))
    .then((snap: RoomSnapshotMessage | null) => {
      if (snap && snap.type === 'snapshot') applySnapshot(snap);
    })
    .catch(() => {});

  let ws: WebSocket | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let closed = false;

  const connect = () => {
    if (closed) return;
    hud.setConnectionStatus('connecting');
    try {
      ws = new WebSocket(wsUrl);
    } catch {
      scheduleReconnect();
      return;
    }
    ws.addEventListener('open', () => hud.setConnectionStatus('live'));
    ws.addEventListener('message', (ev) => {
      try {
        const parsed = JSON.parse(String(ev.data)) as RoomSnapshotMessage;
        if (parsed?.type === 'snapshot') applySnapshot(parsed);
      } catch {}
    });
    ws.addEventListener('close', () => {
      if (!closed) {
        hud.setConnectionStatus('reconnecting');
        scheduleReconnect();
      }
    });
    ws.addEventListener('error', () => ws?.close());
  };

  const scheduleReconnect = () => {
    if (closed || reconnectTimer !== null) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, 1500);
  };

  connect();

  return () => {
    closed = true;
    if (reconnectTimer !== null) clearTimeout(reconnectTimer);
    ws?.close();
    worldRenderer?.dispose();
    hud.dispose();
  };
}

if (typeof document !== 'undefined') {
  const mount = document.getElementById('app');
  if (mount) {
    bootstrapLocklet(mount);
  }
}
