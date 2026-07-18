// F2 — the pure decision for how the edit undo/redo history reacts to a store DOMAIN
// reference change that App observes through its subscription but did NOT author via a
// command (App.tsx: 技術方針 2.5, React 外のストアを subscribe で監視).
//
// Two kinds of unauthored domain swap reach that subscription:
//   1. a base-map REPLACE (FR-04): only `baseMap` changed on the domain — the features
//      / vertices the undo/redo stacks operate on are untouched, so the stacks stay
//      VALID. We PRESERVE them and only rebase the current root state onto the new
//      domain, so a later edit builds on the new base map. The replace is itself
//      NON-undoable (it is not pushed as a history entry — a base-map image can be tens
//      of MB, and 教訓 5.22 favours keeping the edit history over stacking the bytes);
//   2. an external whole-state swap (file LOAD / NEW / D&D): the old stack replays
//      states of a DIFFERENT project (consistency-binding's whole-state-swap commands
//      ignore the live input state), so it is meaningless against the new domain and is
//      RE-ROOTED to a fresh history at the configured depth (FR-74, 教訓 5.22).
//
// Kept as a pure function (教訓 5.41) so the branch is unit-tested without rendering App;
// App supplies `isBasemapReplace` from the store's basemapReplaceNonce (bumped only by
// replaceBaseMap), the one signal that separates the two kinds.

import { createHistory, type History } from '../../domain/command/history';

/**
 * Decide the next edit history after an unauthored store domain swap. A base-map
 * replace preserves the undo/redo stacks (rebasing only the root state); an external
 * load/new re-roots a fresh history at `undoStackSize`.
 */
export function reconcileHistoryOnExternalDomainSwap<S>(params: {
  /** The live edit history immediately before the domain swap was observed. */
  readonly current: History<S>;
  /** The new domain reference now in the store. */
  readonly nextDomain: S;
  /** The configured undo-stack depth (FR-74) — used only when re-rooting. */
  readonly undoStackSize: number;
  /** True when the swap is a base-map replace (store basemapReplaceNonce changed). */
  readonly isBasemapReplace: boolean;
}): History<S> {
  const { current, nextDomain, undoStackSize, isBasemapReplace } = params;
  if (isBasemapReplace) {
    // Preserve the undo/redo stacks; rebase only the current root onto the new domain
    // so subsequent edits build on the replaced base map (F2).
    return { ...current, state: nextDomain };
  }
  // External whole-state swap (load/new): the old stack cannot apply to the new project.
  return createHistory(nextDomain, undoStackSize);
}

/**
 * F2 TRUE FIX (Codex re-review) — graft the LIVE base map onto a CAPTURED undo/redo
 * result state so a base-map REPLACE is genuinely non-undoable.
 *
 * WHY reconcile alone is not enough: {@link reconcileHistoryOnExternalDomainSwap}
 * rebases only the history ROOT state onto the replaced domain. But the undo/redo
 * commands are WHOLE-STATE SWAPS (consistency-binding `makeCommand`): each `undo`/`redo`
 * ignores its live input and returns a route CAPTURED at commit time, still carrying the
 * base map that was current THEN. After `edit → replace(B1) → undo`, the undo command
 * returns its captured `{ …, baseMap: B0 }`, so B0 came back and the replaced B1 was
 * lost — the replace was NOT actually non-undoable (the FR-04 契約). The bytes that back
 * the map (display `baseMapImageRef` / save `loadedAssetsRef`) live OUTSIDE the domain
 * snapshot and are NOT touched by undo/redo, so only `domain.baseMap` (source/meta)
 * regressed — leaving the retained B1 bytes inconsistent with a B0 source (display falls
 * back to the preset; a save writes a B0 manifest over B1 bytes).
 *
 * The fix: before applying an undo/redo result to the store, replace the captured
 * route's `baseMap` with the store's LIVE one. A replace is defined non-undoable, so the
 * CURRENT base map must survive every feature-edit undo/redo. This is a pure decision
 * (教訓 5.41) so it is unit-tested without rendering App.
 *
 * Identity contract: when no replace intervened the captured route ALREADY carries the
 * live base map (edits preserve `baseMap` by reference), so `captured.baseMap ===
 * live.baseMap` and the captured object is returned UNCHANGED (same reference) — an
 * ordinary undo/redo is byte-for-byte the pre-fix behaviour, busting no memo/subscription
 * with a value-equal-but-new object. Only an actual replace (a new `baseMap` reference)
 * grafts, and a run of replaces always grafts to the LATEST live map.
 */
export function graftLiveBaseMap<S extends { readonly baseMap: unknown }>(
  captured: S,
  live: S,
): S {
  // Reference identity is the exact signal: a replace mints a NEW baseMap object
  // (store.replaceBaseMap), while every feature edit preserves it by reference. So an
  // unchanged reference means "no replace since capture" → a genuine no-op.
  if (captured.baseMap === live.baseMap) return captured;
  // Only `baseMap` is swapped; `live` is the same domain type S, so its `baseMap` is a
  // valid S['baseMap']. The generic spread widens the field to `unknown`, so we assert
  // the reconstructed object back to S (sound: same field, same source type).
  return { ...captured, baseMap: live.baseMap } as S;
}
