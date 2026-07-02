// HB3-9 / HB3-4 — the active-feature edit-handle + live-drag PREVIEW render input.
//
// Proves (HB3-9) the handle layer is computed for the active feature, and (HB3-4) that a
// LIVE drag session moves the handles AND a preview outline to the preview position so
// the vertex / feature follows the cursor and release does not jump. Built from the REAL
// domain factories via the persistence fixtures (教訓 5.39: instantiate, never hand-write).

import { afterEach, describe, expect, it } from 'vitest';

import { timePointYear } from '../../domain/time/time-point';
import { createVertex, createVertexStore } from '../../domain/vertex';
import { createCoordinate } from '../../domain/coordinate';
import type { DomainProject } from '../../domain/persistence/index';
import {
  DEFAULT_BASEMAP,
  DEFAULT_SETTINGS,
  pointFeature,
  squareLeaf,
  singleAnchorHistory,
} from '../../domain/persistence/fixtures';
import { createLeafFeature, createLineFeature } from '../../domain/feature';
import { createBasicAttributes, createColorInfo } from '../../domain/attributes';
import { createShape, createTerritoryRing } from '../../domain/ring';
import { unwrapLonSequence } from '../../domain/geo/longitude';
import { unwrapRingClosed } from '../../domain/geo/seam';
import { asFeatureId, asRingId, asVertexId } from '../../domain/ids';
import { DEFAULT_EDIT_HANDLE_STYLE } from '../../render/edit-handles-layer';
import {
  EDIT_TOOL,
  beginDrag,
  updateDrag,
  type DragSession,
} from '../../domain/editing/drag-session';
import type { HandlePrimitive, LinePrimitive } from '../../render/map-renderer';
import type { DisplayControlInput } from '../../render/display-pipeline';

import {
  buildActiveFeatureHandlePrimitives,
  buildEditPreviewPrimitives,
} from './active-feature-handles';
import { clearDisplayResolutionCache } from './display-resolution-cache';

const DISPLAY: DisplayControlInput = {
  globalDepth: 0,
  focus: { originId: null, depth: 0, emphasize: false },
};

/** A project with one square leaf (4 vertices) effective from year 0. */
function leafProject() {
  const leaf = squareLeaf('leaf-1', 'A国', 0, 0, 10);
  const root: DomainProject = {
    histories: [
      singleAnchorHistory('leaf-1', [leaf.feature], createVertexStore(leaf.vertices), 0),
    ],
    settings: DEFAULT_SETTINGS,
    baseMap: DEFAULT_BASEMAP,
  };
  return { root, leaf };
}

afterEach(() => clearDisplayResolutionCache());

function handles(prims: readonly { kind: string }[]): HandlePrimitive[] {
  return prims.filter((p): p is HandlePrimitive => p.kind === 'handle');
}
function vertexHandles(prims: readonly { kind: string }[]): HandlePrimitive[] {
  return handles(prims).filter((h) => h.handleKind === 'vertex');
}
function lines(prims: readonly { kind: string }[]): LinePrimitive[] {
  return prims.filter((p): p is LinePrimitive => p.kind === 'line');
}

describe('buildActiveFeatureHandlePrimitives (HB3-9 static handles)', () => {
  it('emits a vertex handle per vertex + edge handles for the active leaf', () => {
    const { root } = leafProject();
    const prims = buildActiveFeatureHandlePrimitives(
      root,
      timePointYear(0),
      asFeatureId('leaf-1'),
      DISPLAY,
    );
    // 4 vertices + 4 closed-ring edges.
    expect(vertexHandles(prims)).toHaveLength(4);
    expect(handles(prims)).toHaveLength(8);
    // No live session → NO preview outline.
    expect(lines(prims)).toHaveLength(0);
  });

  it('returns no primitives when there is no active feature', () => {
    const { root } = leafProject();
    expect(
      buildActiveFeatureHandlePrimitives(root, timePointYear(0), null, DISPLAY),
    ).toEqual([]);
  });
});

describe('buildActiveFeatureHandlePrimitives (FR-110 vertexMarkerCap perf gate)', () => {
  it('draws ALL handles when the vertex count is <= cap', () => {
    const { root } = leafProject(); // 4-vertex square
    const prims = buildActiveFeatureHandlePrimitives(
      root,
      timePointYear(0),
      asFeatureId('leaf-1'),
      DISPLAY,
      null,
      undefined,
      undefined,
      4, // cap == count → still all handles
    );
    expect(vertexHandles(prims)).toHaveLength(4);
    expect(handles(prims)).toHaveLength(8);
  });

  it('suppresses ALL handles WHOLESALE (vertex + edge) when count > cap', () => {
    const { root } = leafProject(); // 4-vertex square
    const prims = buildActiveFeatureHandlePrimitives(
      root,
      timePointYear(0),
      asFeatureId('leaf-1'),
      DISPLAY,
      null,
      undefined,
      undefined,
      3, // 4 > 3 → nothing drawn (not a leading-N slice)
    );
    expect(handles(prims)).toHaveLength(0);
    expect(prims).toHaveLength(0);
  });

  it('cap === 0 suppresses all handles', () => {
    const { root } = leafProject();
    const prims = buildActiveFeatureHandlePrimitives(
      root,
      timePointYear(0),
      asFeatureId('leaf-1'),
      DISPLAY,
      null,
      undefined,
      undefined,
      0,
    );
    expect(handles(prims)).toHaveLength(0);
    expect(prims).toHaveLength(0);
  });

  it('undefined cap leaves handles unlimited (default behaviour)', () => {
    const { root } = leafProject();
    const prims = buildActiveFeatureHandlePrimitives(
      root,
      timePointYear(0),
      asFeatureId('leaf-1'),
      DISPLAY,
      null,
      undefined,
      undefined,
      undefined,
    );
    expect(handles(prims)).toHaveLength(8);
  });

  it('gates the live-drag preview too when over cap (perf guard is wholesale)', () => {
    const { root } = leafProject();
    // A live vertex drag would normally draw handles + a preview outline; over cap
    // the whole handle path is suppressed (no partial preview).
    let session: DragSession = beginDrag(
      {
        tool: EDIT_TOOL.VertexMove,
        featureId: asFeatureId('leaf-1'),
        vertexId: asVertexId('leaf-1-0'),
      } as const,
      { lon: 0, lat: 0 },
    );
    session = updateDrag(session, { preview: { lon: 3, lat: 4 } });
    const prims = buildActiveFeatureHandlePrimitives(
      root,
      timePointYear(0),
      asFeatureId('leaf-1'),
      DISPLAY,
      session,
      undefined,
      undefined,
      1, // 4 > 1 → suppress everything, including the preview outline
    );
    expect(prims).toHaveLength(0);
  });
});

describe('buildActiveFeatureHandlePrimitives (HB3-4 live drag preview)', () => {
  it('moves the dragged vertex handle to the preview position (follows the cursor)', () => {
    const { root } = leafProject();
    // Drag vertex leaf-1-0 (committed at (0,0)) to (3,4).
    const target = {
      tool: EDIT_TOOL.VertexMove,
      featureId: asFeatureId('leaf-1'),
      vertexId: asVertexId('leaf-1-0'),
    } as const;
    let session: DragSession = beginDrag(target, { lon: 0, lat: 0 });
    session = updateDrag(session, { preview: { lon: 3, lat: 4 } });

    const prims = buildActiveFeatureHandlePrimitives(
      root,
      timePointYear(0),
      asFeatureId('leaf-1'),
      DISPLAY,
      session,
    );

    // The dragged vertex handle is now at the PREVIEW position, not the committed (0,0).
    const vh = vertexHandles(prims);
    expect(vh.some((h) => h.at.lon === 3 && h.at.lat === 4)).toBe(true);
    expect(vh.some((h) => h.at.lon === 0 && h.at.lat === 0)).toBe(false);
    // A live drag also draws a preview outline (so the SHAPE follows, not just handles).
    expect(lines(prims).length).toBeGreaterThanOrEqual(1);
    // The preview outline contains the moved vertex coordinate.
    expect(
      lines(prims).some((l) => l.points.some((p) => p.lon === 3 && p.lat === 4)),
    ).toBe(true);
  });

  it('a whole-feature move shifts EVERY vertex handle by the drag delta', () => {
    const { root } = leafProject();
    const target = {
      tool: EDIT_TOOL.FeatureMove,
      featureId: asFeatureId('leaf-1'),
    } as const;
    // Press at (1,1), drag to (6,3) → delta (+5,+2).
    let session: DragSession = beginDrag(target, { lon: 1, lat: 1 });
    session = updateDrag(session, { preview: { lon: 6, lat: 3 } });

    const prims = buildActiveFeatureHandlePrimitives(
      root,
      timePointYear(0),
      asFeatureId('leaf-1'),
      DISPLAY,
      session,
    );
    const vh = vertexHandles(prims);
    // Original corners (0,0),(10,0),(10,10),(0,10) shifted by (+5,+2).
    const moved = vh.map((h) => `${h.at.lon},${h.at.lat}`).sort();
    expect(moved).toEqual(['5,2', '15,2', '15,12', '5,12'].sort());
  });

  it('ignores a session that targets a DIFFERENT feature (no stale bleed)', () => {
    const { root } = leafProject();
    const session = beginDrag(
      {
        tool: EDIT_TOOL.VertexMove,
        featureId: asFeatureId('other'),
        vertexId: asVertexId('x'),
      } as const,
      { lon: 99, lat: 99 },
    );
    const prims = buildActiveFeatureHandlePrimitives(
      root,
      timePointYear(0),
      asFeatureId('leaf-1'),
      DISPLAY,
      session,
    );
    // Committed positions only — no preview outline, handle still at (0,0).
    expect(lines(prims)).toHaveLength(0);
    expect(vertexHandles(prims).some((h) => h.at.lon === 0 && h.at.lat === 0)).toBe(true);
  });

  it('previews a point feature drag at the cursor', () => {
    const pt = pointFeature('pt-1', '首都', 50, 30);
    const root: DomainProject = {
      histories: [
        singleAnchorHistory('pt-1', [pt.feature], createVertexStore([pt.vertex]), 0),
      ],
      settings: DEFAULT_SETTINGS,
      baseMap: DEFAULT_BASEMAP,
    };
    const session = updateDrag(
      beginDrag(
        {
          tool: EDIT_TOOL.VertexMove,
          featureId: asFeatureId('pt-1'),
          vertexId: pt.vertex.id,
        } as const,
        { lon: 50, lat: 30 },
      ),
      { preview: { lon: 70, lat: 35 } },
    );
    const prims = buildActiveFeatureHandlePrimitives(
      root,
      timePointYear(0),
      asFeatureId('pt-1'),
      DISPLAY,
      session,
    );
    // The vertex handle AND a preview point marker sit at the cursor.
    expect(vertexHandles(prims).some((h) => h.at.lon === 70 && h.at.lat === 35)).toBe(true);
    const points = prims.filter((p) => p.kind === 'point');
    expect(points.length).toBeGreaterThanOrEqual(1);
  });
});

const COLOR = createColorInfo(true, '#102030', '#405060', '#708090', 'default', 1, 1);

/**
 * Two adjacent square leaves that SHARE one vertex id: `shared-v` is cited by both
 * `leaf-L`'s ring and `leaf-R`'s ring (the two squares touch at that corner). Every
 * other vertex is cited by exactly one ring. Both leaves live in ONE anchor so both
 * are effective (and drawn as their own Real shape) at the same time.
 */
function sharedCornerProject(): DomainProject {
  const shared = createVertex(asVertexId('shared-v'), createCoordinate(10, 0));
  // Left square: corners (0,0),(10,0)=shared,(10,10),(0,10).
  const lVerts = [
    createVertex(asVertexId('lv0'), createCoordinate(0, 0)),
    shared,
    createVertex(asVertexId('lv2'), createCoordinate(10, 10)),
    createVertex(asVertexId('lv3'), createCoordinate(0, 10)),
  ];
  const lRing = createTerritoryRing(asRingId('leaf-L-r'), lVerts.map((v) => v.id));
  const leafL = createLeafFeature(
    asFeatureId('leaf-L'),
    createBasicAttributes('L国', 0, 100),
    COLOR,
    createShape([lRing]),
  );
  // Right square: corners (10,0)=shared,(20,0),(20,10),(10,10).
  const rVerts = [
    shared,
    createVertex(asVertexId('rv1'), createCoordinate(20, 0)),
    createVertex(asVertexId('rv2'), createCoordinate(20, 10)),
    createVertex(asVertexId('rv3'), createCoordinate(10, 10)),
  ];
  const rRing = createTerritoryRing(asRingId('leaf-R-r'), rVerts.map((v) => v.id));
  const leafR = createLeafFeature(
    asFeatureId('leaf-R'),
    createBasicAttributes('R国', 0, 100),
    COLOR,
    createShape([rRing]),
  );
  const store = createVertexStore([...lVerts, ...rVerts]);
  return {
    histories: [
      singleAnchorHistory('grp', [leafL, leafR], store, 0),
    ],
    settings: DEFAULT_SETTINGS,
    baseMap: DEFAULT_BASEMAP,
  };
}

/** The largest adjacent-lon gap magnitude along a polyline's points (no implicit
 * close). A CONTINUOUS run has every gap ≤ 180°; a world-crossing run (folded
 * representatives) spans ~358° across the seam. */
function maxAdjacentGap(points: readonly { lon: number; lat: number }[]): number {
  let max = 0;
  for (let i = 1; i < points.length; i += 1) {
    max = Math.max(max, Math.abs(points[i]!.lon - points[i - 1]!.lon));
  }
  return max;
}

describe('buildEditPreviewPrimitives (Fix C #4 — seam-crossing preview outline unwrap)', () => {
  it('unwraps a seam-crossing LINE preview to a continuous run [179,181] (parity with committed)', () => {
    // A line whose two vertices straddle the antimeridian (lon 179 / lon -179): the
    // committed draw unwraps them to [179, 181] (committed-features.ts:292 via
    // unwrapLonSequence) so the polyline is one 2° segment. The live-drag PREVIEW
    // outline must match — not trace 358° the long way round.
    const va = createVertex(asVertexId('sl-a'), createCoordinate(179, 0));
    const vb = createVertex(asVertexId('sl-b'), createCoordinate(-179, 0));
    const line = createLineFeature(
      asFeatureId('seam-line'),
      createBasicAttributes('日付変更線', 0, 50),
      createColorInfo(true, '#abcdef', '#fedcba', '#012345'),
      [va.id, vb.id],
    );
    const store = createVertexStore([va, vb]);

    const prims = buildEditPreviewPrimitives(line, store);
    const line0 = lines(prims)[0]!;
    // Identical to the committed line path's single source (unwrapLonSequence).
    const expected = unwrapLonSequence([179, -179]);
    expect(line0.points.map((p) => p.lon)).toEqual(expected);
    expect(line0.points.map((p) => p.lon)).toEqual([179, 181]);
    expect(line0.points.map((p) => p.lat)).toEqual([0, 0]);
    // Continuous: the 2° seam hop, never the ~358° world-crossing span.
    expect(maxAdjacentGap(line0.points)).toBeLessThanOrEqual(180);
  });

  it('leaves a NON-seam LINE preview unchanged (identity)', () => {
    const va = createVertex(asVertexId('nl-a'), createCoordinate(10, 20));
    const vb = createVertex(asVertexId('nl-b'), createCoordinate(30, 25));
    const line = createLineFeature(
      asFeatureId('plain-line'),
      createBasicAttributes('線', 0, 50),
      createColorInfo(true, '#abcdef', '#fedcba', '#012345'),
      [va.id, vb.id],
    );
    const store = createVertexStore([va, vb]);
    const line0 = lines(buildEditPreviewPrimitives(line, store))[0]!;
    expect(line0.points.map((p) => p.lon)).toEqual([10, 30]);
    expect(line0.points.map((p) => p.lat)).toEqual([20, 25]);
  });

  it('unwraps a seam-crossing LEAF ring preview into a continuous closed outline', () => {
    // A square straddling the antimeridian: corners at lon 170,-170 (a 20° band across
    // +180 stored as folded representatives). Its committed area draws through
    // unwrapShape/alignMultiPolygon (unwrapRingClosed) so every edge — the closing edge
    // included — stays ≤ 180°. The preview outline must match, not span ~340° per edge.
    const rv = [
      createVertex(asVertexId('sr-0'), createCoordinate(170, 0)),
      createVertex(asVertexId('sr-1'), createCoordinate(-170, 0)),
      createVertex(asVertexId('sr-2'), createCoordinate(-170, 10)),
      createVertex(asVertexId('sr-3'), createCoordinate(170, 10)),
    ];
    const ring = createTerritoryRing(asRingId('sr-r'), rv.map((v) => v.id));
    const leaf = createLeafFeature(
      asFeatureId('seam-leaf'),
      createBasicAttributes('環礁', 0, 100),
      createColorInfo(true, '#102030', '#405060', '#708090'),
      createShape([ring]),
    );
    const store = createVertexStore(rv);

    const line0 = lines(buildEditPreviewPrimitives(leaf, store))[0]!;
    // Continuous across EVERY edge including the implicit closing edge (last → first).
    expect(maxAdjacentGap(line0.points)).toBeLessThanOrEqual(180);
    // Matches the domain single source: unwrapRingClosed on the ring, then closed.
    const unwrapped = unwrapRingClosed(rv.map((v) => v.coordinate));
    const expectedLons = [...unwrapped.map((c) => c.lon), unwrapped[0]!.lon];
    expect(line0.points.map((p) => p.lon)).toEqual(expectedLons);
    // First+last coincide (closed) and lats preserved verbatim.
    expect(line0.points[0]).toEqual(line0.points[line0.points.length - 1]);
    expect(line0.points.map((p) => p.lat)).toEqual([0, 0, 10, 10, 0]);
  });

  it('leaves a NON-seam LEAF ring preview unchanged (identity, still closed)', () => {
    const { leaf } = leafProject(); // square (0,0)-(10,10), no seam crossing
    const store = createVertexStore(leaf.vertices);
    const line0 = lines(buildEditPreviewPrimitives(leaf.feature, store))[0]!;
    // Raw square corners + closing vertex, longitudes untouched.
    const rawLons = leaf.vertices.map((v) => v.coordinate.lon);
    expect(line0.points.map((p) => p.lon)).toEqual([...rawLons, rawLons[0]]);
    expect(maxAdjacentGap(line0.points)).toBeLessThanOrEqual(180);
  });
});

describe('buildActiveFeatureHandlePrimitives (FR-30 shared-vertex visual)', () => {
  it('fills the SHARED vertex handle with sharedVertexFill; non-shared with vertexFill', () => {
    const root = sharedCornerProject();
    const prims = buildActiveFeatureHandlePrimitives(
      root,
      timePointYear(0),
      asFeatureId('leaf-L'),
      DISPLAY,
    );
    const vh = vertexHandles(prims);
    expect(vh).toHaveLength(4);
    // The handle at the shared corner (10,0) uses sharedVertexFill.
    const sharedHandle = vh.find((h) => h.at.lon === 10 && h.at.lat === 0)!;
    expect(sharedHandle.fill).toBe(DEFAULT_EDIT_HANDLE_STYLE.sharedVertexFill);
    // Every OTHER vertex of leaf-L is a normal (unshared) fill.
    for (const h of vh) {
      if (h.at.lon === 10 && h.at.lat === 0) continue;
      expect(h.fill).toBe(DEFAULT_EDIT_HANDLE_STYLE.vertexFill);
    }
  });

  it('draws every vertex with the normal fill when the active feature shares nothing', () => {
    const { root } = leafProject(); // a lone square, no sharing
    const prims = buildActiveFeatureHandlePrimitives(
      root,
      timePointYear(0),
      asFeatureId('leaf-1'),
      DISPLAY,
    );
    const vh = vertexHandles(prims);
    expect(vh).toHaveLength(4);
    for (const h of vh) {
      expect(h.fill).toBe(DEFAULT_EDIT_HANDLE_STYLE.vertexFill);
    }
  });

  it('marks the shared vertex from the NEIGHBOUR feature\'s perspective too (symmetry)', () => {
    const root = sharedCornerProject();
    const prims = buildActiveFeatureHandlePrimitives(
      root,
      timePointYear(0),
      asFeatureId('leaf-R'),
      DISPLAY,
    );
    const vh = vertexHandles(prims);
    const sharedHandle = vh.find((h) => h.at.lon === 10 && h.at.lat === 0)!;
    expect(sharedHandle.fill).toBe(DEFAULT_EDIT_HANDLE_STYLE.sharedVertexFill);
  });
});
