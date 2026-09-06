// アプリ側の設定ファイル（userData の JSON 1 枚）の読み書きを固定する。
//
// **守りたいのは「壊れていても起動を止めない」こと**（増分 6 の手直し / 決定 (2)）。
// 初回はファイルが無いのがふつうで、それは異常ではない。古い版・新しい版・壊れた JSON も
// 既定へ倒す ―― 覚え書き 1 つのためにアプリが起動しないのは割に合わない。

import { describe, expect, it } from 'vitest';

import { DEFAULT_APP_PREFS } from '../ipc/contract';

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
    expect(parseAppPrefs('{"showFirstRunGuide":false}')).toEqual({ showFirstRunGuide: false });
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
    expect(mergeAppPrefs({ showFirstRunGuide: true }, {})).toEqual({ showFirstRunGuide: true });
    expect(mergeAppPrefs({ showFirstRunGuide: true }, { showFirstRunGuide: false })).toEqual({
      showFirstRunGuide: false,
    });
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
      showFirstRunGuide: false,
    });
    await expect(readAppPrefs(env)).resolves.toEqual({ showFirstRunGuide: false });
  });

  it('書けなくても投げず、いまの値を返す', async () => {
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
    await expect(writeAppPrefs(env, { showFirstRunGuide: false })).resolves.toEqual({
      showFirstRunGuide: false,
    });
    // 覚え書きは残らない（次の起動でまたガイドが出る、が最悪の結果）。
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
