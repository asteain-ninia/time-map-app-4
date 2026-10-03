// アプリ側の設定ファイル（userData の JSON 1 枚）の読み書きを固定する。
//
// **守りたいのは「壊れていても起動を止めない」こと**（増分 6 の手直し / 決定 (2)）。
// 初回はファイルが無いのがふつうで、それは異常ではない。古い版・新しい版・壊れた JSON も
// 既定へ倒す ―― 覚え書き 1 つのためにアプリが起動しないのは割に合わない。

import { describe, expect, it } from 'vitest';

import {
  AUTO_SAVE_INTERVAL_MINUTES_RANGE,
  BACKUP_GENERATIONS_RANGE,
  DEFAULT_APP_PREFS,
} from '../ipc/contract';
import { DEFAULT_AUTO_SAVE_INTERVAL_MS } from './autosave';
import { DEFAULT_MAX_GENERATIONS } from './backup';

import {
  APP_PREFS_FILE,
  appPrefsPath,
  mergeAppPrefs,
  parseAppPrefs,
  readAppPrefs,
  writeAppPrefs,
  type AppPrefsEnv,
  type AppPrefsFs,
} from './app-prefs';

/** 記憶の中の fs（注入して物理ディスクに触らない）。 */
function memoryFs(initial: Record<string, string> = {}): AppPrefsFs & {
  readonly files: Map<string, string>;
} {
  const files = new Map(Object.entries(initial));
  return {
    files,
    readFile: async (path) => {
      const text = files.get(path);
      if (text === undefined) throw new Error(`ENOENT: ${path}`);
      return text;
    },
    writeFile: async (path, text) => {
      files.set(path, text);
    },
    mkdir: async () => {},
  };
}

const DIR = '/userData';
const PATH = appPrefsPath(DIR);

describe('置き場', () => {
  it('userData の直下の 1 枚', () => {
    expect(PATH.endsWith(APP_PREFS_FILE)).toBe(true);
  });
});

describe('解釈（壊れていても既定へ倒す）', () => {
  it('素直な JSON はそのまま読む', () => {
    expect(parseAppPrefs('{"showFirstRunGuide":false}')).toEqual({
      ...DEFAULT_APP_PREFS,
      showFirstRunGuide: false,
    });
  });

  it('壊れた JSON・配列・null は既定', () => {
    for (const text of ['', '{', '[]', 'null', '3']) {
      expect(parseAppPrefs(text), text).toEqual(DEFAULT_APP_PREFS);
    }
  });

  it('知らない鍵は捨て、欠けた鍵は既定で埋める', () => {
    expect(parseAppPrefs('{"unknown":1}')).toEqual(DEFAULT_APP_PREFS);
    expect(parseAppPrefs('{"showFirstRunGuide":"no"}')).toEqual(DEFAULT_APP_PREFS);
  });
});

describe('併合', () => {
  it('渡された鍵だけを差し替える', () => {
    expect(mergeAppPrefs(DEFAULT_APP_PREFS, {})).toEqual(DEFAULT_APP_PREFS);
    expect(mergeAppPrefs(DEFAULT_APP_PREFS, { showFirstRunGuide: false })).toEqual({
      ...DEFAULT_APP_PREFS,
      showFirstRunGuide: false,
    });
    expect(
      mergeAppPrefs(DEFAULT_APP_PREFS, { autoSaveIntervalMinutes: 10, backupGenerations: 20 }),
    ).toEqual({ ...DEFAULT_APP_PREFS, autoSaveIntervalMinutes: 10, backupGenerations: 20 });
  });

  it('範囲外・整数でない値は今の値のまま（主プロセスの入口として信用しない）', () => {
    const current = { ...DEFAULT_APP_PREFS, autoSaveIntervalMinutes: 7, backupGenerations: 3 };
    for (const bad of [0, -1, 1.5, Number.NaN, AUTO_SAVE_INTERVAL_MINUTES_RANGE.max + 1]) {
      expect(mergeAppPrefs(current, { autoSaveIntervalMinutes: bad }).autoSaveIntervalMinutes).toBe(7);
    }
    for (const bad of [0, 1, 2.5, BACKUP_GENERATIONS_RANGE.max + 1]) {
      expect(mergeAppPrefs(current, { backupGenerations: bad }).backupGenerations).toBe(3);
    }
  });
});

describe('自動保存の間隔と世代数（増分 8D）', () => {
  it('既定は FR-108 の 5 分・10 世代で、主プロセスの既定と同じ値', () => {
    expect(DEFAULT_APP_PREFS.autoSaveIntervalMinutes * 60 * 1000).toBe(DEFAULT_AUTO_SAVE_INTERVAL_MS);
    expect(DEFAULT_APP_PREFS.backupGenerations).toBe(DEFAULT_MAX_GENERATIONS);
  });

  it('範囲内の整数だけを読む（手で書き換えたファイルの 0 分・1 億世代は既定へ倒す）', () => {
    expect(parseAppPrefs('{"autoSaveIntervalMinutes":10,"backupGenerations":20}')).toEqual({
      ...DEFAULT_APP_PREFS,
      autoSaveIntervalMinutes: 10,
      backupGenerations: 20,
    });
    expect(parseAppPrefs('{"autoSaveIntervalMinutes":0,"backupGenerations":100000000}')).toEqual(
      DEFAULT_APP_PREFS,
    );
    expect(parseAppPrefs('{"autoSaveIntervalMinutes":"10","backupGenerations":2.5}')).toEqual(
      DEFAULT_APP_PREFS,
    );
  });

  it('世代数の下限は 2。下限を上げる前のファイルの 1 は 2 として読む（既定の 10 へ倒さない）', () => {
    expect(BACKUP_GENERATIONS_RANGE.min).toBe(2);
    expect(parseAppPrefs('{"backupGenerations":1}').backupGenerations).toBe(2);
    expect(parseAppPrefs('{"backupGenerations":2}').backupGenerations).toBe(2);
    // 0 以下は壊れた値なので、これまでどおり既定。
    expect(parseAppPrefs('{"backupGenerations":0}').backupGenerations).toBe(DEFAULT_APP_PREFS.backupGenerations);
  });
});

describe('読み書き（失敗を例外にしない）', () => {
  it('ファイルが無ければ既定', async () => {
    const env: AppPrefsEnv = { fs: memoryFs(), userDataDir: DIR };
    await expect(readAppPrefs(env)).resolves.toEqual(DEFAULT_APP_PREFS);
  });

  it('書いたものを読み戻せる', async () => {
    const env: AppPrefsEnv = { fs: memoryFs(), userDataDir: DIR };
    await expect(writeAppPrefs(env, { showFirstRunGuide: false })).resolves.toEqual({
      ok: true,
      prefs: { ...DEFAULT_APP_PREFS, showFirstRunGuide: false },
    });
    await expect(readAppPrefs(env)).resolves.toEqual({
      ...DEFAULT_APP_PREFS,
      showFirstRunGuide: false,
    });
  });

  it('書けなくても投げないが、失敗と理由と「いまディスクにある値」を返す（増分 8D の手直し）', async () => {
    const fs = memoryFs();
    const env: AppPrefsEnv = {
      fs: {
        ...fs,
        writeFile: async () => {
          throw new Error('EACCES');
        },
      },
      userDataDir: DIR,
    };
    const result = await writeAppPrefs(env, { showFirstRunGuide: false, backupGenerations: 50 });
    expect(result.ok).toBe(false);
    // 返す値は書こうとした値ではなく、いま効いている（ディスクの）値。
    expect(result.prefs).toEqual(DEFAULT_APP_PREFS);
    if (!result.ok) expect(result.message).toContain('EACCES');
    // 覚え書きは残らない。
    await expect(readAppPrefs(env)).resolves.toEqual(DEFAULT_APP_PREFS);
  });

  it('読めない（権限が無い）ときも既定へ倒す', async () => {
    const env: AppPrefsEnv = {
      fs: {
        ...memoryFs(),
        readFile: async () => {
          throw new Error('EACCES');
        },
      },
      userDataDir: DIR,
    };
    await expect(readAppPrefs(env)).resolves.toEqual(DEFAULT_APP_PREFS);
  });
});
