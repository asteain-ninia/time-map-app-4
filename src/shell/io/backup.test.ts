// U15 受け入れ基準3: 最大10世代バックアップ（古い順削除・タイムスタンプ名）。
// 新旧判定が一箇所・決定的で、同一ミリ秒内の複数保存でも破綻しない（教訓5.15/5.37）。

import { describe, expect, it } from 'vitest';

import {
  backupKeyOf,
  backupName,
  compareBackupNames,
  DEFAULT_MAX_GENERATIONS,
  nextSequence,
  runBackup,
  selectBackupsToDelete,
  type BackupFsOps,
} from './backup';

const BASE = 'world.gimoza';

describe('backup naming (受け入れ基準3)', () => {
  it('default generation cap is 10', () => {
    expect(DEFAULT_MAX_GENERATIONS).toBe(10);
  });

  it('embeds the timestamp in the filename', () => {
    const name = backupName(BASE, 1_718_870_400_000, 0);
    expect(name).toContain(BASE);
    expect(name).toContain('1718870400000');
  });

  it('round-trips the (ts, seq) key', () => {
    const name = backupName(BASE, 123456, 7);
    const key = backupKeyOf(BASE, name);
    expect(key).toBeDefined();
    expect(Number(key!.ts)).toBe(123456);
    expect(Number(key!.seq)).toBe(7);
  });

  it('non-backup names yield no key', () => {
    expect(backupKeyOf(BASE, 'world.gimoza')).toBeUndefined();
    expect(backupKeyOf(BASE, 'other.gimoza.bak.0001-0000')).toBeUndefined();
  });
});

describe('deterministic new/old ordering in ONE place (教訓5.15)', () => {
  it('orders by timestamp then sequence, ascending = oldest first', () => {
    const a = backupName(BASE, 100, 0);
    const b = backupName(BASE, 100, 1); // same ms, later seq → newer
    const c = backupName(BASE, 200, 0); // later ms → newer
    expect(compareBackupNames(BASE, a, b)).toBeLessThan(0);
    expect(compareBackupNames(BASE, b, c)).toBeLessThan(0);
    expect(compareBackupNames(BASE, c, a)).toBeGreaterThan(0);
  });

  it('same-millisecond saves get distinct sequences (教訓5.37)', () => {
    const existing = [backupName(BASE, 500, 0), backupName(BASE, 500, 1)];
    expect(nextSequence(BASE, existing, 500)).toBe(2);
    // A fresh millisecond starts at 0.
    expect(nextSequence(BASE, existing, 999)).toBe(0);
  });
});

describe('prune selection keeps at most maxGenerations (受け入れ基準3)', () => {
  it('selects the oldest excess for deletion, leaving room for the incoming one', () => {
    // 10 existing; adding one → must end at ≤ 10, so delete the 1 oldest.
    const existing = Array.from({ length: 10 }, (_, i) => backupName(BASE, 1000 + i, 0));
    const toDelete = selectBackupsToDelete(BASE, existing, 10);
    expect(toDelete).toHaveLength(1);
    expect(toDelete[0]).toBe(backupName(BASE, 1000, 0)); // the oldest
  });

  it('deletes nothing when under cap', () => {
    const existing = [backupName(BASE, 1, 0), backupName(BASE, 2, 0)];
    expect(selectBackupsToDelete(BASE, existing, 10)).toEqual([]);
  });

  it('ignores non-backup files in the directory', () => {
    const existing = [BASE, 'readme.txt', backupName(BASE, 1, 0)];
    expect(selectBackupsToDelete(BASE, existing, 10)).toEqual([]);
  });
});

// --- runBackup: create-then-prune, copies from the finalized canonical file ---

interface FakeDir {
  files: Set<string>;
  ops: string[];
}

function makeBackupFs(dir: FakeDir): BackupFsOps {
  // Async (bughunt4): copyFile resolves on a later microtask so create-then-prune
  // only holds if runBackup truly awaits the copy before any remove.
  return {
    listDir: async () => [...dir.files],
    copyFile: async (sourcePath, destPath) => {
      dir.ops.push(`copy ${sourcePath} -> ${destPath}`);
      await Promise.resolve();
      dir.files.add(basename(destPath));
    },
    remove: async (path) => {
      dir.ops.push(`remove ${path}`);
      dir.files.delete(basename(path));
    },
  };
}

function basename(p: string): string {
  const i = p.lastIndexOf('/');
  return i === -1 ? p : p.slice(i + 1);
}
const join = (d: string, n: string): string => `${d}/${n}`;

describe('runBackup (受け入れ基準3 / 教訓5.22 create-then-prune)', () => {
  it('creates the new backup BEFORE pruning, capped at maxGenerations', async () => {
    const dir: FakeDir = { files: new Set([BASE]), ops: [] };
    // Pre-seed 10 existing backups (ts 1000..1009).
    for (let i = 0; i < 10; i++) dir.files.add(backupName(BASE, 1000 + i, 0));
    const fs = makeBackupFs(dir);

    const result = await runBackup(fs, join, '/d', BASE, 2000, 10);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // The copy happens before any remove (新規確定後に削除, 教訓5.22).
    const firstRemoveIdx = dir.ops.findIndex((o) => o.startsWith('remove'));
    const copyIdx = dir.ops.findIndex((o) => o.startsWith('copy'));
    expect(copyIdx).toBeGreaterThanOrEqual(0);
    expect(copyIdx).toBeLessThan(firstRemoveIdx);

    // After the run, total backups (excluding the canonical) is exactly 10.
    const backups = [...dir.files].filter((f) => backupKeyOf(BASE, f) !== undefined);
    expect(backups).toHaveLength(10);
    // The deleted one is the oldest (ts 1000).
    expect(result.deletedNames).toContain(backupName(BASE, 1000, 0));
    // The newest (ts 2000) is present.
    expect(dir.files.has(result.createdName)).toBe(true);
  });

  it('the backup is copied FROM the canonical finalized file (受け入れ基準3)', async () => {
    const dir: FakeDir = { files: new Set([BASE]), ops: [] };
    const result = await runBackup(makeBackupFs(dir), join, '/d', BASE, 5, 10);
    expect(result.ok).toBe(true);
    expect(dir.ops.some((o) => o.startsWith(`copy /d/${BASE} ->`))).toBe(true);
  });

  it('initial save with 0 prior backups is valid (教訓5.18)', async () => {
    const dir: FakeDir = { files: new Set([BASE]), ops: [] };
    const result = await runBackup(makeBackupFs(dir), join, '/d', BASE, 1, 10);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.deletedNames).toEqual([]);
  });
});
