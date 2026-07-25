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
