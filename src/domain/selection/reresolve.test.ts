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
import { ownerLookupFromMap, type VertexOwnerLookup } from './contracts';
import {
  reresolveAfterStructureChange,
  revalidateForTime,
  revalidateForDisplay,
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

// --- 選択 heal の対称性: display re-validation (root/time/control ↔ 選択) -------
//
// The sibling of revalidateForTime on the DISPLAY axis (教訓 5.5/5.6/5.11): any
// display-resolution input change (depth/focus, time, domain swap) can make selected
// vertices vanish from the display owner lookup, and the property panel would show
//「所有地物を特定できません」(CONTEXT_KIND.Unknown). The heal re-resolves each vertex
// through the CURRENT owner lookup — per-vertex, so a SHARED vertex surviving through
// another drawn owner is KEPT with the owner rewritten (Codex [MED]) — NOT a blanket
// clear (active feature + still-resolvable vertices survive).

describe('display re-validation (選択 heal の対称性)', () => {
  // A plain vid→fid lookup mirroring resolveDisplayFor(...).owners membership.
  const lookup = (
    entries: ReadonlyArray<readonly [string, string]>,
  ): VertexOwnerLookup =>
    ownerLookupFromMap(new Map(entries.map(([v, f]) => [vid(v), fid(f)])));

  it('prunes the whole vertex set when NO selected vertex resolves any more', () => {
    const state = withVertexSet(EMPTY_SELECTION, fid('A'), vidSet('A-v0', 'A-v1'));
    // A is aggregated/omitted and nothing shares its vertices → owners empty for them.
    const healed = revalidateForDisplay(state, lookup([]));
    expect(healed.vertexIds.size).toBe(0);
    expect(healed.vertexOwner).toBeNull();
  });

  it('keeps the whole set (SAME reference) when every vertex still resolves to the owner', () => {
    const state = withVertexSet(EMPTY_SELECTION, fid('B'), vidSet('B-v0', 'B-v1'));
    const healed = revalidateForDisplay(
      state,
      lookup([
        ['B-v0', 'B'],
        ['B-v1', 'B'],
      ]),
    );
    expect(healed).toBe(state); // idempotent no-op — no redundant notification
    expect(healed.vertexIds).toEqual(vidSet('B-v0', 'B-v1'));
  });

  it('[Codex MED] KEEPS a shared vertex through its surviving owner and REWRITES vertexOwner', () => {
    // 隣接 A / B share A-v1 (first-wins owner was A). A is omitted, B stays Real: the
    // owners map now resolves A-v1 → B while A's other vertices resolve to nothing.
    // The shared vertex is still drawn/selectable via B → it must NOT be pruned; the
    // selection's owner is rewritten to B (FR-81 one-owner invariant kept).
    const state = withVertexSet(
      EMPTY_SELECTION,
      fid('A'),
      vidSet('A-v0', 'A-v1', 'A-v2'),
    );
    const healed = revalidateForDisplay(state, lookup([['A-v1', 'B']]));
    expect(healed.vertexIds).toEqual(vidSet('A-v1'));
    expect(healed.vertexOwner).toBe(fid('B'));
  });

  it('prefers the PREVIOUS owner group when it still owns survivors (owners split)', () => {
    // A still owns A-v0; A-v1 re-resolves to B (shared). FR-81 one owner: keep the
    // current owner's group deterministically, prune the split-off vertex.
    const state = withVertexSet(EMPTY_SELECTION, fid('A'), vidSet('A-v0', 'A-v1'));
    const healed = revalidateForDisplay(
      state,
      lookup([
        ['A-v0', 'A'],
        ['A-v1', 'B'],
      ]),
    );
    expect(healed.vertexIds).toEqual(vidSet('A-v0'));
    expect(healed.vertexOwner).toBe(fid('A'));
  });

  it('with the previous owner gone and owners split, keeps the FIRST surviving group (deterministic)', () => {
    // A is gone; A-v0 → B, A-v1 → C. Selection iteration order (insertion) makes B's
    // group the deterministic pick — same first-wins spirit as the owners map itself.
    const state = withVertexSet(EMPTY_SELECTION, fid('A'), vidSet('A-v0', 'A-v1'));
    const healed = revalidateForDisplay(
      state,
      lookup([
        ['A-v0', 'B'],
        ['A-v1', 'C'],
      ]),
    );
    expect(healed.vertexIds).toEqual(vidSet('A-v0'));
    expect(healed.vertexOwner).toBe(fid('B'));
  });

  it('never prunes vertices owned by the ACTIVE feature (its handles stay drawn when omitted)', () => {
    // A is the active feature AND the vertex owner; A is aggregation-omitted. Its edit
    // handles (and vertices) are still drawn (draw ⊇ hit), so the selection survives.
    const state = withVertexSet(
      withActiveFeature(EMPTY_SELECTION, fid('A')),
      fid('A'),
      vidSet('A-v0'),
    );
    const healed = revalidateForDisplay(state, lookup([]));
    expect(healed).toBe(state);
    expect(healed.vertexIds).toEqual(vidSet('A-v0'));
    expect(healed.activeFeature).toBe(fid('A'));
  });

  it('prunes a stale vertex set owned by a NON-active feature, keeping the active feature', () => {
    // Active = A; vertex owner = B (a different feature) whose vertices no longer
    // resolve. B's stale vertices drop; A stays active (NOT a blanket clear, 教訓 5.11).
    const state = withVertexSet(
      withActiveFeature(EMPTY_SELECTION, fid('A')),
      fid('B'),
      vidSet('B-v0'),
    );
    const healed = revalidateForDisplay(state, lookup([]));
    expect(healed.activeFeature).toBe(fid('A'));
    expect(healed.vertexIds.size).toBe(0);
    expect(healed.vertexOwner).toBeNull();
  });

  it('does not consult the lookup and returns the SAME reference for an empty / active-only selection', () => {
    const calls: string[] = [];
    const spyLookup: VertexOwnerLookup = {
      ownerOf: (v) => {
        calls.push(v);
        return null;
      },
    };
    expect(revalidateForDisplay(EMPTY_SELECTION, spyLookup)).toBe(EMPTY_SELECTION);
    const activeOnly = withActiveFeature(EMPTY_SELECTION, fid('A'));
    expect(revalidateForDisplay(activeOnly, spyLookup)).toBe(activeOnly);
    // Active-owned selection short-circuits BEFORE the lookup too.
    const activeOwned = withVertexSet(
      withActiveFeature(EMPTY_SELECTION, fid('A')),
      fid('A'),
      vidSet('A-v0'),
    );
    expect(revalidateForDisplay(activeOwned, spyLookup)).toBe(activeOwned);
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
    // B still resolves → unchanged, transient intact.
    const healed = revalidateForDisplay(dragging, lookup([['B-v0', 'B']]));
    expect(healed).toBe(dragging);
    expect(healed.transient.phase).toBe(POINTER_PHASE.VertexDrag);
  });
});
