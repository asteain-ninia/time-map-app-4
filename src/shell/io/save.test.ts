// U15 受け入れ基準1/2/3/7: save pipeline (buildTmap → atomicWrite → backup),
// fully driven by injected ports — Electron 無しで end-to-end 検証。round-trip も
// 確認（保存して読み戻す）。

import { describe, expect, it } from 'vitest';

import { serialize } from '../../domain/persistence/serialize';
import { richValidProject } from '../../domain/persistence/fixtures';
import type { FsOps } from './atomic';
import type { BackupFsOps } from './backup';
import { backupKeyOf } from './backup';
import { loadTmapBytes } from './load';
import { saveTmap, type SaveEnv } from './save';

/** An in-memory disk: target + backup files all live in one Map. */
function makeMemoryEnv(): {
  env: SaveEnv;
  disk: Map<string, Uint8Array>;
} {
  const disk = new Map<string, Uint8Array>();
  let pendingPath = '';
  let pendingData: Uint8Array = new Uint8Array();

  const atomicFs: FsOps = {
    open: async (path) => {
      pendingPath = path;
      return 1;
    },
    write: async (_fd, data) => {
      pendingData = data;
    },
    fsync: async () => {
      disk.set(pendingPath, pendingData);
    },
    close: async () => {},
    rename: async (from, to) => {
      const d = disk.get(from);
      if (d !== undefined) {
        disk.set(to, d);
        disk.delete(from);
      }
    },
    unlink: async (path) => {
      disk.delete(path);
    },
  };

  const dirOf = (p: string): string => p.slice(0, p.lastIndexOf('/'));
  const nameOf = (p: string): string => p.slice(p.lastIndexOf('/') + 1);

  const backupFs: BackupFsOps = {
    listDir: async (dir) =>
      [...disk.keys()].filter((p) => dirOf(p) === dir).map((p) => nameOf(p)),
    copyFile: async (sourcePath, destPath) => {
      const d = disk.get(sourcePath);
      if (d !== undefined) disk.set(destPath, d);
    },
    remove: async (path) => {
      disk.delete(path);
    },
  };

  const clock = 1000;
  let counter = 0;
  const env: SaveEnv = {
    atomicFs,
    backupFs,
    now: () => clock,
    token: () => `t${counter++}`,
    splitPath: (fullPath) => ({ dir: dirOf(fullPath), name: nameOf(fullPath) }),
    joinPath: (dir, name) => `${dir}/${name}`,
  };
  return { env, disk };
}

const TARGET = '/proj/world.gimoza';
const baseMap = new Uint8Array([5, 5, 5]);

describe('saveTmap end-to-end (受け入れ基準1/2/7)', () => {
  it('writes a .gimoza that loads back to the same manifest (round-trip)', async () => {
    const { env, disk } = makeMemoryEnv();
    const manifest = serialize(richValidProject());

    const res = await saveTmap(env, TARGET, { manifest, baseMapImage: baseMap, attachments: [] }, 10);
    expect(res.ok).toBe(true);

    const written = disk.get(TARGET);
    expect(written).toBeDefined();
    const loaded = loadTmapBytes(TARGET, written!);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.manifest).toEqual(manifest);
  });

  it('a write failure returns ok:false and preserves the existing file (受け入れ基準2)', async () => {
    const { env, disk } = makeMemoryEnv();
    disk.set(TARGET, new Uint8Array([9, 9])); // existing good file
    const failingEnv: SaveEnv = {
      ...env,
      atomicFs: { ...env.atomicFs, write: async () => { throw new Error('disk full'); } },
    };
    const res = await saveTmap(
      failingEnv,
      TARGET,
      { manifest: serialize(richValidProject()), baseMapImage: baseMap, attachments: [] },
      10,
    );
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toBe('write-failed');
    // Existing file untouched.
    expect(Array.from(disk.get(TARGET) ?? [])).toEqual([9, 9]);
  });
});

describe('repeated saves keep ≤ maxGenerations backups (受け入れ基準3)', () => {
  it('after many saves the backup count is capped at 10, oldest removed', async () => {
    const { env, disk } = makeMemoryEnv();
    const manifest = serialize(richValidProject());
    // Drive 15 saves; the memory env's clock is fixed at 1000 so all backups
    // share a millisecond — the sequence (教訓5.37) must keep them distinct AND
    // pruning must still cap at 10.
    for (let i = 0; i < 15; i++) {
      const res = await saveTmap(env, TARGET, { manifest, baseMapImage: baseMap, attachments: [] }, 10);
      expect(res.ok).toBe(true);
    }
    const backups = [...disk.keys()]
      .map((p) => p.slice(p.lastIndexOf('/') + 1))
      .filter((name) => backupKeyOf('world.gimoza', name) !== undefined);
    expect(backups.length).toBe(10);
  });
});
