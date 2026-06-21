// Bug-hunt regression — focus: a duplicate-owner FeatureHistory is allowed and an
// edit may target the WRONG (earlier) history (editing/apply-proposal.ts +
// persistence/consistency.ts).
//
// THE BUG (medium severity, area=persistence):
//   `findHistoryContaining` first called `findHistory`, which returns the FIRST
//   FeatureHistory whose `featureId` matches — regardless of `anchorTime`. When a
//   project (corrupt / hand-edited / legacy) holds TWO histories for the same
//   featureId over DISJOINT periods, an edit at the LATER period resolved to the
//   FIRST (earlier-period) history and was inserted there — silently corrupting the
//   wrong timeline. `consistency.ts` also never flagged two histories sharing one
//   featureId, so the project loaded clean.
//
// THE FIX (two parts, root):
//   1. `findHistoryContaining` now routes by EFFECTIVE CONTAINMENT at the edit time:
//      it returns the own-keyed history only when that history actually carries the
//      feature AT `anchorTime`; otherwise it scans for the history whose effective
//      snapshot contains the feature at that time (so the later edit lands in the
//      later history). A defensive own-keyed fallback remains for absent-everywhere.
//   2. `checkConsistency` now emits `DuplicateOwnerHistory` when two histories share
//      one featureId, and `repair.ts` offers DropDuplicateOwnerHistories.
//
// These tests would FAIL on the pre-fix code (the edit wrote into the earlier
// history). Run ONLY this file:
//   npx vitest run src/domain/__bughunt__/duplicate-owner-history-edit-routing.property.test.ts

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { applyEditProposal } from '../editing/apply-proposal';
import { createEditProposal } from '../consistency/types';
import { checkConsistency, INCONSISTENCY } from '../persistence/consistency';
import { getCalendar } from '../time/calendar';
import { timePointYear } from '../time/time-point';
import { createBasicAttributes, createColorInfo } from '../attributes';
import { createLeafFeature, type LeafFeature } from '../feature';
import { createShape, createTerritoryRing } from '../ring';
import { createVertex, createVertexStore, type Vertex } from '../vertex';
import { createAnchor, createAnchorSnapshot } from '../anchor';
import { createAnchorEntry, normalizeSeries, resolveAt } from '../anchor-series';
import { asAnchorId, asFeatureId, asRingId, asVertexId } from '../ids';
import type { FeatureSnapshot } from '../editing/edit-flow';
import type { DomainProject, FeatureHistory } from '../persistence/serialize';
import { createGeoParams } from '../geo/geo-params';

const calendar = getCalendar('gregorian');
const color = createColorInfo(true, '#90caf9', '#ffb300', '#0d47a1');
const FID = asFeatureId('dup');

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

/** A triangular leaf (shared FID), with the given vertex ids + coordinates. */
function triLeaf(
  vids: readonly [string, string, string],
  coords: readonly [
    { lon: number; lat: number },
    { lon: number; lat: number },
    { lon: number; lat: number },
  ],
): { feature: LeafFeature; vertices: Vertex[] } {
  const vertices = vids.map((v, i) => createVertex(asVertexId(v), coords[i]!));
  const ring = createTerritoryRing(asRingId(`r-${vids[0]}`), vids.map(asVertexId));
  const feature = createLeafFeature(FID, createBasicAttributes('国', 0, 0), color, createShape([ring]));
  return { feature, vertices };
}

/**
 * Build a project with TWO histories for the SAME featureId over DISJOINT periods:
 *   - EARLY history: bounded entry [0, 500) carrying `early`.
 *   - LATE  history: open entry  [500, ∞) carrying `late`.
 * (Two separate FeatureHistory entries, both keyed by FID — the corrupt state.)
 */
function duplicateOwnerProject(
  early: { feature: LeafFeature; vertices: Vertex[] },
  late: { feature: LeafFeature; vertices: Vertex[] },
): DomainProject {
  const earlyHistory: FeatureHistory = {
    featureId: FID,
    series: normalizeSeries(
      [
        createAnchorEntry(
          createAnchor(asAnchorId('early-anc'), createAnchorSnapshot([early.feature], createVertexStore(early.vertices))),
          timePointYear(0),
          timePointYear(500),
        ),
      ],
      calendar,
    ),
  };
  const lateHistory: FeatureHistory = {
    featureId: FID,
    series: normalizeSeries(
      [
        createAnchorEntry(
          createAnchor(asAnchorId('late-anc'), createAnchorSnapshot([late.feature], createVertexStore(late.vertices))),
          timePointYear(500),
          null,
        ),
      ],
      calendar,
    ),
  };
  return { ...emptyProject(), histories: [earlyHistory, lateHistory] };
}

describe('duplicate-owner history edit-routing (bughunt regression)', () => {
  it('an edit at the LATE period lands in the LATE history, not the earlier duplicate', () => {
    const early = triLeaf(['e0', 'e1', 'e2'], [
      { lon: 0, lat: 0 },
      { lon: 2, lat: 0 },
      { lon: 1, lat: 2 },
    ]);
    const late = triLeaf(['l0', 'l1', 'l2'], [
      { lon: 10, lat: 10 },
      { lon: 12, lat: 10 },
      { lon: 11, lat: 12 },
    ]);
    const root = duplicateOwnerProject(early, late);

    // Edit at year 1000 (well inside the LATE period): move l0.
    const movedL0: Vertex = createVertex(asVertexId('l0'), { lon: 99, lat: 99 });
    const editedLate: LeafFeature = {
      ...late.feature,
      shape: createShape([createTerritoryRing(asRingId('r-l0'), ['l0', 'l1', 'l2'].map(asVertexId))]),
    };
    const snapshot: FeatureSnapshot = { feature: editedLate, vertices: [movedL0] };
    const next = applyEditProposal(root, createEditProposal(FID, timePointYear(1000), snapshot), calendar);

    // Identify the two histories by their anchor ids (order is preserved by the op).
    const earlyAfter = next.histories.find((h) => h.series.entries.some((e) => e.anchor.id === 'early-anc'))!;
    const lateAfter = next.histories.find((h) => h.series.entries.some((e) => e.anchor.id === 'late-anc'))!;

    // The LATE history received the edit: l0 now resolves to the moved coordinate.
    const lateRes = resolveAt(lateAfter.series, timePointYear(1000), calendar);
    expect(lateRes.kind).toBe('present');
    if (lateRes.kind !== 'present') return;
    const lateStore = lateRes.entry.anchor.snapshot.vertices;
    expect(lateStore.byId.get(asVertexId('l0'))?.coordinate).toEqual({ lon: 99, lat: 99 });

    // The EARLY history is UNTOUCHED — the pre-fix code wrote the edit here (the bug).
    const earlyRes = resolveAt(earlyAfter.series, timePointYear(100), calendar);
    expect(earlyRes.kind).toBe('present');
    if (earlyRes.kind !== 'present') return;
    const earlyStore = earlyRes.entry.anchor.snapshot.vertices;
    // The early snapshot never cited l0, and the edit must not have leaked into it.
    expect(earlyStore.byId.has(asVertexId('l0'))).toBe(false);
    // Its own vertex e0 keeps its original coordinate.
    expect(earlyStore.byId.get(asVertexId('e0'))?.coordinate).toEqual({ lon: 0, lat: 0 });
    // The early entry's id-string is unchanged (no new anchor inserted there).
    expect(earlyAfter.series.entries.map((e) => e.anchor.id)).toEqual(['early-anc']);
  });

  it('an edit at the EARLY period still lands in the EARLY history (symmetry)', () => {
    const early = triLeaf(['e0', 'e1', 'e2'], [
      { lon: 0, lat: 0 },
      { lon: 2, lat: 0 },
      { lon: 1, lat: 2 },
    ]);
    const late = triLeaf(['l0', 'l1', 'l2'], [
      { lon: 10, lat: 10 },
      { lon: 12, lat: 10 },
      { lon: 11, lat: 12 },
    ]);
    const root = duplicateOwnerProject(early, late);

    const movedE0: Vertex = createVertex(asVertexId('e0'), { lon: -5, lat: -5 });
    const editedEarly: LeafFeature = {
      ...early.feature,
      shape: createShape([createTerritoryRing(asRingId('r-e0'), ['e0', 'e1', 'e2'].map(asVertexId))]),
    };
    const next = applyEditProposal(
      root,
      createEditProposal(FID, timePointYear(100), { feature: editedEarly, vertices: [movedE0] }),
      calendar,
    );

    const earlyAfter = next.histories.find((h) => h.series.entries.some((e) => e.anchor.id === 'early-anc'))!;
    const lateAfter = next.histories.find((h) => h.series.entries.some((e) => e.anchor.id === 'late-anc'))!;

    // The EARLY history received the edit; e0 moved.
    const earlyRes = resolveAt(earlyAfter.series, timePointYear(100), calendar);
    expect(earlyRes.kind).toBe('present');
    if (earlyRes.kind !== 'present') return;
    expect(earlyRes.entry.anchor.snapshot.vertices.byId.get(asVertexId('e0'))?.coordinate).toEqual({
      lon: -5,
      lat: -5,
    });

    // The LATE history is untouched: l0 keeps its original coordinate.
    const lateRes = resolveAt(lateAfter.series, timePointYear(1000), calendar);
    expect(lateRes.kind).toBe('present');
    if (lateRes.kind !== 'present') return;
    expect(lateRes.entry.anchor.snapshot.vertices.byId.get(asVertexId('l0'))?.coordinate).toEqual({
      lon: 10,
      lat: 10,
    });
  });

  it('consistency flags the duplicate-owner state (so a load never silently keeps it)', () => {
    const early = triLeaf(['e0', 'e1', 'e2'], [
      { lon: 0, lat: 0 },
      { lon: 2, lat: 0 },
      { lon: 1, lat: 2 },
    ]);
    const late = triLeaf(['l0', 'l1', 'l2'], [
      { lon: 10, lat: 10 },
      { lon: 12, lat: 10 },
      { lon: 11, lat: 12 },
    ]);
    const report = checkConsistency(duplicateOwnerProject(early, late), calendar);
    const inc = report.inconsistencies.find((i) => i.kind === INCONSISTENCY.DuplicateOwnerHistory);
    expect(inc).toBeDefined();
    expect(inc!.featureIds).toContain(FID);
  });

  it('property: an edit at any time routes into the history effective at that time', () => {
    fc.assert(
      fc.property(fc.integer({ min: 501, max: 5000 }), (year) => {
        const early = triLeaf(['e0', 'e1', 'e2'], [
          { lon: 0, lat: 0 },
          { lon: 2, lat: 0 },
          { lon: 1, lat: 2 },
        ]);
        const late = triLeaf(['l0', 'l1', 'l2'], [
          { lon: 10, lat: 10 },
          { lon: 12, lat: 10 },
          { lon: 11, lat: 12 },
        ]);
        const root = duplicateOwnerProject(early, late);
        const moved = createVertex(asVertexId('l0'), { lon: 77, lat: 77 });
        const editedLate: LeafFeature = {
          ...late.feature,
          shape: createShape([createTerritoryRing(asRingId('r-l0'), ['l0', 'l1', 'l2'].map(asVertexId))]),
        };
        const next = applyEditProposal(
          root,
          createEditProposal(FID, timePointYear(year), { feature: editedLate, vertices: [moved] }),
          calendar,
        );
        const earlyAfter = next.histories.find((h) => h.series.entries.some((e) => e.anchor.id === 'early-anc'))!;
        // The early history is never the target for a late-period edit.
        expect(earlyAfter.series.entries.map((e) => e.anchor.id)).toEqual(['early-anc']);
        const earlyRes = resolveAt(earlyAfter.series, timePointYear(100), calendar);
        if (earlyRes.kind === 'present') {
          expect(earlyRes.entry.anchor.snapshot.vertices.byId.has(asVertexId('l0'))).toBe(false);
        }
      }),
      { seed: 7777, numRuns: 50 },
    );
  });
});
