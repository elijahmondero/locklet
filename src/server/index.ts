import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { LockletGameServer, type LockletServerOptions } from './tiktok/liveBridge.js';

export { LockletGameServer, type LockletServerOptions };

export function createAppServer(options: LockletServerOptions = {}): LockletGameServer {
  return new LockletGameServer(options);
}

function isMainEntry(metaUrl: string): boolean {
  const entryArg = process.argv[1];
  if (!entryArg) return false;
  const currentFile = path.resolve(fileURLToPath(metaUrl));
  const invokedFile = path.resolve(entryArg);
  return process.platform === 'win32'
    ? currentFile.toLowerCase() === invokedFile.toLowerCase()
    : currentFile === invokedFile;
}

async function runCli(): Promise<void> {
  dotenv.config();
  const server = createAppServer();
  const info = await server.start();
  console.log(
    `Locklet server listening on ${info.httpUrl} (WS: ${info.wsUrl}) [mode=${info.liveMode ? 'live' : 'simulator'}]`
  );

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    await server.stop();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

if (isMainEntry(import.meta.url)) {
  void runCli().catch((err) => {
    console.error('Failed to start Locklet server:', err);
    process.exit(1);
  });
}
