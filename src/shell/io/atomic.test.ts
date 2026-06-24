// U15 受け入れ基準2: 書込が 一時ファイル→fsync→アトミックリネーム で破損防止。
// 失敗時は一時ファイルを後始末し既存ファイルを温存、例外を握りつぶさず戻り値で返す。
//
// bughunt4: the atomic write is now ASYNC (node:fs/promises) so it does not block
// the main-process event loop. The durability barrier (fsync BEFORE rename) and
// every failure-recovery property below are preserved — these tests drive an
// async fake fs and `await` the procedure.

import { describe, expect, it } from 'vitest';

import { atomicWrite, tempPathFor, type FsOps } from './atomic';

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
