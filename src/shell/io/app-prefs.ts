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

import { randomUUID } from 'node:crypto';
import { mkdir as fsMkdir, readFile as fsReadFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { atomicWrite, nodeFsOps, type FsOps } from './atomic';
import { SHELL_IO_STRINGS } from './strings';

import {
  AUTO_SAVE_INTERVAL_MINUTES_RANGE,
  BACKUP_GENERATIONS_RANGE,
  DEFAULT_APP_PREFS,
  type AppPrefs,
  type AppPrefsWriteResult,
} from '../ipc/contract';

/** ファイル名（userData 直下）。 */
export const APP_PREFS_FILE = 'app-prefs.json';

/** 読み書きに要る最小の fs（注入して単体テストできるようにする）。 */
export interface AppPrefsFs {
  /** ファイルを読む。無ければ拒否してよい（呼ぶ側が既定へ倒す）。 */
  readFile: (path: string) => Promise<string>;
  /**
   * 書くときの口（一時ファイル → fsync → 名前の付け替え。プロジェクトの保存と同じ `atomicWrite`）。
   * 増分 8D の再手直し: 以前は `fs.writeFile` で直接書いていた。`writeFile` は開いた時点で中身を
   * 空にするので、途中で失敗する（容量切れ・電源断・強制終了）とファイルが壊れ、次の起動で
   * 世代数が既定の 10 に戻り、次の保存で古い世代が確認なしにまとめて消えた。名前の付け替えなら、
   * 途中で失敗しても前のファイルがそのまま残る。
   */
  atomic: FsOps;
  /** 一時ファイルの名前を他と重ねないための印。 */
  token: () => string;
  /** 置き場を作る。 */
  mkdir: (dir: string) => Promise<void>;
}

/** 本番の束ね。 */
export const nodeAppPrefsFs: AppPrefsFs = {
  readFile: (path) => fsReadFile(path, 'utf8'),
  atomic: nodeFsOps,
  token: () => randomUUID(),
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
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return DEFAULT_APP_PREFS;
  }
  const record = value as Record<string, unknown>;
  const raw = record['showFirstRunGuide'];
  return {
    showFirstRunGuide:
      typeof raw === 'boolean' ? raw : DEFAULT_APP_PREFS.showFirstRunGuide,
    autoSaveIntervalMinutes: integerInRange(
      record['autoSaveIntervalMinutes'],
      AUTO_SAVE_INTERVAL_MINUTES_RANGE,
      DEFAULT_APP_PREFS.autoSaveIntervalMinutes,
    ),
    backupGenerations: integerInRange(
      raiseToGenerationsFloor(record['backupGenerations']),
      BACKUP_GENERATIONS_RANGE,
      DEFAULT_APP_PREFS.backupGenerations,
    ),
  };
}

/**
 * 下限を 2 へ上げる前のファイルには 1 が入りうる（増分 8D の手直し）。**1 は 2 として読む** ――
 * 既定の 10 へ倒すと、利用者が少なくしたかった数を黙って 5 倍にしてしまう。0 以下・小数・
 * 文字列などの壊れた値はこれまでどおり既定へ倒す（ここでは触らない）。
 */
function raiseToGenerationsFloor(raw: unknown): unknown {
  return typeof raw === 'number' &&
    Number.isInteger(raw) &&
    raw >= 1 &&
    raw < BACKUP_GENERATIONS_RANGE.min
    ? BACKUP_GENERATIONS_RANGE.min
    : raw;
}

/**
 * 範囲内の整数ならその値、そうでなければ既定（増分 8D）。ファイルは手で書き換えられうる
 * ので、0 分（＝毎ティック保存）や 1 億世代のような値を主プロセスへそのまま流さない。
 */
function integerInRange(
  raw: unknown,
  range: { readonly min: number; readonly max: number },
  fallback: number,
): number {
  if (typeof raw !== 'number' || !Number.isInteger(raw)) return fallback;
  if (raw < range.min || raw > range.max) return fallback;
  return raw;
}

/**
 * 部分更新を併合する（純粋）。範囲外の値は **今の値のまま**にする（設定画面が先に断るので
 * ここへ来るのは壊れた呼び出しだけだが、主プロセスの入口として信用しない）。
 */
export function mergeAppPrefs(current: AppPrefs, patch: Partial<AppPrefs>): AppPrefs {
  return {
    showFirstRunGuide:
      typeof patch.showFirstRunGuide === 'boolean'
        ? patch.showFirstRunGuide
        : current.showFirstRunGuide,
    autoSaveIntervalMinutes: integerInRange(
      patch.autoSaveIntervalMinutes,
      AUTO_SAVE_INTERVAL_MINUTES_RANGE,
      current.autoSaveIntervalMinutes,
    ),
    backupGenerations: integerInRange(
      patch.backupGenerations,
      BACKUP_GENERATIONS_RANGE,
      current.backupGenerations,
    ),
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
 * 部分更新して書く。例外にはしないが、**書けたかどうかを返す**（増分 8D の手直し）。
 *
 * 以前は書けなくても併合した値を返していた（「最悪でもガイドがまた出るだけ」）。8D で
 * 自動保存の間隔と世代数をここへ載せたので、その前提が崩れた ―― 画面は「適用しました」と
 * 出し、その起動の間は新しい世代数が効き、再起動すると既定へ戻って次の保存で世代が
 * まとめて消えた。書けなかったら `ok: false` と **いまディスクにある値** を返す。
 */
export async function writeAppPrefs(
  env: AppPrefsEnv,
  patch: Partial<AppPrefs>,
): Promise<AppPrefsWriteResult> {
  const current = await readAppPrefs(env);
  const next = mergeAppPrefs(current, patch);
  const path = appPrefsPath(env.userDataDir);
  try {
    await env.fs.mkdir(dirname(path));
    // 一時ファイルへ書いて fsync してから名前を付け替える（途中で失敗しても前のファイルが残る）。
    const written = await atomicWrite(
      env.fs.atomic,
      path,
      new TextEncoder().encode(`${JSON.stringify(next, null, 2)}\n`),
      env.fs.token(),
    );
    if (!written.ok) throw new Error(written.message);
  } catch (error) {
    return {
      ok: false,
      prefs: current,
      message: appPrefsWriteFailedMessage(error),
    };
  }
  return { ok: true, prefs: next };
}

/** 設定を書けなかったときの理由（画面に出す）。 */
export function appPrefsWriteFailedMessage(error: unknown): string {
  const detail = error instanceof Error && error.message.length > 0 ? SHELL_IO_STRINGS.prefsWriteFailedDetail(error.message) : '';
  return SHELL_IO_STRINGS.prefsWriteFailed(detail);
}
