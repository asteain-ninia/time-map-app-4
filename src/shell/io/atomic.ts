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
// ASYNC (bughunt4): the procedure is now non-blocking — it runs on
// `node:fs/promises` so the main-process event loop is NOT frozen during save
// (large files / slow or network drives / antivirus could stall it for seconds).
// The DURABILITY BARRIER is unchanged: we still fsync the temp file's content to
// disk (`handle.sync()`) BEFORE the atomic rename, so a crash mid-save can never
// corrupt the existing target. Each step is simply `await`ed instead of being a
// blocking `*Sync` call.
//
// fs is INJECTED (the `FsOps` port) so the procedure is unit-testable WITHOUT
// Electron and without touching a real disk (受け入れ基準7 / 開発ガイド §5.41).
// `nodeFsOps` is the production binding over `node:fs/promises`.

import {
  open as fsOpen,
  rename as fsRename,
  unlink as fsUnlink,
  type FileHandle,
} from 'node:fs/promises';

/** Result of an atomic write. Discriminated so callers cannot ignore failure. */
export type AtomicWriteResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly message: string };

/**
 * The minimal filesystem port the atomic write needs. Modeled on the file-
 * descriptor flow so a fake can assert the order (open → write → fsync → close →
 * rename) and inject a failure at any step (受け入れ基準2).
 *
 * All operations are ASYNC (return Promises) so the write never blocks the
 * event loop (bughunt4). The descriptor `handle` is an OPAQUE token: `atomicWrite`
 * only threads back whatever `open` returned, so the handle type is erased to
 * `unknown` at the port boundary (production threads a `node:fs/promises`
 * FileHandle; a fake threads a plain number). The procedure awaits each step in
 * turn, so the call order — and the fsync barrier before rename — stays
 * unambiguous.
 */
export interface FsOps {
  /** Open `path` for writing, returning an opaque descriptor handle. */
  open: (path: string) => Promise<unknown>;
  /** Write the full buffer to the descriptor. */
  write: (handle: unknown, data: Uint8Array) => Promise<void>;
  /** Flush the descriptor's content to durable storage (fsync). */
  fsync: (handle: unknown) => Promise<void>;
  /** Close the descriptor. */
  close: (handle: unknown) => Promise<void>;
  /** Atomically rename `from` over `to` (same-volume guarantee). */
  rename: (from: string, to: string) => Promise<void>;
  /** Best-effort remove of the temp file on failure (never throws). */
  unlink: (path: string) => Promise<void>;
}

/**
 * Production fs port over `node:fs/promises`. `open` yields a FileHandle; the
 * durability barrier is `handle.sync()` (fsync) called BEFORE close + rename.
 * The handle is opaque at the port boundary, so each method narrows the threaded
 * `unknown` back to `FileHandle` at its single point of use (atomicWrite only
 * ever passes back exactly what this `open` returned).
 */
export const nodeFsOps: FsOps = {
  open: (path) => fsOpen(path, 'w'),
  write: async (handle, data) => {
    await (handle as FileHandle).write(data);
  },
  fsync: async (handle) => {
    await (handle as FileHandle).sync();
  },
  close: async (handle) => {
    await (handle as FileHandle).close();
  },
  rename: async (from, to) => {
    await fsRename(from, to);
  },
  unlink: async (path) => {
    await fsUnlink(path);
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
 *
 * Each fs step is `await`ed in order — in particular `fsync` is awaited BEFORE
 * the rename, so the durability barrier holds on the async path exactly as it
 * did synchronously: the temp file's bytes are on durable storage before it is
 * atomically renamed over the target (bughunt4 — non-blocking, same guarantee).
 */
export async function atomicWrite(
  fs: FsOps,
  targetPath: string,
  data: Uint8Array,
  token: string,
): Promise<AtomicWriteResult> {
  const tempPath = tempPathFor(targetPath, token);
  let handle: unknown;
  try {
    handle = await fs.open(tempPath);
    await fs.write(handle, data);
    await fs.fsync(handle); // durability barrier: bytes durable BEFORE rename.
    await fs.close(handle);
    handle = undefined;
    await fs.rename(tempPath, targetPath);
    return { ok: true };
  } catch (error) {
    // Clean up the descriptor (if still open) and the partial temp file. Both
    // cleanups are best-effort: a failure here must not mask the原因 error.
    if (handle !== undefined) {
      try {
        await fs.close(handle);
      } catch {
        // ignore — the write already failed; closing is best-effort.
      }
    }
    try {
      await fs.unlink(tempPath);
    } catch {
      // ignore — temp may not exist; existing target is untouched regardless.
    }
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}
