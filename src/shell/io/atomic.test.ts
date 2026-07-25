// U15 受け入れ基準2: 書込が 一時ファイル→fsync→アトミックリネーム で破損防止。
// 失敗時は一時ファイルを後始末し既存ファイルを温存、例外を握りつぶさず戻り値で返す。
//
// bughunt4: the atomic write is now ASYNC (node:fs/promises) so it does not block
// the main-process event loop. The durability barrier (fsync BEFORE rename) and
// every failure-recovery property below are preserved — these tests drive an
// async fake fs and `await` the procedure.

import { describe, expect, it } from 'vitest';

import { atomicWrite, nodeFsOps, tempPathFor, type FsOps } from './atomic';

interface Recording {
  readonly events: string[];
  /** Files that "exist" with their bytes (target + temp). */
  readonly files: Map<string, Uint8Array>;
}

/**
 * A fake fs that records the operation order and the surviving files. All ops
 * are async (return Promises) so the test exercises the real awaited path; the
 * `fsync` op resolves on a microtask AFTER pushing its event, so if the
 * procedure ever failed to `await` before renaming, the order would break.
 */
function makeFakeFs(
  rec: Recording,
  failAt?: 'open' | 'write' | 'fsync' | 'rename',
): FsOps {
  const fdToPath = new Map<unknown, string>();
  let nextFd = 1;
  let pendingPath = '';
  let pendingData: Uint8Array = new Uint8Array();
  return {
    open: async (path) => {
      rec.events.push(`open ${path}`);
      if (failAt === 'open') throw new Error('open failed');
      const fd = nextFd++;
      fdToPath.set(fd, path);
      pendingPath = path;
      return fd;
    },
    write: async (fd, data) => {
      rec.events.push(`write fd=${fd}`);
      if (failAt === 'write') throw new Error('write failed');
      pendingData = data;
    },
    fsync: async (fd) => {
      rec.events.push(`fsync fd=${fd}`);
      // Resolve on a later microtask: only a procedure that truly awaits fsync
      // before renaming will see the content durable in time (durability barrier).
      await Promise.resolve();
      if (failAt === 'fsync') throw new Error('fsync failed');
      // Content becomes durable in the temp file at fsync time.
      rec.files.set(pendingPath, pendingData);
    },
    close: async (fd) => {
      rec.events.push(`close fd=${fd}`);
      fdToPath.delete(fd);
    },
    rename: async (from, to) => {
      rec.events.push(`rename ${from} -> ${to}`);
      if (failAt === 'rename') throw new Error('rename failed');
      const data = rec.files.get(from);
      if (data !== undefined) {
        rec.files.set(to, data);
        rec.files.delete(from);
      }
    },
    unlink: async (path) => {
      rec.events.push(`unlink ${path}`);
      rec.files.delete(path);
    },
  };
}

const TARGET = '/dir/world.tmap';
const DATA = new Uint8Array([1, 2, 3, 4]);

describe('atomicWrite success path (受け入れ基準2)', () => {
  it('writes temp → fsync → rename, in that fixed order', async () => {
    const rec: Recording = { events: [], files: new Map() };
    const result = await atomicWrite(makeFakeFs(rec), TARGET, DATA, 'tok');
    expect(result.ok).toBe(true);

    const temp = tempPathFor(TARGET, 'tok');
    // The order: open(temp), write, fsync, close, rename(temp -> target).
    expect(rec.events).toEqual([
      `open ${temp}`,
      'write fd=1',
      'fsync fd=1',
      'close fd=1',
      `rename ${temp} -> ${TARGET}`,
    ]);
    // Final state: target holds the data, temp gone.
    expect(Array.from(rec.files.get(TARGET) ?? [])).toEqual(Array.from(DATA));
    expect(rec.files.has(temp)).toBe(false);
  });

  it('awaits the fsync durability barrier BEFORE rename (bughunt4)', async () => {
    // Records the absolute order; because the fake fsync resolves on a later
    // microtask, fsync must be fully awaited (durable) before rename appears.
    const rec: Recording = { events: [], files: new Map() };
    await atomicWrite(makeFakeFs(rec), TARGET, DATA, 'tok');

    const fsyncIdx = rec.events.findIndex((e) => e.startsWith('fsync'));
    const renameIdx = rec.events.findIndex((e) => e.startsWith('rename'));
    expect(fsyncIdx).toBeGreaterThanOrEqual(0);
    expect(renameIdx).toBeGreaterThan(fsyncIdx);
    // And at rename time the temp file's bytes were already durable (set by fsync).
    expect(Array.from(rec.files.get(TARGET) ?? [])).toEqual(Array.from(DATA));
  });

  it('does not block: with a SLOW async fs the result resolves only after I/O', async () => {
    // The slow fsync resolves after a macrotask. If atomicWrite were still
    // synchronous (or did not await), `settled` would be true synchronously
    // before the I/O completed. Asserting it is still false right after the call
    // proves the procedure actually awaits the async I/O (non-blocking path).
    const rec: Recording = { events: [], files: new Map() };
    const base = makeFakeFs(rec);
    const slowFs: FsOps = {
      ...base,
      fsync: async (fd) => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        await base.fsync(fd);
      },
    };
    let settled = false;
    const promise = atomicWrite(slowFs, TARGET, DATA, 'tok').then((r) => {
      settled = true;
      return r;
    });
    // Synchronously after the call the slow I/O cannot have finished.
    expect(settled).toBe(false);
    const result = await promise;
    expect(settled).toBe(true);
    expect(result.ok).toBe(true);
    expect(Array.from(rec.files.get(TARGET) ?? [])).toEqual(Array.from(DATA));
  });

  it('the temp file is in the SAME directory as the target (同一ボリューム)', () => {
    const temp = tempPathFor(TARGET, 'tok');
    expect(temp.startsWith('/dir/')).toBe(true);
  });
});

describe('atomicWrite failure paths preserve the existing file (受け入れ基準2 / 教訓5.22)', () => {
  it('on write failure: returns ok:false, cleans temp, leaves existing target intact', async () => {
    const rec: Recording = { events: [], files: new Map() };
    // An existing target file is present before the write.
    const existing = new Uint8Array([9, 9, 9]);
    rec.files.set(TARGET, existing);

    const result = await atomicWrite(makeFakeFs(rec, 'write'), TARGET, DATA, 'tok');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain('write failed');

    // Existing target untouched (not overwritten / corrupted).
    expect(Array.from(rec.files.get(TARGET) ?? [])).toEqual(Array.from(existing));
    // Temp cleaned up.
    expect(rec.files.has(tempPathFor(TARGET, 'tok'))).toBe(false);
    // unlink was attempted (後始末).
    expect(rec.events.some((e) => e.startsWith('unlink'))).toBe(true);
    // No rename happened (確定まで破壊しない).
    expect(rec.events.some((e) => e.startsWith('rename'))).toBe(false);
  });

  it('on fsync failure: returns ok:false and never renames', async () => {
    const rec: Recording = { events: [], files: new Map() };
    rec.files.set(TARGET, new Uint8Array([7]));
    const result = await atomicWrite(makeFakeFs(rec, 'fsync'), TARGET, DATA, 'tok');
    expect(result.ok).toBe(false);
    expect(rec.events.some((e) => e.startsWith('rename'))).toBe(false);
    expect(Array.from(rec.files.get(TARGET) ?? [])).toEqual([7]);
  });

  it('on rename failure: returns ok:false and cleans the temp', async () => {
    const rec: Recording = { events: [], files: new Map() };
    rec.files.set(TARGET, new Uint8Array([7]));
    const result = await atomicWrite(makeFakeFs(rec, 'rename'), TARGET, DATA, 'tok');
    expect(result.ok).toBe(false);
    expect(rec.files.has(tempPathFor(TARGET, 'tok'))).toBe(false);
    expect(Array.from(rec.files.get(TARGET) ?? [])).toEqual([7]);
  });

  it('does not throw for the expected failure (例外を握りつぶさず戻り値で返す)', async () => {
    const rec: Recording = { events: [], files: new Map() };
    await expect(atomicWrite(makeFakeFs(rec, 'open'), TARGET, DATA, 'tok')).resolves.toMatchObject(
      { ok: false },
    );
  });
});

/** One recorded call into the fake descriptor's `write`. */
interface FakeWriteCall {
  /** Where the requested payload starts INSIDE the original source buffer. */
  readonly payloadStart: number;
  /** How many bytes the caller asked to write. */
  readonly requested: number;
  /** True when the payload is a view over the ORIGINAL buffer (no copy made). */
  readonly sharesSourceBuffer: boolean;
  /**
   * The 4th `FileHandle.write` argument as received. A caller confusing the
   * buffer offset with the FILE position (e.g. a fixed `0` here) would rewrite
   * every chunk over the start of the file — recorded so a test can pin it.
   */
  readonly positionArg: number | null | undefined;
}

/**
 * A fake `FileHandle` whose `write` behaves like POSIX `write(2)`: it accepts
 * only PART of what it was asked to write and reports that via `bytesWritten`.
 * Call i accepts at most `accepts[i]` bytes (the last entry repeats forever), so
 * `[3, 2]` means "3 bytes, then 2 bytes per call" and `[4, 0]` means "4 bytes,
 * then stop making progress".
 *
 * It records each call and the bytes it actually stored, so a test can assert
 * the FULL payload eventually reaches the descriptor. The recorded
 * `payloadStart` is measured against the original buffer, so it is meaningful
 * whether the caller resumes via an `offset` argument or via a subarray view.
 */
function makeShortWriteHandle(
  source: Uint8Array,
  accepts: readonly number[],
): { handle: unknown; stored: number[]; calls: FakeWriteCall[] } {
  const stored: number[] = [];
  const calls: FakeWriteCall[] = [];
  const handle = {
    write: async (
      buffer: Uint8Array,
      offset?: number | null,
      length?: number | null,
      position?: number | null,
    ): Promise<{ bytesWritten: number; buffer: Uint8Array }> => {
      // Fail LOUDLY if the production progress guard is ever removed: without
      // this cap an unguarded retry loop never yields to the timer queue, so
      // vitest's timeout cannot fire and the worker dies of OOM instead of a
      // readable assertion (mutation-verified during review).
      if (calls.length >= 1000) {
        throw new Error('fake: runaway write loop — the zero-progress guard is gone');
      }
      const start = offset ?? 0;
      const requested = length ?? buffer.length - start;
      calls.push({
        payloadStart: buffer.byteOffset + start - source.byteOffset,
        requested,
        sharesSourceBuffer: buffer.buffer === source.buffer,
        positionArg: position,
      });
      const quota = accepts[Math.min(calls.length - 1, accepts.length - 1)] ?? requested;
      const bytesWritten = Math.min(quota, requested);
      for (const byte of buffer.subarray(start, start + bytesWritten)) stored.push(byte);
      return { bytesWritten, buffer };
    },
  };
  return { handle, stored, calls };
}

describe('nodeFsOps.write finishes SHORT writes (Codex UC2 — 受け入れ基準2)', () => {
  // `FileHandle.write` resolves as soon as the OS accepted SOME bytes; a single
  // call is NOT guaranteed to write the whole buffer (Node's own `writeFile`
  // loops on `bytesWritten` for exactly this reason). A truncated temp file
  // would then be fsync'd and renamed over the good target.
  const PAYLOAD = new Uint8Array([10, 20, 30, 40, 50, 60, 70, 80]);

  it('keeps writing until every byte is accepted', async () => {
    const { handle, stored, calls } = makeShortWriteHandle(PAYLOAD, [3, 2]);

    await nodeFsOps.write(handle, PAYLOAD);

    // The whole payload reached the descriptor, in order and exactly once each.
    expect(stored).toEqual(Array.from(PAYLOAD));
    // 3 + 2 + 2 + 1 → four calls, each resuming where the previous stopped.
    expect(calls.map((c) => c.payloadStart)).toEqual([0, 3, 5, 7]);
    // Only the REMAINING bytes are re-offered — no byte is written twice.
    expect(calls.map((c) => c.requested)).toEqual([8, 5, 3, 1]);
  });

  it('never targets a fixed file position (position is absent or tracks the running offset)', async () => {
    // MUTATION-VERIFIED gap: `write(data, offset, remaining, 0)` — a fixed file
    // position — passed every other test but rewrites each chunk over byte 0 of
    // the real file, truncating the temp to the LAST chunk before fsync+rename.
    // Correct implementations either omit `position` (kernel file pointer) or
    // pass exactly the running offset; anything else corrupts the temp file.
    const { handle, calls } = makeShortWriteHandle(PAYLOAD, [3, 2]);

    await nodeFsOps.write(handle, PAYLOAD);

    expect(calls.length).toBeGreaterThan(1);
    for (const call of calls) {
      if (call.positionArg !== undefined && call.positionArg !== null) {
        expect(call.positionArg).toBe(call.payloadStart);
      }
    }
  });

  it('passes a view over the original buffer (no copy of the payload)', async () => {
    const { handle, calls } = makeShortWriteHandle(PAYLOAD, [3, 2]);

    await nodeFsOps.write(handle, PAYLOAD);

    expect(calls.length).toBeGreaterThan(1);
    expect(calls.every((c) => c.sharesSourceBuffer)).toBe(true);
  });

  it('rejects instead of spinning when the descriptor stops making progress', async () => {
    // Accepts 4 bytes, then 0 forever: without a progress check this would loop
    // for ever; without the loop at all it would silently truncate.
    const { handle, stored, calls } = makeShortWriteHandle(PAYLOAD, [4, 0]);

    await expect(nodeFsOps.write(handle, PAYLOAD)).rejects.toThrow(/progress/i);

    // Failed FAST on the first zero-progress call (no infinite retry loop).
    expect(calls.length).toBe(2);
    expect(stored).toEqual([10, 20, 30, 40]);
  });

  it('issues no write at all for an empty payload', async () => {
    const empty = new Uint8Array(0);
    const { handle, calls } = makeShortWriteHandle(empty, [0]);

    await nodeFsOps.write(handle, empty);

    // Nothing to write: the `w` open already truncated the temp file.
    expect(calls).toEqual([]);
  });

  it('a short write can never let a TRUNCATED temp file be renamed over the target', async () => {
    // End-to-end through the real procedure with the REAL production write op:
    // only the descriptor/rename plumbing is faked. The fake descriptor accepts
    // 2 bytes per call, so an unlooped write would publish 2 of 8 bytes.
    const events: string[] = [];
    const disk = new Map<string, Uint8Array>();
    const temp = tempPathFor(TARGET, 'tok');
    const existing = new Uint8Array([9, 9, 9]);
    disk.set(TARGET, existing);
    const short = makeShortWriteHandle(PAYLOAD, [2]);

    const fs: FsOps = {
      open: async (path) => {
        events.push(`open ${path}`);
        return short.handle;
      },
      // The production write op under test — everything else is a fake.
      write: nodeFsOps.write,
      fsync: async () => {
        events.push('fsync');
        // Only the bytes the descriptor actually accepted become durable.
        disk.set(temp, Uint8Array.from(short.stored));
      },
      close: async () => {
        events.push('close');
      },
      rename: async (from, to) => {
        events.push('rename');
        const data = disk.get(from);
        if (data !== undefined) {
          disk.set(to, data);
          disk.delete(from);
        }
      },
      unlink: async (path) => {
        events.push('unlink');
        disk.delete(path);
      },
    };

    const result = await atomicWrite(fs, TARGET, PAYLOAD, 'tok');

    expect(result.ok).toBe(true);
    // The published target holds the FULL payload — not a truncated prefix.
    expect(Array.from(disk.get(TARGET) ?? [])).toEqual(Array.from(PAYLOAD));
    expect(disk.has(temp)).toBe(false);
    expect(events).toEqual([`open ${temp}`, 'fsync', 'close', 'rename']);
  });

  it('a stalled descriptor leaves the existing target intact (ok:false, temp removed)', async () => {
    // Progress stops mid-payload: the procedure must NOT rename, must clean the
    // temp and must report the failure as a result (教訓5.22 / 受け入れ基準2).
    const events: string[] = [];
    const disk = new Map<string, Uint8Array>();
    const temp = tempPathFor(TARGET, 'tok');
    disk.set(TARGET, new Uint8Array([9, 9, 9]));
    const short = makeShortWriteHandle(PAYLOAD, [2, 0]);

    const fs: FsOps = {
      open: async () => {
        disk.set(temp, new Uint8Array(0));
        return short.handle;
      },
      write: nodeFsOps.write,
      fsync: async () => {
        events.push('fsync');
      },
      close: async () => {
        events.push('close');
      },
      rename: async () => {
        events.push('rename');
      },
      unlink: async (path) => {
        events.push('unlink');
        disk.delete(path);
      },
    };

    const result = await atomicWrite(fs, TARGET, PAYLOAD, 'tok');

    expect(result.ok).toBe(false);
    // Never fsync'd, never renamed — the good target is untouched.
    expect(events).toEqual(['close', 'unlink']);
    expect(Array.from(disk.get(TARGET) ?? [])).toEqual([9, 9, 9]);
    expect(disk.has(temp)).toBe(false);
  });
});
