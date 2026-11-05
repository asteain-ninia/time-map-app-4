// U15 — the ZIP ENTRY-PATH CONVENTION, defined ONCE (単一の真実源, 技術方針
// 2.12 / 注意点: エントリパス規約の二重定義禁止). Both the writer (`buildTmap`)
// and the reader (`readTmap`) import these constants; neither hardcodes a path
// string of its own. A round-trip test changes ONE side and proves it breaks
// (受け入れ基準1).
//
// Layout inside a `.gimoza` ZIP container:
//   manifest.json            — the manifest JSON (FR-103/104), version先頭
//   assets/basemap.img       — the base-map image bytes (FR-103)
//
// 添付画像の領域（`assets/attachments/`）は持たない。FR-98 を作業メモと参照名に改めた
// （2026-11-03）ので、地物の資料の本文は本アプリの外が正本で、本アプリは複製も保持も
// しない。古いファイルにその領域があっても、読み込みは上の 2 つしか取り出さず、
// 次の保存では書かない。
//
// Pure const module (shell layer). No Electron, no fs.

/** Fixed path of the manifest JSON entry. */
export const MANIFEST_ENTRY = 'manifest.json';

/** Fixed path of the base-map image entry. */
export const BASEMAP_ENTRY = 'assets/basemap.img';
