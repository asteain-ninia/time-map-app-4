// U23 — the add-session state machine (FR-76 / FR-77 / FR-78, 教訓 5.2 / 5.7 /
// 5.8 / 5.19).
//
// Pure, framework-free domain logic: the add interaction (start → click vertices
// → confirm shape → property form → save / cancel) is an EXPLICIT state machine
// so every transition AND every temporary-state discard path is testable in
// plain Node without React / Canvas / Zustand (spec §実装方針「層分離」). The
// owning UI unit (U23 ui) holds ONE instance of this state in its session store
// and routes pointer / key events through these pure transitions; the
// transitions return a NEW state (immutable, 教訓 5.17) and never mutate input.
//
// This module is the SINGLE source of truth for the in-progress add state (spec
// §一時 UI 状態の単一の真実源): the current tool kind, the placed vertices, the
// cursor-follow preview point, the grid-snap on/off draft, the (face-only)
// parent selection. Generation happens at start ONLY; discarding happens through
// the SINGLE `resetSession` helper that every exit path funnels through (開始・
// 確定・キャンセル・ツール切替・モード切替 — 教訓 5.2 全経路で破棄).
//
// 教訓 5.18 (empty is a true value): "0 placed vertices" is the empty array `[]`
// and "no parent selected" is an explicit discriminated value, never conflated
// with a falsy short-circuit. Callers test `vertices.length` / the parent kind.

import type { WorldCoordinate } from '../coordinate';
import type { FeatureId } from '../ids';

// --- Add-tool kind (型・定数・ファクトリ経由; 教訓 5.19) ----------------------

/**
 * The add-tool kind discriminant (FR-76). Branching on which shape is being
 * added always goes through this constant / the helpers below — never a bare
 * display string (教訓 5.19), so create / preview / confirm / save share one
 * value.
 */
export const ADD_TOOL_KIND = {
  /** Point feature: a single click confirms the shape (FR-18 / FR-76). */
  Point: 'point',
  /** Line feature: 2+ clicks then an explicit complete (FR-19 / FR-76). */
  Line: 'line',
  /** Face (leaf) feature: 3+ clicks then closing to the start (FR-20 / FR-76). */
  Face: 'face',
} as const;

export type AddToolKind = (typeof ADD_TOOL_KIND)[keyof typeof ADD_TOOL_KIND];

/** The minimum placed-vertex count each tool needs before it can confirm. */
export function minVerticesFor(kind: AddToolKind): number {
  switch (kind) {
    case ADD_TOOL_KIND.Point:
      return 1;
    case ADD_TOOL_KIND.Line:
      return 2;
    case ADD_TOOL_KIND.Face:
      return 3;
  }
}

// --- Parent selection (face only; FR-77 / FR-39, 教訓 5.18) ------------------

/**
 * The parent-selection draft for a face add (FR-77). Modeled as a discriminated
 * value so "no parent yet decided", "explicitly top-level (親なし)" and "a
 * chosen parent face" are three DISTINCT states (教訓 5.18): an unset selection
 * is NOT the same as the user explicitly choosing 親なし. The default before any
 * choice is `Unset`; the UI forces a choice or treats `Unset` as top-level at
 * save (documented at the proposal-assembly site).
 */
export const PARENT_SELECTION_KIND = {
  /** No choice made yet (the initial draft state). */
  Unset: 'unset',
  /** Explicit 親なし — record as top-level (最上位フラグ真, FR-39). */
  TopLevel: 'top-level',
  /** A chosen existing face as the new face's parent. */
  Parent: 'parent',
} as const;

export type ParentSelectionKind =
  (typeof PARENT_SELECTION_KIND)[keyof typeof PARENT_SELECTION_KIND];

export type ParentSelection =
  | { readonly kind: typeof PARENT_SELECTION_KIND.Unset }
  | { readonly kind: typeof PARENT_SELECTION_KIND.TopLevel }
  | { readonly kind: typeof PARENT_SELECTION_KIND.Parent; readonly parentId: FeatureId };

export const PARENT_UNSET: ParentSelection = { kind: PARENT_SELECTION_KIND.Unset };
export const PARENT_TOP_LEVEL: ParentSelection = { kind: PARENT_SELECTION_KIND.TopLevel };

/** Build a "chosen parent" selection (factory, never a bare literal — 教訓 5.19). */
export function parentSelection(parentId: FeatureId): ParentSelection {
  return { kind: PARENT_SELECTION_KIND.Parent, parentId };
}

// --- A placed vertex (with optional shared-vertex candidate; FR-30〜33) ------

/**
 * One vertex placed during the add. `coordinate` is the (possibly snapped) world
 * point. `sharedCandidateId` records, when the placement snapped onto an existing
 * vertex, that existing vertex's id so confirmation can mark this position a
 * shared-vertex candidate (FR-30〜33). The snap distance / candidate search is
 * delegated to U10/U24 (spec §やらないこと); this module only stores the result.
 */
export interface PlacedVertex {
  readonly coordinate: WorldCoordinate;
  /** The existing vertex this placement snapped onto, if any (FR-31 → FR-30共有). */
  readonly sharedCandidateId?: FeatureId | null;
}

/** Build a placed vertex (factory; only attaches the shared id when present). */
export function placedVertex(
  coordinate: WorldCoordinate,
  sharedCandidateId?: FeatureId | null,
): PlacedVertex {
  return sharedCandidateId == null
    ? { coordinate }
    : { coordinate, sharedCandidateId };
}

// --- The whole add session --------------------------------------------------

/**
 * The complete in-progress add state (spec §AddSession 相当). All transient
 * fields the spec enumerates live here as ONE value:
 *   - `tool`: the current add-tool kind (FR-76),
 *   - `vertices`: the placed vertices in click order (教訓 5.18 empty=[]) — point
 *     never exceeds 1,
 *   - `preview`: the cursor-follow preview point, null until the first hover,
 *   - `gridSnap`: the grid-snap on/off draft (FR-78),
 *   - `parent`: the face-only parent selection (FR-77); always {@link PARENT_UNSET}
 *     for point/line.
 *
 * The session is created ONLY by {@link startSession} and discarded ONLY by
 * {@link resetSession} (the single reset契約 every exit path runs — 教訓 5.2).
 */
export interface AddSession {
  readonly tool: AddToolKind;
  readonly vertices: readonly PlacedVertex[];
  readonly preview: WorldCoordinate | null;
  readonly gridSnap: boolean;
  readonly parent: ParentSelection;
}

/**
 * Start a fresh add session for `tool` (spec §セッション開始). Any prior session
 * is implicitly discarded because this returns a brand-new value — the caller
 * REPLACES its single session slot, which is the start-path discard (教訓 5.2 (a)).
 * `gridSnap` carries the current toggle preference (default off) into the new
 * session so a user's grid choice persists across tool starts; everything else
 * starts empty (no vertices, no preview, parent unset).
 */
export function startSession(tool: AddToolKind, gridSnap = false): AddSession {
  return {
    tool,
    vertices: [],
    preview: null,
    gridSnap,
    parent: PARENT_UNSET,
  };
}

/**
 * The single reset契約 (spec §一時状態の全経路破棄, 教訓 5.2). Returns `null` —
 * the absence of a session — so EVERY discard path (キャンセル・確定後・ツール
 * 切替・モード切替) funnels through this one helper and the caller's session slot
 * becomes `null`. There is no "partial reset": discarding the session drops the
 * vertices, preview, parent selection and grid draft together.
 */
export function resetSession(): null {
  return null;
}

// --- Vertex placement (click) -----------------------------------------------

/**
 * Place a vertex at `coordinate` (a confirming click; the input layer routes
 * drags to pan, 教訓 5.8). For a point tool the session holds AT MOST one vertex:
 * a second placement REPLACES the first (a point is a single position; clicking
 * again just relocates it before save). For line / face the vertex is appended in
 * click order. `sharedCandidateId` (optional) records a snap onto an existing
 * vertex (FR-30〜33). Placing also clears any stale preview at that position is
 * unnecessary — the preview is updated independently by {@link updatePreview}.
 */
export function placeVertex(
  session: AddSession,
  coordinate: WorldCoordinate,
  sharedCandidateId?: FeatureId | null,
): AddSession {
  const v = placedVertex(coordinate, sharedCandidateId);
  if (session.tool === ADD_TOOL_KIND.Point) {
    // A point holds exactly one vertex; re-click relocates it.
    return { ...session, vertices: [v] };
  }
  return { ...session, vertices: [...session.vertices, v] };
}

/**
 * Update the cursor-follow preview point (spec §カーソル追従プレビュー). High-
 * frequency; the owning unit keeps this in the Zustand session store so the
 * Canvas subscribes and the React render path is NOT taken (技術方針 2.3 / 2.5).
 * A point tool with a vertex already placed still updates preview (harmless) but
 * the render layer only previews an edge for line/face.
 */
export function updatePreview(
  session: AddSession,
  coordinate: WorldCoordinate,
): AddSession {
  return { ...session, preview: coordinate };
}

// --- Vertex undo (Ctrl+Z; FR-78, 取消が頂点 0 のときの振る舞い) --------------

/**
 * The result of an undo at zero vertices (spec §注意点 取消が頂点 0 のとき).
 * Discriminated so the caller branches on a value (教訓 5.19): when there is at
 * least one vertex, `removed` removes the last one and returns the new session;
 * when there are none, `cancelled` signals the add flow itself is cancelled (the
 * defined behavior — an undo past the first vertex backs out of the add) so the
 * caller runs the reset契約.
 */
export const UNDO_RESULT = {
  /** A vertex was removed; `session` is the updated state. */
  Removed: 'removed',
  /** No vertex remained; the add flow is cancelled (run resetSession). */
  Cancelled: 'cancelled',
} as const;

export type UndoResultKind = (typeof UNDO_RESULT)[keyof typeof UNDO_RESULT];

export type UndoResult =
  | { readonly kind: typeof UNDO_RESULT.Removed; readonly session: AddSession }
  | { readonly kind: typeof UNDO_RESULT.Cancelled };

/**
 * Undo the last placed vertex (FR-78 頂点 1 つずつの取消). Valid only while ≥1
 * vertex is placed; removing the last vertex leaves the session at 0 vertices
 * (ready to re-place). An undo with 0 vertices does NOT silently no-op: it is the
 * defined "back out of the add" path (spec §注意点) and returns `Cancelled` so
 * the caller discards the session (教訓 5.2). Decided by length, never a falsy
 * check (教訓 5.18).
 */
export function undoVertex(session: AddSession): UndoResult {
  if (session.vertices.length === 0) {
    return { kind: UNDO_RESULT.Cancelled };
  }
  const vertices = session.vertices.slice(0, -1);
  return { kind: UNDO_RESULT.Removed, session: { ...session, vertices } };
}

// --- Grid-snap toggle (FR-78) -----------------------------------------------

/** Toggle the grid-snap draft on/off (FR-78). */
export function setGridSnap(session: AddSession, gridSnap: boolean): AddSession {
  return { ...session, gridSnap };
}

// --- Parent selection (face only; FR-77) ------------------------------------

/**
 * Set the parent selection draft (FR-77). For point/line this is a no-op-shaped
 * setter the UI never calls (the panel only shows for a face); it still writes
 * the value so a test can assert face-only usage. Choosing 親なし uses
 * {@link PARENT_TOP_LEVEL}; choosing a parent uses {@link parentSelection}.
 */
export function setParentSelection(
  session: AddSession,
  parent: ParentSelection,
): AddSession {
  return { ...session, parent };
}

/**
 * Re-validate the parent selection against a fresh candidate set (教訓 5.5). When
 * the timeline time changes the face's covering candidates change, so a
 * previously-chosen parent may no longer be eligible. If the chosen parent's id
 * is not in `eligibleParentIds`, the selection is cleared back to
 * {@link PARENT_UNSET} so the UI re-prompts (it never silently keeps an
 * ineligible parent). 親なし / unset are unaffected. Membership is decided by the
 * set, never a falsy short-circuit (教訓 5.18).
 */
export function revalidateParent(
  session: AddSession,
  eligibleParentIds: ReadonlySet<FeatureId>,
): AddSession {
  if (session.parent.kind !== PARENT_SELECTION_KIND.Parent) {
    return session;
  }
  if (eligibleParentIds.has(session.parent.parentId)) {
    return session;
  }
  return { ...session, parent: PARENT_UNSET };
}

// --- Closing readiness (face; FR-76) ----------------------------------------

/**
 * Whether the current session has enough vertices to confirm its shape (FR-76):
 * point ≥1, line ≥2, face ≥3. Used to gate the complete / close trigger AND to
 * decide whether the render layer should draw the face closing line (which only
 * makes sense once a ring is closable). Decided by length (教訓 5.18).
 */
export function canConfirm(session: AddSession): boolean {
  return session.vertices.length >= minVerticesFor(session.tool);
}
