import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';

const root = path.resolve(import.meta.dirname, '..');
const serverUrl = 'http://127.0.0.1:3000';
const logDir = path.join(root, 'logs', 'desktop');
fs.mkdirSync(logDir, { recursive: true });
const logPath = path.join(logDir, 'launcher.log');
const logFd = fs.openSync(logPath, 'a');
const log = (message) =>
  fs.writeSync(logFd, `${new Date().toISOString()} ${message}\n`);

async function serverState() {
  try {
    const response = await fetch(`${serverUrl}/api/auth/status`, {
      signal: AbortSignal.timeout(2000),
    });
    const body = await response.json();
    if (!response.ok || typeof body.initialized !== 'boolean') return 'other';
    const page = await fetch(serverUrl, { signal: AbortSignal.timeout(2000) });
    return (await page.text()).includes('<title>FinTrace') ? 'ready' : 'other';
  } catch (error) {
    return error?.cause?.code === 'ECONNREFUSED' ? 'stopped' : 'unknown';
  }
}

function buildIfMissing(file, command) {
  if (fs.existsSync(path.join(root, file))) return;
  log(`Building: ${command}`);
  const result = spawnSync(command, {
    cwd: root,
    shell: true,
    windowsHide: true,
    stdio: ['ignore', logFd, logFd],
  });
  if (result.error || result.status !== 0) {
    throw new Error(`Build failed: ${command}. See ${logPath}`);
  }
}

async function launch() {
  if (process.platform !== 'win32') {
    throw new Error('This double-click launcher is for Windows.');
  }
  const electronExe = path.join(
    root,
    'node_modules',
    'electron',
    'dist',
    'electron.exe',
  );
  if (!fs.existsSync(electronExe)) {
    throw new Error(
      'Install dependencies first: npm ci; npm --prefix web ci; npm --prefix container/agent-runner ci',
    );
  }
  buildIfMissing('dist/index.js', 'npm run build:all');
  buildIfMissing('web/dist/index.html', 'npm run build:web');
  buildIfMissing(
    'container/agent-runner/dist/pi-index.js',
    'npm --prefix container/agent-runner run build',
  );
  buildIfMissing('electron/dist/main.cjs', 'npm run desktop:build');
  buildIfMissing('electron/dist/preload.cjs', 'npm run desktop:build');

  let state = await serverState();
  if (state === 'other' || state === 'unknown') {
    throw new Error(
      'Port 3000 is unavailable or occupied by another service. See launcher.log.',
    );
  }
  if (state === 'stopped') {
    log('Starting local backend');
    const backend = spawn(
      process.execPath,
      [path.join(root, 'dist', 'index.js')],
      {
        cwd: root,
        env: { ...process.env, WEB_PORT: '3000' },
        detached: true,
        windowsHide: true,
        stdio: ['ignore', logFd, logFd],
      },
    );
    await once(backend, 'spawn');
    backend.unref();
    const deadline = Date.now() + 90000;
    do {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      state = await serverState();
    } while (state !== 'ready' && Date.now() < deadline);
    if (state !== 'ready')
      throw new Error(`Backend did not become ready. See ${logPath}`);
  } else {
    log('Reusing local backend');
  }

  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const desktop = spawn(
    electronExe,
    [
      path.join(root, 'electron'),
      `--server-url=${serverUrl}`,
      `--renderer-url=${serverUrl}`,
    ],
    { cwd: root, env, detached: true, stdio: 'ignore' },
  );
  await once(desktop, 'spawn');
  desktop.unref();
  log('Desktop launched');
}

try {
  await launch();
} catch (error) {
  log(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  fs.closeSync(logFd);
}
