// U31 deletion — the multi-anchor domain VIEW the delete operation acts on.
//
// FR-41 / 教訓 5.21 require deletion to sweep 全錨 (every history anchor / full
// time-axis state). The concrete root state shape is owned by U03 / later units;
// U31 must not reach into a private representation (技術方針 2.13, spec 依存). So
// this unit defines the minimal STRUCTURAL contract it needs — an ordered list of
// anchors, each a full feature set + the vertex store those features reference
// (exactly U03's {@link AnchorSnapshot}). A host state that holds anchors maps to
// this view; the delete functions are pure over it and return a new view.
//
// This is a layer/unit-crossing contract: fixed here as a shared type and
// exercised by both-side tests so callers and U31 agree by type, not by accident
// (教訓 5.33 / 5.34).

import type { Anchor } from '../anchor';

/**
 * The deletion view: the ordered anchors (全錨) the operation sweeps. Each anchor
 * carries its own feature set and vertex store ({@link Anchor} / AnchorSnapshot).
 * Pure data; never mutated in place (Immer-style structural sharing on update).
 */
export interface DeletionState {
  readonly anchors: readonly Anchor[];
}

/** Build a deletion view from anchors. */
export function createDeletionState(anchors: readonly Anchor[]): DeletionState {
  return { anchors };
}
