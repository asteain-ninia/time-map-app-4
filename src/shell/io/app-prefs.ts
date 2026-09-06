// U15 — アプリ側の設定ファイル（userData の `app-prefs.json` 1 枚）。増分 6 の手直し
// （司令塔の決定 (2)、2026-09-07）。
//
// **なぜ要るのか**: 初回起動のガイドの「今後表示しない」は、プロジェクトの設定
// （保存ファイルの `uiSettings`）にしか載っていなかった。だから **押しても次の起動で
// また出た** ―― 起動直後は新規プロジェクトなので、押した印はどこにも保存されない。
// 「この PC のこのアプリ」に属する覚え書きは、プロジェクトとは別の置き場が要る。
//
// **書くのは userData の中だけ**（FR-02 オフライン・ローカルのみ）。中身は小さな JSON 1 枚で、
// 壊れていたら既定に戻す ―― 設定ファイルの破損でアプリが起動しないのは割に合わない。
//
// 物理 fs は {@link AppPrefsFs} として注入分離し、併合と解釈は純粋関数として単体テスト
// できるようにする（教訓 5.41）。

import { mkdir as fsMkdir, readFile as fsReadFile, writeFile as fsWriteFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { DEFAULT_APP_PREFS, type AppPrefs } from '../ipc/contract';

/** ファイル名（userData 直下）。 */
export const APP_PREFS_FILE = 'app-prefs.json';

/** 読み書きに要る最小の fs（注入して単体テストできるようにする）。 */
export interface AppPrefsFs {
  /** ファイルを読む。無ければ拒否してよい（呼ぶ側が既定へ倒す）。 */
  readFile: (path: string) => Promise<string>;
  /** ファイルを書く（原子性までは要らない ―― 失っても既定に戻るだけ）。 */
  writeFile: (path: string, text: string) => Promise<void>;
  /** 置き場を作る。 */
  mkdir: (dir: string) => Promise<void>;
}

/** 本番の束ね。 */
export const nodeAppPrefsFs: AppPrefsFs = {
  readFile: (path) => fsReadFile(path, 'utf8'),
  writeFile: (path, text) => fsWriteFile(path, text, 'utf8'),
  mkdir: async (dir) => {
    await fsMkdir(dir, { recursive: true });
  },
};

/** 置き場（`userData` ディレクトリ）と fs の束。 */
export interface AppPrefsEnv {
  readonly fs: AppPrefsFs;
  readonly userDataDir: string;
}

/** 設定ファイルの絶対パス。 */
export function appPrefsPath(userDataDir: string): string {
  return join(userDataDir, APP_PREFS_FILE);
}

/**
 * 読んだ文字列を設定として解釈する。**知らない項目は捨て、欠けた項目は既定で埋める**
 * ―― 古い版・新しい版のファイルが混ざっても、起動が止まる経路を作らない。
 */
export function parseAppPrefs(text: string): AppPrefs {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return DEFAULT_APP_PREFS;
  }
  if (typeof value !== 'object' || value === null) return DEFAULT_APP_PREFS;
  const raw = (value as Record<string, unknown>)['showFirstRunGuide'];
  return {
    showFirstRunGuide:
      typeof raw === 'boolean' ? raw : DEFAULT_APP_PREFS.showFirstRunGuide,
  };
}

/** 部分更新を併合する（純粋）。 */
export function mergeAppPrefs(current: AppPrefs, patch: Partial<AppPrefs>): AppPrefs {
  return {
    showFirstRunGuide: patch.showFirstRunGuide ?? current.showFirstRunGuide,
  };
}

/** 読む。無い・壊れている・読めないは **すべて既定**（例外にしない）。 */
export async function readAppPrefs(env: AppPrefsEnv): Promise<AppPrefs> {
  try {
    return parseAppPrefs(await env.fs.readFile(appPrefsPath(env.userDataDir)));
  } catch {
    return DEFAULT_APP_PREFS;
  }
}

/**
 * 部分更新して書く。**書けなくても例外にしない** ―― 覚え書きが残らないだけで、
 * アプリの動きは変わらない。戻り値は「いま設定はこうなっている」という値。
 */
export async function writeAppPrefs(
  env: AppPrefsEnv,
  patch: Partial<AppPrefs>,
): Promise<AppPrefs> {
  const next = mergeAppPrefs(await readAppPrefs(env), patch);
  const path = appPrefsPath(env.userDataDir);
  try {
    await env.fs.mkdir(dirname(path));
    await env.fs.writeFile(path, `${JSON.stringify(next, null, 2)}\n`);
  } catch {
    // 覚え書きが残らないだけ。次の起動でまたガイドが出る、が最悪の結果である。
  }
  return next;
}
