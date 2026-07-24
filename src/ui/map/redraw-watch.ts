// UI (map): WHICH session-state changes must trigger a Canvas re-composite.
//
// WHY THIS FILE EXISTS (教訓 5.35 / 5.7 — 結線漏れの再発防止):
// The Canvas subscribes to the session store OFF the React render path (技術方針 2.3 /
// 2.5) and re-reads its host getters (`committedFeatures` / `editHandles` / `gridStyle`
// …) on every scheduled composite. The subscription therefore needs a WATCH set: the
// state values whose change means "the next frame would look different". That set used
// to be a hand-maintained列 of `let prevX` variables inside the composition root, and it
// DRIFTED from what the getters actually read — twice:
//
//   - FR-13 グリッド (spacing / color / opacity / visible) was read by `gridStyle` but not
//     watched, so a panel change was invisible until an unrelated input moved;
//   - FR-80/82 頂点選択 (`selection.vertexIds` / `transient`) was read by `editHandles`
//     but not watched. Selecting a vertex does NOT change `activeFeature` (the U22
//     reducer's HIT_KIND.Vertex branch deliberately leaves it alone — FR-82 even has a
//     distinct「頂点選択コンテキスト地物」state), so on a feature that was already active
//     EVERY watched value stayed identical → early return → no redraw → the selection
//     ring appeared only once some other input happened to move.
//
// The fix is structural, not another `let`: the watch set is ONE pure function, unit
// tested, and the discipline is stated once — **every value a host getter reads must
// appear here**. A pure function is also the only form this can be regression-tested in
// (the composition root needs a real Canvas to mount).
//
// COMPARISON RULE: identity (`===`). The store swaps each slice WHOLESALE and never
// mutates one in place (see the identity-stability note in `state/store.ts`), so a
// reference match IS a value match; scalars compare by value. A value-equal but
// reference-new slice costs one redundant (idempotent) composite — never a missed one.
//
// PURITY: reads only; allocates one fresh array per call.

/** The U22 selection value the watch needs (structural slice, 教訓 5.34 契約越し). */
export interface RedrawWatchSelection {
  readonly activeFeature: unknown;
  readonly vertexIds: unknown;
  readonly vertexOwner: unknown;
  readonly transient: unknown;
}

/**
 * The session-state slice the Canvas redraw decision reads. A STRUCTURAL slice so the
 * function is testable without the whole store and cannot silently depend on unrelated
 * state (教訓 5.34). Values are `unknown` on purpose: this module compares them, it never
 * interprets them.
 */
export interface RedrawWatchInput {
  readonly domain: unknown;
  readonly currentTime: unknown;
  /**
   * The whole U22 selection value (FR-79 / FR-80 / FR-82). Watched WHOLESALE — not just
   * `activeFeature` — because `editHandles` reads the vertex set / owner / transient and
   * those change without the active feature changing. Watching the whole value is what
   * makes a future getter that reads any other selection field safe by construction.
   */
  readonly selection: RedrawWatchSelection;
  /** The `selection.activeFeature` mirror (kept explicit: several getters read it). */
  readonly activeFeature: unknown;
  readonly mode: unknown;
  /** HB3-6/18: 編集ハンドルは専用オーバーレイ系ツール中は描かれない → ツールも watch. */
  readonly activeTool: unknown;
  readonly displayControl: unknown;
  /** FR-113 表示フィルタ (種別/深度/個別非表示/不透明度). */
  readonly filter: unknown;
  readonly projectSettings: {
    readonly areaLabelOccupancyThreshold: unknown;
    readonly gridSpacingDeg: unknown;
    readonly gridColor: unknown;
    readonly gridOpacity: unknown;
    readonly gridVisible: unknown;
  };
  readonly appSettings: {
    /** FR-110 表示上限: `editHandles` gates the whole handle path on it (即時反映). */
    readonly vertexMarkerCap: unknown;
  };
}

/**
 * The ordered watch values for one state. Compare two of these with
 * {@link redrawWatchChanged} to decide whether a composite is needed.
 *
 * INVARIANT (the discipline this module exists to hold): every value a Canvas host getter
 * reads appears in this array. Adding a getter read without adding it here reproduces the
 * FR-13 / FR-80 class of bug — a change the user made that never reaches the pixels.
 */
export function redrawWatch(s: RedrawWatchInput): readonly unknown[] {
  return [
    s.domain,
    s.currentTime,
    s.selection,
    s.activeFeature,
    s.mode,
    s.activeTool,
    s.displayControl,
    s.filter,
    s.projectSettings.areaLabelOccupancyThreshold,
    s.projectSettings.gridSpacingDeg,
    s.projectSettings.gridColor,
    s.projectSettings.gridOpacity,
    s.projectSettings.gridVisible,
    s.appSettings.vertexMarkerCap,
  ];
}

/**
 * `true` when any watched value changed identity (`!==`) — i.e. the next composite could
 * differ, so a redraw must be scheduled. Both arrays come from {@link redrawWatch}, so
 * they always have the same fixed length; a length mismatch is treated as changed rather
 * than silently comparing a prefix (教訓 5.18 absence-not-crash).
 */
export function redrawWatchChanged(
  prev: readonly unknown[],
  next: readonly unknown[],
): boolean {
  if (prev.length !== next.length) return true;
  for (let i = 0; i < next.length; i += 1) {
    if (!Object.is(prev[i], next[i])) return true;
  }
  return false;
}
