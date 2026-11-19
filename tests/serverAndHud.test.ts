// @vitest-environment jsdom
import { EventEmitter } from 'node:events';
import { describe, it, expect, afterEach, vi } from 'vitest';
import WebSocket from 'ws';
import { LockletGameServer } from '../src/server/tiktok/liveBridge';
import { StreamHUD } from '../src/client/StreamHUD';
import { WorldRenderer } from '../src/client/WorldRenderer';
import { bootstrapLocklet } from '../src/client/main';

describe('Locklet Server, HTTP/WS Bridge, 3D Renderer & XSS-Safe StreamHUD', () => {
  const servers: LockletGameServer[] = [];

  afterEach(async () => {
    while (servers.length > 0) {
      await servers.pop()!.stop();
    }
    document.body.innerHTML = '';
    document.getElementById('locklet-hud-styles')?.remove();
  });

  it('serves WebSocket snapshots, REST mode switches, and locks down /sim/* in live mode', async () => {
    const server = new LockletGameServer({
      dbPath: ':memory:',
      port: 0,
      host: '127.0.0.1',
      initialMode: 'coop',
      tickIntervalMs: 60_000,
      rng: () => 0,
    });
    servers.push(server);

    const info = await server.start();
    const ws = new WebSocket(info.wsUrl);
    const firstSnap = await new Promise<any>((resolve) => {
      ws.once('message', (d) => resolve(JSON.parse(String(d))));
    });
    expect(firstSnap.type).toBe('snapshot');
    expect(firstSnap.activeMode).toBe('coop');

    // Switch to versus via REST and generate new room
    const modeRes = await fetch(`${info.httpUrl}/sim/mode`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'versus' }),
    });
    expect(modeRes.status).toBe(200);

    const snapRes = await fetch(`${info.httpUrl}/api/snapshot`);
    const snapJson = (await snapRes.json()) as any;
    expect(snapJson.activeMode).toBe('versus');
    expect(snapJson.chambers.red).toBeDefined();
    expect(snapJson.chambers.blue).toBeDefined();

    // Simulate 100 concurrent viewers -> 10 visible upNext gallery + accurate poolCount
    await fetch(`${info.httpUrl}/sim/mode`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'coop' }),
    });
    const crowdRes = await fetch(`${info.httpUrl}/sim/crowd`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ count: 100 }),
    });
    expect(crowdRes.status).toBe(200);
    const crowdSnap = (await (await fetch(`${info.httpUrl}/api/snapshot`)).json()) as any;
    expect(crowdSnap.activePlayersCount).toBe(100);
    expect(crowdSnap.chambers.coop.poolCount).toBe(100);
    expect(crowdSnap.chambers.coop.upNext).toHaveLength(10);
    ws.close();

    // Verify /sim/* rejects with 403 when liveMode (tiktokUsername) is set without allowSimRoutes
    const liveServer = new LockletGameServer({
      dbPath: ':memory:',
      port: 0,
      tiktokUsername: 'SomeLiveHost',
      connectorFactory: () => {
        const ee = new EventEmitter() as EventEmitter & {
          connect: () => Promise<void>;
          disconnect: () => void;
        };
        ee.connect = async () => {};
        ee.disconnect = () => {};
        return ee;
      },
      tickIntervalMs: 0,
    });
    servers.push(liveServer);
    const liveInfo = await liveServer.start();
    const simBlocked = await fetch(`${liveInfo.httpUrl}/sim/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'Hacker', comment: 'red' }),
    });
    expect(simBlocked.status).toBe(403);
  });

  it('renders XSS-safely in StreamHUD and toggles Co-op vs Versus chambers in headless WorldRenderer', () => {
    const root = document.createElement('div');
    document.body.appendChild(root);

    const getContextSpy = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    const consoleErrSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      const hud = new StreamHUD(root, { apiBaseUrl: 'http://127.0.0.1:8080' });
      const renderer = new WorldRenderer(hud.getWorldStageElement(), { width: 540, height: 960 });
      expect(renderer.isWebGLActive()).toBe(false);
      expect(renderer.getVisibleChamberCount()).toBe(1);

      const xssPayload = '<img src=x onerror="window.__xss=1">';
      const server = new LockletGameServer({
        dbPath: ':memory:',
        port: 0,
        initialMode: 'coop',
        rng: () => 0,
      });
      servers.push(server);

      server.handleChat({ uniqueId: xssPayload, comment: 'red' });
      const coopSnap = server.getSnapshot();
      hud.updateSnapshot(coopSnap);
      renderer.updateSnapshot(coopSnap);

      expect(root.querySelectorAll('img, script, svg').length).toBe(0);
      expect(root.textContent).toContain(xssPayload);
      expect(renderer.getVisibleChamberCount()).toBe(1);

      // Switch to Versus -> 2 visible chambers
      server.getEngine().setModeSetting('versus', Date.now());
      const versusSnap = server.getSnapshot();
      hud.updateSnapshot(versusSnap);
      renderer.updateSnapshot(versusSnap);
      expect(renderer.getVisibleChamberCount()).toBe(2);

      // Toggle safe-zone guide & unmount cleanly
      expect(hud.toggleGuides()).toBe(true);
      renderer.dispose();
      hud.dispose();
      expect(document.getElementById('locklet-hud-styles')).toBeNull();
    } finally {
      getContextSpy.mockRestore();
      consoleErrSpy.mockRestore();
    }
  });

  it('bootstraps client cleanly via bootstrapLocklet and unmounts timers/listeners', () => {
    const getContextSpy = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    const consoleErrSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const root = document.createElement('div');
      document.body.appendChild(root);
      const unmount = bootstrapLocklet(root);
      expect(root.querySelector('.phone-frame')).not.toBeNull();
      unmount();
      expect(root.querySelector('.phone-frame')).toBeNull();
    } finally {
      getContextSpy.mockRestore();
      consoleErrSpy.mockRestore();
    }
  });
});
