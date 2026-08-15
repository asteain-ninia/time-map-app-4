// U15 — the SAVE pipeline tying together: buildTmap → atomicWrite → backup
// (FR-103 / NFR 5.3 / FR-108 / 受け入れ基準1,2,3). Electron-free: every effectful
// dependency (fs ports, clock, unique token) is injected, so the whole save flow
// is unit-testable end-to-end without Electron (受け入れ基準7).
//
// Both manual save and auto-save call THIS function, guaranteeing they take the
// identical atomic write + backup path (受け入れ基準3: 自動保存は通常保存と同じ
// アトミック書き込み経路を通る).

import { atomicWrite, type AtomicWriteResult, type FsOps } from './atomic';
import { runBackup, type BackupFsOps, type BackupResult } from './backup';
import { buildTmap, type TmapContents } from './tmap';

/**
 * Outcome of {@link saveTmap}. Narrower than the IPC `SaveResponse`: the save
 * pipeline itself never produces `cancelled` (that is a dialog decision in the
 * handler). On success it also surfaces the backup outcome for logging.
 */
export type SaveTmapResult =
  | { readonly ok: true; readonly path: string; readonly backup: BackupResult }
  | { readonly ok: false; readonly reason: 'write-failed'; readonly message: string };

/** Everything the save pipeline needs from its environment, all injected. */
export interface SaveEnv {
  /** Atomic-write fs port (temp → fsync → rename). */
  readonly atomicFs: FsOps;
  /** Backup fs port (list / copy / remove). */
  readonly backupFs: BackupFsOps;
  /** Real-time clock for the backup timestamp (実時間, 教訓5.15). */
  readonly now: () => number;
  /** Unique token for the temp file name (collision-safe, 教訓5.37). */
  readonly token: () => string;
  /** Split a full path into directory + filename. */
  readonly splitPath: (fullPath: string) => { dir: string; name: string };
  /** Join directory + filename into a full path. */
  readonly joinPath: (dir: string, name: string) => string;
}

/**
 * Save `contents` as a `.gimoza` to `targetPath`: assemble the ZIP, atomically
 * write it, then create a timestamped generation backup capped at
 * `maxGenerations`. A write failure is returned as `ok:false` WITHOUT touching
 * the existing file (atomicWrite guarantee). A backup failure does NOT fail the
 * save (the canonical file is already safely written) but is surfaced via
 * `backup` for the caller to log.
 */
export async function saveTmap(
  env: SaveEnv,
  targetPath: string,
  contents: TmapContents,
  maxGenerations: number,
): Promise<SaveTmapResult> {
  // buildTmap (fflate `zipSync`) is still synchronous: it is CPU-bound, not I/O,
  // so it cannot block on a slow/network disk and is fast for typical project
  // sizes. The bughunt4 fix targets the fsync/rename/copy I/O below, which is
  // what stalls the main-process event loop on slow or network drives.
  const zipBytes = buildTmap(contents);
  // Awaited: the atomic write is now non-blocking (node:fs/promises) but its
  // durability barrier (fsync BEFORE rename) is preserved inside atomicWrite.
  const write: AtomicWriteResult = await atomicWrite(
    env.atomicFs,
    targetPath,
    zipBytes,
    env.token(),
  );
  if (!write.ok) {
    return { ok: false, reason: 'write-failed', message: write.message };
  }

  const { dir, name } = env.splitPath(targetPath);
  const backup = await runBackup(
    env.backupFs,
    env.joinPath,
    dir,
    name,
    env.now(),
    maxGenerations,
  );
  return { ok: true, path: targetPath, backup };
}
