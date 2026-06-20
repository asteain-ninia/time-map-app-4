/// <reference types="vite/client" />

// Asset URL imports (Vite `?url` suffix): resolve to a bundled, same-origin URL
// string at build time. Used by the render adapter to load the bundled preset
// 出界図 (base-map) image offline (技術方針 2.12 / FR-03), served under the app's
// own origin so the renderer's CSP (`img-src 'self'`) admits it.
declare module '*.svg?url' {
  const url: string;
  export default url;
}

// Build-time application version (HB-9 バージョン情報). Injected by Vite `define`
// from package.json `version`; the same constant is defined in the vitest config
// so the バージョン情報 view + its tests read ONE source of truth (§4 単一の真実源).
declare const __APP_VERSION__: string;
