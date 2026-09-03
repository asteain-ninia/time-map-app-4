// UI layer (U39): the SAVE CONTEXT — the session-level file-operation state that
// a destructive operation must initialise as ONE unit (教訓 5.36 / FR-03 / FR-107).
//
// 教訓 5.36 適用 (spec §D): a new project (and a freshly LOADED project) must
// initialise NOT just the displayed domain data but, AS THE SAME save context,
// also: the save-target path, the project metadata, the backup target, the dirty
// flag, and the exit-confirmation guard. This module owns that bundle as ONE
// immutable value built ONCE (`buildNewProjectContext` / `contextForLoadedFile`),
// so a path can never be「表示だけ差し替えて保存先や dirty を取り残す」(受け入れ基準 4).
//
// This is pure & framework-free (受け入れ基準 7): the React shell holds an instance
// and swaps it wholesale; the bundle and its builders are unit-testable with no
// Electron. The DISPLAYED domain truth is owned elsewhere (domain/persistence);
// this module carries only the file-operation session state around it.

import { PRESET_BASEMAP_ID, FULL_WORLD_META } from '../../domain/basemap/preset';
import { createGeoParams } from '../../domain/geo/geo-params';
import type { DomainProject, ProjectSettings } from '../../domain/persistence/index';
import { DEFAULT_APP_SETTINGS, DEFAULT_PROJECT_SETTINGS } from '../state/settings';
import { toPersistedUiSettings } from './ui-settings-bridge';

/**
 * Project-level metadata that is part of the save context (spec §D メタdata). Kept
 * minimal here (name / description); richer metadata lives in the persisted
 * manifest. Re-initialised together with the rest of the context on new-project.
 */
export interface ProjectMetadata {
  readonly name: string;
  readonly description: string;
}

/** Empty metadata for a brand-new, never-named project. */
export const EMPTY_PROJECT_METADATA: ProjectMetadata = {
  name: '',
  description: '',
};

/**
 * The complete file-operation save context (spec §D). Built as ONE value so every
 * destructive transition (new / load) replaces ALL of it atomically:
 *   - `savePath`: the current save-target absolute path, or null when undetermined
 *     (新規プロジェクトで一度も保存していない). A null path routes 保存 → 名前を付けて保存.
 *   - `metadata`: project name / description.
 *   - `baseMapId`: the background base-map reference; a new project uses the preset
 *     出界図 (FR-03). A loaded project carries the file's reference.
 *   - `backupTarget`: the generation-backup target (= the save path). A new project
 *     has no backup series yet, so it does NOT inherit the previous project's
 *     series (spec §D バックアップ対象). Mirrors `savePath`.
 *   - `dirty`: unsaved-changes flag. A new project / a fresh load is CLEAN (the
 *     init / load is the save baseline, spec §D dirty / 教訓 5.24).
 *   - `exitGuardEnabled`: the exit-confirmation guard is armed for this context
 *     (spec §D 終了確認ガード). Always true so a later edit's dirty state is guarded.
 */
export interface SaveContext {
  readonly savePath: string | null;
  readonly metadata: ProjectMetadata;
  readonly baseMapId: string;
  readonly backupTarget: string | null;
  readonly dirty: boolean;
  readonly exitGuardEnabled: boolean;
}

/**
 * Build the save context for a NEW project (spec §D / 教訓 5.36). Initialises ALL
 * fields together: empty path (→ 名前を付けて保存 on first save), empty metadata,
 * the PRESET 出界図 background (FR-03), no backup series, CLEAN dirty, and an armed
 * exit guard. Returns a fresh value each call (no shared mutable default).
 *
 * The displayed DOMAIN state (地物 0 件の空プロジェクト) is initialised by the
 * caller against the domain/persistence empty-project factory and committed in the
 * SAME transition as this context (受け入れ基準 4: 同時初期化), so neither half is
 * left stale.
 */
/**
 * ホストへ上げる「保存の素性」（設計書 §H.6 / V12）。ウィンドウタイトルと状態行が読む。
 *
 * `savePath` は SaveContext と同じ値の写しで、`savedAtMs` は **セッションの事実** である
 * （文書の属性ではないので SaveContext には入れない）。プロジェクトを開き直すと null に戻る
 * ——「このセッションでまだ一度も保存していない」を「未保存」と出すため。
 */
export interface SaveStatus {
  /** いまの保存先の絶対パス。null = 保存先が決まっていない新規。 */
  readonly savePath: string | null;
  /** 最後に保存できた時刻（epoch ms）。null = このセッションでまだ保存していない。 */
  readonly savedAtMs: number | null;
  /**
   * 自動保存が本体ファイルへ書ける状態か（A4-a）。false のときは
   * 「保存先が未確定」か「その保存先への上書きを利用者がまだ確認していない」ので、
   * 自動保存はティックのたびに**黙って何もしない**。それを黙ったままにすると
   * 「5 分ごとに保存されているはず」という誤解のまま作業が進むので、状態行の
   * 最終保存の枠に静かに出す（設計書 §H.5: 状態は常設の場所に出す）。
   */
  readonly autoSaveArmed: boolean;
}

/**
 * 上書き確認から戻ってきたときに、**本当にその先へ書いてよいか**を決める（A2）。
 *
 * 確認ダイアログを出している間にプロジェクトが差し替わりうる（読み込み・新規・
 * ドラッグ＆ドロップ）。**確認したファイルと実際に書かれるファイルが入れ替わる**のが
 * 増分 1 の検証で見つかった唯一の「致命」だった。だから確認を出した時点の保存先と
 * 保存文脈の世代を控えておき、戻ってきたときに突き合わせる。世代が動いていなければ
 * 何も起きていないので素通し、動いていたら**保存先が同じときだけ**書く。
 */
export const SAVE_AFTER_CONFIRM = {
  /** そのまま保存してよい。 */
  Save: 'save',
  /** 利用者がやめた。 */
  Cancel: 'cancel',
  /** 確認の間に保存先が変わった。書かずに中止する。 */
  DestinationChanged: 'destination-changed',
} as const;

export type SaveAfterConfirm = (typeof SAVE_AFTER_CONFIRM)[keyof typeof SAVE_AFTER_CONFIRM];

export function decideSaveAfterConfirm(input: {
  /** 利用者が「上書き保存する」を押したか。 */
  readonly confirmed: boolean;
  /** 確認を出したときの保存先。 */
  readonly pathAtPrompt: string;
  /** 確認を出したときの保存文脈の世代番号。 */
  readonly generationAtPrompt: number;
  /** いまの保存先。 */
  readonly pathNow: string | null;
  /** いまの保存文脈の世代番号。 */
  readonly generationNow: number;
}): SaveAfterConfirm {
  if (!input.confirmed) return SAVE_AFTER_CONFIRM.Cancel;
  // 世代が動いていない = 保存文脈は 1 度も差し替わっていない（＝同じファイル）。
  if (input.generationNow === input.generationAtPrompt) return SAVE_AFTER_CONFIRM.Save;
  // 世代が動いた。行き先が同じなら書いてよい（保存の完了で世代だけが進む経路がある）。
  return input.pathNow === input.pathAtPrompt
    ? SAVE_AFTER_CONFIRM.Save
    : SAVE_AFTER_CONFIRM.DestinationChanged;
}

export function buildNewProjectContext(): SaveContext {
  return {
    savePath: null,
    metadata: EMPTY_PROJECT_METADATA,
    // FR-03: a new project shows the preset 出界図 as its background.
    baseMapId: PRESET_BASEMAP_ID,
    backupTarget: null,
    // 新規初期化を保存基点とみなす (clean, 教訓 5.24 baseline 一致).
    dirty: false,
    exitGuardEnabled: true,
  };
}

/**
 * Build the save context for a successfully LOADED file (spec §D 同じ保存文脈). The
 * load establishes a new save baseline: the load path becomes the save path AND
 * the backup target, metadata + base-map come from the file, and the project is
 * CLEAN (the load is the baseline, not a change). The exit guard stays armed.
 */
export function contextForLoadedFile(args: {
  readonly path: string;
  readonly metadata: ProjectMetadata;
  readonly baseMapId: string;
}): SaveContext {
  return {
    savePath: args.path,
    metadata: args.metadata,
    baseMapId: args.baseMapId,
    backupTarget: args.path,
    dirty: false,
    exitGuardEnabled: true,
  };
}

/**
 * Apply a successful SAVE to a context (spec §A 保存後): adopt the (possibly new,
 * from 名前を付けて保存) path as the save path AND backup target, and clear dirty
 * (the save is the new baseline, 教訓 5.24). Returns a new value (immutable).
 */
export function contextAfterSave(context: SaveContext, savedPath: string): SaveContext {
  return {
    ...context,
    savePath: savedPath,
    backupTarget: savedPath,
    dirty: false,
  };
}

/** Mark a context dirty after a domain change. Idempotent; returns a new value. */
export function markDirty(context: SaveContext): SaveContext {
  return context.dirty ? context : { ...context, dirty: true };
}

/**
 * Clear the SAVE TARGET from a context so the next 保存 routes to 名前を付けて保存
 * (HIGH-2 fail-safe). Used when the renderer already adopted a loaded file's path but
 * main's `currentPath` was NOT actually promoted onto it (the load-commit IPC failed):
 * a plain 保存 would then atomic-write THIS project's content to the PREVIOUS file's path.
 * Nulling `savePath` (and its mirror `backupTarget`) makes {@link needsSaveAs} true, so
 * main is asked for a fresh destination instead of silently targeting the wrong file. The
 * rest of the context (metadata / baseMapId / dirty / exit guard) is untouched — only the
 * destination is retracted. Returns a new value (immutable).
 */
export function contextWithoutSaveTarget(context: SaveContext): SaveContext {
  return { ...context, savePath: null, backupTarget: null };
}

/**
 * Whether a 保存 must route to 名前を付けて保存 (spec §A): true when the save path is
 * undetermined (a new project that has never been saved). Single decision the save
 * command consults so both the menu 保存 and the guard's 保存 branch agree (教訓 5.30).
 */
export function needsSaveAs(context: SaveContext): boolean {
  return context.savePath === null;
}

/** Default project settings for a brand-new empty project (FR-03 / spec §D). */
const NEW_PROJECT_SETTINGS: ProjectSettings = {
  calendarId: 'gregorian',
  geo: createGeoParams(40000, 0.0034),
  gridSpacingDeg: 10,
  snapDistancePx: 50,
  autoColorDefault: true,
};

/**
 * Build the empty DOMAIN project for a new project (spec §D / FR-03): 地物 0 件,
 * the preset 出界図 background, and default settings. Committed in the SAME
 * transition as {@link buildNewProjectContext} so the displayed data and the save
 * context are never left half-initialised (受け入れ基準 4: 同時初期化). A fresh
 * value each call (no shared mutable default).
 */
export function buildEmptyProject(): DomainProject {
  return {
    histories: [],
    settings: NEW_PROJECT_SETTINGS,
    baseMap: { source: PRESET_BASEMAP_ID, meta: FULL_WORLD_META },
    // A new project starts at the DEFAULT UI settings (FR-109 / FR-110 既定値). Folding
    // them in here means a new project SERIALIZES its settings (a save right after 新規
    // round-trips the defaults) AND the new-project path can hydrate the store from a
    // single source — the same defaults the store itself initialises with (単一の真実源).
    uiSettings: toPersistedUiSettings({
      projectSettings: DEFAULT_PROJECT_SETTINGS,
      appSettings: DEFAULT_APP_SETTINGS,
    }),
  };
}
