// U15 — the ZIP ENTRY-PATH CONVENTION, defined ONCE (単一の真実源, 技術方針
// 2.12 / 注意点: エントリパス規約の二重定義禁止). Both the writer (`buildTmap`)
// and the reader (`readTmap`) import these constants; neither hardcodes a path
// string of its own. A round-trip test changes ONE side and proves it breaks
// (受け入れ基準1).
//
// Layout inside a `.gimoza` ZIP container:
//   manifest.json            — the manifest JSON (FR-103/104), version先頭
//   assets/basemap.img       — the base-map image bytes (FR-103)
//   assets/attachments/<name>— each attached document image (FR-103)
//
// Pure const module (shell layer). No Electron, no fs.

/** Fixed path of the manifest JSON entry. */
export const MANIFEST_ENTRY = 'manifest.json';

/** Fixed path of the base-map image entry. */
export const BASEMAP_ENTRY = 'assets/basemap.img';

/** Directory prefix under which attached images are stored. */
export const ATTACHMENTS_DIR = 'assets/attachments/';

/** Build the ZIP entry path for an attachment of the given name. */
export function attachmentEntry(name: string): string {
  return `${ATTACHMENTS_DIR}${name}`;
}

/**
 * Recover an attachment's name from its entry path, or `undefined` if the path
 * is not under the attachments directory. Used by the reader to map ZIP entries
 * back to {@link NamedAsset} names through the SAME convention the writer used.
 */
export function attachmentNameOf(entryPath: string): string | undefined {
  if (!entryPath.startsWith(ATTACHMENTS_DIR)) return undefined;
  const name = entryPath.slice(ATTACHMENTS_DIR.length);
  // A bare directory entry (empty remainder) is not an attachment.
  return name.length === 0 ? undefined : name;
}
