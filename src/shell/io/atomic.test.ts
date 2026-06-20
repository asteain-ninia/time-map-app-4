// U15 受け入れ基準2: 書込が 一時ファイル→fsync→アトミックリネーム で破損防止。
// 失敗時は一時ファイルを後始末し既存ファイルを温存、例外を握りつぶさず戻り値で返す。

import { describe, expect, it } from 'vitest';

import { atomicWrite, tempPathFor, type FsOps } from './atomic';

interface Recording {
  readonly events: string[];
  /** Files that "exist" with their bytes (target + temp). */
  readonly files: Map<string, Uint8Array>;
}

/** A fake fs that records the operation order and the surviving files. */
function makeFakeFs(
  rec: Recording,
  failAt?: 'open' | 'write' | 'fsync' | 'rename',
): FsOps {
  const fdToPath = new Map<number, string>();
  let nextFd = 1;
  let pendingPath = '';
  let pendingData: Uint8Array = new Uint8Array();
  return {
    open: (path) => {
      rec.events.push(`open ${path}`);
      if (failAt === 'open') throw new Error('open failed');
      const fd = nextFd++;
      fdToPath.set(fd, path);
      pendingPath = path;
      return fd;
    },
    write: (fd, data) => {
      rec.events.push(`write fd=${fd}`);
      if (failAt === 'write') throw new Error('write failed');
      pendingData = data;
    },
    fsync: (fd) => {
      rec.events.push(`fsync fd=${fd}`);
      if (failAt === 'fsync') throw new Error('fsync failed');
      // Content becomes durable in the temp file at fsync time.
      rec.files.set(pendingPath, pendingData);
    },
    close: (fd) => {
      rec.events.push(`close fd=${fd}`);
      fdToPath.delete(fd);
    },
    rename: (from, to) => {
      rec.events.push(`rename ${from} -> ${to}`);
      if (failAt === 'rename') throw new Error('rename failed');
      const data = rec.files.get(from);
      if (data !== undefined) {
        rec.files.set(to, data);
        rec.files.delete(from);
      }
    },
    unlink: (path) => {
      rec.events.push(`unlink ${path}`);
      rec.files.delete(path);
    },
  };
}

const TARGET = '/dir/world.tmap';
const DATA = new Uint8Array([1, 2, 3, 4]);

describe('atomicWrite success path (受け入れ基準2)', () => {
  it('writes temp → fsync → rename, in that fixed order', () => {
    const rec: Recording = { events: [], files: new Map() };
    const result = atomicWrite(makeFakeFs(rec), TARGET, DATA, 'tok');
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

  it('the temp file is in the SAME directory as the target (同一ボリューム)', () => {
    const temp = tempPathFor(TARGET, 'tok');
    expect(temp.startsWith('/dir/')).toBe(true);
  });
});

describe('atomicWrite failure paths preserve the existing file (受け入れ基準2 / 教訓5.22)', () => {
  it('on write failure: returns ok:false, cleans temp, leaves existing target intact', () => {
    const rec: Recording = { events: [], files: new Map() };
    // An existing target file is present before the write.
    const existing = new Uint8Array([9, 9, 9]);
    rec.files.set(TARGET, existing);

    const result = atomicWrite(makeFakeFs(rec, 'write'), TARGET, DATA, 'tok');
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

  it('on fsync failure: returns ok:false and never renames', () => {
    const rec: Recording = { events: [], files: new Map() };
    rec.files.set(TARGET, new Uint8Array([7]));
    const result = atomicWrite(makeFakeFs(rec, 'fsync'), TARGET, DATA, 'tok');
    expect(result.ok).toBe(false);
    expect(rec.events.some((e) => e.startsWith('rename'))).toBe(false);
    expect(Array.from(rec.files.get(TARGET) ?? [])).toEqual([7]);
  });

  it('on rename failure: returns ok:false and cleans the temp', () => {
    const rec: Recording = { events: [], files: new Map() };
    rec.files.set(TARGET, new Uint8Array([7]));
    const result = atomicWrite(makeFakeFs(rec, 'rename'), TARGET, DATA, 'tok');
    expect(result.ok).toBe(false);
    expect(rec.files.has(tempPathFor(TARGET, 'tok'))).toBe(false);
    expect(Array.from(rec.files.get(TARGET) ?? [])).toEqual([7]);
  });

  it('does not throw for the expected failure (例外を握りつぶさず戻り値で返す)', () => {
    const rec: Recording = { events: [], files: new Map() };
    expect(() => atomicWrite(makeFakeFs(rec, 'open'), TARGET, DATA, 'tok')).not.toThrow();
  });
});
