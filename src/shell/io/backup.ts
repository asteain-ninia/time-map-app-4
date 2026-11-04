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

import { countFeaturesInTmap, MAX_TMAP_BYTES } from './tmap';

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
 * Shape: `<baseName>.bak.<ts16>-<seq4>` e.g. `world.gimoza.bak.0001718870400000-0003`
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
  keep: ReadonlySet<string> = NO_NAMES,
): string[] {
  const backups = existing
    .filter((name) => backupKeyOf(baseName, name) !== undefined)
    .sort((a, b) => compareBackupNames(baseName, a, b)); // oldest first
  // After adding one new backup the count becomes backups.length + 1; we must
  // end with at most `maxGenerations`. So delete the oldest `overflow` of them.
  const cap = Math.max(0, Math.trunc(maxGenerations));
  const keepExisting = Math.max(0, cap - 1); // room for the incoming new backup
  const deleteCount = Math.max(0, backups.length - keepExisting);
  // 増分 8D の手直し: `keep` に載っている世代（「以前の保存から開く」の一覧で利用者に見せて
  // いる世代）は **消さずに飛ばす**。代わりに新しい世代を消すことはしない ―― 上限を一時的に
  // 超えるだけにする（利用者が選ぼうとしている世代を、その確認の保存が消さないように）。
  return backups.slice(0, deleteCount).filter((name) => !keep.has(name));
}

const NO_NAMES: ReadonlySet<string> = new Set();

/**
 * ファイル名が世代の名前の形（`<元の名前>.bak.<数字>-<数字>`）なら、元の名前と保存時刻を返す
 * （増分 8D の手直し）。世代の世代（`a.gimoza.bak.1-0000.bak.2-0000`）は元まで剥がす。
 *
 * 世代のファイルを D&D や「開く」で直接開いたときに、**世代そのものを保存先にしない**ための
 * 判定に使う（設計書 §E.1 の V14 が名指しした危険）。
 */
export function parseBackupFileName(
  fileName: string,
): { readonly baseName: string; readonly savedAtMs: number } | undefined {
  const match = BACKUP_NAME_PATTERN.exec(fileName);
  if (match === null) return undefined;
  const savedAtMs = Number.parseInt(match[2]!, 10);
  if (!Number.isFinite(savedAtMs)) return undefined;
  let baseName = match[1]!;
  for (let inner = BACKUP_NAME_PATTERN.exec(baseName); inner !== null; inner = BACKUP_NAME_PATTERN.exec(baseName)) {
    baseName = inner[1]!;
  }
  return { baseName, savedAtMs };
}

/**
 * 世代の名前の形。時刻と連番は **アプリが書く桁数**（{@link backupName} の 16 桁以上・4 桁以上）の
 * ときだけ世代と見なす（再検証 1-2: `計画.bak.2024-10` のような利用者の付けた名前まで世代と
 * 見なし、「1970 年の世代から復旧」と出ていた）。
 */
const BACKUP_NAME_PATTERN = /^(.+)\.bak\.(\d{16,})-(\d{4,})$/;

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

// --- 世代の一覧（増分 8D。設計書 §E.1 の V14）--------------------------------

/**
 * 一覧に出す 1 世代（名前から読み取れるぶん）。`savedAtMs` は名前に埋めた保存時刻
 * （実時間）で、ファイルの更新時刻は見ない ―― 新旧の並びを決めるのは名前の鍵 1 つ
 * （{@link compareBackupNames}。教訓 5.15）。
 */
export interface BackupGeneration {
  /** 世代のファイル名（ディレクトリを含まない）。 */
  readonly fileName: string;
  /** 保存した時刻（epoch ms）。 */
  readonly savedAtMs: number;
}

/**
 * ディレクトリの中の名前から、`baseName` の世代だけを **新しい順** に取り出す（純粋）。
 *
 * 時刻の桁数は決め打ちしない（{@link backupName} は 16 桁で書く。設計書の `<ts13>` は
 * 書いた当時の見込み）。数字以外が混ざった名前は世代とみなさない。
 */
export function listBackupGenerations(
  baseName: string,
  names: readonly string[],
): BackupGeneration[] {
  const generations: BackupGeneration[] = [];
  for (const fileName of names) {
    const key = backupKeyOf(baseName, fileName);
    if (key === undefined) continue;
    if (!/^\d+$/.test(key.ts) || !/^\d+$/.test(key.seq)) continue;
    const savedAtMs = Number.parseInt(key.ts, 10);
    if (!Number.isFinite(savedAtMs)) continue;
    generations.push({ fileName, savedAtMs });
  }
  // compareBackupNames は古い順。一覧は新しいものを上に出す。
  return generations.sort((a, b) => compareBackupNames(baseName, b.fileName, a.fileName));
}

/** ファイルの大きさと更新時刻（地物数の覚え書きの鍵に使う）。 */
export interface BackupFileStat {
  readonly size: number;
  /** 更新時刻（epoch ms）。測れない環境では -1（鍵は大きさとパスだけになる）。 */
  readonly mtimeMs: number;
}

/** 一覧を作るときに読むもの（注入。Electron 抜きで単体テストできる）。 */
export interface BackupInspectPorts {
  /** ディレクトリの中のファイル名。 */
  listDir: (dir: string) => Promise<readonly string[]>;
  /** ファイルの大きさと更新時刻。**中身は読まない**。 */
  stat: (path: string) => Promise<BackupFileStat>;
}

/** 一覧の 1 行ぶんの中身（主プロセスの内側の形。画面へ出す id はまだ振っていない）。 */
export interface DescribedBackup extends BackupGeneration {
  /** 世代の絶対パス（**主プロセスの外へは出さない**）。 */
  readonly path: string;
  readonly byteSize: number;
  /** 更新時刻（地物数の覚え書きの鍵）。 */
  readonly mtimeMs: number;
}

/**
 * `dir` にある `baseName` の世代を新しい順に並べ、大きさを添える。
 *
 * **中身は読まない**（増分 8D の手直し。以前は一覧のたびに全部の世代を読んで地物を数えて
 * いたので、100 世代で 4〜6 秒かかり、その間は板が出なかった）。地物数は板を出したあとで
 * 1 行ずつ {@link countBackupFeatures} が埋める。
 *
 * - 大きさが測れない（一覧を作る間に消えた）世代は **行ごと出さない**（開けないので）。
 * - ディレクトリが読めなければ空の一覧（例外にしない）。
 */
export async function describeBackups(
  ports: BackupInspectPorts,
  joinPath: (dir: string, name: string) => string,
  dir: string,
  baseName: string,
): Promise<DescribedBackup[]> {
  let names: readonly string[];
  try {
    names = await ports.listDir(dir);
  } catch {
    return [];
  }
  const rows: DescribedBackup[] = [];
  for (const generation of listBackupGenerations(baseName, names)) {
    const path = joinPath(dir, generation.fileName);
    let info: BackupFileStat;
    try {
      info = await ports.stat(path);
    } catch {
      continue;
    }
    rows.push({ ...generation, path, byteSize: info.size, mtimeMs: info.mtimeMs });
  }
  return rows;
}

/**
 * `dir` にある `baseName` の世代の **数だけ** を返す（増分 8D の手直し。設定の「いまの世代の
 * 数」用）。ディレクトリの名前を見るだけで、1 つも開かない。読めなければ 0。
 */
export async function countBackups(
  listDir: (dir: string) => Promise<readonly string[]>,
  dir: string,
  baseName: string,
): Promise<number> {
  try {
    return listBackupGenerations(baseName, await listDir(dir)).length;
  } catch {
    return 0;
  }
}

/**
 * 世代 1 つの地物数を数える（増分 8D の手直し）。同じパス・大きさ・更新時刻の世代は
 * `memo` に覚えた数を使い、2 回目からは読まない。読めない・大きすぎる世代は null。
 */
export async function countBackupFeatures(
  ports: { readonly stat: BackupInspectPorts['stat']; readonly readFile: (path: string) => Promise<Uint8Array> },
  path: string,
  memo: Map<string, number | null> | undefined,
): Promise<number | null> {
  let info: BackupFileStat;
  try {
    info = await ports.stat(path);
  } catch {
    return null;
  }
  const key = `${path}\u0000${String(info.size)}\u0000${String(info.mtimeMs)}`;
  if (memo?.has(key) === true) return memo.get(key) ?? null;
  let count: number | null = null;
  if (info.size <= MAX_TMAP_BYTES) {
    try {
      count = countFeaturesInTmap(await ports.readFile(path));
    } catch {
      count = null;
    }
  }
  if (memo !== undefined) {
    memo.set(key, count);
    // 覚え書きは小さく保つ（古いものから捨てる。上限 100 世代 × 数ファイルぶん）。
    while (memo.size > FEATURE_MEMO_LIMIT) {
      const oldest = memo.keys().next().value;
      if (oldest === undefined) break;
      memo.delete(oldest);
    }
  }
  return count;
}

const FEATURE_MEMO_LIMIT = 500;

/** 覚え書きにすでに数がある世代なら、その数（読まない）。無ければ undefined。 */
export function memoizedFeatureCount(
  memo: ReadonlyMap<string, number | null> | undefined,
  row: Pick<DescribedBackup, 'path' | 'byteSize' | 'mtimeMs'>,
): number | null | undefined {
  if (memo === undefined) return undefined;
  const key = `${row.path}\u0000${String(row.byteSize)}\u0000${String(row.mtimeMs)}`;
  return memo.has(key) ? (memo.get(key) ?? null) : undefined;
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
  keep: ReadonlySet<string> = NO_NAMES,
): Promise<BackupResult> {
  try {
    const before = await fs.listDir(dir);
    const seq = nextSequence(baseName, before, timestampMs);
    const newName = backupName(baseName, timestampMs, seq);
    // Decide deletions from the PRE-add list: selectBackupsToDelete reserves a
    // slot for the one incoming backup, so the post-add total lands at exactly
    // maxGenerations. 増分 8D の手直し: `keep`（一覧で見せている世代の名前）は消さない。
    const toDelete = selectBackupsToDelete(baseName, before, maxGenerations, keep)
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
