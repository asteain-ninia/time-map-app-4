// U40 — pure pointer-input DISPATCH discipline for the central map (FR-09).
//
// This module is the single decision authority for "given the current mode, the
// pressed pointer button, and what the pointer hit, where does this interaction
// go?" — pan / selection-or-edit delegation / add delegation / context-menu
// delegation / ignore. It is a PURE module (no DOM, no store, no Canvas): the
// imperative controller (PointerDispatcher) normalizes raw events and feeds them
// here, then routes the returned destination to the right dependency
// (U17 camera, U22 selection, U20 add/context-menu). Keeping the decision pure
// lets the full モード × ボタン × ヒット対象 matrix be exhaustively unit-tested in
// plain Node (NFR 5.8, 受け入れ基準 3 / 7).
//
// 教訓 5.9「排他分岐が重要処理をスキップしていないか確認する」(引用:「排他的な
// 条件分岐が、他の重要な処理をスキップさせていないか確認する。選択優先順位と、
// 同時選択/排他選択を明確に定義する。」)。適用: the destination is decided ONCE
// here from the (mode, button, hit) COMBINATION — never re-decided downstream and
// never by display strings — so the middle-button pan branch can never swallow
// the left-button selection / add start or the release-time teardown
// (受け入れ基準 3). Conditions are covered as a combination matrix, not as
// mutually-exclusive shortcuts.
//
// 教訓 5.19「分岐識別子は型定義・定数・ファクトリを経由する」。適用: pointer
// buttons and destinations are CONSTANTS (PointerButton / DISPATCH_TARGET), and
// the mode → pan-button table (PAN_BUTTONS) is the SINGLE source the pan割当 reads
// from, so a button/mode/destination value is never a bare literal anywhere
// (受け入れ基準 1).

import { EDIT_MODE, type EditMode } from '../state/session';
import { HIT_KIND, type HitResult } from '../../domain/selection';

// --- Pointer buttons (the normalized button identity) ------------------------
//
// Browsers expose two button encodings on a PointerEvent: `button` (which button
// changed state on this event, used by down/up) and `buttons` (the bitmask of
// buttons currently held, used by move). We classify ONLY the three buttons the
// dispatch cares about; everything else is `Other` and never starts pan/select.

export const POINTER_BUTTON = {
  /** Primary (left) button. */
  Left: 'left',
  /** Auxiliary (middle / wheel) button. */
  Middle: 'middle',
  /** Secondary (right) button → context-menu request. */
  Right: 'right',
  /** Any other button (back/forward/eraser…): never starts pan or selection. */
  Other: 'other',
} as const;

export type PointerButton = (typeof POINTER_BUTTON)[keyof typeof POINTER_BUTTON];

/**
 * Classify a DOM `PointerEvent.button` value (0 = left, 1 = middle, 2 = right)
 * into a {@link PointerButton}. Routed through this factory so no caller compares
 * the raw numeric code (教訓 5.19). Unknown codes map to `Other`.
 */
export function pointerButtonFromCode(code: number): PointerButton {
  switch (code) {
    case 0:
      return POINTER_BUTTON.Left;
    case 1:
      return POINTER_BUTTON.Middle;
    case 2:
      return POINTER_BUTTON.Right;
    default:
      return POINTER_BUTTON.Other;
  }
}

// --- Mode → pan-button table (THE single source of pan割当, FR-09) -----------
//
// 受け入れ基準 1: モード×ボタンのパン割当 is derived from ONE table. Every pan
// decision (and any future query of "does this button pan in this mode") reads
// from PAN_BUTTONS — there is no second copy of the rule.
//
//   - View mode: LEFT or MIDDLE drag pans (editing is wholesale-disabled by U20,
//     so a left-button pan cannot collide with selection/edit — 受け入れ基準 5).
//   - Add mode:  MIDDLE only (left is the point-placement / add operation).
//   - Edit mode: MIDDLE only (left is selection / vertex-drag / rubber-band,
//     driven by U22). Limiting pan to middle structurally guarantees a single
//     pointerdown can never start both pan AND selection (受け入れ基準 5).
const PAN_BUTTONS: Readonly<Record<EditMode, ReadonlySet<PointerButton>>> = {
  [EDIT_MODE.View]: new Set([POINTER_BUTTON.Left, POINTER_BUTTON.Middle]),
  [EDIT_MODE.Add]: new Set([POINTER_BUTTON.Middle]),
  [EDIT_MODE.Edit]: new Set([POINTER_BUTTON.Middle]),
};

/**
 * Whether the given button starts a pan in the given mode, read from the single
 * {@link PAN_BUTTONS} table (受け入れ基準 1). This is the ONLY pan割当 query; the
 * dispatcher and any test use it rather than re-encoding the per-mode rule.
 */
export function panStartsFor(mode: EditMode, button: PointerButton): boolean {
  return PAN_BUTTONS[mode].has(button);
}

// --- Dispatch destinations (the single行き先 vocabulary) ---------------------

export const DISPATCH_TARGET = {
  /** Start a camera pan (this unit owns the pan sequence). */
  Pan: 'pan',
  /** Delegate to U22 selection / vertex-drag / rubber-band (edit mode, left). */
  SelectEdit: 'selectEdit',
  /** Delegate to the add-feature operation (add mode, left). */
  Add: 'add',
  /** Delegate to U20's context-menu mechanism (right button, all modes). */
  ContextMenu: 'contextMenu',
  /** Do nothing (e.g. an unhandled button). */
  Ignore: 'ignore',
} as const;

export type DispatchTarget =
  (typeof DISPATCH_TARGET)[keyof typeof DISPATCH_TARGET];

/**
 * The full input a dispatch decision needs: the current mode (read from U20), the
 * pressed button, and the hit-test result (from U17/U22). The hit対象 is carried
 * so a left-button decision in edit mode can branch on feature-body / vertex /
 * empty downstream — though the destination here is the SAME (SelectEdit): U22
 * decides the precise selection action from the hit, this unit only routes there
 * (教訓 5.30 過剰共有の戒め: it does not re-decide U22's internal priority).
 */
export interface DispatchInput {
  readonly mode: EditMode;
  readonly button: PointerButton;
  readonly hit: HitResult;
}

/**
 * THE single decision function (受け入れ基準 3): map (mode × button × hit) to one
 * destination. A press is routed to exactly ONE place; the same pointerdown never
 * flows to both pan and selection (受け入れ基準 5). The rules:
 *
 *   - Right button → ContextMenu in every mode (never pan).
 *   - A button in the mode's PAN_BUTTONS set → Pan.
 *   - Otherwise the LEFT button routes per mode: Add mode → Add, Edit mode →
 *     SelectEdit. (In View mode left is already a pan button above, so it never
 *     reaches here; View has no select/add destination — editing is disabled.)
 *   - Anything else → Ignore.
 *
 * Pan割当 is read from {@link panStartsFor} so this function never re-encodes the
 * mode×button table (single truth, 受け入れ基準 1). The `hit` is part of the input
 * (and exhaustively varied in tests) even though it does not change the
 * destination today — it is the contract U22 consumes after delegation, and
 * keeping it in the signature fixes the layer-crossing data shape (教訓 5.34).
 */
export function decideDispatch(input: DispatchInput): DispatchTarget {
  const { mode, button } = input;

  // Right button is always a context-menu request, never a pan (受け入れ基準 3).
  if (button === POINTER_BUTTON.Right) {
    return DISPATCH_TARGET.ContextMenu;
  }

  // Pan割当 from the single table (受け入れ基準 1). This is checked BEFORE the
  // left-button select/add routing so View-mode left correctly pans.
  if (panStartsFor(mode, button)) {
    return DISPATCH_TARGET.Pan;
  }

  // Remaining left-button handling is mode-specific and NOT collapsed together
  // (教訓 5.30 過剰共有の戒め: add-mode left ≠ edit-mode left).
  if (button === POINTER_BUTTON.Left) {
    if (mode === EDIT_MODE.Add) return DISPATCH_TARGET.Add;
    if (mode === EDIT_MODE.Edit) return DISPATCH_TARGET.SelectEdit;
  }

  return DISPATCH_TARGET.Ignore;
}

// --- Drag threshold (the single クリック/ドラッグ judgement, 教訓 5.8) --------

/**
 * The shared drag threshold in CSS pixels. A press→release whose total screen
 * movement is BELOW this is a click (移動なし); AT OR ABOVE it is a drag. Pan,
 * selection and rubber-band all share this one judgement (受け入れ基準 4,
 * 教訓 5.30 過少共有の戒め: one threshold, not three). 4px is a conventional,
 * pointer-agnostic default that distinguishes an intentional drag from hand
 * jitter on a click.
 */
export const DRAG_THRESHOLD_PX = 4;

/**
 * Squared distance between two screen points. Compared against the squared
 * threshold to avoid a `Math.sqrt` on every move sample (it is called on the hot
 * pointermove path). Pure.
 */
export function screenDistanceSq(
  ax: number,
  ay: number,
  bx: number,
  by: number,
): number {
  const dx = ax - bx;
  const dy = ay - by;
  return dx * dx + dy * dy;
}

/**
 * Whether the movement from the press origin (`ox`,`oy`) to the current point
 * (`x`,`y`) has reached the drag threshold. Uses the squared comparison so it is
 * allocation- and sqrt-free. A non-finite coordinate yields `false` (病的入力の
 * 安全性: a bad sample never spuriously promotes a click to a drag).
 */
export function exceedsDragThreshold(
  ox: number,
  oy: number,
  x: number,
  y: number,
  thresholdPx: number = DRAG_THRESHOLD_PX,
): boolean {
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(ox) || !Number.isFinite(oy)) {
    return false;
  }
  return screenDistanceSq(ox, oy, x, y) >= thresholdPx * thresholdPx;
}

/** Re-export so callers building a vertex-hit decision use the same kind constants. */
export { HIT_KIND };
export type { HitResult, EditMode };
