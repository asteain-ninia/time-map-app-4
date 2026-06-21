// U11 shared-vertex system tests (受け入れ基準 1–5).

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { createCoordinate } from './coordinate';
import { createIdGeneratorState } from './id-generator';
import { asFeatureId, asVertexId, type VertexId } from './ids';
import { sharedVertexStateArb } from './shared-vertex.arbitraries';
import {
  buildReverseIndex,
  checkParticipation,
  containerKey,
  createSharedVertexState,
  insertSharedEdgeCut,
  isResharingSuppressed,
  isSharedVertex,
  liftSuppressionIfMoved,
  moveVertices,
  PARTICIPATION_REJECT,
  referencesOf,
  REJECT_REASON,
  RESULT_VIOLATION,
  shareVertices,
  SHARED_VERTEX_OUTCOME,
  sharedVertexIds,
  shouldLiftSuppression,
  transferSharing,
  unshareReference,
  zeroLengthEdgeValidator,
  type ContainerEntry,
  type ResultValidator,
  type SharedVertexState,
  type ShapeContainer,
  type SuppressionEntry,
} from './shared-vertex';
import { createVertex, createVertexStore, getVertex } from './vertex';

// --- builders ---------------------------------------------------------------

const F = (n: string) => asFeatureId(n);
const V = (n: string) => asVertexId(n);

function ring(featureId: string, ringId: string): ShapeContainer {
  return { kind: 'ring', featureId: F(featureId), ringId };
}
function line(featureId: string): ShapeContainer {
  return { kind: 'line', featureId: F(featureId) };
}

function state(
  vertices: ReadonlyArray<readonly [string, number, number]>,
  containers: readonly ContainerEntry[],
): SharedVertexState {
  return createSharedVertexState(
    createVertexStore(vertices.map(([id, lon, lat]) => createVertex(V(id), createCoordinate(lon, lat)))),
    containers,
  );
}

// A baseline state: ring A (vA1,vA2,vA3), ring B (vB1,vB2,vB3), line L (vL1,vL2).
function baseline(): SharedVertexState {
  return state(
    [
      ['vA1', 0, 0],
      ['vA2', 10, 0],
      ['vA3', 5, 10],
      ['vB1', 20, 0],
      ['vB2', 30, 0],
      ['vB3', 25, 10],
      ['vL1', 0, 50],
      ['vL2', 10, 50],
    ],
    [
      { container: ring('A', 'r0'), vertexIds: [V('vA1'), V('vA2'), V('vA3')] },
      { container: ring('B', 'r0'), vertexIds: [V('vB1'), V('vB2'), V('vB3')] },
      { container: line('L'), vertexIds: [V('vL1'), V('vL2')] },
    ],
  );
}

// ---------------------------------------------------------------------------
// 受け入れ基準 1: linked move connects every sharer.
// ---------------------------------------------------------------------------

describe('shared vertex group derivation + linked move (FR-30)', () => {
  it('merges two vertices into a shared vertex referenced by both rings', () => {
    const s = baseline();
    // Share vB1 (candidate) into vA2 (target).
    const r = shareVertices(s, V('vB1'), V('vA2'));
    expect(r.status).toBe(SHARED_VERTEX_OUTCOME.Applied);
    if (r.status !== SHARED_VERTEX_OUTCOME.Applied) return;
    expect(isSharedVertex(r.state, V('vA2'))).toBe(true);
    // vB1 is pruned from the store (orphaned).
    expect(getVertex(r.state.vertices, V('vB1'))).toBeUndefined();
    // Ring B now cites vA2 where vB1 was.
    const refs = referencesOf(r.state, V('vA2'));
    expect(refs.map((x) => containerKey(x.container)).sort()).toEqual(
      [containerKey(ring('A', 'r0')), containerKey(ring('B', 'r0'))].sort(),
    );
  });

  it('linked move updates the coordinate for ALL sharers, leaving others unchanged', () => {
    const shared = shareVertices(baseline(), V('vB1'), V('vA2'));
    expect(shared.status).toBe(SHARED_VERTEX_OUTCOME.Applied);
    if (shared.status !== SHARED_VERTEX_OUTCOME.Applied) return;

    const moved = moveVertices(shared.state, [
      { vertexId: V('vA2'), coordinate: createCoordinate(99, 99) },
    ]);
    expect(moved.status).toBe(SHARED_VERTEX_OUTCOME.Applied);
    if (moved.status !== SHARED_VERTEX_OUTCOME.Applied) return;

    const v = getVertex(moved.state.vertices, V('vA2'));
    expect(v?.coordinate).toEqual(createCoordinate(99, 99));
    // Every sharer resolves to the same single body => same coordinate.
    for (const r of referencesOf(moved.state, V('vA2'))) {
      const entry = moved.state.containers.get(containerKey(r.container));
      const id = entry?.vertexIds[r.position];
      expect(id).toBe(V('vA2'));
    }
    // A non-shared vertex is untouched.
    expect(getVertex(moved.state.vertices, V('vA1'))?.coordinate).toEqual(
      createCoordinate(0, 0),
    );
  });

  it('three shapes sharing one vertex all see the moved coordinate', () => {
    let s = baseline();
    // Make vA2, vB1, vL1 share into vA2.
    let r = shareVertices(s, V('vB1'), V('vA2'));
    expect(r.status).toBe(SHARED_VERTEX_OUTCOME.Applied);
    if (r.status !== SHARED_VERTEX_OUTCOME.Applied) return;
    s = r.state;
    r = shareVertices(s, V('vL1'), V('vA2'));
    expect(r.status).toBe(SHARED_VERTEX_OUTCOME.Applied);
    if (r.status !== SHARED_VERTEX_OUTCOME.Applied) return;
    s = r.state;
    expect(referencesOf(s, V('vA2')).length).toBe(3);

    const moved = moveVertices(s, [
      { vertexId: V('vA2'), coordinate: createCoordinate(7, 7) },
    ]);
    expect(moved.status).toBe(SHARED_VERTEX_OUTCOME.Applied);
    if (moved.status !== SHARED_VERTEX_OUTCOME.Applied) return;
    expect(getVertex(moved.state.vertices, V('vA2'))?.coordinate).toEqual(
      createCoordinate(7, 7),
    );
    expect(referencesOf(moved.state, V('vA2')).length).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// 受け入れ基準 2: participation restriction (FR-32).
// ---------------------------------------------------------------------------

describe('participation restriction (FR-32 §4.3)', () => {
  it('rejects sharing two vertices of the same ring; state unchanged', () => {
    const s = baseline();
    const r = shareVertices(s, V('vA1'), V('vA2')); // both in ring A
    expect(r.status).toBe(SHARED_VERTEX_OUTCOME.Rejected);
    if (r.status !== SHARED_VERTEX_OUTCOME.Rejected) return;
    expect(r.reason).toBe(REJECT_REASON.Participation);
    expect(r.participation?.[0]?.kind).toBe(PARTICIPATION_REJECT.SameRing);
  });

  it('rejects sharing two vertices of the same line path', () => {
    const s = baseline();
    const r = shareVertices(s, V('vL1'), V('vL2'));
    expect(r.status).toBe(SHARED_VERTEX_OUTCOME.Rejected);
    if (r.status !== SHARED_VERTEX_OUTCOME.Rejected) return;
    expect(r.reason).toBe(REJECT_REASON.Participation);
    expect(r.participation?.[0]?.kind).toBe(PARTICIPATION_REJECT.SameLinePath);
  });

  it('allows sharing across different rings of the same feature (outer + enclave)', () => {
    // One leaf feature C with two distinct rings.
    const s = state(
      [
        ['c1', 0, 0],
        ['c2', 10, 0],
        ['c3', 5, 10],
        ['e1', 2, 2],
        ['e2', 6, 2],
        ['e3', 4, 5],
      ],
      [
        { container: ring('C', 'outer'), vertexIds: [V('c1'), V('c2'), V('c3')] },
        { container: ring('C', 'enclave'), vertexIds: [V('e1'), V('e2'), V('e3')] },
      ],
    );
    const r = shareVertices(s, V('e1'), V('c2'));
    expect(r.status).toBe(SHARED_VERTEX_OUTCOME.Applied);
  });

  it('checkParticipation flags a duplicate container key directly', () => {
    const refs = [
      { container: ring('A', 'r0'), position: 0 },
      { container: ring('A', 'r0'), position: 2 },
    ];
    const v = checkParticipation(refs);
    expect(v).toHaveLength(1);
    expect(v[0]?.kind).toBe(PARTICIPATION_REJECT.SameRing);
  });
});

// ---------------------------------------------------------------------------
// 受け入れ基準 3: result-invalid rejection + validator delegation.
// ---------------------------------------------------------------------------

describe('result-invalid rejection via injected validators (FR-32 §4.4)', () => {
  function stubValidator(kind: keyof typeof RESULT_VIOLATION, calls: { n: number }): ResultValidator {
    return () => {
      calls.n += 1;
      return [{ kind: RESULT_VIOLATION[kind], message: `stub ${kind}` }];
    };
  }

  it.each(['ZeroLengthEdge', 'SelfIntersection', 'HierarchyBroken', 'LeafOverlap'] as const)(
    'rejects when the %s validator reports a violation',
    (kind) => {
    const calls = { n: 0 };
    const r = shareVertices(baseline(), V('vB1'), V('vA2'), {
      validators: [stubValidator(kind, calls)],
    });
    expect(calls.n).toBe(1); // the delegated validator WAS called
    expect(r.status).toBe(SHARED_VERTEX_OUTCOME.Rejected);
    if (r.status !== SHARED_VERTEX_OUTCOME.Rejected) return;
    expect(r.reason).toBe(REJECT_REASON.ResultInvalid);
    expect(r.result?.[0]?.kind).toBe(RESULT_VIOLATION[kind]);
    expect(r.message).toContain('result would be invalid');
  });

  it('rejected share leaves the state completely unchanged (no partial apply)', () => {
    const before = baseline();
    const r = shareVertices(before, V('vB1'), V('vA2'), {
      validators: [() => [{ kind: RESULT_VIOLATION.LeafOverlap, message: 'x' }]],
    });
    expect(r.status).toBe(SHARED_VERTEX_OUTCOME.Rejected);
    // The original still has vB1 with its body and ring B citing it.
    expect(getVertex(before.vertices, V('vB1'))).toBeDefined();
    expect(referencesOf(before, V('vB1')).length).toBe(1);
  });

  it('built-in zeroLengthEdgeValidator flags adjacent same-id and coincident ids', () => {
    // Direct validator test: a ring whose adjacent vertices are coincident.
    const coincident = state(
      [
        ['p', 0, 0],
        ['q', 0, 0], // coincident with p
        ['t', 5, 10],
      ],
      [{ container: ring('P', 'r0'), vertexIds: [V('p'), V('q'), V('t')] }],
    );
    const v = zeroLengthEdgeValidator(coincident);
    expect(v.some((x) => x.kind === RESULT_VIOLATION.ZeroLengthEdge)).toBe(true);
  });

  it('a cross-ring merge that makes a ring re-cite an adjacent id is caught', () => {
    // Ring P = [p, q, t]; ring R = [u, w, t2]. Share u(in R) into q(in P): no
    // same-ring conflict. But arrange coordinates so the resulting ring R edge
    // becomes coincident — validator runs on the post-merge state.
    const s = state(
      [
        ['p', 0, 0],
        ['q', 10, 0],
        ['t', 5, 10],
        ['u', 10, 0], // coincident with q
        ['w', 10, 0], // coincident with q too => R has a zero-length edge u->w
        ['x', 7, 9],
      ],
      [
        { container: ring('P', 'r0'), vertexIds: [V('p'), V('q'), V('t')] },
        { container: ring('R', 'r0'), vertexIds: [V('u'), V('w'), V('x')] },
      ],
    );
    const r = shareVertices(s, V('u'), V('q'), { validators: [zeroLengthEdgeValidator] });
    expect(r.status).toBe(SHARED_VERTEX_OUTCOME.Rejected);
    if (r.status !== SHARED_VERTEX_OUTCOME.Rejected) return;
    expect(r.reason).toBe(REJECT_REASON.ResultInvalid);
    expect(r.result?.some((x) => x.kind === RESULT_VIOLATION.ZeroLengthEdge)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 受け入れ基準 4: unshare + continuity + suppression.
// ---------------------------------------------------------------------------

describe('unshare (FR-33 §4.6)', () => {
  function sharedState(): SharedVertexState {
    const r = shareVertices(baseline(), V('vB1'), V('vA2'));
    if (r.status !== SHARED_VERTEX_OUTCOME.Applied) throw new Error('setup');
    return r.state;
  }

  it('splits one reference into a fresh same-coordinate vertex; others keep original', () => {
    const s = sharedState();
    const refB = referencesOf(s, V('vA2')).find(
      (x) => x.container.kind === 'ring' && x.container.featureId === F('B'),
    );
    expect(refB).toBeDefined();
    if (refB === undefined) return;

    const ur = unshareReference(s, V('vA2'), refB, createIdGeneratorState(), () => 1);
    expect(ur.result.status).toBe(SHARED_VERTEX_OUTCOME.Applied);
    if (ur.result.status !== SHARED_VERTEX_OUTCOME.Applied) return;
    const newId = ur.newVertexId;
    expect(newId).toBeDefined();
    if (newId === undefined) return;

    // New vertex has the same coordinate as the original.
    expect(getVertex(ur.result.state.vertices, newId)?.coordinate).toEqual(
      getVertex(s.vertices, V('vA2'))?.coordinate,
    );
    // Ring A still cites vA2; it now has only 1 reference => no longer shared.
    expect(isSharedVertex(ur.result.state, V('vA2'))).toBe(false);
    expect(referencesOf(ur.result.state, V('vA2')).length).toBe(1);
    // Ring B cites the new id.
    expect(referencesOf(ur.result.state, newId).length).toBe(1);
  });

  it('records the created vertex id in the change set', () => {
    const s = sharedState();
    const refB = referencesOf(s, V('vA2')).find(
      (x) => x.container.kind === 'ring' && x.container.featureId === F('B'),
    );
    if (refB === undefined) throw new Error('no ref');
    const ur = unshareReference(s, V('vA2'), refB, createIdGeneratorState(), () => 1);
    if (ur.result.status !== SHARED_VERTEX_OUTCOME.Applied) throw new Error('apply');
    expect(ur.newVertexId).toBeDefined();
    expect([...ur.result.change.createdVertexIds]).toEqual([ur.newVertexId]);
  });
});

describe('auto-resharing suppression (FR-33 §4.6.3)', () => {
  const entries: SuppressionEntry[] = [{ vertexId: V('vA2'), suppressed: true }];

  it('reports a vertex as suppressed right after unshare', () => {
    expect(isResharingSuppressed(entries, V('vA2'))).toBe(true);
    expect(isResharingSuppressed(entries, V('vA1'))).toBe(false);
  });

  it('lifts suppression once moved beyond the snap distance', () => {
    expect(shouldLiftSuppression(60, 50)).toBe(true);
    expect(shouldLiftSuppression(40, 50)).toBe(false);
    const lifted = liftSuppressionIfMoved(entries, V('vA2'), 60, 50);
    expect(isResharingSuppressed(lifted, V('vA2'))).toBe(false);
    const kept = liftSuppressionIfMoved(entries, V('vA2'), 40, 50);
    expect(isResharingSuppressed(kept, V('vA2'))).toBe(true);
  });
});

describe('continuity rules (FR-95 §4.7)', () => {
  it('transferSharing carries a shared relationship onto remapped (split) ids', () => {
    const s = sharedState();
    function sharedState(): SharedVertexState {
      const r = shareVertices(baseline(), V('vB1'), V('vA2'));
      if (r.status !== SHARED_VERTEX_OUTCOME.Applied) throw new Error('setup');
      return r.state;
    }
    // Split re-creates vA2 as nA2 everywhere.
    const remap = new Map<VertexId, VertexId>([[V('vA2'), V('nA2')]]);
    const moved = transferSharing(s, remap);
    // nA2 inherits both references (still shared); old body pruned.
    expect(referencesOf(moved, V('nA2')).length).toBe(2);
    expect(getVertex(moved.vertices, V('vA2'))).toBeUndefined();
    // Single source of truth (R6): the remapped-to id MUST have a body carrying
    // the old vertex's coordinate forward — not just dangling references.
    const carried = getVertex(moved.vertices, V('nA2'));
    expect(carried).toBeDefined();
    expect(carried?.coordinate).toEqual(createCoordinate(10, 0));
  });

  it('transferSharing leaves a pre-existing merge-target body untouched', () => {
    // When the remapped-to id already has a body (e.g. merge target), the carry-
    // forward must NOT overwrite it.
    const s = baseline();
    const remap = new Map<VertexId, VertexId>([[V('vA2'), V('m')]]);
    const withM = {
      vertices: createVertexStore([
        ...[...s.vertices.byId.values()],
        createVertex(V('m'), createCoordinate(77, 88)),
      ]),
      containers: s.containers,
    };
    const moved = transferSharing(withM, remap);
    expect(getVertex(moved.vertices, V('m'))?.coordinate).toEqual(createCoordinate(77, 88));
  });

  it('transferSharing merges two old ids that map to the same new id', () => {
    const s = baseline();
    const remap = new Map<VertexId, VertexId>([
      [V('vA2'), V('m')],
      [V('vB1'), V('m')],
    ]);
    // Add a body for m so prune logic leaves it.
    const withM = {
      vertices: createVertexStore([
        ...[...s.vertices.byId.values()],
        createVertex(V('m'), createCoordinate(10, 0)),
      ]),
      containers: s.containers,
    };
    const moved = transferSharing(withM, remap);
    // m is now cited by ring A and ring B => shared.
    expect(isSharedVertex(moved, V('m'))).toBe(true);
  });

  it('insertSharedEdgeCut inserts a single shared vertex on both partner edges', () => {
    // Two rings sharing an edge (vA1,vA2) — build A and B over the same two ids.
    const s = state(
      [
        ['a', 0, 0],
        ['b', 10, 0],
        ['c', 5, 10],
        ['d', 5, -10],
      ],
      [
        { container: ring('A', 'r0'), vertexIds: [V('a'), V('b'), V('c')] },
        { container: ring('B', 'r0'), vertexIds: [V('b'), V('a'), V('d')] },
      ],
    );
    const cut = insertSharedEdgeCut(
      s,
      {
        primary: { containerKey: containerKey(ring('A', 'r0')), edgeStart: 0 }, // a->b
        partner: { containerKey: containerKey(ring('B', 'r0')), edgeStart: 1 }, // a->d? choose a->... ; use edge a between
        cutCoordinate: createCoordinate(5, 0),
      },
      createIdGeneratorState(),
      () => 1,
    );
    expect(cut.result.status).toBe(SHARED_VERTEX_OUTCOME.Applied);
    if (cut.result.status !== SHARED_VERTEX_OUTCOME.Applied) return;
    const cutId = cut.cutVertexId;
    expect(cutId).toBeDefined();
    if (cutId === undefined) return;
    // The cut vertex is cited by both rings => shared.
    expect(isSharedVertex(cut.result.state, cutId)).toBe(true);
    expect(referencesOf(cut.result.state, cutId).length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// 受け入れ基準 5: property tests (前後比較 invariants).
// ---------------------------------------------------------------------------

describe('property: shared-group invariants (技術方針 R6)', () => {
  it('groups derive uniquely; no group has a same-ring/same-line duplicate', () => {
    fc.assert(
      fc.property(sharedVertexStateArb, (s) => {
        for (const vid of sharedVertexIds(s)) {
          const refs = referencesOf(s, vid);
          // The generator never cites a vertex twice in one ring; assert the
          // derived group is conflict-free.
          expect(checkParticipation(refs)).toHaveLength(0);
        }
      }),
    );
  });

  it('reverse index is consistent with referencesOf', () => {
    fc.assert(
      fc.property(sharedVertexStateArb, (s) => {
        const index = buildReverseIndex(s);
        for (const [vid, refs] of index) {
          expect(referencesOf(s, vid)).toHaveLength(refs.length);
        }
      }),
    );
  });

  it('linked move keeps every sharer pointing at the one moved body', () => {
    fc.assert(
      fc.property(
        sharedVertexStateArb,
        fc.integer({ min: -90, max: 90 }),
        (s, lat) => {
          const sharedIds = sharedVertexIds(s);
          fc.pre(sharedIds.length > 0);
          const target = sharedIds[0];
          if (target === undefined) return;
          const moved = moveVertices(s, [
            { vertexId: target, coordinate: createCoordinate(0, lat) },
          ]);
          if (moved.status !== SHARED_VERTEX_OUTCOME.Applied) return;
          const body = getVertex(moved.state.vertices, target);
          expect(body?.coordinate).toEqual(createCoordinate(0, lat));
          // All citations still resolve to the single body.
          for (const ref of referencesOf(moved.state, target)) {
            const entry = moved.state.containers.get(containerKey(ref.container));
            expect(entry?.vertexIds[ref.position]).toBe(target);
          }
        },
      ),
    );
  });

  it('a rejected share returns a state equal to the input (no partial apply)', () => {
    fc.assert(
      fc.property(sharedVertexStateArb, (s) => {
        const ids = [...s.vertices.byId.keys()];
        fc.pre(ids.length >= 2);
        const a = ids[0];
        const b = ids[1];
        if (a === undefined || b === undefined) return;
        // Force result-invalid via a validator that always rejects.
        const r = shareVertices(s, a, b, {
          validators: [() => [{ kind: RESULT_VIOLATION.LeafOverlap, message: 'reject' }]],
        });
        if (r.status === SHARED_VERTEX_OUTCOME.Applied) return; // share not possible
        // Input untouched.
        expect([...s.vertices.byId.keys()].sort()).toEqual(ids.sort());
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// バグハント3 回帰: referencesOf / shareVertices / moveVertices must build the
// reverse index AT MOST ONCE per command entry — not once per looked-up vertex.
// Regression for: referencesOf(state, vid) rebuilt buildReverseIndex() from
// scratch on every call, so the per-frame move loop and shareVertices' two
// lookups re-scanned every container O(C·L) times each.
// ---------------------------------------------------------------------------

describe('reverse-index reuse (バグハント3 performance regression)', () => {
  // Wrap a state's container map so every full iteration (what buildReverseIndex
  // performs via `.values()`) is counted. referencesOf with a pre-built index
  // must NOT iterate; commands must iterate exactly once regardless of how many
  // vertices they touch.
  function countingState(base: SharedVertexState): {
    state: SharedVertexState;
    scans: () => number;
  } {
    let scans = 0;
    const real = base.containers;
    const proxy = new Proxy(real, {
      get(target, prop, receiver) {
        if (prop === 'values') {
          return () => {
            scans += 1;
            return target.values();
          };
        }
        const v = Reflect.get(target, prop, receiver);
        return typeof v === 'function' ? v.bind(target) : v;
      },
    });
    return {
      state: { vertices: base.vertices, containers: proxy as typeof real },
      scans: () => scans,
    };
  }

  it('referencesOf with a supplied index does not scan the containers', () => {
    const base = baseline();
    const index = buildReverseIndex(base);
    const { state: s, scans } = countingState(base);
    // Look up many vertices using the shared index.
    for (const id of ['vA1', 'vA2', 'vA3', 'vB1', 'vB2', 'vB3']) {
      referencesOf(s, V(id), index);
    }
    expect(scans()).toBe(0);
    // Equivalence with the unindexed path.
    expect(referencesOf(base, V('vA2'), index)).toEqual(referencesOf(base, V('vA2')));
  });

  it('moveVertices builds the reverse index once for a multi-vertex move', () => {
    const base = baseline();
    const { state: s, scans } = countingState(base);
    const moved = moveVertices(s, [
      { vertexId: V('vA1'), coordinate: createCoordinate(1, 1) },
      { vertexId: V('vA2'), coordinate: createCoordinate(2, 2) },
      { vertexId: V('vA3'), coordinate: createCoordinate(3, 3) },
      { vertexId: V('vB1'), coordinate: createCoordinate(4, 4) },
    ]);
    expect(moved.status).toBe(SHARED_VERTEX_OUTCOME.Applied);
    // One scan total — not one per moved vertex (would have been 4 before fix).
    expect(scans()).toBe(1);
  });

  it('shareVertices builds the reverse index once (not twice) per call', () => {
    const base = baseline();
    const { state: s, scans } = countingState(base);
    const r = shareVertices(s, V('vB1'), V('vA2'));
    expect(r.status).toBe(SHARED_VERTEX_OUTCOME.Applied);
    // candidateRefs + targetRefs share one index — a single container scan.
    expect(scans()).toBe(1);
  });

  it('repeated linked moves stay correct with the cached index', () => {
    const s = shareVertices(baseline(), V('vB1'), V('vA2'));
    expect(s.status).toBe(SHARED_VERTEX_OUTCOME.Applied);
    if (s.status !== SHARED_VERTEX_OUTCOME.Applied) return;
    let cur = s.state;
    // Simulate a drag: many move frames over the same (shared) vertex.
    for (let i = 0; i < 50; i += 1) {
      const moved = moveVertices(cur, [
        { vertexId: V('vA2'), coordinate: createCoordinate(i, i) },
      ]);
      expect(moved.status).toBe(SHARED_VERTEX_OUTCOME.Applied);
      if (moved.status !== SHARED_VERTEX_OUTCOME.Applied) return;
      cur = moved.state;
    }
    expect(getVertex(cur.vertices, V('vA2'))?.coordinate).toEqual(createCoordinate(49, 49));
    // Both rings still cite the one shared body.
    expect(referencesOf(cur, V('vA2')).length).toBe(2);
  });

  // バグハント3 回帰: repointAll (内部) must rewrite ONLY the containers that
  // actually cite the candidate, using the pre-built reverse index — never the
  // old Array.includes(fromId) guard run over EVERY container (O(C·L) scan).
  // The orphan-prune that follows must likewise NOT re-scan every container.
  // We instrument `.includes` on the DECOY containers' vertexId arrays: those
  // arrays have nothing to do with the share, so an Array.includes call on any
  // of them is exactly the regression. buildReverseIndex uses positional
  // iteration (no .includes), so it does not register — the only thing this
  // counts is the guard / orphan scan the fix removed.
  it('shareVertices repoints without an Array.includes scan over every container', () => {
    const verts: Array<readonly [string, number, number]> = [
      ['vA1', 0, 0],
      ['vA2', 10, 0],
      ['vA3', 5, 10],
      ['vB1', 20, 0],
      ['vB2', 30, 0],
      ['vB3', 25, 10],
    ];
    const containers: ContainerEntry[] = [
      { container: ring('A', 'r0'), vertexIds: [V('vA1'), V('vA2'), V('vA3')] },
      { container: ring('B', 'r0'), vertexIds: [V('vB1'), V('vB2'), V('vB3')] },
    ];
    // Many decoy rings that cite NEITHER the candidate (vB1) nor the target (vA2).
    const decoyCount = 50;
    const decoyKeys: string[] = [];
    for (let i = 0; i < decoyCount; i += 1) {
      const a = `d${i}a`;
      const b = `d${i}b`;
      const c = `d${i}c`;
      verts.push([a, 100 + i, 0], [b, 110 + i, 0], [c, 105 + i, 10]);
      const container = ring(`D${i}`, 'r0');
      containers.push({ container, vertexIds: [V(a), V(b), V(c)] });
      decoyKeys.push(containerKey(container));
    }

    // Wrap each decoy's vertexId array so any `.includes(...)` is counted.
    let decoyIncludes = 0;
    const instrumentedContainers = containers.map((entry) => {
      if (!decoyKeys.includes(containerKey(entry.container))) return entry;
      const wrapped = new Proxy(entry.vertexIds as VertexId[], {
        get(target, prop, receiver) {
          if (prop === 'includes') {
            return (...args: Parameters<VertexId[]['includes']>) => {
              decoyIncludes += 1;
              return target.includes(...args);
            };
          }
          return Reflect.get(target, prop, receiver);
        },
      });
      return { container: entry.container, vertexIds: wrapped };
    });
    const store = state(verts, []).vertices;
    const baseState = createSharedVertexState(store, instrumentedContainers);

    const r = shareVertices(baseState, V('vB1'), V('vA2'));
    expect(r.status).toBe(SHARED_VERTEX_OUTCOME.Applied);
    if (r.status !== SHARED_VERTEX_OUTCOME.Applied) return;

    // Zero includes on decoy containers: the fix uses the reverse index instead
    // of scanning every container. Before the fix, repointAll's guard alone
    // called .includes on all decoyCount decoys (and the orphan check repeated it).
    expect(decoyIncludes).toBe(0);

    // Correctness fully preserved: vB1 folded into vA2 (shared by rings A and B);
    // candidate pruned; every decoy ring left identical (same array reference).
    expect(isSharedVertex(r.state, V('vA2'))).toBe(true);
    expect(getVertex(r.state.vertices, V('vB1'))).toBeUndefined();
    for (const key of decoyKeys) {
      expect(r.state.containers.get(key)?.vertexIds).toBe(
        baseState.containers.get(key)?.vertexIds,
      );
    }
    const bRefs = referencesOf(r.state, V('vA2'))
      .map((x) => containerKey(x.container))
      .sort();
    expect(bRefs).toEqual(
      [containerKey(ring('A', 'r0')), containerKey(ring('B', 'r0'))].sort(),
    );
  });
});
