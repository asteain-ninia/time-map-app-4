// UI layer (U39): the unsaved-changes guard for destructive operations (FR-107).
//
// One guard, three contexts (spec §B): new-file load, app quit, and new-project
// start ALL pass through {@link decideUnsavedGuard} / {@link runUnsavedGuard}.
// 教訓 5.6 適用: the guard fires on the RESULT STATE「dirty かつ破壊的に状態を置き
// 換える操作」, never per-entry-path. The three callers (and the load entry's
// menu / shortcut / D&D sub-paths) funnel through the SAME guard, so no path can
// silently skip the warning (受け入れ基準 2 / 注意点「経路ごとに別ゲートを書かない」).
//
// TESTABILITY (受け入れ基準 7 / 教訓 5.41): the branch logic is split into a PURE
// decision ({@link decideUnsavedGuard}: dirty × 3-choice → next action) and a thin
// async runner ({@link runUnsavedGuard}) that calls injected ports (show dialog /
// save). The decision is unit-testable with no Electron / OS dialog; the runner is
// testable with mock ports. The OS dialog itself is the only un-unit-testable part
// (covered by E2E, spec §依存 U20 modal).

// --- the user's 3-choice (spec §B 3 択) -------------------------------------

/**
 * The user's response to the unsaved-changes warning (保存 / 保存せず続行 /
 * キャンセル). A constant vocabulary so callers branch on values, not literals
 * (教訓 5.19).
 */
export const UNSAVED_CHOICE = {
  /** 保存: save first, then continue ONLY if the save succeeds (spec §B). */
  Save: 'save',
  /** 保存せず続行: discard unsaved changes and continue. */
  Discard: 'discard',
  /** キャンセル: abort the operation, keep current state. */
  Cancel: 'cancel',
} as const;

export type UnsavedChoice = (typeof UNSAVED_CHOICE)[keyof typeof UNSAVED_CHOICE];

// --- the guard's decision (what the caller must do next) ---------------------

/**
 * What the destructive operation must do next, decided purely from the dirty flag
 * and (when dirty) the user's choice + the save outcome. `proceed` ⇒ run the
 * destructive operation; `abort` ⇒ keep current state (protect unsaved data).
 */
export const GUARD_ACTION = {
  /** Continue with the destructive operation. */
  Proceed: 'proceed',
  /** Stop; keep the current (possibly unsaved) state. */
  Abort: 'abort',
  /** dirty + 保存 chosen: the caller must save, then re-decide on the outcome. */
  SaveThenDecide: 'save-then-decide',
} as const;

export type GuardAction = (typeof GUARD_ACTION)[keyof typeof GUARD_ACTION];

/**
 * The PURE first-stage decision (受け入れ基準 7): given dirty and (optionally) the
 * user's choice, decide the next action WITHOUT performing any I/O.
 *   - not dirty                 → Proceed directly (no dialog, 受け入れ基準 2 末項).
 *   - dirty, choice undefined   → caller must show the dialog (returns Abort as a
 *                                  safe placeholder until a choice is supplied).
 *   - dirty + キャンセル         → Abort (keep current state).
 *   - dirty + 保存せず続行       → Proceed (discard).
 *   - dirty + 保存              → SaveThenDecide (save, then re-decide on outcome).
 *
 * `dirty === false` short-circuits BEFORE the choice is consulted, so a clean
 * project never shows a dialog (教訓 5.18: dirty is the real gate, not a falsy
 * choice).
 */
export function decideUnsavedGuard(
  dirty: boolean,
  choice?: UnsavedChoice,
): GuardAction {
  if (!dirty) return GUARD_ACTION.Proceed;
  switch (choice) {
    case UNSAVED_CHOICE.Discard:
      return GUARD_ACTION.Proceed;
    case UNSAVED_CHOICE.Save:
      return GUARD_ACTION.SaveThenDecide;
    case UNSAVED_CHOICE.Cancel:
    case undefined:
      return GUARD_ACTION.Abort;
  }
}

/**
 * The PURE post-save decision (spec §B 「保存成功時のみ続行」, 注意点「保存失敗時の
 * 保護」): after the 保存 branch ran a save, continue ONLY if it succeeded. A
 * failed / cancelled save aborts the destructive operation so unsaved data is
 * never silently discarded (受け入れ基準 2).
 */
export function decideAfterSave(saveSucceeded: boolean): GuardAction {
  return saveSucceeded ? GUARD_ACTION.Proceed : GUARD_ACTION.Abort;
}

// --- the thin async runner (mockable ports, 教訓 5.41) ----------------------

/** Ports the runner calls; injected so the runner is testable without Electron. */
export interface UnsavedGuardPorts {
  /** Is the project currently dirty (unsaved)? Single basis (spec §B / 教訓 5.24). */
  readonly isDirty: () => boolean;
  /** Show the 3-choice warning dialog (U20 modal); resolves with the choice. */
  readonly promptUnsaved: () => Promise<UnsavedChoice>;
  /** Perform a save (保存/必要なら名前を付けて保存). Resolves true iff it succeeded. */
  readonly save: () => Promise<boolean>;
}

/**
 * Run the full guard for one destructive operation and resolve whether the caller
 * may proceed. EVERY destructive path (load / quit / new) awaits this single
 * function (教訓 5.6). It composes the pure decisions above with the injected
 * ports so the ONLY non-pure parts are the dialog + save calls.
 *
 *   not dirty            → true (no dialog).
 *   dirty → prompt:
 *     キャンセル          → false (keep state).
 *     保存せず続行        → true (discard).
 *     保存 → save:
 *       success          → true (continue).
 *       failure/cancel   → false (protect unsaved data, 注意点「保存失敗時の保護」).
 */
export async function runUnsavedGuard(ports: UnsavedGuardPorts): Promise<boolean> {
  if (decideUnsavedGuard(ports.isDirty()) === GUARD_ACTION.Proceed) {
    return true;
  }
  const choice = await ports.promptUnsaved();
  const action = decideUnsavedGuard(true, choice);
  if (action === GUARD_ACTION.Proceed) return true;
  if (action === GUARD_ACTION.Abort) return false;
  // SaveThenDecide: save, then continue ONLY on success.
  const saved = await ports.save();
  return decideAfterSave(saved) === GUARD_ACTION.Proceed;
}
