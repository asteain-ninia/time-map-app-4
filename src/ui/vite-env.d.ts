/// <reference types="vite/client" />

// Asset URL imports (Vite `?url` suffix): resolve to a bundled, same-origin URL
// string at build time. Used by the render adapter to load the bundled preset
// 出界図 (base-map) image offline (技術方針 2.12 / FR-03), served under the app's
// own origin so the renderer's CSP (`img-src 'self'`) admits it.
declare module '*.svg?url' {
  const url: string;
  export default url;
}
