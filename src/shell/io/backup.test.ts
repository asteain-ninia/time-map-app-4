// U15 受け入れ基準3: 最大10世代バックアップ（古い順削除・タイムスタンプ名）。
// 新旧判定が一箇所・決定的で、同一ミリ秒内の複数保存でも破綻しない（教訓5.15/5.37）。

import { describe, expect, it } from 'vitest';

import {
  backupKeyOf,
  backupName,
  compareBackupNames,
  countBackupFeatures,
  countBackups,
  describeBackups,
  memoizedFeatureCount,
  parseBackupFileName,
  listBackupGenerations,
  DEFAULT_MAX_GENERATIONS,
  nextSequence,
  runBackup,
  selectBackupsToDelete,
  type BackupFsOps,
} from './backup';
import { buildTmap } from './tmap';

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

// --- 増分 8D: 世代の一覧（設計書 §E.1 の V14）-------------------------------------

describe('listBackupGenerations / describeBackups（増分 8D）', () => {
  it('その保存ファイルの世代だけを新しい順に並べ、名前の時刻を読む（桁数は決め打ちしない）', () => {
    const names = [
      backupName(BASE, 1000, 0),
      backupName(BASE, 3000, 0),
      backupName(BASE, 3000, 1),
      backupName('other.gimoza', 9000, 0),
      `${BASE}.bak.abc-0000`,
      BASE,
    ];
    expect(listBackupGenerations(BASE, names)).toEqual([
      { fileName: backupName(BASE, 3000, 1), savedAtMs: 3000 },
      { fileName: backupName(BASE, 3000, 0), savedAtMs: 3000 },
      { fileName: backupName(BASE, 1000, 0), savedAtMs: 1000 },
    ]);
  });

  it('大きさが測れない世代は行ごと落とす。中身は読まない（大きさと更新時刻だけ）', async () => {
    const files = new Map<string, Uint8Array>([
      [`/d/${backupName(BASE, 1000, 0)}`, new Uint8Array([9, 9])],
      [`/d/${backupName(BASE, 2000, 0)}`, new Uint8Array([1])],
    ]);
    const rows = await describeBackups(
      {
        listDir: async () => [
          ...[...files.keys()].map((p) => p.slice(3)),
          backupName(BASE, 3000, 0), // 一覧には出たが stat の前に消えた
        ],
        stat: async (p) => {
          const data = files.get(p);
          if (data === undefined) throw new Error('ENOENT');
          return { size: data.length, mtimeMs: 7 };
        },
      },
      (dir, name) => `${dir}/${name}`,
      '/d',
      BASE,
    );
    expect(rows.map((r) => [r.savedAtMs, r.byteSize, r.mtimeMs])).toEqual([
      [2000, 1, 7],
      [1000, 2, 7],
    ]);
  });

  it('ディレクトリが読めなければ空（例外にしない）', async () => {
    const rows = await describeBackups(
      {
        listDir: async () => {
          throw new Error('EACCES');
        },
        stat: async () => ({ size: 0, mtimeMs: 0 }),
      },
      (dir, name) => `${dir}/${name}`,
      '/d',
      BASE,
    );
    expect(rows).toEqual([]);
  });

  it('countBackups は名前だけで数える（読めなければ 0）', async () => {
    const names = [backupName(BASE, 1, 0), backupName(BASE, 2, 0), BASE, 'x.txt'];
    await expect(countBackups(async () => names, '/d', BASE)).resolves.toBe(2);
    await expect(
      countBackups(
        async () => {
          throw new Error('EACCES');
        },
        '/d',
        BASE,
      ),
    ).resolves.toBe(0);
  });
});

describe('世代の地物数の覚え書き（増分 8D の手直し）', () => {
  const good = buildTmap({
    manifest: { histories: [{ entries: [{ anchor: { snapshot: { features: [{ id: 'a' }, { id: 'b' }] } } }] }] },
    baseMapImage: new Uint8Array([1]),
    attachments: [],
  });

  it('同じパス・大きさ・更新時刻なら覚えた数を使い、読まない。どれかが変われば数え直す', async () => {
    const memo = new Map<string, number | null>();
    let reads = 0;
    let mtimeMs = 1;
    const ports = {
      stat: async () => ({ size: good.length, mtimeMs }),
      readFile: async () => {
        reads += 1;
        return good;
      },
    };
    await expect(countBackupFeatures(ports, '/d/a', memo)).resolves.toBe(2);
    await expect(countBackupFeatures(ports, '/d/a', memo)).resolves.toBe(2);
    expect(reads).toBe(1);
    expect(memoizedFeatureCount(memo, { path: '/d/a', byteSize: good.length, mtimeMs: 1 })).toBe(2);
    mtimeMs = 2;
    await countBackupFeatures(ports, '/d/a', memo);
    expect(reads).toBe(2);
    expect(memoizedFeatureCount(memo, { path: '/d/b', byteSize: good.length, mtimeMs: 2 })).toBeUndefined();
  });

  it('読めない・測れない世代は null（読めない結果も覚える）', async () => {
    const memo = new Map<string, number | null>();
    const broken = {
      stat: async () => ({ size: 3, mtimeMs: 1 }),
      readFile: async () => new Uint8Array([1, 2, 3]),
    };
    await expect(countBackupFeatures(broken, '/d/x', memo)).resolves.toBeNull();
    expect(memoizedFeatureCount(memo, { path: '/d/x', byteSize: 3, mtimeMs: 1 })).toBeNull();
    const gone = {
      stat: async () => {
        throw new Error('ENOENT');
      },
      readFile: async () => good,
    };
    await expect(countBackupFeatures(gone, '/d/y', memo)).resolves.toBeNull();
  });
});

describe('一覧に出している世代は間引かない（増分 8D の手直し・重 3）', () => {
  it('keep に載った世代は消さずに飛ばし、代わりに新しい世代を消すこともしない', () => {
    const existing = Array.from({ length: 10 }, (_, i) => backupName(BASE, 1000 + i, 0));
    const oldest = backupName(BASE, 1000, 0);
    expect(selectBackupsToDelete(BASE, existing, 10, new Set([oldest]))).toEqual([]);
    // 上限を 2 に下げても、keep 以外の古いものだけを消す（keep の分は上限を超えて残る）。
    const toDelete = selectBackupsToDelete(BASE, existing, 2, new Set([oldest]));
    expect(toDelete).not.toContain(oldest);
    expect(toDelete).toHaveLength(8);
  });

  it('runBackup も keep を守る', async () => {
    const dir: FakeDir = { files: new Set([BASE]), ops: [] };
    for (let i = 0; i < 3; i++) dir.files.add(backupName(BASE, 1000 + i, 0));
    const keep = new Set([backupName(BASE, 1000, 0)]);
    const result = await runBackup(makeBackupFs(dir), join, '/d', BASE, 2000, 3, keep);
    expect(result.ok).toBe(true);
    expect(dir.files.has(backupName(BASE, 1000, 0))).toBe(true);
    expect(dir.ops.some((o) => o.startsWith('remove'))).toBe(false);
  });
});

describe('世代の名前の形（増分 8D の手直し）', () => {
  it('<元の名前>.bak.<時刻>-<連番> を読み、世代の世代は元まで剥がす', () => {
    expect(parseBackupFileName(backupName(BASE, 1234, 2))).toEqual({ baseName: BASE, savedAtMs: 1234 });
    expect(
      parseBackupFileName(`${backupName(BASE, 1, 0)}.bak.0000000000000009-0000`),
    ).toEqual({ baseName: BASE, savedAtMs: 9 });
  });

  it('世代の形でない名前は undefined', () => {
    // アプリが書く桁数（時刻 16 桁・連番 4 桁）でないものも世代と見なさない（再検証 1-2）。
    for (const name of [
      BASE,
      `${BASE}.bak.`,
      `${BASE}.bak.abc-0000`,
      `${BASE}.bak.12`,
      '.bak.1-0',
      '計画.bak.2024-10',
      `${BASE}.bak.1-1`,
    ]) {
      expect(parseBackupFileName(name)).toBeUndefined();
    }
  });
});
