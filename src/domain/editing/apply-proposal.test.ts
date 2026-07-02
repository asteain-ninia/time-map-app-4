// U44 apply-proposal — pure domain tests (history shape, normalizeSeries
// invariants, idempotence, split inheritor-update + new-feature creation).

import { describe, expect, it } from 'vitest';

import { applyAddProposal, applyEditProposal, applyMergeProposal, applySplitProposal, deriveAnchorId } from './apply-proposal';
import { createEditProposal } from '../consistency/types';
import { MERGE_STATUS, buildMergeProposal, toMergeEditProposal } from '../merge/proposal';
import { parentNone, propertyNew } from '../merge/decision';
import { makeIdPorts } from '../merge/fixtures';
import { getCalendar } from '../time/calendar';
import { timePointYear } from '../time/time-point';
import { createBasicAttributes } from '../attributes';
import { createColorInfo } from '../attributes';
import {
  createAggregateFeature,
  createLeafFeature,
  createLineFeature,
  withLeafShape,
  type Feature,
  type LeafFeature,
  type LineFeature,
} from '../feature';
import type { FeatureSnapshot } from './edit-flow';
import { createShape, createTerritoryRing } from '../ring';
import { createVertex, createVertexStore, setVertex, withVertexCoordinate } from '../vertex';
import { createAnchor, createAnchorSnapshot } from '../anchor';
import { createAnchorEntry, normalizeSeries, resolveAt } from '../anchor-series';
import { checkConsistency, INCONSISTENCY } from '../persistence/consistency';
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

  it('cuts a neighbour shared edge at MULTIPLE points, all seams transferred in edge order (FR-95 / bughunt regression)', () => {
    // Target and neighbour share the edge e0-e1 (e0 at lon 0, e1 at lon 10). The split
    // line crosses that ONE shared edge at TWO mid-edge points (lon 3 and lon 7). The
    // target's new shape gains BOTH seam nodes; the neighbour's matching edge must ALSO
    // gain BOTH seam vertices, in edge-parameter order (e0 -> cut3 -> cut7 -> e1).
    //
    // The bug: seams were spliced one-cut-at-a-time, so after the FIRST seam was
    // inserted between e0 and e1 they were no longer consecutive — the SECOND cut on
    // the same edge matched nothing and the neighbour was left missing it (boundary
    // tear on a later move). This asserts BOTH seams land and in the correct order even
    // though the cuts are listed REVERSED (cut7 before cut3) in sharedEdgeCuts.
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

    const coord3 = { lon: 3, lat: 0 };
    const coord7 = { lon: 7, lat: 0 };
    const cut3 = createVertex(asVertexId('cut3'), coord3);
    const cut7 = createVertex(asVertexId('cut7'), coord7);
    const newSide = squareLeaf('f-new', ['n0', 'n1', 'n2'], [20, 21, 22]);
    // Inheritor's new shape carries BOTH seam nodes between e0 and e1, in order.
    const inheritorShape = createShape([
      createTerritoryRing(asRingId('r-tgt-2'), ['e0', 'cut3', 'cut7', 'e1'].map(asVertexId)),
    ]);
    const snapshot: SplitSnapshot = {
      inheritorFeatureId: target.feature.id,
      inheritorShape,
      newFeature: newSide.feature,
      vertices: [cut3, cut7, ...newSide.vertices],
      vertexRemap: new Map(),
      // Listed REVERSED on purpose (cut7 first): the splice must order by edge parameter.
      sharedEdgeCuts: [
        {
          featureId: target.feature.id,
          ringId: asRingId('r-f-tgt'),
          edgeStartIndex: 0,
          edgeStartVertexId: asVertexId('e0'),
          edgeEndVertexId: asVertexId('e1'),
          cutCoordinate: coord7,
        },
        {
          featureId: target.feature.id,
          ringId: asRingId('r-f-tgt'),
          edgeStartIndex: 0,
          edgeStartVertexId: asVertexId('e0'),
          edgeEndVertexId: asVertexId('e1'),
          cutCoordinate: coord3,
        },
      ],
      touchedFeatureIds: [target.feature.id, newSide.feature.id],
    };
    const proposal = createEditProposal(target.feature.id, timePointYear(500), snapshot);

    const next = applySplitProposal(root, proposal, calendar);

    const nbrHistory = next.histories.find((h) => h.featureId === neighbour.feature.id)!;
    const nbrAt500 = resolveAt(nbrHistory.series, timePointYear(500), calendar);
    expect(nbrAt500.kind).toBe('present');
    if (nbrAt500.kind !== 'present') return;
    const nbrSnapshot = nbrAt500.entry.anchor.snapshot;
    const nbrFeature = nbrSnapshot.features.find((f) => f.id === neighbour.feature.id)!;
    expect(nbrFeature.kind).toBe('leaf');
    if (nbrFeature.kind !== 'leaf') return;
    const nbrIds = nbrFeature.shape.rings[0]!.vertexIds.map((v) => v as string);
    // BOTH seams present, in edge order between e0 and e1.
    const i0 = nbrIds.indexOf('e0');
    const i3 = nbrIds.indexOf('cut3');
    const i7 = nbrIds.indexOf('cut7');
    const i1 = nbrIds.indexOf('e1');
    expect(i3).toBeGreaterThanOrEqual(0);
    expect(i7).toBeGreaterThanOrEqual(0);
    expect(i3).toBe(i0 + 1); // e0 -> cut3
    expect(i7).toBe(i3 + 1); // cut3 -> cut7
    expect(i1).toBe(i7 + 1); // cut7 -> e1
    // Single source of truth: BOTH seam ids resolve to bodies in the neighbour's store.
    expect(nbrSnapshot.vertices.byId.has(asVertexId('cut3'))).toBe(true);
    expect(nbrSnapshot.vertices.byId.has(asVertexId('cut7'))).toBe(true);

    // The neighbour's ORIGINAL year-0 anchor is untouched (no seams there).
    const nbrAt0 = resolveAt(nbrHistory.series, timePointYear(0), calendar);
    expect(nbrAt0.kind).toBe('present');
    if (nbrAt0.kind !== 'present') return;
    const nbrFeature0 = nbrAt0.entry.anchor.snapshot.features.find(
      (f) => f.id === neighbour.feature.id,
    )!;
    if (nbrFeature0.kind === 'leaf') {
      const ids0 = nbrFeature0.shape.rings[0]!.vertexIds.map((v) => v as string);
      expect(ids0).not.toContain('cut3');
      expect(ids0).not.toContain('cut7');
    }
  });

  // --- 新地物履歴に継承地物の非共有頂点の孤児コピーが焼き込まれない（data整合・第11波 HIGH）--
  //
  // 分割の新地物アンカーは、分割プール全体の vertexStore（継承地物の未変更・非共有な境界
  // 頂点、n-way では他新地物の私的頂点まで含む）をそのまま焼くと、新地物が cite しない孤児
  // コピーを抱える。後で継承地物がその非共有頂点を移動すると、継承地物の履歴は新座標、新地物
  // の履歴は焼き込んだ旧座標のまま乖離し、checkConsistency が偽の VertexCoordinateDivergence
  // を発火させる（load 時に ReconcileVertexCoordinate 修復ダイアログに化ける）。merge スライス
  // (applyMergeProposal step3) / drill スライス (applyDrillProposal step2) と対称に、新地物
  // アンカーは自参照のみへ剪定されねばならない。分割は cut 境界を継承地物と新地物が共有する
  // (双方が同じ cut 頂点 id を cite) ので、剪定 [nf] は共有 cut 境界を保持し（両側履歴で保持
  // され一致＝整合）、非共有な私的頂点だけを落とす（境界は裂けない）。
  it('新地物履歴アンカーの store は新地物が cite する id のみ（継承地物の非共有頂点の孤児なし・共有 cut 境界は保持）', () => {
    // 継承地物 f-inh の頂点: vi-1(共有 cut 境界), vi-2, vi-3(継承地物の私的・非共有).
    const inheritor = squareLeaf('f-inh', ['vi-1', 'vi-2', 'vi-3'], [0, 1, 2]);
    const seeded = applyAddProposal(emptyProject(), {
      featureId: inheritor.feature.id,
      anchorTime: timePointYear(0),
      snapshot: { feature: inheritor.feature, vertices: inheritor.vertices, sharedCandidateIds: new Map() },
    });

    // 新地物 f-new は共有 cut 境界 vi-1 を cite し、加えて自分の私的頂点 vn-1, vn-2 を持つ.
    // 継承地物の新形状は vi-1(共有), vi-2, vi-3(非共有) を cite する.
    const vn1 = createVertex(asVertexId('vn-1'), { lon: 10, lat: 0 });
    const vn2 = createVertex(asVertexId('vn-2'), { lon: 11, lat: 0 });
    const newSideFeature = createLeafFeature(
      asFeatureId('f-new'),
      createBasicAttributes('F', 0, 0),
      color,
      createShape([createTerritoryRing(asRingId('r-f-new'), ['vi-1', 'vn-1', 'vn-2'].map(asVertexId))]),
    );
    const newInheritorShape = createShape([
      createTerritoryRing(asRingId('r-inh-2'), ['vi-1', 'vi-2', 'vi-3'].map(asVertexId)),
    ]);
    const snapshot: SplitSnapshot = {
      inheritorFeatureId: inheritor.feature.id,
      inheritorShape: newInheritorShape,
      newFeature: newSideFeature,
      vertices: [...inheritor.vertices, vn1, vn2],
      vertexRemap: new Map(),
      sharedEdgeCuts: [],
      touchedFeatureIds: [inheritor.feature.id, newSideFeature.id],
    };
    const proposal = createEditProposal(inheritor.feature.id, timePointYear(500), snapshot);

    const next = applySplitProposal(seeded, proposal, calendar);

    const nfHist = next.histories.find((h) => h.featureId === newSideFeature.id)!;
    const nfSnap = nfHist.series.entries.find((e) => e.start.year === 500)!.anchor.snapshot;

    const citedIds = newSideFeature.shape.rings.flatMap((r) => r.vertexIds);
    const citedStrings = citedIds.map((v) => v as string);
    const storeStrings = [...nfSnap.vertices.byId.keys()].map((v) => v as string);

    // store は cite する id 集合と完全一致（孤児コピー 0）— merge createdIds / drill 経路と対称.
    expect([...storeStrings].sort()).toEqual([...citedStrings].sort());
    // 継承地物の非共有な私的頂点 vi-2 / vi-3 は新地物 store に混入しない（孤児コピーの直接検証）.
    expect(nfSnap.vertices.byId.has(asVertexId('vi-2'))).toBe(false);
    expect(nfSnap.vertices.byId.has(asVertexId('vi-3'))).toBe(false);
    // 共有 cut 境界 vi-1 は新地物が cite するので保持される（境界が裂けない根拠）.
    expect(nfSnap.vertices.byId.has(asVertexId('vi-1'))).toBe(true);
    // それでも新地物は自己完結（cite する全 id が store で解決できる — dangling 無し）.
    for (const cid of citedIds) {
      expect(nfSnap.vertices.byId.has(cid)).toBe(true);
    }
  });

  it('分割後に継承地物の非共有頂点を移動しても偽 VertexCoordinateDivergence が出ない', () => {
    const inheritor = squareLeaf('f-inh', ['vi-1', 'vi-2', 'vi-3'], [0, 1, 2]);
    const seeded = applyAddProposal(emptyProject(), {
      featureId: inheritor.feature.id,
      anchorTime: timePointYear(0),
      snapshot: { feature: inheritor.feature, vertices: inheritor.vertices, sharedCandidateIds: new Map() },
    });
    const vn1 = createVertex(asVertexId('vn-1'), { lon: 10, lat: 0 });
    const vn2 = createVertex(asVertexId('vn-2'), { lon: 11, lat: 0 });
    const newSideFeature = createLeafFeature(
      asFeatureId('f-new'),
      createBasicAttributes('F', 0, 0),
      color,
      createShape([createTerritoryRing(asRingId('r-f-new'), ['vi-1', 'vn-1', 'vn-2'].map(asVertexId))]),
    );
    const newInheritorShape = createShape([
      createTerritoryRing(asRingId('r-inh-2'), ['vi-1', 'vi-2', 'vi-3'].map(asVertexId)),
    ]);
    const snapshot: SplitSnapshot = {
      inheritorFeatureId: inheritor.feature.id,
      inheritorShape: newInheritorShape,
      newFeature: newSideFeature,
      vertices: [...inheritor.vertices, vn1, vn2],
      vertexRemap: new Map(),
      sharedEdgeCuts: [],
      touchedFeatureIds: [inheritor.feature.id, newSideFeature.id],
    };
    const next = applySplitProposal(
      seeded,
      createEditProposal(inheritor.feature.id, timePointYear(500), snapshot),
      calendar,
    );

    // 継承地物 f-inh の 500 スナップショットから、その非共有頂点 vi-3 を通常の形状編集で移動する
    // （id 列は不変、body だけ移動 = 同 id・新座標）.
    const inhHist = next.histories.find((h) => h.featureId === inheritor.feature.id)!;
    const oSnap = inhHist.series.entries.find((e) => e.start.year === 500)!.anchor.snapshot;
    const oFeat = oSnap.features.find((f) => f.id === inheritor.feature.id)!;
    expect(oFeat.kind).toBe('leaf');
    if (oFeat.kind !== 'leaf') return;
    const movedId = asVertexId('vi-3');
    const movedBody = createVertex(movedId, { lon: -7, lat: -7 });
    const movedFeature = withLeafShape(oFeat, oFeat.shape); // 形状（id 列）不変、body のみ移動.
    const moveSnapshot: FeatureSnapshot = { feature: movedFeature, vertices: [movedBody] };
    const afterMove = applyEditProposal(
      next,
      createEditProposal(inheritor.feature.id, timePointYear(500), moveSnapshot),
      calendar,
    );

    // 継承地物の履歴は移動後座標を持つ.
    const nInhHist = afterMove.histories.find((h) => h.featureId === inheritor.feature.id)!;
    const nInhSnap = nInhHist.series.entries.find((e) => e.start.year === 500)!.anchor.snapshot;
    expect(nInhSnap.vertices.byId.get(movedId)!.coordinate.lon).toBeCloseTo(-7);
    expect(nInhSnap.vertices.byId.get(movedId)!.coordinate.lat).toBeCloseTo(-7);

    // 偽の VertexCoordinateDivergence が発火しない（新地物履歴に vi-3 の孤児旧コピーが無い）.
    const report = checkConsistency(afterMove, calendar);
    const divergence = report.inconsistencies.find(
      (i) => i.kind === INCONSISTENCY.VertexCoordinateDivergence,
    );
    expect(divergence).toBeUndefined();
  });

  // --- 逆方向: 継承地物 step1 アンカーに新地物の私的頂点の孤児コピーが焼き込まれない ------
  //  （data整合・第11波 #1 HIGH）
  //
  // step2（新地物アンカー）は既に自参照のみへ剪定済（上記2テスト）。だが step1（継承地物側）は
  // mergedVertices = createVertexStore([...base.vertices, ...vertices]) が分割プール全体（新地物
  // の私的頂点 vn-* を含む）を継承地物の履歴アンカーへそのまま焼くため、継承地物が cite しない
  // 新地物私的頂点の孤児コピーを抱える。後で新地物が自分の私的頂点を移動すると、新地物の履歴は
  // 新座標・継承地物の step1 孤児は旧座標のまま乖離し、checkConsistency が偽の
  // VertexCoordinateDivergence を発火（load 時に ReconcileVertexCoordinate 修復に化ける）。step2
  // と対称に step1 mergedVertices も snapshot feature 集合（継承地物 + 全 sibling）へ剪定されねば
  // ならない。分割の共有 cut 境界 vi-1 は継承地物が cite するので剪定後も保持され、境界は裂けない。
  it('継承地物 step1 アンカーの store は継承地物が cite する id のみ（新地物私的頂点の孤児なし・共有 cut 境界は保持）', () => {
    const inheritor = squareLeaf('f-inh', ['vi-1', 'vi-2', 'vi-3'], [0, 1, 2]);
    const seeded = applyAddProposal(emptyProject(), {
      featureId: inheritor.feature.id,
      anchorTime: timePointYear(0),
      snapshot: { feature: inheritor.feature, vertices: inheritor.vertices, sharedCandidateIds: new Map() },
    });
    const vn1 = createVertex(asVertexId('vn-1'), { lon: 10, lat: 0 });
    const vn2 = createVertex(asVertexId('vn-2'), { lon: 11, lat: 0 });
    const newSideFeature = createLeafFeature(
      asFeatureId('f-new'),
      createBasicAttributes('F', 0, 0),
      color,
      createShape([createTerritoryRing(asRingId('r-f-new'), ['vi-1', 'vn-1', 'vn-2'].map(asVertexId))]),
    );
    // 継承地物の新形状は共有 cut 境界 vi-1 + 私的 vi-2/vi-3 を cite する（vn-* は cite しない）.
    const newInheritorShape = createShape([
      createTerritoryRing(asRingId('r-inh-2'), ['vi-1', 'vi-2', 'vi-3'].map(asVertexId)),
    ]);
    const snapshot: SplitSnapshot = {
      inheritorFeatureId: inheritor.feature.id,
      inheritorShape: newInheritorShape,
      newFeature: newSideFeature,
      vertices: [...inheritor.vertices, vn1, vn2],
      vertexRemap: new Map(),
      sharedEdgeCuts: [],
      touchedFeatureIds: [inheritor.feature.id, newSideFeature.id],
    };
    const next = applySplitProposal(
      seeded,
      createEditProposal(inheritor.feature.id, timePointYear(500), snapshot),
      calendar,
    );

    const inhHist = next.histories.find((h) => h.featureId === inheritor.feature.id)!;
    const inhSnap = inhHist.series.entries.find((e) => e.start.year === 500)!.anchor.snapshot;

    const inhFeat = inhSnap.features.find((f) => f.id === inheritor.feature.id)!;
    const citedIds = inhFeat.kind === 'leaf'
      ? inhFeat.shape.rings.flatMap((r) => r.vertexIds)
      : [];
    const citedStrings = citedIds.map((v) => v as string);
    const storeStrings = [...inhSnap.vertices.byId.keys()].map((v) => v as string);

    // store は継承地物が cite する id 集合と完全一致（新地物私的頂点の孤児コピー 0）.
    expect([...storeStrings].sort()).toEqual([...citedStrings].sort());
    // 新地物の私的頂点 vn-1 / vn-2 は継承地物 step1 store に混入しない（孤児コピーの直接検証）.
    expect(inhSnap.vertices.byId.has(asVertexId('vn-1'))).toBe(false);
    expect(inhSnap.vertices.byId.has(asVertexId('vn-2'))).toBe(false);
    // 共有 cut 境界 vi-1 は継承地物が cite するので保持される（境界が裂けない根拠）.
    expect(inhSnap.vertices.byId.has(asVertexId('vi-1'))).toBe(true);
    // 継承地物は自己完結（cite する全 id が store で解決できる — dangling 無し）.
    for (const cid of citedIds) {
      expect(inhSnap.vertices.byId.has(cid)).toBe(true);
    }
  });

  it('分割後に新地物の私的頂点を移動しても偽 VertexCoordinateDivergence が出ない（step1 逆方向）', () => {
    const inheritor = squareLeaf('f-inh', ['vi-1', 'vi-2', 'vi-3'], [0, 1, 2]);
    const seeded = applyAddProposal(emptyProject(), {
      featureId: inheritor.feature.id,
      anchorTime: timePointYear(0),
      snapshot: { feature: inheritor.feature, vertices: inheritor.vertices, sharedCandidateIds: new Map() },
    });
    const vn1 = createVertex(asVertexId('vn-1'), { lon: 10, lat: 0 });
    const vn2 = createVertex(asVertexId('vn-2'), { lon: 11, lat: 0 });
    const newSideFeature = createLeafFeature(
      asFeatureId('f-new'),
      createBasicAttributes('F', 0, 0),
      color,
      createShape([createTerritoryRing(asRingId('r-f-new'), ['vi-1', 'vn-1', 'vn-2'].map(asVertexId))]),
    );
    const newInheritorShape = createShape([
      createTerritoryRing(asRingId('r-inh-2'), ['vi-1', 'vi-2', 'vi-3'].map(asVertexId)),
    ]);
    const snapshot: SplitSnapshot = {
      inheritorFeatureId: inheritor.feature.id,
      inheritorShape: newInheritorShape,
      newFeature: newSideFeature,
      vertices: [...inheritor.vertices, vn1, vn2],
      vertexRemap: new Map(),
      sharedEdgeCuts: [],
      touchedFeatureIds: [inheritor.feature.id, newSideFeature.id],
    };
    const next = applySplitProposal(
      seeded,
      createEditProposal(inheritor.feature.id, timePointYear(500), snapshot),
      calendar,
    );

    // 新地物 f-new の 500 スナップショットから、その私的頂点 vn-1 を通常の形状編集で移動する
    // （id 列は不変、body だけ移動 = 同 id・新座標）.
    const nfHist = next.histories.find((h) => h.featureId === newSideFeature.id)!;
    const nSnap = nfHist.series.entries.find((e) => e.start.year === 500)!.anchor.snapshot;
    const nFeat = nSnap.features.find((f) => f.id === newSideFeature.id)!;
    expect(nFeat.kind).toBe('leaf');
    if (nFeat.kind !== 'leaf') return;
    const movedId = asVertexId('vn-1');
    const movedBody = createVertex(movedId, { lon: -9, lat: -9 });
    const movedFeature = withLeafShape(nFeat, nFeat.shape); // 形状（id 列）不変、body のみ移動.
    const moveSnapshot: FeatureSnapshot = { feature: movedFeature, vertices: [movedBody] };
    const afterMove = applyEditProposal(
      next,
      createEditProposal(newSideFeature.id, timePointYear(500), moveSnapshot),
      calendar,
    );

    // 新地物の履歴は移動後座標を持つ.
    const mHist = afterMove.histories.find((h) => h.featureId === newSideFeature.id)!;
    const mSnap = mHist.series.entries.find((e) => e.start.year === 500)!.anchor.snapshot;
    expect(mSnap.vertices.byId.get(movedId)!.coordinate.lon).toBeCloseTo(-9);
    expect(mSnap.vertices.byId.get(movedId)!.coordinate.lat).toBeCloseTo(-9);

    // 偽の VertexCoordinateDivergence が発火しない（継承地物 step1 履歴に vn-1 の孤児旧コピーが無い）.
    const report = checkConsistency(afterMove, calendar);
    const divergence = report.inconsistencies.find(
      (i) => i.kind === INCONSISTENCY.VertexCoordinateDivergence,
    );
    expect(divergence).toBeUndefined();
  });
});

describe('applyMergeProposal', () => {
  // Collect EVERY vertex id any feature in an anchor snapshot cites (ring vertices,
  // line vertices, point vertex). A reference to an id absent from that snapshot's
  // vertex store is a dangling reference — the seam tears on the next move/resolve.
  function citedVertexIds(features: readonly Feature[]): Set<string> {
    const cited = new Set<string>();
    for (const f of features) {
      if (f.kind === 'leaf') {
        for (const ring of f.shape.rings) for (const v of ring.vertexIds) cited.add(v as string);
      } else if (f.kind === 'line') {
        for (const v of f.vertexIds) cited.add(v as string);
      } else if (f.kind === 'point') {
        cited.add(f.vertexId as string);
      }
    }
    return cited;
  }

  it('repoints a NEIGHBOUR sharing a merged boundary vertex (FR-95 / dangling regression)', () => {
    // Leaf-only merge re-mints the union boundary into NEW vertex ids. Three leaves:
    //   A = square [0,0]-[10,10], B = square [10,10]-[20,20] touch ONLY at corner
    //   (10,10), citing it by the SAME VertexId 'sc' (a real shared corner). A third
    //   leaf C = square [10,10]-[20,0] ALSO cites 'sc' at (10,10) but is NOT a merge
    //   target. Merging A+B re-mints the corner 'sc' -> a new id; C still cites the
    //   OLD 'sc'. The apply path MUST repoint C onto the new id as part of the same
    //   indivisible merge (mirroring the split path's applyVertexRemapToHistories),
    //   else the old body is orphaned and C's ring holds a dangling reference.
    const sc = asVertexId('sc'); // corner (10,10), shared by A, B and the neighbour C.
    const va0 = createVertex(asVertexId('a-v0'), { lon: 0, lat: 0 });
    const va1 = createVertex(asVertexId('a-v1'), { lon: 10, lat: 0 });
    const vscBody = createVertex(sc, { lon: 10, lat: 10 });
    const va3 = createVertex(asVertexId('a-v3'), { lon: 0, lat: 10 });
    const vb1 = createVertex(asVertexId('b-v1'), { lon: 20, lat: 10 });
    const vb2 = createVertex(asVertexId('b-v2'), { lon: 20, lat: 20 });
    const vb3 = createVertex(asVertexId('b-v3'), { lon: 10, lat: 20 });
    const vc1 = createVertex(asVertexId('c-v1'), { lon: 20, lat: 0 });
    const vc2 = createVertex(asVertexId('c-v2'), { lon: 20, lat: 10 });
    const vc3 = createVertex(asVertexId('c-v3'), { lon: 10, lat: 0 });

    const aRing = createTerritoryRing(asRingId('a-r0'), [va0.id, va1.id, sc, va3.id]);
    const bRing = createTerritoryRing(asRingId('b-r0'), [sc, vb1.id, vb2.id, vb3.id]);
    // C touches the shared corner (10,10) via 'sc' (truly shared), but is not merged.
    const cRing = createTerritoryRing(asRingId('c-r0'), [vc3.id, vc1.id, vc2.id, sc]);
    // Periods span the merge time (500) so all three exist at the merge (precondition).
    const a = createLeafFeature(asFeatureId('a'), createBasicAttributes('a', 0, 1000), color, createShape([aRing]));
    const b = createLeafFeature(asFeatureId('b'), createBasicAttributes('b', 0, 1000), color, createShape([bRing]));
    const cFeature = createLeafFeature(asFeatureId('c'), createBasicAttributes('c', 0, 1000), color, createShape([cRing]));

    const features: Feature[] = [a, b, cFeature];
    const store = createVertexStore([va0, va1, vscBody, va3, vb1, vb2, vb3, vc1, vc2, vc3]);

    // Seed all three leaves' histories into a project, each effective at the merge time.
    let root: DomainProject = emptyProject();
    for (const f of [a, b, cFeature]) {
      const fStore = createVertexStore(
        [...store.byId.values()].filter((v) => citedVertexIds([f]).has(v.id as string)),
      );
      root = applyAddProposal(root, {
        featureId: f.id,
        anchorTime: timePointYear(0),
        snapshot: { feature: f, vertices: [...fStore.byId.values()], sharedCandidateIds: new Map() },
      });
    }

    // Build the REAL merge proposal for A+B (leaf-only) and confirm 'sc' is re-minted.
    const built = buildMergeProposal({
      features,
      vertices: store,
      targetIds: [asFeatureId('a'), asFeatureId('b')],
      atTime: 500,
      parentDecision: parentNone,
      propertyDecision: propertyNew({
        attributes: createBasicAttributes('merged', 0, 100),
        color,
      }),
      ids: makeIdPorts(),
    });
    expect(built.status).toBe(MERGE_STATUS.Proposal);
    if (built.status !== MERGE_STATUS.Proposal) return;
    const mergeProposal = built.proposal;
    // The shared corner survives as a union boundary vertex and is re-minted.
    expect(mergeProposal.vertexRemap.has(sc)).toBe(true);
    expect(mergeProposal.deletedIds).toContain(asFeatureId('a'));
    expect(mergeProposal.deletedIds).toContain(asFeatureId('b'));
    // C is NOT a target — not deleted, not survived-touched, not created by the merge.
    expect(mergeProposal.deletedIds).not.toContain(asFeatureId('c'));
    expect(mergeProposal.survivedTouchedIds).not.toContain(asFeatureId('c'));
    expect(mergeProposal.createdIds).not.toContain(asFeatureId('c'));

    const editProposal = toMergeEditProposal(mergeProposal, timePointYear(500));
    const next = applyMergeProposal(root, editProposal, calendar);

    // CORE ASSERTION: after the merge, NO surviving feature references a VertexId that
    // is absent from its own anchor snapshot's vertex store at the merge time. If C was
    // left citing the orphaned old 'sc', that id resolves to no body -> dangling.
    for (const history of next.histories) {
      const at = resolveAt(history.series, timePointYear(500), calendar);
      if (at.kind !== 'present') continue;
      const snap = at.entry.anchor.snapshot;
      const cited = citedVertexIds(snap.features);
      for (const vid of cited) {
        expect(
          snap.vertices.byId.has(asVertexId(vid)),
          `feature in history ${history.featureId as string} cites vertex ${vid} absent from its store (dangling)`,
        ).toBe(true);
      }
    }

    // Specifically: C's ring was repointed off the stale 'sc' onto the re-minted id,
    // and that new id resolves to a body in C's anchor store (single source of truth).
    const newSc = mergeProposal.vertexRemap.get(sc)! as string;
    const cHistory = next.histories.find((h) => h.featureId === asFeatureId('c'))!;
    const cAt500 = resolveAt(cHistory.series, timePointYear(500), calendar);
    expect(cAt500.kind).toBe('present');
    if (cAt500.kind !== 'present') return;
    const cSnap = cAt500.entry.anchor.snapshot;
    const cAfter = cSnap.features.find((f) => f.id === asFeatureId('c'))!;
    expect(cAfter.kind).toBe('leaf');
    if (cAfter.kind !== 'leaf') return;
    const cIds = cAfter.shape.rings[0]!.vertexIds.map((v) => v as string);
    expect(cIds).toContain(newSc);
    expect(cIds).not.toContain('sc');
    expect(cSnap.vertices.byId.has(asVertexId(newSc))).toBe(true);

    // C's ORIGINAL year-0 anchor is untouched (identity continuity; past-edit only the
    // anchor effective at the merge time).
    const cAt0 = resolveAt(cHistory.series, timePointYear(0), calendar);
    expect(cAt0.kind).toBe('present');
    if (cAt0.kind !== 'present') return;
    const cFeature0 = cAt0.entry.anchor.snapshot.features.find((f) => f.id === asFeatureId('c'))!;
    if (cFeature0.kind === 'leaf') {
      expect(cFeature0.shape.rings[0]!.vertexIds.map((v) => v as string)).toContain('sc');
    }
  });

  it('a merge with NO sharing neighbour leaves unrelated histories untouched (no-op repoint)', () => {
    // A+B merge as before, but the third leaf D shares NO vertex id with A or B (it
    // sits far away with its own ids). The repoint step must be a no-op for D: its
    // history object is preserved and it still cites exactly its own vertices.
    const sc = asVertexId('sc');
    const va0 = createVertex(asVertexId('a-v0'), { lon: 0, lat: 0 });
    const va1 = createVertex(asVertexId('a-v1'), { lon: 10, lat: 0 });
    const vscBody = createVertex(sc, { lon: 10, lat: 10 });
    const va3 = createVertex(asVertexId('a-v3'), { lon: 0, lat: 10 });
    const vb1 = createVertex(asVertexId('b-v1'), { lon: 20, lat: 10 });
    const vb2 = createVertex(asVertexId('b-v2'), { lon: 20, lat: 20 });
    const vb3 = createVertex(asVertexId('b-v3'), { lon: 10, lat: 20 });

    const aRing = createTerritoryRing(asRingId('a-r0'), [va0.id, va1.id, sc, va3.id]);
    const bRing = createTerritoryRing(asRingId('b-r0'), [sc, vb1.id, vb2.id, vb3.id]);
    const a = createLeafFeature(asFeatureId('a'), createBasicAttributes('a', 0, 1000), color, createShape([aRing]));
    const b = createLeafFeature(asFeatureId('b'), createBasicAttributes('b', 0, 1000), color, createShape([bRing]));
    const d = squareLeaf('d', ['d0', 'd1', 'd2'], [100, 110, 120]);

    const store = createVertexStore([va0, va1, vscBody, va3, vb1, vb2, vb3, ...d.vertices]);

    let root: DomainProject = emptyProject();
    root = applyAddProposal(root, {
      featureId: a.id,
      anchorTime: timePointYear(0),
      snapshot: { feature: a, vertices: [va0, va1, vscBody, va3], sharedCandidateIds: new Map() },
    });
    root = applyAddProposal(root, {
      featureId: b.id,
      anchorTime: timePointYear(0),
      snapshot: { feature: b, vertices: [vscBody, vb1, vb2, vb3], sharedCandidateIds: new Map() },
    });
    root = applyAddProposal(root, {
      featureId: d.feature.id,
      anchorTime: timePointYear(0),
      snapshot: { feature: d.feature, vertices: d.vertices, sharedCandidateIds: new Map() },
    });

    const dHistoryBefore = root.histories.find((h) => h.featureId === d.feature.id)!;

    const built = buildMergeProposal({
      features: [a, b, d.feature],
      vertices: store,
      targetIds: [asFeatureId('a'), asFeatureId('b')],
      atTime: 500,
      parentDecision: parentNone,
      propertyDecision: propertyNew({
        attributes: createBasicAttributes('merged', 0, 100),
        color,
      }),
      ids: makeIdPorts(),
    });
    expect(built.status).toBe(MERGE_STATUS.Proposal);
    if (built.status !== MERGE_STATUS.Proposal) return;

    const next = applyMergeProposal(root, toMergeEditProposal(built.proposal, timePointYear(500)), calendar);

    // D's history is referentially identical (the empty-overlap repoint is a no-op for it).
    const dHistoryAfter = next.histories.find((h) => h.featureId === d.feature.id)!;
    expect(dHistoryAfter).toBe(dHistoryBefore);
    // D still cites exactly its own vertices, all resolving to bodies (no dangling).
    const dAt = resolveAt(dHistoryAfter.series, timePointYear(500), calendar);
    expect(dAt.kind).toBe('present');
    if (dAt.kind !== 'present') return;
    const dSnap = dAt.entry.anchor.snapshot;
    const dCited = citedVertexIds(dSnap.features);
    for (const vid of dCited) expect(dSnap.vertices.byId.has(asVertexId(vid))).toBe(true);
  });

  it('does NOT leak an unrelated feature\'s private vertices into the result history (第7波 divergence)', () => {
    // A+B merge with an UNRELATED, disjoint leaf N present in the merge input (as it
    // would be — buildMergeProposal receives the whole effective snapshot). N shares NO
    // vertex with A/B. The result feature is born a fresh single-feature history; its
    // snapshot store must carry ONLY the result's own union-boundary vertices — never a
    // COPY of N's private vertices. If it did, a later move of N (updating N's OWN
    // history) would disagree with the stale copy and raise a spurious
    // VertexCoordinateDivergence across histories.
    const rectLeaf = (
      id: string,
      corners: readonly [number, number][],
    ): { feature: LeafFeature; vertices: ReturnType<typeof createVertex>[] } => {
      const vertices = corners.map((c, i) => createVertex(asVertexId(`${id}-v${i}`), { lon: c[0], lat: c[1] }));
      const ring = createTerritoryRing(asRingId(`${id}-r0`), vertices.map((v) => v.id));
      const feature = createLeafFeature(asFeatureId(id), createBasicAttributes(id, 0, 1000), color, createShape([ring]));
      return { feature, vertices };
    };
    const a = rectLeaf('a', [[0, 0], [10, 0], [10, 10], [0, 10]]);
    const b = rectLeaf('b', [[10, 0], [20, 0], [20, 10], [10, 10]]); // adjacent to A along x=10.
    const n = rectLeaf('n', [[100, 100], [110, 100], [110, 110], [100, 110]]); // disjoint, unrelated.
    const features: Feature[] = [a.feature, b.feature, n.feature];
    const store = createVertexStore([...a.vertices, ...b.vertices, ...n.vertices]);

    let root: DomainProject = emptyProject();
    for (const { feature, vertices } of [a, b, n]) {
      root = applyAddProposal(root, {
        featureId: feature.id,
        anchorTime: timePointYear(0),
        snapshot: { feature, vertices, sharedCandidateIds: new Map() },
      });
    }

    const built = buildMergeProposal({
      features,
      vertices: store,
      targetIds: [asFeatureId('a'), asFeatureId('b')],
      atTime: 500,
      parentDecision: parentNone,
      propertyDecision: propertyNew({ attributes: createBasicAttributes('merged', 0, 100), color }),
      ids: makeIdPorts(),
    });
    expect(built.status).toBe(MERGE_STATUS.Proposal);
    if (built.status !== MERGE_STATUS.Proposal) return;
    const proposal = built.proposal;
    const merged = applyMergeProposal(root, toMergeEditProposal(proposal, timePointYear(500)), calendar);

    // The result history's snapshot store carries NONE of N's vertices.
    const resultHistory = merged.histories.find((h) => h.featureId === proposal.resultFeatureId)!;
    const rAt = resolveAt(resultHistory.series, timePointYear(500), calendar);
    expect(rAt.kind).toBe('present');
    if (rAt.kind !== 'present') return;
    const rStore = rAt.entry.anchor.snapshot.vertices;
    for (const nv of n.vertices) expect(rStore.byId.has(nv.id)).toBe(false);
    // And it still resolves every vertex the result feature genuinely cites.
    const rCited = citedVertexIds(rAt.entry.anchor.snapshot.features);
    for (const vid of rCited) expect(rStore.byId.has(asVertexId(vid))).toBe(true);

    // Now MOVE N's own vertex (edits N's history only). With the leak fixed no other
    // history holds an N-vertex copy, so the whole project stays consistent.
    const nHistory = merged.histories.find((h) => h.featureId === n.feature.id)!;
    const movedSeries = normalizeSeries(
      nHistory.series.entries.map((entry) => {
        const snap = entry.anchor.snapshot;
        const moved = setVertex(snap.vertices, withVertexCoordinate(n.vertices[0]!, { lon: 999, lat: 999 }));
        return createAnchorEntry(
          createAnchor(entry.anchor.id, createAnchorSnapshot(snap.features, moved)),
          entry.start,
          entry.end,
        );
      }),
      calendar,
    );
    const afterMove: DomainProject = {
      ...merged,
      histories: merged.histories.map((h) =>
        h.featureId === n.feature.id ? { featureId: h.featureId, series: movedSeries } : h,
      ),
    };
    const report = checkConsistency(afterMove, calendar);
    const divergence = report.inconsistencies.find(
      (i) => i.kind === INCONSISTENCY.VertexCoordinateDivergence,
    );
    expect(divergence).toBeUndefined();
  });
});
