// UI layer (U38 / settings): PURE draft→commit diff (no-op guard). Framework-free.
//
// On confirm, only the keys whose draft value DIFFERS from the baseline (the
// current committed value, taken from the SAME U16 source the dialog initialised
// from) are written. A confirm where nothing changed yields an EMPTY changed-key
// list, so no dirty-marking / notification / phantom history entry is produced
// (教訓 5.24 no-op ガード, 受け入れ基準 6). Single-run under Vitest (NFR 5.8).

import {
  type AppSettingKey,
  type AppSettings,
  type ProjectSettingKey,
  type ProjectSettings,
  APP_SETTING_KEYS,
  PROJECT_SETTING_KEYS,
  appSettingDirtiesProject,
} from '../state/settings';

/** Structural equality for a setting value (handles the customPalette array). */
function valueEquals(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i += 1) {
      if (a[i] !== b[i]) return false;
    }
    return true;
  }
  return false;
}

/**
 * The keys whose draft value differs from the baseline for PROJECT settings.
 * Empty ⇒ a no-op confirm (教訓 5.24). The order follows PROJECT_SETTING_KEYS so
 * the result is deterministic (single source of the key list, 教訓 5.19).
 */
export function changedProjectKeys(
  baseline: ProjectSettings,
  draft: ProjectSettings,
): readonly ProjectSettingKey[] {
  return PROJECT_SETTING_KEYS.filter((key) => !valueEquals(baseline[key], draft[key]));
}

/** The keys whose draft value differs from the baseline for APP settings. */
export function changedAppKeys(
  baseline: AppSettings,
  draft: AppSettings,
): readonly AppSettingKey[] {
  return APP_SETTING_KEYS.filter((key) => !valueEquals(baseline[key], draft[key]));
}

/** True iff NOTHING changed in the project draft (the no-op confirm predicate). */
export function isProjectNoOp(baseline: ProjectSettings, draft: ProjectSettings): boolean {
  return changedProjectKeys(baseline, draft).length === 0;
}

/** True iff NOTHING changed in the app draft (the no-op confirm predicate). */
export function isAppNoOp(baseline: AppSettings, draft: AppSettings): boolean {
  return changedAppKeys(baseline, draft).length === 0;
}

/**
 * True iff no DOCUMENT-AFFECTING app setting differs between baseline and draft —
 * i.e. the two are equal ignoring pure cosmetic / first-time-hint keys
 * (`showConflictGuide`, see {@link appSettingDirtiesProject}).
 *
 * This mirrors the dirty-marking exception in `updateAppSetting`: a cosmetic key
 * deliberately does NOT dirty the project, so the saved-baseline comparison the
 * undo/redo clean-check uses must ignore those same keys too. Comparing ALL keys
 * (via {@link isAppNoOp}) would falsely report the project as settings-dirty after
 * an undo merely because a non-dirtying cosmetic preference was toggled since save
 * (bughunt-review: undo-dirty false positive). Single-sourced through
 * `appSettingDirtiesProject` so the dirty basis stays singular (教訓 5.19).
 */
export function isDocumentAffectingAppNoOp(
  baseline: AppSettings,
  draft: AppSettings,
): boolean {
  return APP_SETTING_KEYS.filter(appSettingDirtiesProject).every((key) =>
    valueEquals(baseline[key], draft[key]),
  );
}
