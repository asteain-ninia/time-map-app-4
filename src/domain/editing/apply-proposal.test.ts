// U44 apply-proposal — pure domain tests (history shape, normalizeSeries
// invariants, idempotence, split inheritor-update + new-feature creation).

import { describe, expect, it } from 'vitest';

import { applyAddProposal, applySplitProposal, deriveAnchorId } from './apply-proposal';
import { createEditProposal } from '../consistency/types';
import { getCalendar } from '../time/calendar';
import { timePointYear } from '../time/time-point';
import { createBasicAttributes } from '../attributes';
import { createColorInfo } from '../attributes';
import { createLeafFeature, type LeafFeature } from '../feature';
import { createShape, createTerritoryRing } from '../ring';
import { createVertex } from '../vertex';
import { asFeatureId, asRingId, asVertexId } from '../ids';
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
});
