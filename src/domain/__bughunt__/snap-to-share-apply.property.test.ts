// Bug-hunt regression — focus: snap-to-share is PRODUCED but never APPLIED
// (editing/apply-proposal.ts — sharePair dropped on confirm).
//
// THE BUG (high severity, area=editing):
//   `edit-flow.ts` documents that a snap candidate surviving to release becomes a
//   `FeatureSnapshot.sharePair` forwarded to U11 at confirm, and `confirmRelease`
//   threads that pair into the EditProposal. But `applyEditProposal` consumed only
//   `snapshot.feature` + `snapshot.vertices` and NEVER read `snapshot.sharePair`.
//   Result: a vertex the user snapped onto another feature's vertex stayed a
//   DISTINCT id at the same coordinate. A later move of one vertex then tore the
//   shared boundary apart (gap / overlap) — FR-31 / FR-32 not realised through the
//   apply op.
//
// THE FIX: `applyEditProposal` now repoints the dragged vertex id to the target id
// across every feature in the edited anchor snapshot (collapsing the two coincident
// vertices into ONE shared id, single-source-of-truth R6) AS PART OF the same
// indivisible edit, carrying the canonical coordinate forward and pruning the
// orphaned dragged body.
//
// These tests would FAIL on the pre-fix code (the dragged id survived and the two
// boundaries diverged on a later move). Run ONLY this file:
//   npx vitest run src/domain/__bughunt__/snap-to-share-apply.property.test.ts

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { applyEditProposal, applyAddProposal } from '../editing/apply-proposal';
import { createEditProposal } from '../consistency/types';
import { getCalendar } from '../time/calendar';
import { timePointYear } from '../time/time-point';
import { createBasicAttributes, createColorInfo } from '../attributes';
import {
  createLeafFeature,
  type LeafFeature,
} from '../feature';
import { createShape, createTerritoryRing } from '../ring';
import { createVertex, createVertexStore, getVertex, type Vertex } from '../vertex';
import { resolveAt } from '../anchor-series';
import { asFeatureId, asRingId, asVertexId, type VertexId } from '../ids';
import type { FeatureSnapshot } from '../editing/edit-flow';
import type { DomainProject } from '../persistence/serialize';
import { createGeoParams } from '../geo/geo-params';
import {
  buildReverseIndex,
  createSharedVertexState,
  isSharedVertex,
  type ContainerEntry,
} from '../shared-vertex';

const calendar = getCalendar('gregorian');
const color = createColorInfo(true, '#90caf9', '#ffb300', '#0d47a1');
const T = timePointYear(1000);

function emptyProject(): DomainProject {
  return {
    histories: [],
    settings: {
      calendarId: 'gregorian',
      geo: createGeoParams(40000, 0.0034),
      gridSpacingDeg: 10,
      snapDistancePx: 50,
      autoColorDefault: true,
    },
    baseMap: { source: 's', meta: { lonWest: -180, lonEast: 180, latNorth: 90, latSouth: -90 } },
  };
}

/** A triangular leaf with explicit vertex bodies. */
function triLeaf(
  idRaw: string,
  vids: readonly [string, string, string],
  coords: readonly [
    { lon: number; lat: number },
    { lon: number; lat: number },
    { lon: number; lat: number },
  ],
): { feature: LeafFeature; vertices: Vertex[] } {
  const vertices = vids.map((v, i) => createVertex(asVertexId(v), coords[i]!));
  const ring = createTerritoryRing(asRingId(`r-${idRaw}`), vids.map(asVertexId));
  const feature = createLeafFeature(
    asFeatureId(idRaw),
    createBasicAttributes(idRaw, 0, 0),
    color,
    createShape([ring]),
  );
  return { feature, vertices };
}

/** Resolve the (single) feature with `id` in the effective snapshot at time T. */
function featureAt(root: DomainProject, id: string): LeafFeature | undefined {
  for (const h of root.histories) {
    const r = resolveAt(h.series, T, calendar);
    if (r.kind !== 'present') continue;
    const f = r.entry.anchor.snapshot.features.find((x) => x.id === asFeatureId(id));
    if (f !== undefined && f.kind === 'leaf') return f;
  }
  return undefined;
}

/** All vertex ids cited by a leaf's rings. */
function leafVertexIds(leaf: LeafFeature): VertexId[] {
  return leaf.shape.rings.flatMap((r) => [...r.vertexIds]);
}

/** Build a DomainProject with two histories (feature A and feature B). */
function seedTwoLeaves(
  a: { feature: LeafFeature; vertices: Vertex[] },
  b: { feature: LeafFeature; vertices: Vertex[] },
): DomainProject {
  let root = applyAddProposal(emptyProject(), {
    featureId: a.feature.id,
    anchorTime: T,
    snapshot: { feature: a.feature, vertices: a.vertices, sharedCandidateIds: new Map() },
  });
  root = applyAddProposal(root, {
    featureId: b.feature.id,
    anchorTime: T,
    snapshot: { feature: b.feature, vertices: b.vertices, sharedCandidateIds: new Map() },
  });
  return root;
}

describe('snap-to-share apply (bughunt regression)', () => {
  it('applyEditProposal collapses the dragged vertex onto the target id (FR-31)', () => {
    // Feature A owns vertex "a2"; feature B owns vertex "b0". The user drags A's a2
    // onto B's b0 (snap survives) → confirmRelease forwards sharePair {a2, b0}.
    const a = triLeaf('A', ['a0', 'a1', 'a2'], [
      { lon: 0, lat: 0 },
      { lon: 2, lat: 0 },
      { lon: 1, lat: 2 },
    ]);
    const b = triLeaf('B', ['b0', 'b1', 'b2'], [
      { lon: 5, lat: 5 }, // b0 is the snap target
      { lon: 7, lat: 5 },
      { lon: 6, lat: 7 },
    ]);
    const root = seedTwoLeaves(a, b);

    // After the drag, A's a2 has been moved onto b0's coordinate.
    const movedA2: Vertex = createVertex(asVertexId('a2'), { lon: 5, lat: 5 });
    const snapshot: FeatureSnapshot = {
      feature: a.feature,
      vertices: [movedA2],
      sharePair: { dragged: asVertexId('a2'), target: asVertexId('b0') },
    };
    const proposal = createEditProposal(a.feature.id, T, snapshot);

    const next = applyEditProposal(root, proposal, calendar);

    const aAfter = featureAt(next, 'A')!;
    const bAfter = featureAt(next, 'B')!;
    expect(aAfter).toBeDefined();
    expect(bAfter).toBeDefined();

    // The dragged id a2 is gone from A's ring; it now cites the TARGET id b0.
    expect(leafVertexIds(aAfter)).not.toContain(asVertexId('a2'));
    expect(leafVertexIds(aAfter)).toContain(asVertexId('b0'));
    // B is unchanged, still citing b0.
    expect(leafVertexIds(bAfter)).toContain(asVertexId('b0'));

    // A's anchor store no longer holds the orphaned dragged body; it holds b0 at
    // the snapped coordinate (no dangling reference, single source of truth).
    const aHistory = next.histories.find((h) => h.featureId === a.feature.id)!;
    const aRes = resolveAt(aHistory.series, T, calendar);
    expect(aRes.kind).toBe('present');
    if (aRes.kind !== 'present') return;
    const aStore = aRes.entry.anchor.snapshot.vertices;
    expect(getVertex(aStore, asVertexId('a2'))).toBeUndefined();
    expect(getVertex(aStore, asVertexId('b0'))?.coordinate).toEqual({ lon: 5, lat: 5 });

    // Derived sharing: across BOTH features, b0 is now cited by ≥2 references.
    const containers: ContainerEntry[] = [
      { container: { kind: 'ring', featureId: aAfter.id, ringId: aAfter.shape.rings[0]!.id }, vertexIds: leafVertexIds(aAfter) },
      { container: { kind: 'ring', featureId: bAfter.id, ringId: bAfter.shape.rings[0]!.id }, vertexIds: leafVertexIds(bAfter) },
    ];
    const sv = createSharedVertexState(createVertexStore([]), containers);
    expect(isSharedVertex(sv, asVertexId('b0'))).toBe(true);
    const refs = buildReverseIndex(sv).get(asVertexId('b0')) ?? [];
    expect(refs.length).toBe(2);
  });

  it('a later move of the shared vertex keeps BOTH boundaries joined (no tear, FR-32)', () => {
    // Set up the share, then move b0 (the now-shared vertex) and check both A and B
    // follow it — the pre-fix code left a2 distinct, so only B would have moved and
    // the boundary would tear (gap/overlap).
    const a = triLeaf('A', ['a0', 'a1', 'a2'], [
      { lon: 0, lat: 0 },
      { lon: 2, lat: 0 },
      { lon: 1, lat: 2 },
    ]);
    const b = triLeaf('B', ['b0', 'b1', 'b2'], [
      { lon: 5, lat: 5 },
      { lon: 7, lat: 5 },
      { lon: 6, lat: 7 },
    ]);
    let root = seedTwoLeaves(a, b);

    // 1) Share: drag A.a2 onto B.b0.
    root = applyEditProposal(
      root,
      createEditProposal(a.feature.id, T, {
        feature: a.feature,
        vertices: [createVertex(asVertexId('a2'), { lon: 5, lat: 5 })],
        sharePair: { dragged: asVertexId('a2'), target: asVertexId('b0') },
      } satisfies FeatureSnapshot),
      calendar,
    );

    // 2) Now move B's b0 to a new coordinate (a plain vertex move, no share).
    const bAfterShare = featureAt(root, 'B')!;
    const moved = createVertex(asVertexId('b0'), { lon: 9, lat: 9 });
    root = applyEditProposal(
      root,
      createEditProposal(bAfterShare.id, T, {
        feature: bAfterShare,
        vertices: [moved],
      } satisfies FeatureSnapshot),
      calendar,
    );

    // Because A now cites b0, A's resolved boundary must also sit at (9,9) — the
    // shared corner stays joined. Resolution unions every history's store, so we
    // resolve b0's coordinate from B's history and confirm A references that id.
    const aFinal = featureAt(root, 'A')!;
    expect(leafVertexIds(aFinal)).toContain(asVertexId('b0'));

    const bHistory = root.histories.find((h) => h.featureId === bAfterShare.id)!;
    const bRes = resolveAt(bHistory.series, T, calendar);
    expect(bRes.kind).toBe('present');
    if (bRes.kind !== 'present') return;
    expect(getVertex(bRes.entry.anchor.snapshot.vertices, asVertexId('b0'))?.coordinate).toEqual({
      lon: 9,
      lat: 9,
    });
    // The torn-apart id (a2) must NOT have resurfaced anywhere.
    for (const h of root.histories) {
      const r = resolveAt(h.series, T, calendar);
      if (r.kind !== 'present') continue;
      for (const f of r.entry.anchor.snapshot.features) {
        if (f.kind !== 'leaf') continue;
        expect(leafVertexIds(f)).not.toContain(asVertexId('a2'));
      }
    }
  });

  it('property: any surviving sharePair makes the dragged id unreferenced and the target shared', () => {
    const idArb = fc.constantFrom('a0', 'a1', 'a2');
    fc.assert(
      fc.property(idArb, (draggedRaw) => {
        const a = triLeaf('A', ['a0', 'a1', 'a2'], [
          { lon: 0, lat: 0 },
          { lon: 2, lat: 0 },
          { lon: 1, lat: 2 },
        ]);
        const b = triLeaf('B', ['b0', 'b1', 'b2'], [
          { lon: 5, lat: 5 },
          { lon: 7, lat: 5 },
          { lon: 6, lat: 7 },
        ]);
        const root = seedTwoLeaves(a, b);
        const dragged = asVertexId(draggedRaw);
        const target = asVertexId('b0');
        const next = applyEditProposal(
          root,
          createEditProposal(a.feature.id, T, {
            feature: a.feature,
            vertices: [createVertex(dragged, { lon: 5, lat: 5 })],
            sharePair: { dragged, target },
          } satisfies FeatureSnapshot),
          calendar,
        );
        const aAfter = featureAt(next, 'A')!;
        const bAfter = featureAt(next, 'B')!;
        // Dragged id is collapsed; target appears in A; sharing is derivable.
        expect(leafVertexIds(aAfter)).not.toContain(dragged);
        expect(leafVertexIds(aAfter)).toContain(target);
        const sv = createSharedVertexState(createVertexStore([]), [
          { container: { kind: 'ring', featureId: aAfter.id, ringId: aAfter.shape.rings[0]!.id }, vertexIds: leafVertexIds(aAfter) },
          { container: { kind: 'ring', featureId: bAfter.id, ringId: bAfter.shape.rings[0]!.id }, vertexIds: leafVertexIds(bAfter) },
        ]);
        expect(isSharedVertex(sv, target)).toBe(true);
        // A's own anchor store has no dangling reference: every cited id resolves.
        const aH = next.histories.find((h) => h.featureId === a.feature.id)!;
        const aR = resolveAt(aH.series, T, calendar);
        if (aR.kind !== 'present') return;
        for (const id of leafVertexIds(aAfter)) {
          expect(getVertex(aR.entry.anchor.snapshot.vertices, id)).toBeDefined();
        }
      }),
      { seed: 4242, numRuns: 50 },
    );
  });
});
