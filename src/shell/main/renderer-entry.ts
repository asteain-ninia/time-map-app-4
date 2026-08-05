// Renderer ENTRY hardening (Codex 全体レビュー MED「dev URL」対処) — pure, Electron-free.
//
// The dev entry URL comes from the environment (`ELECTRON_RENDERER_URL`, set by
// electron-vite). main must not blindly `loadURL` whatever that variable holds: a
// poisoned environment could point the window — WITH the preload and its typed IPC
// bridge attached — at an arbitrary remote origin. Only loopback http origins are
// accepted as a dev server; anything else falls back to the bundled file entry
// (FR-02 オフライン完結: no external URL is ever loaded).
//
// The same module decides in-page NAVIGATION policy (`will-navigate`): in dev only
// same-origin navigations (HMR full reloads) are allowed; in production every
// in-page navigation is denied — the bundled entry is loaded once via `loadFile`
// and the app never legitimately navigates (a stray file drop outside the dropzone
// must not replace the app document with the dropped file).

/** True iff `url` is an acceptable DEV-SERVER entry: http on a loopback host. */
export function isTrustedDevServerUrl(url: string | undefined): boolean {
  if (url === undefined) return false;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:') return false;
  const host = parsed.hostname;
  return host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1';
}

/**
 * True iff an in-page navigation to `targetUrl` is allowed. `trustedDevUrl` is the
 * dev entry when (and only when) it passed {@link isTrustedDevServerUrl}; absent in
 * production. Dev: same-origin only (HMR). Production: never.
 */
export function isAllowedNavigation(
  targetUrl: string,
  trustedDevUrl: string | undefined,
): boolean {
  if (trustedDevUrl === undefined) return false;
  try {
    return new URL(targetUrl).origin === new URL(trustedDevUrl).origin;
  } catch {
    return false;
  }
}
