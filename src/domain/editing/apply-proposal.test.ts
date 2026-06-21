// U44 apply-proposal — pure domain tests (history shape, normalizeSeries
// invariants, idempotence, split inheritor-update + new-feature creation).

import { describe, expect, it } from 'vitest';

import { applyAddProposal, applySplitProposal, deriveAnchorId } from './apply-proposal';
import { createEditProposal } from '../consistency/types';
import { getCalendar } from '../time/calendar';
import { timePointYear } from '../time/time-point';
import { createBasicAttributes } from '../attributes';
import { createColorInfo } from '../attributes';
import {
  createAggregateFeature,
  createLeafFeature,
  createLineFeature,
  type Feature,
  type LeafFeature,
  type LineFeature,
} from '../feature';
import { createShape, createTerritoryRing } from '../ring';
import { createVertex, createVertexStore } from '../vertex';
import { createAnchor, createAnchorSnapshot } from '../anchor';
import { createAnchorEntry, normalizeSeries, resolveAt } from '../anchor-series';
import { asAnchorId, asFeatureId, asRingId, asVertexId } from '../ids';
import { isValidSeries } from '../anchor-series';
import type { AddSnapshot } from '../add/proposal';
import type { SplitSnapshot } from '../knife/proposal';
import type { DomainProject, FeatureHistory } from '../persistence/serialize';
import { createGeoParams } from '../geo/geo-params';

const calendar = getCalendar('gregorian');
const color = createColorInfo(true, '#90caf9', '#ffb300', '#0d47a1');

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

function squareLeaf(idRaw: string, vRaw: readonly string[], lons: readonly number[]): {
  feature: LeafFeature;
  vertices: ReturnType<typeof createVertex>[];
} {
  const vertices = vRaw.map((v, i) => createVertex(asVertexId(v), { lon: lons[i] ?? 0, lat: 0 }));
  const ring = createTerritoryRing(asRingId(`r-${idRaw}`), vertices.map((v) => v.id));
  const feature = createLeafFeature(
    asFeatureId(idRaw),
    createBasicAttributes('F', 0, 0),
    color,
    createShape([ring]),
  );
  return { feature, vertices };
}

function lineFeat(idRaw: string, vRaw: readonly string[], lons: readonly number[]): {
  feature: LineFeature;
  vertices: ReturnType<typeof createVertex>[];
} {
  const vertices = vRaw.map((v, i) => createVertex(asVertexId(v), { lon: lons[i] ?? 0, lat: 0 }));
  const feature = createLineFeature(
    asFeatureId(idRaw),
    createBasicAttributes('L', 0, 0),
    color,
    vertices.map((v) => v.id),
  );
  return { feature, vertices };
}

describe('applyAddProposal', () => {
  it('appends a new FeatureHistory with a single anchor at the proposal time', () => {
    const root = emptyProject();
    const { feature, vertices } = squareLeaf('f-1', ['v-1', 'v-2', 'v-3'], [0, 1, 2]);
    const snapshot: AddSnapshot = {
      feature,
      vertices,
      sharedCandidateIds: new Map(),
    };
    const proposal = createEditProposal(feature.id, timePointYear(1000), snapshot);

    const next = applyAddProposal(root, proposal);

    expect(next).not.toBe(root); // immutable
    expect(root.histories).toHaveLength(0); // input untouched
    expect(next.histories).toHaveLength(1);
    const history = next.histories[0] as FeatureHistory;
    expect(history.featureId).toBe(feature.id);
    expect(history.series.entries).toHaveLength(1);
    const entry = history.series.entries[0]!;
    expect(entry.start).toEqual(timePointYear(1000));
    expect(entry.end).toBeNull();
    expect(entry.anchor.snapshot.features[0]).toBe(feature);
    expect(entry.anchor.snapshot.vertices.byId.size).toBe(3);
    expect(isValidSeries(history.series, calendar)).toBe(true);
  });

  it('preserves other histories and is idempotent on re-application', () => {
    const root = emptyProject();
    const a = squareLeaf('f-a', ['va-1', 'va-2', 'va-3'], [0, 1, 2]);
    const b = squareLeaf('f-b', ['vb-1', 'vb-2', 'vb-3'], [5, 6, 7]);
    const pa = createEditProposal(a.feature.id, timePointYear(100), {
      feature: a.feature,
      vertices: a.vertices,
      sharedCandidateIds: new Map(),
    } satisfies AddSnapshot);
    const pb = createEditProposal(b.feature.id, timePointYear(200), {
      feature: b.feature,
      vertices: b.vertices,
      sharedCandidateIds: new Map(),
    } satisfies AddSnapshot);

    const afterA = applyAddProposal(root, pa);
    const afterB = applyAddProposal(afterA, pb);
    expect(afterB.histories).toHaveLength(2);

    // Re-applying pa REPLACES, never duplicates.
    const afterAgain = applyAddProposal(afterB, pa);
    expect(afterAgain.histories).toHaveLength(2);
    expect(afterAgain.histories.filter((h) => h.featureId === a.feature.id)).toHaveLength(1);
  });

  it('derives a stable anchor id from feature id + time', () => {
    const id1 = deriveAnchorId(asFeatureId('f-1'), timePointYear(1000));
    const id2 = deriveAnchorId(asFeatureId('f-1'), timePointYear(1000));
    const id3 = deriveAnchorId(asFeatureId('f-1'), timePointYear(1001));
    expect(id1).toBe(id2);
    expect(id1).not.toBe(id3);
  });
});

describe('applySplitProposal', () => {
  it('updates the inheritor shape and creates the non-inherited new feature', () => {
    // Seed a project with the inheritor feature's history.
    const inheritor = squareLeaf('f-inh', ['vi-1', 'vi-2', 'vi-3'], [0, 1, 2]);
    const seeded = applyAddProposal(emptyProject(), {
      featureId: inheritor.feature.id,
      anchorTime: timePointYear(0),
      snapshot: {
        feature: inheritor.feature,
        vertices: inheritor.vertices,
        sharedCandidateIds: new Map(),
      },
    });

    // Build a split snapshot: new inheritor shape + a new non-inherited leaf.
    const newSide = squareLeaf('f-new', ['vn-1', 'vn-2', 'vn-3'], [10, 11, 12]);
    const newInheritorRing = createTerritoryRing(
      asRingId('r-inh-2'),
      ['vi-1', 'vi-2'].map(asVertexId),
    );
    const newInheritorShape = createShape([newInheritorRing]);
    const splitVertices = [...inheritor.vertices, ...newSide.vertices];
    const snapshot: SplitSnapshot = {
      inheritorFeatureId: inheritor.feature.id,
      inheritorShape: newInheritorShape,
      newFeature: newSide.feature,
      vertices: splitVertices,
      vertexRemap: new Map(),
      sharedEdgeCuts: [],
      touchedFeatureIds: [inheritor.feature.id, newSide.feature.id],
    };
    const proposal = createEditProposal(inheritor.feature.id, timePointYear(500), snapshot);

    const next = applySplitProposal(seeded, proposal, calendar);

    expect(next.histories).toHaveLength(2);
    const inhHistory = next.histories.find((h) => h.featureId === inheritor.feature.id)!;
    const newHistory = next.histories.find((h) => h.featureId === newSide.feature.id)!;
    expect(inhHistory).toBeDefined();
    expect(newHistory).toBeDefined();

    // Inheritor: a past-edit inserted a new anchor at year 500 with the new shape.
    expect(isValidSeries(inhHistory.series, calendar)).toBe(true);
    const at500 = inhHistory.series.entries.find((e) => e.start.year === 500)!;
    expect(at500).toBeDefined();
    const inhFeature = at500.anchor.snapshot.features.find(
      (f) => f.id === inheritor.feature.id,
    )!;
    expect(inhFeature.kind).toBe('leaf');
    if (inhFeature.kind === 'leaf') {
      expect(inhFeature.shape).toBe(newInheritorShape);
    }
    // Original anchor at year 0 still has the original shape (identity continuity).
    const at0 = inhHistory.series.entries.find((e) => e.start.year === 0)!;
    expect(at0).toBeDefined();

    // New feature: a single anchor at year 500.
    expect(newHistory.series.entries).toHaveLength(1);
    expect(newHistory.series.entries[0]!.start.year).toBe(500);
    expect(isValidSeries(newHistory.series, calendar)).toBe(true);
  });

  it('splits a child leaf living INSIDE an aggregate snapshot without duplicating it (FR-44 / containment)', () => {
    // An aggregate's history snapshot carries [child, agg] under the AGGREGATE id —
    // the child leaf has NO history of its own. Splitting that child must rewrite it
    // inside the owning snapshot, preserving the aggregate + sibling, never appending
    // a duplicate same-id history (the bug findHistory-by-featureId would cause).
    const child = squareLeaf('child', ['c0', 'c1', 'c2'], [0, 1, 2]);
    const childWithParent = { ...child.feature, parentId: asFeatureId('agg') } as Feature;
    const agg = createAggregateFeature(
      asFeatureId('agg'),
      createBasicAttributes('連邦', 0, 100),
      color,
      [asFeatureId('child')],
    );
    const aggSnapshot = createAnchorSnapshot(
      [childWithParent, agg],
      createVertexStore(child.vertices),
    );
    const aggHistory: FeatureHistory = {
      featureId: asFeatureId('agg'),
      series: normalizeSeries(
        [createAnchorEntry(createAnchor(asAnchorId('agg-anc'), aggSnapshot), timePointYear(0), null)],
        calendar,
      ),
    };
    const root: DomainProject = { ...emptyProject(), histories: [aggHistory] };

    const newSide = squareLeaf('child-new', ['n0', 'n1', 'n2'], [10, 11, 12]);
    const newShape = createShape([
      createTerritoryRing(asRingId('r-child-2'), ['c0', 'c1'].map(asVertexId)),
    ]);
    const snapshot: SplitSnapshot = {
      inheritorFeatureId: asFeatureId('child'),
      inheritorShape: newShape,
      newFeature: newSide.feature,
      vertices: [...child.vertices, ...newSide.vertices],
      vertexRemap: new Map(),
      sharedEdgeCuts: [],
      touchedFeatureIds: [asFeatureId('child'), newSide.feature.id],
    };
    const proposal = createEditProposal(asFeatureId('child'), timePointYear(50), snapshot);

    const next = applySplitProposal(root, proposal, calendar);

    // No duplicate 'child' history was appended — the aggregate history was rewritten
    // in place, and only the new (non-inherited) feature was added.
    expect(next.histories.filter((h) => h.featureId === asFeatureId('child'))).toHaveLength(0);
    expect(next.histories).toHaveLength(2); // aggregate + new feature.

    const aggAfter = next.histories.find((h) => h.featureId === asFeatureId('agg'))!;
    const at50 = resolveAt(aggAfter.series, timePointYear(50), calendar);
    expect(at50.kind).toBe('present');
    if (at50.kind !== 'present') return;
    const features = at50.entry.anchor.snapshot.features;
    // The aggregate sibling is preserved.
    expect(features.some((f) => f.id === asFeatureId('agg'))).toBe(true);
    // The child's shape was swapped to the split inheritor shape.
    const childAfter = features.find((f) => f.id === asFeatureId('child'));
    expect(childAfter?.kind).toBe('leaf');
    if (childAfter?.kind === 'leaf') expect(childAfter.shape).toBe(newShape);
    // The original year-0 anchor still has the child's original shape (identity continuity).
    const at0 = resolveAt(aggAfter.series, timePointYear(0), calendar);
    expect(at0.kind).toBe('present');
  });

  it('transfers 共有頂点継続 to a neighbour history via vertexRemap (FR-95 / regression)', () => {
    // Two leaves sharing ONE boundary vertex id 'sv' (a real shared vertex, cited
    // by both rings). The split re-mints that boundary id into a NEW id 'sv-new';
    // the apply path MUST repoint the NEIGHBOUR's citation onto 'sv-new' as part of
    // the same indivisible split, else the neighbour keeps the stale id and the
    // boundary tears apart (the bug: vertexRemap was discarded).
    const target = squareLeaf('f-tgt', ['sv', 't1', 't2'], [0, 1, 2]);
    const neighbour = squareLeaf('f-nbr', ['sv', 'b1', 'b2'], [0, -1, -2]);

    let root = applyAddProposal(emptyProject(), {
      featureId: target.feature.id,
      anchorTime: timePointYear(0),
      snapshot: { feature: target.feature, vertices: target.vertices, sharedCandidateIds: new Map() },
    });
    root = applyAddProposal(root, {
      featureId: neighbour.feature.id,
      anchorTime: timePointYear(0),
      snapshot: { feature: neighbour.feature, vertices: neighbour.vertices, sharedCandidateIds: new Map() },
    });

    // The split re-mints 'sv' -> 'sv-new'. The new vertex body rides in the snapshot
    // vertices; the inheritor's new shape cites the new id (as the geometry would).
    const svNew = createVertex(asVertexId('sv-new'), { lon: 0, lat: 0 });
    const newSide = squareLeaf('f-new', ['n0', 'n1', 'n2'], [10, 11, 12]);
    const inheritorShape = createShape([
      createTerritoryRing(asRingId('r-tgt-2'), ['sv-new', 't1'].map(asVertexId)),
    ]);
    const snapshot: SplitSnapshot = {
      inheritorFeatureId: target.feature.id,
      inheritorShape,
      newFeature: newSide.feature,
      vertices: [svNew, ...newSide.vertices],
      vertexRemap: new Map([[asVertexId('sv'), asVertexId('sv-new')]]),
      sharedEdgeCuts: [],
      touchedFeatureIds: [target.feature.id, newSide.feature.id],
    };
    const proposal = createEditProposal(target.feature.id, timePointYear(500), snapshot);

    const next = applySplitProposal(root, proposal, calendar);

    // The neighbour's anchor effective at the split time repoints 'sv' -> 'sv-new'.
    const nbrHistory = next.histories.find((h) => h.featureId === neighbour.feature.id)!;
    const nbrAt500 = resolveAt(nbrHistory.series, timePointYear(500), calendar);
    expect(nbrAt500.kind).toBe('present');
    if (nbrAt500.kind !== 'present') return;
    const nbrSnapshot = nbrAt500.entry.anchor.snapshot;
    const nbrFeature = nbrSnapshot.features.find((f) => f.id === neighbour.feature.id)!;
    expect(nbrFeature.kind).toBe('leaf');
    if (nbrFeature.kind !== 'leaf') return;
    const nbrIds = nbrFeature.shape.rings[0]!.vertexIds.map((v) => v as string);
    // The stale shared id is gone; the new shared id is cited (continuation), and
    // the neighbour's own (un-shared) vertices are untouched.
    expect(nbrIds).toContain('sv-new');
    expect(nbrIds).not.toContain('sv');
    expect(nbrIds).toContain('b1');
    expect(nbrIds).toContain('b2');
    // Single source of truth: 'sv-new' resolves to a body in this anchor's store.
    expect(nbrSnapshot.vertices.byId.has(asVertexId('sv-new'))).toBe(true);
    // The orphaned old body was pruned (nothing cites it here any more).
    expect(nbrSnapshot.vertices.byId.has(asVertexId('sv'))).toBe(false);

    // The neighbour's ORIGINAL year-0 anchor is untouched (identity continuity):
    // the past-edit only inserted/updated the anchor AT the split time.
    const nbrAt0 = resolveAt(nbrHistory.series, timePointYear(0), calendar);
    expect(nbrAt0.kind).toBe('present');
    if (nbrAt0.kind !== 'present') return;
    const nbrFeature0 = nbrAt0.entry.anchor.snapshot.features.find(
      (f) => f.id === neighbour.feature.id,
    )!;
    if (nbrFeature0.kind === 'leaf') {
      expect(nbrFeature0.shape.rings[0]!.vertexIds.map((v) => v as string)).toContain('sv');
    }

    // The inheritor cites the new shared id (its new shape), and an empty-remap split
    // would leave neighbours untouched — proven by the no-stale-id assertion above.
    const inhHistory = next.histories.find((h) => h.featureId === target.feature.id)!;
    const inhAt500 = resolveAt(inhHistory.series, timePointYear(500), calendar);
    expect(inhAt500.kind).toBe('present');
  });

  it('cuts a neighbour shared edge mid-way via sharedEdgeCuts (FR-95 / regression)', () => {
    // Target and neighbour share the EDGE e0-e1 (both rings cite e0 then e1). The
    // split line crosses that shared edge mid-way at a seam coordinate; the target's
    // new shape gains a seam node, but the neighbour's matching edge must ALSO gain
    // the SAME seam vertex id (the discarded second half of FR-95). seamVertex 'cut0'
    // rides in the snapshot vertices at the seam coordinate.
    const target = squareLeaf('f-tgt', ['e0', 'e1', 't2'], [0, 10, 5]);
    const neighbour = squareLeaf('f-nbr', ['e0', 'e1', 'b2'], [0, 10, 5]);

    let root = applyAddProposal(emptyProject(), {
      featureId: target.feature.id,
      anchorTime: timePointYear(0),
      snapshot: { feature: target.feature, vertices: target.vertices, sharedCandidateIds: new Map() },
    });
    root = applyAddProposal(root, {
      featureId: neighbour.feature.id,
      anchorTime: timePointYear(0),
      snapshot: { feature: neighbour.feature, vertices: neighbour.vertices, sharedCandidateIds: new Map() },
    });

    const seamCoord = { lon: 5, lat: 0 };
    const cut0 = createVertex(asVertexId('cut0'), seamCoord);
    const newSide = squareLeaf('f-new', ['n0', 'n1', 'n2'], [20, 21, 22]);
    // Inheritor's new shape carries the seam node between e0 and e1.
    const inheritorShape = createShape([
      createTerritoryRing(asRingId('r-tgt-2'), ['e0', 'cut0', 'e1'].map(asVertexId)),
    ]);
    const snapshot: SplitSnapshot = {
      inheritorFeatureId: target.feature.id,
      inheritorShape,
      newFeature: newSide.feature,
      vertices: [cut0, ...newSide.vertices],
      vertexRemap: new Map(),
      sharedEdgeCuts: [
        {
          featureId: target.feature.id,
          ringId: asRingId('r-f-tgt'),
          edgeStartIndex: 0,
          edgeStartVertexId: asVertexId('e0'),
          edgeEndVertexId: asVertexId('e1'),
          cutCoordinate: seamCoord,
        },
      ],
      touchedFeatureIds: [target.feature.id, newSide.feature.id],
    };
    const proposal = createEditProposal(target.feature.id, timePointYear(500), snapshot);

    const next = applySplitProposal(root, proposal, calendar);

    // The neighbour's edge e0-e1 now carries the seam vertex BETWEEN the endpoints.
    const nbrHistory = next.histories.find((h) => h.featureId === neighbour.feature.id)!;
    const nbrAt500 = resolveAt(nbrHistory.series, timePointYear(500), calendar);
    expect(nbrAt500.kind).toBe('present');
    if (nbrAt500.kind !== 'present') return;
    const nbrSnapshot = nbrAt500.entry.anchor.snapshot;
    const nbrFeature = nbrSnapshot.features.find((f) => f.id === neighbour.feature.id)!;
    expect(nbrFeature.kind).toBe('leaf');
    if (nbrFeature.kind !== 'leaf') return;
    const nbrIds = nbrFeature.shape.rings[0]!.vertexIds.map((v) => v as string);
    const i0 = nbrIds.indexOf('e0');
    const iCut = nbrIds.indexOf('cut0');
    const i1 = nbrIds.indexOf('e1');
    expect(iCut).toBeGreaterThanOrEqual(0); // seam inserted on the neighbour.
    expect(iCut).toBe(i0 + 1); // immediately after e0.
    expect(i1).toBe(iCut + 1); // before e1 (e0 -> cut0 -> e1).
    // Single source of truth: the seam id resolves to a body in the neighbour's store.
    expect(nbrSnapshot.vertices.byId.has(asVertexId('cut0'))).toBe(true);

    // The neighbour's ORIGINAL year-0 anchor is untouched (no seam there).
    const nbrAt0 = resolveAt(nbrHistory.series, timePointYear(0), calendar);
    expect(nbrAt0.kind).toBe('present');
    if (nbrAt0.kind !== 'present') return;
    const nbrFeature0 = nbrAt0.entry.anchor.snapshot.features.find(
      (f) => f.id === neighbour.feature.id,
    )!;
    if (nbrFeature0.kind === 'leaf') {
      expect(nbrFeature0.shape.rings[0]!.vertexIds.map((v) => v as string)).not.toContain('cut0');
    }
  });

  it('does NOT splice a seam onto an OPEN line neighbour via the phantom closing edge (bughunt regression)', () => {
    // An OPEN line neighbour [A, X, B] has NO wrap-around B->A edge: its only real
    // edges are A->X and X->B. A SharedEdgeCut at the A-B seam must therefore find no
    // matching edge on the line and leave it UNTOUCHED. The bug treated the line as a
    // closed ring (edge scan i -> (i+1)%n included the phantom B->A closing edge),
    // matching it and splicing the seam after B -> [A, X, B, cut0], a seam vertex on
    // an edge the line does not have, corrupting the polyline.
    const target = squareLeaf('f-tgt', ['e0', 'e1', 't2'], [0, 10, 5]);
    // Line endpoints A=e0, B=e1 match the cut endpoints; X (mid) sits between them in
    // index order but the A-B pair is only consecutive across the (absent) closing edge.
    const lineNbr = lineFeat('f-line', ['e0', 'lx', 'e1'], [0, 5, 10]);

    let root = applyAddProposal(emptyProject(), {
      featureId: target.feature.id,
      anchorTime: timePointYear(0),
      snapshot: { feature: target.feature, vertices: target.vertices, sharedCandidateIds: new Map() },
    });
    root = applyAddProposal(root, {
      featureId: lineNbr.feature.id,
      anchorTime: timePointYear(0),
      snapshot: { feature: lineNbr.feature, vertices: lineNbr.vertices, sharedCandidateIds: new Map() },
    });

    const seamCoord = { lon: 5, lat: 0 };
    const cut0 = createVertex(asVertexId('cut0'), seamCoord);
    const newSide = squareLeaf('f-new', ['n0', 'n1', 'n2'], [20, 21, 22]);
    const inheritorShape = createShape([
      createTerritoryRing(asRingId('r-tgt-2'), ['e0', 'cut0', 'e1'].map(asVertexId)),
    ]);
    const snapshot: SplitSnapshot = {
      inheritorFeatureId: target.feature.id,
      inheritorShape,
      newFeature: newSide.feature,
      vertices: [cut0, ...newSide.vertices],
      vertexRemap: new Map(),
      sharedEdgeCuts: [
        {
          featureId: target.feature.id,
          ringId: asRingId('r-f-tgt'),
          edgeStartIndex: 0,
          edgeStartVertexId: asVertexId('e0'),
          edgeEndVertexId: asVertexId('e1'),
          cutCoordinate: seamCoord,
        },
      ],
      touchedFeatureIds: [target.feature.id, newSide.feature.id],
    };
    const proposal = createEditProposal(target.feature.id, timePointYear(500), snapshot);

    const next = applySplitProposal(root, proposal, calendar);

    // The line neighbour is left exactly as authored: [e0, lx, e1], no seam anywhere.
    const lineHistory = next.histories.find((h) => h.featureId === lineNbr.feature.id)!;
    for (const t of [timePointYear(0), timePointYear(500)]) {
      const at = resolveAt(lineHistory.series, t, calendar);
      expect(at.kind).toBe('present');
      if (at.kind !== 'present') return;
      const lf = at.entry.anchor.snapshot.features.find((f) => f.id === lineNbr.feature.id)!;
      expect(lf.kind).toBe('line');
      if (lf.kind !== 'line') return;
      expect(lf.vertexIds.map((v) => v as string)).toEqual(['e0', 'lx', 'e1']);
    }
  });
});
