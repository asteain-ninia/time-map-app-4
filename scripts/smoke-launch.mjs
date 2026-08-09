// Headless launch smoke test for acceptance criteria 1 (empty-window launch)
// and 5 (security settings under which the window renders).
//
// This launches the *built* Electron app (out/main/index.cjs via the package
// `main` field) with SMOKE_TEST=1. In that mode the main process renders the
// window offscreen, then observes the real runtime launch path:
//   whenReady -> createWindow -> preload load (under sandbox) -> renderer
//   did-finish-load
// and exits 0 ([smoke] PASS) or non-zero ([smoke] FAIL) deterministically.
//
// It therefore verifies the launch path mechanically, without a visible GUI
// or human inspection. Run after `npm run build`.

import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

const require = createRequire(import.meta.url);
const electronPath = require('electron');
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// 隔離した userData (e2e/helpers.ts と同じ理由): スモークが利用者の実 userData —
// 設定・診断ログ (FR-117)・GPU キャッシュ — を触らないようにする。
const userDataDir = mkdtempSync(join(tmpdir(), 'tmap-smoke-userdata-'));
process.on('exit', () => {
  try {
    rmSync(userDataDir, { recursive: true, force: true });
  } catch {
    // 後始末の失敗は結果に影響させない。
  }
});

const HARD_TIMEOUT_MS = 60_000;

const env = { ...process.env, SMOKE_TEST: '1' };
// Electron must run as an app, not as plain Node. If this env leaks in from the
// surrounding shell, `require('electron')` inside main returns a path string and
// `app` is undefined, so we strip it explicitly.
delete env.ELECTRON_RUN_AS_NODE;

const child = spawn(
  electronPath,
  [
    '.',
    `--user-data-dir=${userDataDir}`,
    '--disable-gpu',
    '--no-sandbox',
    '--disable-software-rasterizer',
  ],
  { cwd: projectRoot, env, stdio: ['ignore', 'pipe', 'pipe'] },
);

let output = '';
const onData = (chunk) => {
  const text = chunk.toString();
  output += text;
  process.stdout.write(text);
};
child.stdout.on('data', onData);
child.stderr.on('data', onData);

const killTimer = setTimeout(() => {
  child.kill('SIGKILL');
  process.stderr.write(`\n[smoke-runner] FAIL: hard timeout after ${HARD_TIMEOUT_MS}ms\n`);
  process.exitCode = 1;
}, HARD_TIMEOUT_MS);

child.on('exit', (code) => {
  clearTimeout(killTimer);
  const passObserved = output.includes('[smoke] PASS');
  if (code === 0 && passObserved) {
    process.stdout.write('[smoke-runner] OK: launch path verified\n');
    process.exitCode = 0;
  } else {
    process.stderr.write(`[smoke-runner] FAIL: exitCode=${String(code)} passObserved=${String(passObserved)}\n`);
    process.exitCode = 1;
  }
});

child.on('error', (err) => {
  clearTimeout(killTimer);
  process.stderr.write(`[smoke-runner] FAIL: spawn error ${err.message}\n`);
  process.exitCode = 1;
});
