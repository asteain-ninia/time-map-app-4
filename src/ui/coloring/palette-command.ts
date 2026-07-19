// FR-109 follow-up (ユーザー裁定): a default-palette change is an UNDOABLE command.
//
// WHY THIS FILE EXISTS (integration honesty, 教訓 5.7「ロジックがあっても UI から呼ばれ
// ず機能しない」): the settings dialog's palette confirm used to write ONLY the U16
// store (store.projectSettings) via updateProjectSetting, but the auto-recolor engine's
// palette SOURCE is `root.uiSettings.project` (paletteFromRoot, recolor-binding.ts) —
// which is synced from the store ONLY on save/load. So a palette change alone never
// re-coloured the map (a known residual). This module turns a palette change into a
// whole-state-swap Command<DomainRoot> that writes the two palette fields INTO
// root.uiSettings.project, so when it flows through App's recordCommand funnel the
// SAME maybeComposeAutoRecolor that fires on split/merge sees a PaletteTransition and
// rides the auto-recolor in the SAME undo unit (Ctrl+Z reverts palette + colours
// together — the ruling). It writes NOTHING but the palette; every other
// uiSettings.project field is carried unchanged (the store stays the truth for those,
// and the save-time overlay re-writes them from the store).
//
// Pure & store-independent: the root, the new palette, and a `materialize` fallback
// (used only when the root carries no uiSettings) are passed in; the composition root
// supplies `materialize` = toPersistedUiSettings(current store settings).

import {
  createCompositeCommand,
  createCommandResult,
  defineCommandKind,
  type Command,
  type CommandOutcome,
  type CommandResult,
} from '../../domain/command/index';
import type { DomainProject, UiSettings } from '../../domain/persistence/index';
import type { PaletteSelection } from '../state/settings';

/** The concrete live root the command swaps (== recolor-binding's DomainRoot). */
export type DomainRoot = DomainProject;

const PALETTE_COMMIT_KIND = defineCommandKind('palette-change');

/** Value equality for two custom-palette arrays (positional hex compare). */
function paletteArraysEqual(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/** True when `project`'s two palette fields already equal `palette` (no-op guard). */
function paletteMatches(
  project: UiSettings['project'],
  palette: PaletteSelection,
): boolean {
  return (
    project.defaultPaletteTheme === palette.defaultPaletteTheme &&
    paletteArraysEqual(project.customPalette, palette.customPalette)
  );
}

/**
 * A whole-state-swap command for a palette change: execute/redo return the captured
 * `finalState`, undo restores the captured `baseline` (the domain root is immutable,
 * so this is a deterministic replay, 教訓 5.20). A palette change touches NO features
 * structurally, so the CommandResult is EMPTY — selection re-resolution is a no-op; the
 * auto-recolor that maybeComposeAutoRecolor composes on top carries the recoloured
 * features. Wrapped in a composite so it records as ONE indivisible undo unit,
 * consistent with every other commit (isCompositeCommand-friendly; FR-94).
 */
function makePaletteSwapCommand(baseline: DomainRoot, finalState: DomainRoot): Command<DomainRoot> {
  const empty: CommandResult = createCommandResult({});
  const swap: Command<DomainRoot> = {
    kind: PALETTE_COMMIT_KIND,
    label: 'palette',
    execute(state: DomainRoot): CommandOutcome<DomainRoot> {
      void state;
      return { state: finalState, result: empty };
    },
    undo(state: DomainRoot): CommandOutcome<DomainRoot> {
      void state;
      return { state: baseline, result: empty };
    },
    redo(state: DomainRoot): CommandOutcome<DomainRoot> {
      void state;
      return { state: finalState, result: empty };
    },
  };
  return createCompositeCommand('palette', [swap]);
}

/**
 * Build the undoable palette-change command, or `null` when the palette is unchanged
 * (the no-op guard — the caller must NOT record a phantom undo entry, 教訓 5.24).
 *
 * @param root         the live domain root the change applies to (its undo target).
 * @param palette      the new defaultPaletteTheme + customPalette (from the dialog draft).
 * @param materialize  a fresh full {@link UiSettings} to seed from when `root.uiSettings`
 *                     is ABSENT (a pre-`ui` manifest — new projects always carry it). The
 *                     composition root wires this to `toPersistedUiSettings(store settings)`
 *                     so the materialised block agrees with every other uiSettings field
 *                     (grid / zoom / label …); only the two palette fields are then
 *                     overwritten. When `root.uiSettings` is present it is used directly
 *                     and `materialize` is not called.
 *
 * The finalState is `{ ...root, uiSettings: { ...base, project: { ...base.project, +palette } } }`
 * — histories/settings/baseMap survive by identity, and every non-palette uiSettings
 * field is carried unchanged (the store remains their truth; the save-time overlay
 * re-writes them). The no-op guard compares the new palette against the CURRENT
 * effective palette (root.uiSettings when present, else the materialised fallback —
 * which equals the store's palette), so it agrees with the confirm-path no-op diff.
 */
export function createPaletteChangeCommand(
  root: DomainRoot,
  palette: PaletteSelection,
  materialize: () => UiSettings,
): Command<DomainRoot> | null {
  const base: UiSettings = root.uiSettings ?? materialize();
  if (paletteMatches(base.project, palette)) return null; // 教訓 5.24 no phantom entry

  // UNDO BASELINE (Codex F2): when the root ALREADY carries uiSettings, undo restores it
  // verbatim. When it does NOT (a pre-`ui` project), the undo target is the root with a
  // MATERIALISED uiSettings carrying the UNCHANGED (pre-change) palette — semantically
  // the same settings made explicit. Without this, undo would restore the uiSettings-less
  // root, the store mirror (readDomainPalette) would return undefined and SKIP, leaving
  // store.projectSettings on the NEW palette — so a save after undo persists the UNDONE
  // palette. Materialising the baseline makes undo reflect the OLD palette back into the
  // store (redo still restores the NEW palette via finalState).
  const baseline: DomainRoot =
    root.uiSettings === undefined ? { ...root, uiSettings: base } : root;

  const finalState: DomainRoot = {
    ...root,
    uiSettings: {
      ...base,
      project: {
        ...base.project,
        defaultPaletteTheme: palette.defaultPaletteTheme,
        customPalette: [...palette.customPalette],
      },
    },
  };
  return makePaletteSwapCommand(baseline, finalState);
}
