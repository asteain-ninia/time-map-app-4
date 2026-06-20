// U25 — the hole/enclave add DRAFT state machine (FR-22 / FR-78, 教訓 5.2 / 5.7 /
// 5.8 / 5.18).
//
// LAYER: pure, framework-free `domain` logic. The add interaction (start → first
// click auto-classifies hole vs enclave → place ≥3 vertices → confirm ring) is an
// EXPLICIT state machine so every transition AND every transient-discard path is
// testable in plain Node without React / Canvas / Zustand. The owning UI unit
// holds ONE instance in its session store and routes pointer / key events through
// these pure transitions; each returns a NEW value (immutable, 教訓 5.17).
//
// This is the SINGLE source of truth for the in-progress ring-add state: the
// target face id, the auto-classified {@link RingAddMode} (decided ON the first
// click, not before), the placed vertices, the cursor-follow preview point, and
// the grid-snap draft. Generation happens at start ONLY; discarding happens
// through the SINGLE {@link resetDraft} helper every exit path funnels through
// (開始・確定・キャンセル・ツール切替・モード切替・選択解除 — 教訓 5.2).
//
// 教訓 5.18: "0 placed vertices" is `[]` and "mode not yet decided" is an explicit
// `null`, never conflated with a falsy short-circuit; callers test `.length` and
// `=== null`.

import type { WorldCoordinate } from '../coordinate';
import type { FeatureId } from '../ids';
import { RING_ADD_MODE, type RingAddMode } from './auto-mode';

/** The minimum placed-vertex count a ring needs before it can confirm (FR-22). */
export const MIN_RING_VERTICES = 3;

/**
 * The complete in-progress ring-add draft. All transient fields live here as ONE
 * value so the single reset契約 drops them together (教訓 5.2):
 *   - `targetFeatureId`: the face whose shape is being edited (the active面情報),
 *   - `mode`: null until the first click classifies it, then Hole / Enclave (FR-22),
 *   - `vertices`: placed vertices in click order (教訓 5.18 empty = []),
 *   - `preview`: cursor-follow preview point, null until first hover,
 *   - `gridSnap`: the grid-snap on/off draft (FR-78).
 *
 * Created ONLY by {@link startDraft}; discarded ONLY by {@link resetDraft}.
 */
export interface RingAddDraft {
  readonly targetFeatureId: FeatureId;
  readonly mode: RingAddMode | null;
  readonly vertices: readonly WorldCoordinate[];
  readonly preview: WorldCoordinate | null;
  readonly gridSnap: boolean;
}

/**
 * Start a fresh ring-add draft for `targetFeatureId` (the selected face). The
 * mode is UNDECIDED (`null`) until the first click — the auto-classification (FR-22)
 * happens at {@link placeFirstVertex}, not here. `gridSnap` carries the current
 * toggle into the new draft so a user's grid choice persists across tool starts.
 * Returning a brand-new value IS the start-path discard of any prior draft (教訓
 * 5.2 (a)): the caller replaces its single draft slot.
 */
export function startDraft(targetFeatureId: FeatureId, gridSnap = false): RingAddDraft {
  return {
    targetFeatureId,
    mode: null,
    vertices: [],
    preview: null,
    gridSnap,
  };
}

/**
 * The single reset契約 (spec §一時 UI 状態の全経路破棄, 教訓 5.2). Returns `null` —
 * the absence of a draft — so EVERY discard path (キャンセル・確定後・ツール切替・
 * モード切替・選択解除) funnels through this one helper and the caller's draft slot
 * becomes `null`. There is no partial reset: vertices, mode, preview and grid
 * draft are dropped together.
 */
export function resetDraft(): null {
  return null;
}

/**
 * Place the FIRST vertex, classifying the mode from `mode` (computed by the caller
 * via {@link classifyFirstClick} against the target face's shape at the current
 * time). Valid only when the draft has no vertices yet; placing the first vertex
 * is the moment the hole/enclave decision is frozen (FR-22). Returns a new draft
 * carrying that mode and the single vertex.
 */
export function placeFirstVertex(
  draft: RingAddDraft,
  coordinate: WorldCoordinate,
  mode: RingAddMode,
): RingAddDraft {
  return { ...draft, mode, vertices: [coordinate] };
}

/**
 * Place a subsequent vertex (the 2nd click onward). Appends in click order. The
 * mode must already be decided (the first vertex set it); if it is somehow still
 * null this is treated as the first placement defaulting to enclave so no click is
 * dropped (教訓 5.7 完了/開始トリガーを欠かさない) — but the normal path is that
 * the caller routes the very first click through {@link placeFirstVertex}.
 */
export function placeVertex(draft: RingAddDraft, coordinate: WorldCoordinate): RingAddDraft {
  if (draft.vertices.length === 0) {
    return placeFirstVertex(draft, coordinate, draft.mode ?? RING_ADD_MODE.Enclave);
  }
  return { ...draft, vertices: [...draft.vertices, coordinate] };
}

/**
 * Update the cursor-follow preview point (the closing line is rendered from the
 * last placed vertex to this preview, and from the preview back to the first
 * vertex once ≥2 are placed). High-frequency; kept in the session store so the
 * Canvas subscribes and the React render path is not taken (技術方針 2.3 / 2.5).
 */
export function updatePreview(draft: RingAddDraft, coordinate: WorldCoordinate): RingAddDraft {
  return { ...draft, preview: coordinate };
}

/** Toggle the grid-snap draft on/off (FR-78). */
export function setGridSnap(draft: RingAddDraft, gridSnap: boolean): RingAddDraft {
  return { ...draft, gridSnap };
}

// --- Vertex undo (Ctrl+Z; FR-78) --------------------------------------------

/**
 * The result of an undo. Discriminated so the caller branches on a value (教訓
 * 5.19): with ≥1 vertex, the last one is removed; removing the last vertex leaves
 * the draft at 0 vertices and resets the mode to undecided (the next first click
 * re-classifies). An undo with 0 vertices does NOT silently no-op — it backs out
 * of the add entirely (`Cancelled`), so the caller runs {@link resetDraft}.
 */
export const UNDO_RESULT = {
  Removed: 'removed',
  Cancelled: 'cancelled',
} as const;

export type UndoResultKind = (typeof UNDO_RESULT)[keyof typeof UNDO_RESULT];

export type UndoResult =
  | { readonly kind: typeof UNDO_RESULT.Removed; readonly draft: RingAddDraft }
  | { readonly kind: typeof UNDO_RESULT.Cancelled };

/**
 * Undo the last placed vertex (FR-78 頂点 1 つずつの取消). Decided by length, never
 * a falsy check (教訓 5.18). When the removed vertex was the only one, the mode
 * reverts to `null` so the next first click re-classifies hole vs enclave — the
 * mode must never linger past a fully-cleared vertex list (教訓 5.2 趣旨).
 */
export function undoVertex(draft: RingAddDraft): UndoResult {
  if (draft.vertices.length === 0) {
    return { kind: UNDO_RESULT.Cancelled };
  }
  const vertices = draft.vertices.slice(0, -1);
  const next: RingAddDraft =
    vertices.length === 0
      ? { ...draft, vertices, mode: null }
      : { ...draft, vertices };
  return { kind: UNDO_RESULT.Removed, draft: next };
}

/**
 * Whether the draft has enough vertices to confirm a ring (FR-22 最低 3 点). Also
 * gates the render layer's closing line (only meaningful once a ring is closable).
 * Decided by length (教訓 5.18).
 */
export function canConfirm(draft: RingAddDraft): boolean {
  return draft.vertices.length >= MIN_RING_VERTICES;
}
