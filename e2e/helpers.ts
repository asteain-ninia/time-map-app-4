// U43 — shared E2E helper: launch the BUILT Electron app headless and return the
// app handle + the renderer page. Every spec uses this so the launch contract
// (offscreen, E2E_TEST=1, sandbox kept on) lives in one place (単一の真実源).

import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { _electron as electron, type ElectronApplication, type Page } from 'playwright';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export interface LaunchedApp {
  readonly app: ElectronApplication;
  readonly page: Page;
}

/**
 * Launch the built app (out/main/index.cjs via package `main`) under Playwright's
 * Electron driver. The window renders offscreen (E2E_TEST=1) so this runs with no
 * display. GPU/sandbox launch flags match the smoke runner so the headless CI box
 * boots deterministically. Returns once the renderer's first window is available.
 */
export async function launchApp(): Promise<LaunchedApp> {
  // Build the child env from the current one, then DELETE the run-as-node leak.
  // Electron treats ELECTRON_RUN_AS_NODE as set even when empty (""), which makes
  // `require('electron')` in main return a path string instead of the app — and
  // Playwright's `--remote-debugging-port` then errors with "bad option". Removing
  // the key entirely (not blanking it) is the only correct fix.
  const childEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) childEnv[key] = value;
  }
  delete childEnv['ELECTRON_RUN_AS_NODE'];
  childEnv['E2E_TEST'] = '1';

  const app = await electron.launch({
    args: ['.', '--disable-gpu', '--no-sandbox', '--disable-software-rasterizer'],
    cwd: projectRoot,
    env: childEnv,
  });
  const page = await app.firstWindow();
  // Wait until the renderer bundle has executed and React mounted the shell.
  await page.waitForSelector('[data-testid="app-shell"]', { state: 'attached' });
  return { app, page };
}
