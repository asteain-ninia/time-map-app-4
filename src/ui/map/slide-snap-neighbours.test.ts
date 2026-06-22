// HB3-20 — the slide/snap LIGHT PATH near-candidate query (`neighboursAt`).
//
// Proves the query the App.tsx composition root injects into the live edit session
// turns the LIVE committed domain into the {@link SlideSnapNeighbours} the adapter's
// constrainSlide / decideSnap consume: it returns the OTHER terminals' boundary edges,
// polygons, and snap-candidate vertices NEAR the preview (never the dragged feature's
// own), narrowed by the U10 RBush + snap world margin. Built from the REAL domain
// factories via the persistence fixtures (教訓 5.39: instantiate, never hand-write).
//
// This is the unit-level lock for the bug 診断 HB3-20 names: the rules were live but the
// UI never fed them inputs, so a dragged vertex tunnelled through a neighbour and never
// snapped. The behavioural E2E (e2e/edit-slide-snap.spec.ts) drives the full live path.

import { describe, expect, it } from 'vitest';

import { timePointYear } from '../../domain/time/time-point';
import { createVertexStore } from '../../domain/vertex';
import type { DomainProject } from '../../domain/persistence/index';
import {
  DEFAULT_BASEMAP,
  DEFAULT_SETTINGS,
  squareLeaf,
  singleAnchorHistory,
} from '../../domain/persistence/fixtures';
import { asFeatureId, asRingId, asVertexId } from '../../domain/ids';
import { beginDrag, EDIT_TOOL, type DragSession } from '../../domain/editing/drag-session';

import { createNeighboursQuery } from './slide-snap-neighbours';

/**
 * A project with two square leaves: A at [0,10]² and B at [12,22]² (a 2° gap). The
 * dragged vertex is A's top-right corner `leaf-a-1` at (10, 0); B's nearest vertices
 * are its left edge corners `leaf-b-0` (12, 0) and `leaf-b-3` (12, 10).
 */
function twoLeafProject(): { root: DomainProject } {
  const a = squareLeaf('leaf-a', 'A国', 0, 0, 10);
  const b = squareLeaf('leaf-b', 'B国', 12, 0, 10);
  const root: DomainProject = {
    histories: [
      singleAnchorHistory(
        'leaf-a',
        [a.feature, b.feature],
        createVertexStore([...a.vertices, ...b.vertices]),
        0,
      ),
    ],
    settings: DEFAULT_SETTINGS,
    baseMap: DEFAULT_BASEMAP,
  };
  return { root };
}

function vertexMoveSession(): DragSession {
  return beginDrag(
    {
      tool: EDIT_TOOL.VertexMove,
      featureId: asFeatureId('leaf-a'),
      vertexId: asVertexId('leaf-a-1'),
      ringId: asRingId('leaf-a-r'),
    },
    { lon: 10, lat: 0 },
  );
}

describe('createNeighboursQuery (HB3-20 slide/snap inputs)', () => {
  it('returns the NEIGHBOUR (leaf-b) edges / polygon / snap vertices, never the dragged feature', () => {
    const { root } = twoLeafProject();
    const query = createNeighboursQuery({
      getRoot: () => root,
      getTime: () => timePointYear(0),
      // A generous world margin so leaf-b (2° away) is in the candidate window.
      snapWorldMargin: () => 5,
    });
    // Preview the dragged vertex pushed toward B (near its left edge at lon≈11).
    const result = query({ lon: 11, lat: 0 }, vertexMoveSession());

    // Candidates / edges belong to leaf-b ONLY (the dragged leaf-a is excluded).
    expect(result.candidates.length).toBeGreaterThan(0);
    expect(result.candidates.every((c) => c.featureId === 'leaf-b')).toBe(true);
    expect(result.edges.length).toBeGreaterThanOrEqual(4); // a square ring has 4 edges.
    expect(result.edges.every((e) => e.featureId === 'leaf-b')).toBe(true);

    // Snap candidates include B's near left-edge vertex and NONE of leaf-a's. The
    // margin window around (11,0) is lon[6,16]×lat[-5,5]: leaf-b-0 (12,0) is inside;
    // leaf-b-3 (12,10) is outside (lat 10 > the 5° margin) — proving the margin filters.
    const snapIds = result.snapCandidates.map((s) => s.vertexId as unknown as string);
    expect(snapIds).toContain('leaf-b-0'); // (12,0) — within 5° of the (11,0) preview.
    expect(snapIds).not.toContain('leaf-b-3'); // (12,10) — outside the lat margin.
    expect(snapIds.some((id) => id.startsWith('leaf-a'))).toBe(false);
  });

  it('narrows by the snap world margin: a zero margin yields no far neighbours', () => {
    const { root } = twoLeafProject();
    const query = createNeighboursQuery({
      getRoot: () => root,
      getTime: () => timePointYear(0),
      snapWorldMargin: () => 0, // exact-coincidence only.
    });
    // Preview at A's own corner: leaf-b (≥2° away) must NOT be selected by the bbox query.
    const result = query({ lon: 10, lat: 0 }, vertexMoveSession());
    expect(result.candidates).toHaveLength(0);
    expect(result.edges).toHaveLength(0);
    expect(result.snapCandidates).toHaveLength(0);
  });

  it('HB3-20 SEAM: includes a neighbour ACROSS the ±180° antimeridian (wrapped distance)', () => {
    // leaf-b sits at lon −179° (its left corner leaf-b-0 = (−179, 0)); the preview is at
    // lon 179° — only 2° apart across the seam, but 358° apart by raw subtraction. The
    // bare-difference bug excluded it; the wrapped distance (shortestLonDeltaDeg) + the
    // ±360° query probe must include it (review-confirmed HIGH defect, 単一真実源 R3).
    const a = squareLeaf('leaf-a', 'A国', 0, 0, 10);
    const b = squareLeaf('leaf-b', 'B国', -179, 0, 5);
    const root: DomainProject = {
      histories: [
        singleAnchorHistory(
          'leaf-a',
          [a.feature, b.feature],
          createVertexStore([...a.vertices, ...b.vertices]),
          0,
        ),
      ],
      settings: DEFAULT_SETTINGS,
      baseMap: DEFAULT_BASEMAP,
    };
    const query = createNeighboursQuery({
      getRoot: () => root,
      getTime: () => timePointYear(0),
      snapWorldMargin: () => 5,
    });
    const result = query({ lon: 179, lat: 0 }, vertexMoveSession());
    expect(result.candidates.some((c) => c.featureId === 'leaf-b')).toBe(true);
    expect(result.edges.some((e) => e.featureId === 'leaf-b')).toBe(true);
    const snapIds = result.snapCandidates.map((s) => s.vertexId as unknown as string);
    expect(snapIds).toContain('leaf-b-0'); // (−179,0) is 2° from the (179,0) preview across the seam.
  });

  it('excludes the dragged feature even when the preview is inside its own bbox', () => {
    const { root } = twoLeafProject();
    const query = createNeighboursQuery({
      getRoot: () => root,
      getTime: () => timePointYear(0),
      snapWorldMargin: () => 3,
    });
    // Preview deep inside leaf-a: leaf-a never appears as its own candidate / snap target.
    const result = query({ lon: 5, lat: 5 }, vertexMoveSession());
    expect(result.candidates.every((c) => c.featureId !== 'leaf-a')).toBe(true);
    expect(
      result.snapCandidates.every((s) => !String(s.vertexId).startsWith('leaf-a')),
    ).toBe(true);
  });
});
