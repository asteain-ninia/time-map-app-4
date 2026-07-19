// UI layer (U38 / settings): the draft-state + validate + confirm/cancel hook.
//
// This is the調停層 (spec §目的): it holds the TRANSIENT draft (project + app
// settings) while the dialog is open, validates on confirm with the SAME pure
// functions a non-UI path would use (教訓 5.26), writes ONLY the changed keys
// through U16's per-scope update actions (no-op guard, 教訓 5.24), and discards the
// draft on EVERY exit path (教訓 5.2). It never mutates the committed store value
// until confirm succeeds (教訓 5.22).
//
// The committed values (baseline) and the update actions are INJECTED so this
// hook depends only on a small contract — it never reaches into the store shape
// itself, and a test can drive it with fakes (教訓 5.33 / 受け入れ基準 3). Project
// settings route through `updateProjectSetting` (dirty-marks the project document)
// and app settings through `updateAppSetting` (app-level persistence); the two
// save contexts are kept distinct (教訓 5.36 / 受け入れ基準 3).

import { useCallback, useState } from 'react';

import type {
  AppSettingKey,
  AppSettings,
  PaletteSelection,
  ProjectSettingKey,
  ProjectSettings,
} from '../state/settings';
import { isPaletteSettingKey } from '../state/settings';

import { changedAppKeys, changedProjectKeys } from './diff';
import {
  type SettingsValidationError,
  validateAppSettings,
  validateProjectSettings,
} from './validation';

// --- The injected store contract (the layer-crossing契約, 教訓 5.33) ----------

/**
 * The slice of U16's store this hook needs. The host binds these to the live
 * store's current values + actions; the hook never inspects the store directly,
 * so it is testable with fakes and the project/app save contexts stay distinct
 * (教訓 5.36).
 */
export interface SettingsStorePort {
  /** Current committed PROJECT settings (the baseline; same source as init). */
  readonly projectSettings: ProjectSettings;
  /** Current committed APP settings (the baseline). */
  readonly appSettings: AppSettings;
  /** U16: write ONE project setting (dirty-marks the project, notifies, 教訓 5.35). */
  updateProjectSetting<K extends ProjectSettingKey>(key: K, value: ProjectSettings[K]): void;
  /**
   * U16: write BOTH timeline-range bounds atomically (finding bughunt2). The
   * confirm path uses this — never two `updateProjectSetting` calls — for the
   * timeline keys, because the per-key path derives the range after EACH single
   * write and a forward range shift ([0,10000]→[20000,30000]) passes through a
   * transient inverted {newMin, oldMax} that throws. One transaction over the
   * validated (min < max) pair removes that intermediate inversion.
   */
  setProjectTimelineRangeYears(minYear: number, maxYear: number): void;
  /** U16: write ONE app setting (app-level persistence, notifies, 教訓 5.35). */
  updateAppSetting<K extends AppSettingKey>(key: K, value: AppSettings[K]): void;
  /**
   * FR-109 follow-up (ユーザー裁定): commit the default-palette change
   * (defaultPaletteTheme / customPalette) as ONE UNDOABLE command that also drives an
   * immediate auto-recolor, INSTEAD of the plain non-undoable `updateProjectSetting`
   * write. The two palette fields feed the recolor engine's palette source
   * (root.uiSettings.project) — a per-key store write never reaches it, so it would not
   * re-colour. The composition root wires this to App's recordCommand funnel (structure
   * + auto-recolor as one undo unit). OPTIONAL: when the seam is ABSENT (a unit test /
   * host that does not exercise undo) the confirm path falls back to per-key
   * updateProjectSetting for the palette, preserving the pre-existing behaviour.
   */
  commitPaletteChange?(palette: PaletteSelection): void;
}

// --- Confirm outcome (テスト可能な戻り値, 教訓 5.26) --------------------------

export const CONFIRM_STATUS = {
  /** Changed keys were written (or it was a clean no-op with no errors). */
  Applied: 'applied',
  /** Nothing changed; no write, no dirty-mark, no notification (教訓 5.24). */
  NoOp: 'noop',
  /** Validation rejected the draft; the committed value is untouched (教訓 5.22). */
  Rejected: 'rejected',
} as const;

export type ConfirmStatus = (typeof CONFIRM_STATUS)[keyof typeof CONFIRM_STATUS];

export interface ConfirmResult {
  readonly status: ConfirmStatus;
  /** The project keys that were written (deterministic order). */
  readonly changedProject: readonly ProjectSettingKey[];
  /** The app keys that were written. */
  readonly changedApp: readonly AppSettingKey[];
  /** The Japanese rejection reasons when status === Rejected (FR-115). */
  readonly errors: readonly SettingsValidationError[];
}

// --- Hook state + actions ----------------------------------------------------

export interface SettingsDialogState {
  readonly projectDraft: ProjectSettings;
  readonly appDraft: AppSettings;
  /**
   * The rejection errors from the LAST failed confirm. Cleared ONLY by a
   * successful confirm, an explicit cancel, or a re-confirm — NOT by unrelated
   * field edits (教訓 5.12: judgement messages survive unrelated interactions).
   */
  readonly errors: readonly SettingsValidationError[];
}

export interface SettingsDialogActions {
  /** Update one PROJECT draft field (does NOT touch the committed store, 教訓 5.22). */
  setProjectField<K extends ProjectSettingKey>(key: K, value: ProjectSettings[K]): void;
  /** Update one APP draft field. */
  setAppField<K extends AppSettingKey>(key: K, value: AppSettings[K]): void;
  /**
   * Validate the draft and, on success, write ONLY the changed keys through the
   * per-scope U16 actions (no-op guard, 教訓 5.24). Returns the outcome so a
   * non-UI caller / test can observe it (教訓 5.26).
   */
  confirm(): ConfirmResult;
  /** Discard the draft: reset to baseline + clear errors (教訓 5.2 全経路で破棄). */
  cancel(): void;
}

export type UseSettingsDialog = SettingsDialogState & SettingsDialogActions;

/**
 * The settings-dialog hook. Initialises the draft FROM the injected committed
 * values (same source as the baseline used for the no-op diff, 教訓 5.24). The
 * caller re-mounts (or keys) the hook when the dialog opens so the draft is fresh
 * each time (教訓 5.2: a stale draft never leaks across opens).
 */
export function useSettingsDialog(store: SettingsStorePort): UseSettingsDialog {
  const [projectDraft, setProjectDraft] = useState<ProjectSettings>(store.projectSettings);
  const [appDraft, setAppDraft] = useState<AppSettings>(store.appSettings);
  const [errors, setErrors] = useState<readonly SettingsValidationError[]>([]);

  const setProjectField = useCallback(
    <K extends ProjectSettingKey>(key: K, value: ProjectSettings[K]) => {
      // Draft-only write (教訓 5.22). Errors are NOT cleared here (教訓 5.12).
      setProjectDraft((d) => ({ ...d, [key]: value }));
    },
    [],
  );

  const setAppField = useCallback(
    <K extends AppSettingKey>(key: K, value: AppSettings[K]) => {
      setAppDraft((d) => ({ ...d, [key]: value }));
    },
    [],
  );

  const confirm = useCallback((): ConfirmResult => {
    // Re-validate at the confirm entry with the SAME pure functions (教訓 5.26).
    const projectV = validateProjectSettings(projectDraft);
    const appV = validateAppSettings(appDraft);
    if (!projectV.ok || !appV.ok) {
      const all = [
        ...(projectV.ok ? [] : projectV.errors),
        ...(appV.ok ? [] : appV.errors),
      ];
      setErrors(all); // Replaces the previous reason on re-confirm (教訓 5.12).
      return { status: CONFIRM_STATUS.Rejected, changedProject: [], changedApp: [], errors: all };
    }

    // No-op guard: only write keys that actually changed (教訓 5.24). Baseline is
    // the SAME committed source the draft initialised from (教訓 5.24).
    const changedProject = changedProjectKeys(store.projectSettings, projectV.value);
    const changedApp = changedAppKeys(store.appSettings, appV.value);

    // finding bughunt2: the two timeline bounds MUST be written in ONE transaction.
    // Writing them one-by-one (the generic per-key path) derives the timeline state
    // after each single write, so a forward range shift ([0,10000]→[20000,30000])
    // first commits {min:20000, max:10000(old)} — an inverted range that throws in
    // deriveTimelineState — escaping the click handler with the other keys partially
    // applied. So we route the timeline keys through the atomic
    // setProjectTimelineRangeYears and write only the NON-timeline changed keys per
    // key. The whole draft is already validated above (min < max), so the pair is
    // safe. `changedProject` (the returned order) is unchanged for observability.
    const timelineChanged = changedProject.some(isTimelineKey);
    // FR-109 follow-up (ユーザー裁定): the two palette keys are routed to the UNDOABLE
    // commitPaletteChange command (which also auto-recolors) — the SAME atomic-branch
    // shape the timeline pair uses — INSTEAD of the per-key updateProjectSetting write,
    // because the palette feeds the recolor engine's root.uiSettings source (a store
    // write never reaches it). `changedProject` (the returned observability list) still
    // lists the palette keys, exactly like the timeline keys. When the seam is absent
    // (a host/test that does not exercise undo) they fall through to the per-key path.
    const commitPaletteChange = store.commitPaletteChange;
    const routePaletteAsCommand =
      commitPaletteChange !== undefined && changedProject.some(isPaletteSettingKey);
    for (const key of changedProject) {
      if (isTimelineKey(key)) continue; // handled atomically below
      if (routePaletteAsCommand && isPaletteSettingKey(key)) continue; // one undoable command below
      // Per-scope routing: project settings dirty-mark the document (教訓 5.36).
      writeProject(store, projectV.value, key);
    }
    if (timelineChanged) {
      store.setProjectTimelineRangeYears(
        projectV.value.timelineMinYear,
        projectV.value.timelineMaxYear,
      );
    }
    if (routePaletteAsCommand) {
      commitPaletteChange({
        defaultPaletteTheme: projectV.value.defaultPaletteTheme,
        customPalette: projectV.value.customPalette,
      });
    }
    for (const key of changedApp) {
      writeApp(store, appV.value, key);
    }

    setErrors([]); // A successful confirm clears the reason (教訓 5.12).
    const status =
      changedProject.length === 0 && changedApp.length === 0
        ? CONFIRM_STATUS.NoOp
        : CONFIRM_STATUS.Applied;
    return { status, changedProject, changedApp, errors: [] };
  }, [projectDraft, appDraft, store]);

  const cancel = useCallback(() => {
    // Discard the transient draft on the cancel path (教訓 5.2). Re-seed from the
    // committed baseline; clear the rejection reason (explicit close契機, 教訓 5.12).
    setProjectDraft(store.projectSettings);
    setAppDraft(store.appSettings);
    setErrors([]);
  }, [store]);

  return { projectDraft, appDraft, errors, setProjectField, setAppField, confirm, cancel };
}

/** The two timeline-range bound keys, written atomically (finding bughunt2). */
function isTimelineKey(key: ProjectSettingKey): boolean {
  return key === 'timelineMinYear' || key === 'timelineMaxYear';
}

// --- Type-preserving single-key writers (avoid an unsafe cast) ----------------

function writeProject<K extends ProjectSettingKey>(
  store: SettingsStorePort,
  value: ProjectSettings,
  key: K,
): void {
  store.updateProjectSetting(key, value[key]);
}

function writeApp<K extends AppSettingKey>(
  store: SettingsStorePort,
  value: AppSettings,
  key: K,
): void {
  store.updateAppSetting(key, value[key]);
}
