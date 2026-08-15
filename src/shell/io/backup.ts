// U15 — generation BACKUP naming + pruning (FR-108 / NFR 5.2 / 受け入れ基準3).
//
// Per saved file we keep at most N timestamped backups; when the count exceeds
// N the OLDEST are deleted. The new/old ordering is decided in ONE place
// (`compareBackupNames`) by a DETERMINISTIC key embedded in the filename, so
// "古い/新しい" never depends on filesystem mtime or wall-clock reads scattered
// around (教訓5.15 注意点).
//
// COLLISION SAFETY (教訓5.37): the timestamp is the actual SAVE-execution real
// time (実時間, NOT作中時間), but ms-precision alone collides on rapid repeated
// saves; so the name also carries a zero-padded SEQUENCE that increments within
// the same millisecond. The (timestamp, sequence) pair is the total order used
// both for naming and for prune selection — they stay consistent because they
// read the same key.
//
// Pure selection/naming functions (Electron-free, 受け入れ基準7). The real
// directory listing / copy / delete is the thin `runBackup` wrapper which takes
// an injected port.

/** Default generation cap (FR-108). Settings may override; this is the既定値. */
export const DEFAULT_MAX_GENERATIONS = 10;

/** Backup filename suffix marking a generation of the base saved file. */
const BACKUP_INFIX = '.bak.';

/**
 * Format a backup filename for `baseName` saved at `timestampMs` with the given
 * within-millisecond `sequence`. The timestamp is rendered as a fixed-width,
 * lexicographically-sortable decimal so string compare == chronological compare;
 * the sequence (also zero-padded) breaks ties (教訓5.37).
 *
 * Shape: `<baseName>.bak.<ts13>-<seq4>` e.g. `world.gimoza.bak.0001718870400000-0003`
 */
export function backupName(baseName: string, timestampMs: number, sequence: number): string {
  const ts = String(Math.trunc(timestampMs)).padStart(16, '0');
  const seq = String(Math.trunc(sequence)).padStart(4, '0');
  return `${baseName}${BACKUP_INFIX}${ts}-${seq}`;
}

/** Parsed sort key extracted from a backup filename. */
interface BackupKey {
  readonly ts: string;
  readonly seq: string;
}

/** Extract the (ts, seq) key from a backup filename, or undefined if it is not one. */
export function backupKeyOf(baseName: string, fileName: string): BackupKey | undefined {
  const prefix = `${baseName}${BACKUP_INFIX}`;
  if (!fileName.startsWith(prefix)) return undefined;
  const rest = fileName.slice(prefix.length);
  const dash = rest.indexOf('-');
  if (dash <= 0) return undefined;
  const ts = rest.slice(0, dash);
  const seq = rest.slice(dash + 1);
  if (ts.length === 0 || seq.length === 0) return undefined;
  return { ts, seq };
}

/**
 * Total order over backup filenames of the same base: ascending = oldest first.
 * Compares the zero-padded timestamp then the sequence as fixed-width strings,
 * so it is deterministic and独立 of mtime (教訓5.15). Names that do not parse as
 * backups sort last (they are not real generations).
 */
export function compareBackupNames(baseName: string, a: string, b: string): number {
  const ka = backupKeyOf(baseName, a);
  const kb = backupKeyOf(baseName, b);
  if (ka === undefined && kb === undefined) return a < b ? -1 : a > b ? 1 : 0;
  if (ka === undefined) return 1;
  if (kb === undefined) return -1;
  if (ka.ts !== kb.ts) return ka.ts < kb.ts ? -1 : 1;
  if (ka.seq !== kb.seq) return ka.seq < kb.seq ? -1 : 1;
  return 0;
}

/**
 * Given the existing backup filenames for `baseName`, decide which to DELETE so
 * that after adding ONE new backup the total stays ≤ `maxGenerations`. Selects
 * the oldest-first excess. `maxGenerations` ≤ 0 is treated as "keep none beyond
 * the incoming one" → delete all existing. Pure: same inputs → same selection.
 */
export function selectBackupsToDelete(
  baseName: string,
  existing: readonly string[],
  maxGenerations: number,
): string[] {
  const backups = existing
    .filter((name) => backupKeyOf(baseName, name) !== undefined)
    .sort((a, b) => compareBackupNames(baseName, a, b)); // oldest first
  // After adding one new backup the count becomes backups.length + 1; we must
  // end with at most `maxGenerations`. So delete the oldest `overflow` of them.
  const cap = Math.max(0, Math.trunc(maxGenerations));
  const keepExisting = Math.max(0, cap - 1); // room for the incoming new backup
  const deleteCount = Math.max(0, backups.length - keepExisting);
  return backups.slice(0, deleteCount);
}

/**
 * Pick the next within-millisecond sequence for `timestampMs`, given the
 * existing backup names: if a backup already exists at the same timestamp, use
 * the max existing sequence + 1; otherwise start at 0. Guarantees a fresh,
 * collision-free name even for multiple saves in the same ms (教訓5.37).
 */
export function nextSequence(
  baseName: string,
  existing: readonly string[],
  timestampMs: number,
): number {
  const ts = String(Math.trunc(timestampMs)).padStart(16, '0');
  let max = -1;
  for (const name of existing) {
    const key = backupKeyOf(baseName, name);
    if (key === undefined || key.ts !== ts) continue;
    const seq = Number.parseInt(key.seq, 10);
    if (Number.isFinite(seq) && seq > max) max = seq;
  }
  return max + 1;
}

// --- thin fs-backed runner (injected port; Electron-free) -------------------

/**
 * Port for the directory operations a backup run performs. All ops are ASYNC
 * (return Promises) so the backup never blocks the event loop (bughunt4): on a
 * large directory the listing / per-generation copy + delete could otherwise
 * stall the main process. The create-then-prune ORDER is preserved by awaiting
 * each step in sequence (see {@link runBackup}).
 */
export interface BackupFsOps {
  /** List the file names (not full paths) in `dir`. */
  listDir: (dir: string) => Promise<readonly string[]>;
  /** Copy the (already atomically-written) source file to `destPath`. */
  copyFile: (sourcePath: string, destPath: string) => Promise<void>;
  /** Delete a backup file by full path. */
  remove: (path: string) => Promise<void>;
}

/** Outcome of a backup run. */
export type BackupResult =
  | { readonly ok: true; readonly createdName: string; readonly deletedNames: readonly string[] }
  | { readonly ok: false; readonly message: string };

/**
 * Create one timestamped backup of the canonical saved file and prune old
 * generations down to `maxGenerations` (FR-108). The backup is copied FROM the
 * already atomically-placed正規 file (so it is never a half-written copy,
 * 受け入れ基準3 / 教訓5.22), and pruning happens AFTER the new copy succeeds so
 * a delete-first crash cannot leave fewer-than-expected generations.
 *
 * `dir` is the directory holding the saved file; `baseName` its filename.
 * `joinPath` builds a full path from dir + name (injected so this stays
 * Electron/path-free at the unit level).
 */
export async function runBackup(
  fs: BackupFsOps,
  joinPath: (dir: string, name: string) => string,
  dir: string,
  baseName: string,
  timestampMs: number,
  maxGenerations: number,
): Promise<BackupResult> {
  try {
    const before = await fs.listDir(dir);
    const seq = nextSequence(baseName, before, timestampMs);
    const newName = backupName(baseName, timestampMs, seq);
    // Decide deletions from the PRE-add list: selectBackupsToDelete reserves a
    // slot for the one incoming backup, so the post-add total lands at exactly
    // maxGenerations.
    const toDelete = selectBackupsToDelete(baseName, before, maxGenerations)
      // never delete the one we just created (defensive: it is the newest).
      .filter((name) => name !== newName);
    // 1) Create the new backup FIRST (from the finalized canonical file).
    //    Awaited so the copy completes before any prune begins.
    await fs.copyFile(joinPath(dir, baseName), joinPath(dir, newName));
    // 2) Only AFTER the new one exists, prune the oldest excess (教訓5.22:
    //    a delete-first crash must never leave fewer-than-expected generations).
    for (const name of toDelete) await fs.remove(joinPath(dir, name));
    return { ok: true, createdName: newName, deletedNames: toDelete };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}
