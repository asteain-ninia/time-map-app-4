// U15 — ATOMIC write: 一時ファイル → fsync → アトミックリネーム (NFR 5.3 /
// 技術方針 2.12 / 受け入れ基準2).
//
// The fixed procedure:
//   1. write the full bytes to a temp file IN THE SAME DIRECTORY as the target
//      (同一ボリュームでないとリネームが原子的にならない — 注意点);
//   2. fsync the file content to disk;
//   3. atomically rename the temp file over the target.
// On ANY failure before the rename, the temp file is cleaned up and the existing
// target is left untouched (確定まで破壊しない, 教訓5.22). Failure is returned as
// a discriminated result — never an unhandled throw (受け入れ基準2: 例外を握り
// つぶさず戻り値で返す).
//
// fs is INJECTED (the `FsOps` port) so the procedure is unit-testable WITHOUT
// Electron and without touching a real disk (受け入れ基準7 / 開発ガイド §5.41).
// `nodeFsOps` is the production binding over `node:fs`.

import {
  closeSync,
  fsyncSync,
  openSync,
  renameSync,
  unlinkSync,
  writeSync,
} from 'node:fs';

/** Result of an atomic write. Discriminated so callers cannot ignore failure. */
export type AtomicWriteResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly message: string };

/**
 * The minimal filesystem port the atomic write needs. Modeled on the file-
 * descriptor flow so a fake can assert the order (open → write → fsync → close →
 * rename) and inject a failure at any step (受け入れ基準2). All operations are
 * synchronous to keep the order unambiguous and the temp-file cleanup simple.
 */
export interface FsOps {
  /** Open `path` for writing, returning a descriptor handle. */
  open: (path: string) => number;
  /** Write the full buffer to the descriptor. */
  write: (fd: number, data: Uint8Array) => void;
  /** Flush the descriptor's content to durable storage (fsync). */
  fsync: (fd: number) => void;
  /** Close the descriptor. */
  close: (fd: number) => void;
  /** Atomically rename `from` over `to` (same-volume guarantee). */
  rename: (from: string, to: string) => void;
  /** Best-effort remove of the temp file on failure (never throws). */
  unlink: (path: string) => void;
}

/** Production fs port over `node:fs` synchronous descriptor calls. */
export const nodeFsOps: FsOps = {
  open: (path) => openSync(path, 'w'),
  write: (fd, data) => {
    writeSync(fd, data);
  },
  fsync: (fd) => {
    fsyncSync(fd);
  },
  close: (fd) => {
    closeSync(fd);
  },
  rename: (from, to) => {
    renameSync(from, to);
  },
  unlink: (path) => {
    unlinkSync(path);
  },
};

/**
 * Derive the temp-file path used for an atomic write of `targetPath`. It is in
 * the SAME directory (so the rename stays on the same volume) and carries the
 * given unique token so concurrent writers / retries do not collide (教訓5.37).
 */
export function tempPathFor(targetPath: string, token: string): string {
  return `${targetPath}.${token}.tmp`;
}

/**
 * Atomically write `data` to `targetPath` via temp → fsync → rename. The temp
 * file lives in the same directory as the target. `token` makes the temp name
 * unique. On failure anywhere before/at the rename, the temp file is removed and
 * the existing target is preserved; the error becomes an `ok:false` result.
 */
export function atomicWrite(
  fs: FsOps,
  targetPath: string,
  data: Uint8Array,
  token: string,
): AtomicWriteResult {
  const tempPath = tempPathFor(targetPath, token);
  let fd: number | undefined;
  try {
    fd = fs.open(tempPath);
    fs.write(fd, data);
    fs.fsync(fd);
    fs.close(fd);
    fd = undefined;
    fs.rename(tempPath, targetPath);
    return { ok: true };
  } catch (error) {
    // Clean up the descriptor (if still open) and the partial temp file. Both
    // cleanups are best-effort: a failure here must not mask the原因 error.
    if (fd !== undefined) {
      try {
        fs.close(fd);
      } catch {
        // ignore — the write already failed; closing is best-effort.
      }
    }
    try {
      fs.unlink(tempPath);
    } catch {
      // ignore — temp may not exist; existing target is untouched regardless.
    }
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}
