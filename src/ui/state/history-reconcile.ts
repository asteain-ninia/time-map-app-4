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
