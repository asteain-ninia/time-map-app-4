// U22 re-resolution tests — 受け入れ基準 7 (structure-change re-resolve from the
// command result, NOT a blanket clear, 教訓 5.11) + 9 (time-change re-validation,
// 教訓 5.5).

import { describe, expect, it } from 'vitest';

import { createCommandResult } from '../command/result';
import type { DomainId, FeatureId, VertexId } from '../ids';

import {
  POINTER_PHASE,
  withActiveFeature,
  withTransient,
  withVertexSet,
  EMPTY_SELECTION,
  type SelectionState,
} from './state';
import {
  reresolveAfterStructureChange,
  revalidateForTime,
  revalidateForDisplay,
  type DisplayGrabbability,
  type ExistenceAtTime,
} from './reresolve';
import { coord, fid, vid, vidSet } from './fixtures';

const dom = (...ids: DomainId[]): Set<DomainId> => new Set(ids);

// --- 受け入れ基準 7: structure-change re-resolution (教訓 5.11) --------------

describe('structure-change re-resolution (教訓 5.11)', () => {
  it('drops a deleted active feature but is NOT a blanket clear', () => {
    const state = withVertexSet(
      withActiveFeature(EMPTY_SELECTION, fid('A')),
      fid('B'),
      vidSet('B-v0'),
    );
    // A deleted; B and its vertex survive.
    const result = createCommandResult({
      deleted: dom(fid('A')),
      survived: dom(fid('B'), vid('B-v0')),
    });
    const next = reresolveAfterStructureChange(state, result);
    expect(next.activeFeature).toBeNull(); // A was deleted.
    expect(next.vertexIds).toEqual(vidSet('B-v0')); // B's selection kept (not cleared).
    expect(next.vertexOwner).toBe(fid('B'));
  });

  it('prunes only the deleted vertices, keeping survivors', () => {
    const state = withVertexSet(EMPTY_SELECTION, fid('A'), vidSet('A-v0', 'A-v1', 'A-v2'));
    const result = createCommandResult({
      deleted: dom(vid('A-v1')),
      survived: dom(fid('A'), vid('A-v0'), vid('A-v2')),
    });
    const next = reresolveAfterStructureChange(state, result);
    expect(next.vertexIds).toEqual(vidSet('A-v0', 'A-v2'));
  });

  it('promotes the next-target feature created by the operation (merge result)', () => {
    // Merge A+B → C. The "next to operate on" is the merged feature C.
    const state = withActiveFeature(EMPTY_SELECTION, fid('A'));
    const result = createCommandResult({
      deleted: dom(fid('A'), fid('B')),
      created: dom(fid('C')),
    });
    const next = reresolveAfterStructureChange(state, result, { featureId: fid('C') });
    expect(next.activeFeature).toBe(fid('C')); // not blanket-cleared (教訓 5.11).
  });

  it('promotes a kept split half as the next vertex selection', () => {
    // Split a feature; keep half A2's vertices selected.
    const state = withActiveFeature(EMPTY_SELECTION, fid('A'));
    const result = createCommandResult({
      deleted: dom(fid('A')),
      created: dom(fid('A1'), fid('A2'), vid('A2-v0')),
    });
    const next = reresolveAfterStructureChange(state, result, {
      vertexSelection: { ownerFeatureId: fid('A2'), vertexIds: vidSet('A2-v0') },
    });
    expect(next.activeFeature).toBeNull(); // A deleted, no feature preference.
    expect(next.vertexOwner).toBe(fid('A2'));
    expect(next.vertexIds).toEqual(vidSet('A2-v0'));
  });

  it('does not promote a preference whose target was also deleted', () => {
    const state = EMPTY_SELECTION;
    const result = createCommandResult({ deleted: dom(fid('C')) });
    const next = reresolveAfterStructureChange(state, result, { featureId: fid('C') });
    expect(next.activeFeature).toBeNull();
  });

  it('does NOT promote a preference present only in touched (not survived/created)', () => {
    // REGRESSION (bughunt3): survivesResult must not treat a `touched`-only ID as
    // present. Per the CommandResult contract (command/result.ts) touched =
    // created ∪ survived ∪ deleted; a touched ID outside survived/created has no
    // defined post-command existence. We hand-build an out-of-contract result
    // (touched ⊃ change sets) to assert the re-resolver no longer "survives" via
    // touched — which previously could mask a contract break.
    const state = EMPTY_SELECTION;
    const result = createCommandResult({
      // C is neither survived, created, nor deleted...
      touched: dom(fid('C')), // ...but it IS in touched (contract-violating shape).
    });
    expect(result.survived.has(fid('C'))).toBe(false);
    expect(result.created.has(fid('C'))).toBe(false);
    expect(result.deleted.has(fid('C'))).toBe(false);
    expect(result.touched.has(fid('C'))).toBe(true);

    const next = reresolveAfterStructureChange(state, result, {
      featureId: fid('C'),
    });
    expect(next.activeFeature).toBeNull(); // touched alone must NOT make C survive.

    // Same for a vertex-selection preference present only in touched.
    const vnext = reresolveAfterStructureChange(state, result, {
      vertexSelection: { ownerFeatureId: fid('C'), vertexIds: vidSet('C-v0') },
    });
    expect(vnext.vertexOwner).toBeNull();
    expect(vnext.vertexIds.size).toBe(0);
  });

  it('discards any in-flight transient on a structure change (教訓 5.2)', () => {
    const dragging: SelectionState = withTransient(
      withVertexSet(EMPTY_SELECTION, fid('A'), vidSet('A-v0')),
      {
        phase: POINTER_PHASE.VertexDrag,
        ownerFeatureId: fid('A'),
        pressedVertexId: vid('A-v0'),
        origin: coord(0, 0),
        current: coord(1, 1),
      },
    );
    const result = createCommandResult({ survived: dom(fid('A'), vid('A-v0')) });
    const next = reresolveAfterStructureChange(dragging, result);
    expect(next.transient.phase).toBe(POINTER_PHASE.Idle);
  });
});

// --- 受け入れ基準 9: time-change re-validation (教訓 5.5) --------------------

describe('time-change re-validation (教訓 5.5)', () => {
  // Existence keyed by a simple numeric "year"; A exists for years < 100.
  const existence: ExistenceAtTime<number> = {
    featureExistsAt: (f: FeatureId, year: number) =>
      f === fid('A') ? year < 100 : true,
    vertexExistsAt: (_f: FeatureId, _v: VertexId, year: number) => year < 100,
  };

  it('drops the active feature when it no longer exists at the new time', () => {
    const state = withActiveFeature(EMPTY_SELECTION, fid('A'));
    expect(revalidateForTime(state, 50, existence).activeFeature).toBe(fid('A'));
    expect(revalidateForTime(state, 200, existence).activeFeature).toBeNull();
  });

  it('drops the vertex selection when its owner is gone at the new time', () => {
    const state = withVertexSet(EMPTY_SELECTION, fid('A'), vidSet('A-v0', 'A-v1'));
    const stillThere = revalidateForTime(state, 50, existence);
    expect(stillThere.vertexIds).toEqual(vidSet('A-v0', 'A-v1'));
    const gone = revalidateForTime(state, 200, existence);
    expect(gone.vertexIds.size).toBe(0);
    expect(gone.vertexOwner).toBeNull();
  });

  it('keeps selection of a feature that still exists at the new time', () => {
    const state = withActiveFeature(EMPTY_SELECTION, fid('B')); // B always exists.
    expect(revalidateForTime(state, 9999, existence).activeFeature).toBe(fid('B'));
  });

  it('returns the SAME reference when nothing is pruned (idempotent no-op)', () => {
    // A fully-present vertex selection (owner B always exists; all vertices present at
    // year 50) must come back UNCHANGED by reference — the resolver allocates no new
    // set when it drops nothing. This is what lets applyCommandResult skip a redundant
    // second set() (第10波 #5): reference-equality is an exact "did it change" test.
    const state = withVertexSet(EMPTY_SELECTION, fid('B'), vidSet('B-v0', 'B-v1'));
    expect(revalidateForTime(state, 50, existence)).toBe(state);
    // Active-feature-only selection of an ever-present feature is likewise identity.
    const activeOnly = withActiveFeature(EMPTY_SELECTION, fid('B'));
    expect(revalidateForTime(activeOnly, 50, existence)).toBe(activeOnly);
  });
});

// --- 選択 heal の対称性: display-control re-validation (時刻↔displayControl) ---
//
// The sibling of revalidateForTime on the DISPLAY axis (教訓 5.5/5.6/5.11): a
// depth/focus change can roll a leaf up into an aggregate (or omit it), so its
// vertices stop being grabbable and the property panel would show「所有地物を特定で
// きません」(CONTEXT_KIND.Unknown). The heal prunes the now-dangling vertex set — NOT
// a blanket clear — keeping the active feature + any still-grabbable selection.

describe('display-control re-validation (選択 heal の対称性)', () => {
  // "A国" (fid A) is rolled up / omitted (no own grabbable vertices); everything else
  // still draws its own shape. Mirrors resolveDisplayFor(...).grabbable membership.
  const grabbableExcept = (hidden: FeatureId): DisplayGrabbability => ({
    ownerExposesVertices: (f: FeatureId) => f !== hidden,
  });

  it('prunes the vertex selection when its owner stops exposing grabbable vertices', () => {
    const state = withVertexSet(EMPTY_SELECTION, fid('A'), vidSet('A-v0', 'A-v1'));
    const healed = revalidateForDisplay(state, grabbableExcept(fid('A')));
    // A is aggregated/omitted now → the dangling vertex set is dropped (would be Unknown).
    expect(healed.vertexIds.size).toBe(0);
    expect(healed.vertexOwner).toBeNull();
  });

  it('keeps the whole vertex set when the owner still draws its own shape (not a blanket clear)', () => {
    const state = withVertexSet(EMPTY_SELECTION, fid('B'), vidSet('B-v0', 'B-v1'));
    // Only A is hidden; B still exposes its vertices → the SAME reference is returned.
    const healed = revalidateForDisplay(state, grabbableExcept(fid('A')));
    expect(healed).toBe(state);
    expect(healed.vertexIds).toEqual(vidSet('B-v0', 'B-v1'));
  });

  it('never prunes vertices owned by the ACTIVE feature (its handles stay grabbable when omitted)', () => {
    // A is the active feature AND the vertex owner; A is aggregation-omitted. Its edit
    // handles (and vertices) are still drawn (draw ⊇ hit), so the selection survives.
    const state = withVertexSet(
      withActiveFeature(EMPTY_SELECTION, fid('A')),
      fid('A'),
      vidSet('A-v0'),
    );
    const healed = revalidateForDisplay(state, grabbableExcept(fid('A')));
    expect(healed).toBe(state);
    expect(healed.vertexIds).toEqual(vidSet('A-v0'));
    expect(healed.activeFeature).toBe(fid('A'));
  });

  it('prunes a stale vertex set owned by a NON-active feature, keeping the active feature', () => {
    // Active = A; vertex owner = B (a different feature) which is now hidden. B's stale
    // vertices drop; A stays active (NOT a blanket clear, 教訓 5.11).
    const state = withVertexSet(
      withActiveFeature(EMPTY_SELECTION, fid('A')),
      fid('B'),
      vidSet('B-v0'),
    );
    const healed = revalidateForDisplay(state, grabbableExcept(fid('B')));
    expect(healed.activeFeature).toBe(fid('A'));
    expect(healed.vertexIds.size).toBe(0);
    expect(healed.vertexOwner).toBeNull();
  });

  it('does not call the resolver and returns the SAME reference for an empty / active-only selection', () => {
    const calls: FeatureId[] = [];
    const spyGrab: DisplayGrabbability = {
      ownerExposesVertices: (f) => {
        calls.push(f);
        return false;
      },
    };
    expect(revalidateForDisplay(EMPTY_SELECTION, spyGrab)).toBe(EMPTY_SELECTION);
    const activeOnly = withActiveFeature(EMPTY_SELECTION, fid('A'));
    expect(revalidateForDisplay(activeOnly, spyGrab)).toBe(activeOnly);
    // The owner check short-circuits before the injected resolver is consulted.
    expect(calls).toEqual([]);
  });

  it('preserves an in-flight transient (FR-42 非干渉: a display change must not abort a gesture)', () => {
    const dragging: SelectionState = withTransient(
      withVertexSet(EMPTY_SELECTION, fid('B'), vidSet('B-v0')),
      {
        phase: POINTER_PHASE.VertexDrag,
        ownerFeatureId: fid('B'),
        pressedVertexId: vid('B-v0'),
        origin: coord(0, 0),
        current: coord(1, 1),
      },
    );
    // B still grabbable → unchanged, transient intact.
    const healed = revalidateForDisplay(dragging, grabbableExcept(fid('A')));
    expect(healed).toBe(dragging);
    expect(healed.transient.phase).toBe(POINTER_PHASE.VertexDrag);
  });
});
