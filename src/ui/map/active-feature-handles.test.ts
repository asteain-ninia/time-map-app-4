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
  DEFAULT_FILTER_STATE,
  setFeatureEmphasized,
  setIndividualHidden,
} from '../discovery/index';

import {
  DEFAULT_CONTEXT_OUTLINE_STYLE,
  buildActiveFeatureHandlePrimitives,
  buildContextOutlinePrimitives,
  buildEditPreviewPrimitives,
} from './active-feature-handles';
import { clearDisplayResolutionCache } from './display-resolution-cache';
import { clearFilteredDisplayCache } from './filtered-display';

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

afterEach(() => {
  clearDisplayResolutionCache();
  clearFilteredDisplayCache();
});

function handles(prims: readonly { kind: string }[]): HandlePrimitive[] {
  return prims.filter((p): p is HandlePrimitive => p.kind === 'handle');
}
function vertexHandles(prims: readonly { kind: string }[]): HandlePrimitive[] {
  return handles(prims).filter((h) => h.handleKind === 'vertex');
}
function lines(prims: readonly { kind: string }[]): LinePrimitive[] {
  return prims.filter((p): p is LinePrimitive => p.kind === 'line');
}
/** The LAST index of a primitive kind, or -1 — for whole-frame 描画順 assertions. */
function lastIndexOfKind(prims: readonly { kind: string }[], kind: string): number {
  return prims.reduce((acc, p, i) => (p.kind === kind ? i : acc), -1);
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

  it('FR-113 (F2): draws NO handles when the display filter HIDES the active feature', () => {
    const { root } = leafProject();
    const hidden = setIndividualHidden(DEFAULT_FILTER_STATE, asFeatureId('leaf-1'), true);
    const prims = buildActiveFeatureHandlePrimitives(
      root,
      timePointYear(0),
      asFeatureId('leaf-1'),
      DISPLAY,
      null,
      undefined,
      undefined,
      undefined,
      hidden,
    );
    // Hidden active feature ⇒ no handles drawn (不変条件: 非表示地物にはハンドルが出ない).
    expect(prims).toEqual([]);
  });

  it('FR-113 (F2): the DEFAULT (inert) filter leaves handles unchanged (zero overhead)', () => {
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
      DEFAULT_FILTER_STATE,
    );
    expect(vertexHandles(prims)).toHaveLength(4);
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

  it('gates the live-drag PREVIEW OUTLINE and every un-dragged handle when over cap', () => {
    const { root } = leafProject();
    // A live vertex drag would normally draw handles + a preview outline; over cap the
    // expensive parts are suppressed. The DRAGGED vertex itself keeps its handle + ring:
    // the cap's contract (domain/selection/visual.ts) exempts 選択/ドラッグ中 explicitly,
    // and the hit-test is NOT capped — so suppressing it too meant a huge feature could be
    // dragged with zero feedback (敵対レビュー MEDIUM).
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
      1, // 4 > 1
    );
    // No preview outline, no edge handles, no un-dragged vertex handles.
    expect(lines(prims)).toHaveLength(0);
    expect(handles(prims).filter((h) => h.handleKind === 'edge')).toHaveLength(0);
    const vh = vertexHandles(prims);
    expect(vh).toHaveLength(1);
    expect(vh[0]!.at).toEqual({ lon: 3, lat: 4 });
    expect(vh[0]!.ring!.stroke).toBe(DEFAULT_EDIT_HANDLE_STYLE.draggingRing.stroke);
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

// --- FR-80 / FR-82 選択頂点ハイライトの結線 ------------------------------------------
//
// 診断 (実機視覚検証): 選択前後の接写 PNG が画素一致 = 選択が「見えない」。真因はこの
// builder が選択頂点集合を引数に取らず、塗りが 共有/通常 の2値しか無かったこと。以下は
// 4象限 (非選択 / 選択 / 共有∧選択 / ドラッグ中) が描画指示の上で区別されることを固定する。

describe('buildActiveFeatureHandlePrimitives (FR-80/82 selected-vertex highlight)', () => {
  it('rings ONLY the selected vertex handles; the rest stay ringless', () => {
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
      DEFAULT_FILTER_STATE,
      { selectedVertexIds: new Set([asVertexId('leaf-1-0')]) },
    );
    const vh = vertexHandles(prims);
    expect(vh).toHaveLength(4);
    const ringed = vh.filter((h) => h.ring !== undefined);
    expect(ringed).toHaveLength(1);
    // leaf-1-0 is the (0,0) corner of the square fixture.
    expect(ringed[0]!.at).toEqual({ lon: 0, lat: 0 });
    expect(ringed[0]!.ring!.stroke).toBe(DEFAULT_EDIT_HANDLE_STYLE.selectedRing.stroke);
  });

  it('produces a DIFFERENT primitive set for the same feature once a vertex is selected', () => {
    // The regression itself: 選択前後で描画指示が変わらない = 画素差ゼロ.
    const { root } = leafProject();
    const before = buildActiveFeatureHandlePrimitives(
      root,
      timePointYear(0),
      asFeatureId('leaf-1'),
      DISPLAY,
    );
    const after = buildActiveFeatureHandlePrimitives(
      root,
      timePointYear(0),
      asFeatureId('leaf-1'),
      DISPLAY,
      null,
      undefined,
      undefined,
      undefined,
      DEFAULT_FILTER_STATE,
      { selectedVertexIds: new Set([asVertexId('leaf-1-0')]) },
    );
    expect(after).not.toEqual(before);
  });

  it('keeps 共有 (fill) and 選択 (ring) simultaneously readable on one vertex', () => {
    const root = sharedCornerProject();
    const prims = buildActiveFeatureHandlePrimitives(
      root,
      timePointYear(0),
      asFeatureId('leaf-L'),
      DISPLAY,
      null,
      undefined,
      undefined,
      undefined,
      DEFAULT_FILTER_STATE,
      { selectedVertexIds: new Set([asVertexId('shared-v')]) },
    );
    const sharedHandle = vertexHandles(prims).find((h) => h.at.lon === 10 && h.at.lat === 0)!;
    expect(sharedHandle.fill).toBe(DEFAULT_EDIT_HANDLE_STYLE.sharedVertexFill);
    expect(sharedHandle.ring!.stroke).toBe(DEFAULT_EDIT_HANDLE_STYLE.selectedRing.stroke);
  });

  it('rings the LIVE-dragged vertex with the dragging style even without a selection set', () => {
    const { root } = leafProject();
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
    );
    const vh = vertexHandles(prims);
    const dragged = vh.find((h) => h.at.lon === 3 && h.at.lat === 4)!;
    expect(dragged.ring).toEqual({
      radiusPx:
        DEFAULT_EDIT_HANDLE_STYLE.vertexRadiusPx + DEFAULT_EDIT_HANDLE_STYLE.draggingRing.gapPx,
      stroke: DEFAULT_EDIT_HANDLE_STYLE.draggingRing.stroke,
      widthPx: DEFAULT_EDIT_HANDLE_STYLE.draggingRing.widthPx,
    });
    // The vertices NOT being dragged carry no ring.
    expect(vh.filter((h) => h.ring !== undefined)).toHaveLength(1);
  });

  it('shows the DRAGGING style (not the selected one) for a vertex that is both', () => {
    const { root } = leafProject();
    const session = beginDrag(
      {
        tool: EDIT_TOOL.VertexMove,
        featureId: asFeatureId('leaf-1'),
        vertexId: asVertexId('leaf-1-0'),
      } as const,
      { lon: 0, lat: 0 },
    );
    const prims = buildActiveFeatureHandlePrimitives(
      root,
      timePointYear(0),
      asFeatureId('leaf-1'),
      DISPLAY,
      session,
      undefined,
      undefined,
      undefined,
      DEFAULT_FILTER_STATE,
      { selectedVertexIds: new Set([asVertexId('leaf-1-0'), asVertexId('leaf-1-1')]) },
    );
    const vh = vertexHandles(prims);
    const dragged = vh.find((h) => h.at.lon === 0 && h.at.lat === 0)!;
    const merelySelected = vh.find((h) => h.at.lon === 10 && h.at.lat === 0)!;
    expect(dragged.ring!.stroke).toBe(DEFAULT_EDIT_HANDLE_STYLE.draggingRing.stroke);
    expect(merelySelected.ring!.stroke).toBe(DEFAULT_EDIT_HANDLE_STYLE.selectedRing.stroke);
  });

  it('rings a multi-vertex simultaneous drag supplied by the caller (FR-80 同時移動)', () => {
    const { root } = leafProject();
    const both = new Set([asVertexId('leaf-1-0'), asVertexId('leaf-1-1')]);
    const prims = buildActiveFeatureHandlePrimitives(
      root,
      timePointYear(0),
      asFeatureId('leaf-1'),
      DISPLAY,
      null,
      undefined,
      undefined,
      undefined,
      DEFAULT_FILTER_STATE,
      { selectedVertexIds: both, draggingVertexIds: both },
    );
    const ringed = vertexHandles(prims).filter((h) => h.ring !== undefined);
    expect(ringed).toHaveLength(2);
    for (const h of ringed) {
      expect(h.ring!.stroke).toBe(DEFAULT_EDIT_HANDLE_STYLE.draggingRing.stroke);
    }
  });

  it('rings EVERY vertex a LIVE multi-vertex session is moving, at its preview position (FR-80)', () => {
    const { root } = leafProject();
    // 掴んだのは leaf-1-0 (0,0)、随伴は leaf-1-3 (0,10)。プレビュー (3,4) ⇒ 変位 (+3,+4)。
    const session = updateDrag(
      beginDrag(
        {
          tool: EDIT_TOOL.VertexMove,
          featureId: asFeatureId('leaf-1'),
          vertexId: asVertexId('leaf-1-0'),
          companionVertexIds: new Set([asVertexId('leaf-1-3')]),
        } as const,
        { lon: 0, lat: 0 },
      ),
      { preview: { lon: 3, lat: 4 } },
    );
    const prims = buildActiveFeatureHandlePrimitives(
      root,
      timePointYear(0),
      asFeatureId('leaf-1'),
      DISPLAY,
      session,
    );
    const vh = vertexHandles(prims);
    const ringed = vh.filter((h) => h.ring !== undefined);
    // 主頂点 (3,4) と随伴頂点 (0,10)+(3,4) = (3,14) の 2 つだけがドラッグ中リングを持つ。
    expect(ringed).toHaveLength(2);
    for (const h of ringed) {
      expect(h.ring!.stroke).toBe(DEFAULT_EDIT_HANDLE_STYLE.draggingRing.stroke);
    }
    // リングは「今動いている頂点」= プレビュー位置に描かれる (リングと位置は同一真実源)。
    expect(ringed.map((h) => ({ lon: h.at.lon, lat: h.at.lat })).sort((a, b) => a.lat - b.lat))
      .toEqual([
        { lon: 3, lat: 4 },
        { lon: 3, lat: 14 },
      ]);
    // 非選択の 2 頂点はコミット位置のまま、リングなし。
    expect(vh.filter((h) => h.ring === undefined).map((h) => ({ lon: h.at.lon, lat: h.at.lat })))
      .toEqual(
        expect.arrayContaining([
          { lon: 10, lat: 0 },
          { lon: 10, lat: 10 },
        ]),
      );
  });

  it('ignores selected ids that belong to another feature (no phantom rings)', () => {
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
      DEFAULT_FILTER_STATE,
      { selectedVertexIds: new Set([asVertexId('someone-elses-vertex')]) },
    );
    for (const h of vertexHandles(prims)) expect(h.ring).toBeUndefined();
  });
});

// 敵対レビュー LOW（実バグ）— FR-81 一owner: a vertex id is a key in the GLOBAL VertexStore
// and FR-30 共有頂点 means a neighbour cites the SAME id. Filtering "ids this feature owns"
// by geometry alone therefore does NOT catch a shared vertex selected on the neighbour:
// the ring landed on the active feature's copy of a vertex it has not selected.
describe('buildActiveFeatureHandlePrimitives (FR-81 選択 owner の照合)', () => {
  it('does NOT ring a SHARED vertex whose selection belongs to the NEIGHBOUR feature', () => {
    // The owner (R) is hidden by the display filter, so ONLY the active feature L is
    // drawn: every ring in the output would necessarily be a phantom on L's own copy of
    // the shared vertex. Before the owner check there was exactly such a ring.
    const root = sharedCornerProject();
    const prims = buildActiveFeatureHandlePrimitives(
      root,
      timePointYear(0),
      asFeatureId('leaf-L'), // active = L
      DISPLAY,
      null,
      undefined,
      undefined,
      undefined,
      setIndividualHidden(DEFAULT_FILTER_STATE, asFeatureId('leaf-R'), true),
      {
        selectedVertexIds: new Set([asVertexId('shared-v')]),
        ownerFeatureId: asFeatureId('leaf-R'), // …but the selection belongs to R
      },
    );
    const vh = vertexHandles(prims);
    expect(vh.length).toBeGreaterThan(0); // L's handles are drawn…
    // …and NONE of them is ringed: L has selected nothing.
    for (const h of vh) expect(h.ring).toBeUndefined();
  });

  it('rings a shared vertex ONCE — on the owner, not on both features', () => {
    // Both leaves are drawn (L active, R the FR-82 context owner) and both own a handle at
    // the SAME world position (10,0). Without the owner check the id matched in both handle
    // sets, so the vertex was ringed twice — once of them on a feature that selected nothing.
    const root = sharedCornerProject();
    const prims = buildActiveFeatureHandlePrimitives(
      root,
      timePointYear(0),
      asFeatureId('leaf-L'),
      DISPLAY,
      null,
      undefined,
      undefined,
      undefined,
      DEFAULT_FILTER_STATE,
      {
        selectedVertexIds: new Set([asVertexId('shared-v')]),
        ownerFeatureId: asFeatureId('leaf-R'),
      },
    );
    const ringed = vertexHandles(prims).filter((h) => h.ring !== undefined);
    expect(ringed).toHaveLength(1);
    expect(ringed[0]!.at).toEqual({ lon: 10, lat: 0 });
  });

  it('DOES ring the same shared vertex when the selection belongs to the ACTIVE feature', () => {
    // The complement of the test above — proves the owner check is a match, not a blanket
    // suppression of shared vertices (骨抜き防止).
    const root = sharedCornerProject();
    const prims = buildActiveFeatureHandlePrimitives(
      root,
      timePointYear(0),
      asFeatureId('leaf-L'),
      DISPLAY,
      null,
      undefined,
      undefined,
      undefined,
      DEFAULT_FILTER_STATE,
      {
        selectedVertexIds: new Set([asVertexId('shared-v')]),
        ownerFeatureId: asFeatureId('leaf-L'),
      },
    );
    const ringed = vertexHandles(prims).filter((h) => h.ring !== undefined);
    expect(ringed).toHaveLength(1);
    expect(ringed[0]!.at).toEqual({ lon: 10, lat: 0 });
  });
});

// 敵対レビュー HIGH（実バグ）— FR-82 頂点選択コンテキスト地物. U22 の HIT_KIND.Vertex 分岐は
// activeFeature を昇格させず、ライブ hit-test は「描かれた全 feature」の頂点を Vertex ヒット
// として返す。よって「編集モードで最初に頂点を直接クリックする」導線では activeFeature=null /
// vertexOwner=A になり、このビルダーは即 [] を返していた = 選択は成立しているのに画面は無変化。
describe('buildActiveFeatureHandlePrimitives (FR-82 頂点選択コンテキスト地物)', () => {
  it('draws the OWNER\'s ringed vertex handles even with NO active feature', () => {
    const { root } = leafProject();
    const prims = buildActiveFeatureHandlePrimitives(
      root,
      timePointYear(0),
      null, // アクティブ地物なし
      DISPLAY,
      null,
      undefined,
      undefined,
      undefined,
      DEFAULT_FILTER_STATE,
      {
        selectedVertexIds: new Set([asVertexId('leaf-1-0')]),
        ownerFeatureId: asFeatureId('leaf-1'),
      },
    );
    const vh = vertexHandles(prims);
    expect(vh).toHaveLength(4);
    const ringed = vh.filter((h) => h.ring !== undefined);
    expect(ringed).toHaveLength(1);
    expect(ringed[0]!.at).toEqual({ lon: 0, lat: 0 });
    expect(ringed[0]!.ring!.stroke).toBe(DEFAULT_EDIT_HANDLE_STYLE.selectedRing.stroke);
  });

  it('draws NO edge handles for the context owner (FR-87 は active 地物だけが掴める)', () => {
    // 描画==ヒット: an edge midpoint is grabbable ONLY for the active feature, so drawing
    // one on a non-active owner would put an ungrabbable handle on screen.
    const { root } = leafProject();
    const prims = buildActiveFeatureHandlePrimitives(
      root,
      timePointYear(0),
      null,
      DISPLAY,
      null,
      undefined,
      undefined,
      undefined,
      DEFAULT_FILTER_STATE,
      {
        selectedVertexIds: new Set([asVertexId('leaf-1-0')]),
        ownerFeatureId: asFeatureId('leaf-1'),
      },
    );
    expect(handles(prims).filter((h) => h.handleKind === 'edge')).toHaveLength(0);
  });

  it('draws BOTH the active feature (edges included) and the context owner', () => {
    const root = sharedCornerProject();
    const prims = buildActiveFeatureHandlePrimitives(
      root,
      timePointYear(0),
      asFeatureId('leaf-L'), // active = L
      DISPLAY,
      null,
      undefined,
      undefined,
      undefined,
      DEFAULT_FILTER_STATE,
      {
        selectedVertexIds: new Set([asVertexId('rv1')]), // R の (20,0) を選択
        ownerFeatureId: asFeatureId('leaf-R'),
      },
    );
    // L keeps its edge handles (active), and R's selected vertex is ringed.
    expect(handles(prims).filter((h) => h.handleKind === 'edge').length).toBeGreaterThan(0);
    const ringed = vertexHandles(prims).filter((h) => h.ring !== undefined);
    expect(ringed).toHaveLength(1);
    expect(ringed[0]!.at).toEqual({ lon: 20, lat: 0 });
  });

  it('FR-113: a context owner HIDDEN by the display filter draws nothing', () => {
    const { root } = leafProject();
    const prims = buildActiveFeatureHandlePrimitives(
      root,
      timePointYear(0),
      null,
      DISPLAY,
      null,
      undefined,
      undefined,
      undefined,
      setIndividualHidden(DEFAULT_FILTER_STATE, asFeatureId('leaf-1'), true),
      {
        selectedVertexIds: new Set([asVertexId('leaf-1-0')]),
        ownerFeatureId: asFeatureId('leaf-1'),
      },
    );
    expect(prims).toHaveLength(0);
  });

  it('an owner WITHOUT any selected vertex adds nothing (no second handle set)', () => {
    const root = sharedCornerProject();
    const withOwner = buildActiveFeatureHandlePrimitives(
      root,
      timePointYear(0),
      asFeatureId('leaf-L'),
      DISPLAY,
      null,
      undefined,
      undefined,
      undefined,
      DEFAULT_FILTER_STATE,
      { selectedVertexIds: new Set(), ownerFeatureId: asFeatureId('leaf-R') },
    );
    const plain = buildActiveFeatureHandlePrimitives(
      root,
      timePointYear(0),
      asFeatureId('leaf-L'),
      DISPLAY,
    );
    expect(withOwner).toEqual(plain);
  });
});

// 敵対レビュー MEDIUM（実バグ）— FR-110 cap の契約は domain/selection/visual.ts に一度だけ
// 書かれている:「cap は FR-79 の全頂点マーカーだけを抑制し、選択済み/ドラッグ中は別経路なので
// cap に関係なく常にスタイルされる」。リングをハンドル経路に載せた結果、その一点だけ規則が
// 食い違っていた（掴んで動かせるのに一切フィードバックが無い状態になる）。
describe('buildActiveFeatureHandlePrimitives (FR-110 cap は選択リングを巻き込まない)', () => {
  it('keeps the SELECTED vertex handle (ringed) while capping all the others', () => {
    const { root } = leafProject(); // 4 頂点
    const prims = buildActiveFeatureHandlePrimitives(
      root,
      timePointYear(0),
      asFeatureId('leaf-1'),
      DISPLAY,
      null,
      undefined,
      undefined,
      1, // 4 > 1 → FR-79 相当の全頂点ハンドルは抑制
      DEFAULT_FILTER_STATE,
      {
        selectedVertexIds: new Set([asVertexId('leaf-1-0')]),
        ownerFeatureId: asFeatureId('leaf-1'),
      },
    );
    const vh = vertexHandles(prims);
    expect(vh).toHaveLength(1);
    expect(vh[0]!.at).toEqual({ lon: 0, lat: 0 });
    expect(vh[0]!.ring!.stroke).toBe(DEFAULT_EDIT_HANDLE_STYLE.selectedRing.stroke);
    // The perf guard still holds for everything else: no edge handles, no outline.
    expect(handles(prims).filter((h) => h.handleKind === 'edge')).toHaveLength(0);
    expect(lines(prims)).toHaveLength(0);
  });

  it('caps everything (returns nothing) when nothing is selected', () => {
    const { root } = leafProject();
    const prims = buildActiveFeatureHandlePrimitives(
      root,
      timePointYear(0),
      asFeatureId('leaf-1'),
      DISPLAY,
      null,
      undefined,
      undefined,
      1,
      DEFAULT_FILTER_STATE,
      { selectedVertexIds: new Set(), ownerFeatureId: null },
    );
    expect(prims).toHaveLength(0);
  });
});

// FR-82 本体 —「頂点選択コンテキスト地物は点線アウトライン」。86948d7 は暫定で
// 「非active オーナーは頂点ハンドルのみ」に留めており、点線アウトラインは未実装だった
// (domain/selection/visual.ts の分類は存在するのに描画消費者ゼロ = 教訓 5.7 の型)。
// どの地物を点線にするかの判定は classifyVisual に一本化してある (二重実装禁止)。
describe('buildActiveFeatureHandlePrimitives (FR-82 点線アウトライン)', () => {
  /** Dashed line primitives only (the FR-82 context outline). */
  function dashed(prims: readonly { kind: string }[]): LinePrimitive[] {
    return lines(prims).filter((l) => l.dashPx !== undefined);
  }

  it('アクティブ地物なし + 頂点選択オーナー → そのオーナーの輪郭が点線で描かれる', () => {
    const { root } = leafProject();
    const prims = buildActiveFeatureHandlePrimitives(
      root,
      timePointYear(0),
      null,
      DISPLAY,
      null,
      undefined,
      undefined,
      undefined,
      DEFAULT_FILTER_STATE,
      {
        selectedVertexIds: new Set([asVertexId('leaf-1-0')]),
        ownerFeatureId: asFeatureId('leaf-1'),
      },
    );
    const outline = dashed(prims);
    expect(outline).toHaveLength(1);
    // 閉じた四角形の輪郭 (4 頂点 + 閉じ点)。
    expect(outline[0]!.points).toHaveLength(5);
    expect(outline[0]!.points[0]).toEqual(outline[0]!.points[4]);
    expect(outline[0]!.dashPx).toEqual(DEFAULT_CONTEXT_OUTLINE_STYLE.dashPx);
    expect(outline[0]!.stroke).toBe(DEFAULT_CONTEXT_OUTLINE_STYLE.stroke);
    // 描画順 (教訓 5.14): 輪郭はハンドルより先 = 下に描かれる。
    const firstHandle = prims.findIndex((p) => p.kind === 'handle');
    const outlineAt = prims.findIndex((p) => p.kind === 'line');
    expect(outlineAt).toBeGreaterThanOrEqual(0);
    expect(outlineAt).toBeLessThan(firstHandle);
  });

  it('オーナー == アクティブ地物 → 点線は出ない (合成規則: 選択スタイル優先)', () => {
    const { root } = leafProject();
    const prims = buildActiveFeatureHandlePrimitives(
      root,
      timePointYear(0),
      asFeatureId('leaf-1'), // active == owner
      DISPLAY,
      null,
      undefined,
      undefined,
      undefined,
      DEFAULT_FILTER_STATE,
      {
        selectedVertexIds: new Set([asVertexId('leaf-1-0')]),
        ownerFeatureId: asFeatureId('leaf-1'),
      },
    );
    expect(dashed(prims)).toHaveLength(0);
    expect(lines(prims)).toHaveLength(0);
  });

  it('アクティブ L + オーナー R → 点線は R だけを囲む (L はアクティブ表示のまま)', () => {
    const root = sharedCornerProject();
    const prims = buildActiveFeatureHandlePrimitives(
      root,
      timePointYear(0),
      asFeatureId('leaf-L'),
      DISPLAY,
      null,
      undefined,
      undefined,
      undefined,
      DEFAULT_FILTER_STATE,
      {
        selectedVertexIds: new Set([asVertexId('rv1')]),
        ownerFeatureId: asFeatureId('leaf-R'),
      },
    );
    const outline = dashed(prims);
    expect(outline).toHaveLength(1);
    // R の四隅 (10,0),(20,0),(20,10),(10,10) — L の (0,0) は含まれない。
    const lons = outline[0]!.points.map((p) => p.lon);
    expect(Math.min(...lons)).toBe(10);
    expect(Math.max(...lons)).toBe(20);
  });

  // 敵対レビュー MEDIUM（実バグ）— 描画順の主張がフレーム全体では成り立っていなかった。
  // featureHandlePrimitives 内の「outline を先に push = ハンドルの下」は同一地物内でしか
  // 効かず、コンテキスト地物 B の primitives は アクティブ地物 A の primitives の後ろに
  // 丸ごと積まれていた。「A がアクティブ・B の頂点を選択」はまさに FR-30 共有頂点で A と B
  // が境界を接している場面で起きるので、B の点線は A のハンドルが並ぶ共有境界の上を通り、
  // widthPx=2 のシアン点線が grab target を横切って覆う（描画==ヒットの可読性が壊れる）。
  it('点線は A のハンドルより下 — 輪郭群はフレーム全体でハンドル群より先に積まれる', () => {
    const root = sharedCornerProject();
    const prims = buildActiveFeatureHandlePrimitives(
      root,
      timePointYear(0),
      asFeatureId('leaf-L'), // A = アクティブ
      DISPLAY,
      null,
      undefined,
      undefined,
      undefined,
      DEFAULT_FILTER_STATE,
      {
        selectedVertexIds: new Set([asVertexId('shared-v')]), // 共有境界上の頂点
        ownerFeatureId: asFeatureId('leaf-R'), // B = コンテキスト地物
      },
    );
    expect(dashed(prims)).toHaveLength(1);
    expect(lastIndexOfKind(prims, 'line')).toBeLessThan(
      prims.findIndex((p) => p.kind === 'handle'),
    );
  });

  it('ライブドラッグ中のプレビュー輪郭も B のハンドルより下に敷かれる', () => {
    // A を頂点ドラッグしながら B の頂点を選択している状態。オレンジのプレビュー輪郭も
    // シアンの点線も「形をなぞる線」で、どちらも掴める点の下に居なければならない。
    const root = sharedCornerProject();
    const session = updateDrag(
      beginDrag(
        {
          tool: EDIT_TOOL.VertexMove,
          featureId: asFeatureId('leaf-L'),
          vertexId: asVertexId('lv0'),
        } as const,
        { lon: 0, lat: 0 },
      ),
      { preview: { lon: -3, lat: -4 } },
    );
    const prims = buildActiveFeatureHandlePrimitives(
      root,
      timePointYear(0),
      asFeatureId('leaf-L'),
      DISPLAY,
      session,
      undefined,
      undefined,
      undefined,
      DEFAULT_FILTER_STATE,
      {
        selectedVertexIds: new Set([asVertexId('rv1')]),
        ownerFeatureId: asFeatureId('leaf-R'),
      },
    );
    // A のプレビュー輪郭 (実線) と B の点線の 2 本。
    expect(lines(prims)).toHaveLength(2);
    expect(dashed(prims)).toHaveLength(1);
    expect(lastIndexOfKind(prims, 'line')).toBeLessThan(
      prims.findIndex((p) => p.kind === 'handle'),
    );
  });

  // FR-113 dim と編集アフォーダンスの関係 — 意図的な設計判断の固定 (敵対レビュー MEDIUM に
  // 対する裁定)。強調フィルタで淡くなるのは「地物の本体描画」であり、掴める点とその帰属を
  // 示す編集アフォーダンス（ハンドル・選択リング・点線アウトライン）は dim の対象外。
  // 根拠: FR-113 の当たり判定母集合は verdict.visible であって opacity ではない
  //（filtered-display.isFeatureVisibleUnderFilter）ので、淡い地物の頂点も普通に掴める。
  // その掴める操作のフィードバックを 0.25 倍にすると「どの地物を掴んでいるのか見えない」
  // 状態が復活する（86948d7 と FR-110 cap 免除が塞いだ不可視そのもの）。
  it('強調フィルタで dim されたオーナーでも点線とハンドルはフル濃度のまま', () => {
    const root = sharedCornerProject();
    // L を強調 ⇒ R は非強調側なので DIM_OPACITY_FACTOR で薄く描かれる（本体描画は淡い）。
    const emphasized = setFeatureEmphasized(
      DEFAULT_FILTER_STATE,
      asFeatureId('leaf-L'),
      true,
    );
    const prims = buildActiveFeatureHandlePrimitives(
      root,
      timePointYear(0),
      null,
      DISPLAY,
      null,
      undefined,
      undefined,
      undefined,
      emphasized,
      {
        selectedVertexIds: new Set([asVertexId('rv1')]),
        ownerFeatureId: asFeatureId('leaf-R'),
      },
    );
    const outline = dashed(prims);
    expect(outline).toHaveLength(1);
    expect(outline[0]!.stroke).toBe(DEFAULT_CONTEXT_OUTLINE_STYLE.stroke);
    expect(outline[0]!.widthPx).toBe(DEFAULT_CONTEXT_OUTLINE_STYLE.widthPx);
    const ringed = vertexHandles(prims).filter((h) => h.ring !== undefined);
    expect(ringed).toHaveLength(1);
    expect(ringed[0]!.ring!.stroke).toBe(DEFAULT_EDIT_HANDLE_STYLE.selectedRing.stroke);
  });

  it('選択が空ならオーナーが指名されていても点線は出ない (教訓 5.18)', () => {
    const root = sharedCornerProject();
    const prims = buildActiveFeatureHandlePrimitives(
      root,
      timePointYear(0),
      asFeatureId('leaf-L'),
      DISPLAY,
      null,
      undefined,
      undefined,
      undefined,
      DEFAULT_FILTER_STATE,
      { selectedVertexIds: new Set(), ownerFeatureId: asFeatureId('leaf-R') },
    );
    expect(dashed(prims)).toHaveLength(0);
  });

  it('FR-113: 表示フィルタで隠れたオーナーには点線も出ない', () => {
    const { root } = leafProject();
    const prims = buildActiveFeatureHandlePrimitives(
      root,
      timePointYear(0),
      null,
      DISPLAY,
      null,
      undefined,
      undefined,
      undefined,
      setIndividualHidden(DEFAULT_FILTER_STATE, asFeatureId('leaf-1'), true),
      {
        selectedVertexIds: new Set([asVertexId('leaf-1-0')]),
        ownerFeatureId: asFeatureId('leaf-1'),
      },
    );
    expect(prims).toHaveLength(0);
  });

  it('FR-110 cap を超えたオーナーでも点線アウトラインは残る (cap は頂点ハンドルの門)', () => {
    // cap は「頂点数に比例するハンドル群」を抑える perf guard。地物ごとに 1 本の輪郭は
    // 確定描画が既に払っているコストと同等で、これを消すと「どの地物の頂点を掴んでいるか」
    // が完全に不可視になる (86948d7 が塞いだ無反応の再発)。
    const { root } = leafProject();
    const prims = buildActiveFeatureHandlePrimitives(
      root,
      timePointYear(0),
      null,
      DISPLAY,
      null,
      undefined,
      undefined,
      1, // 4 > 1
      DEFAULT_FILTER_STATE,
      {
        selectedVertexIds: new Set([asVertexId('leaf-1-0')]),
        ownerFeatureId: asFeatureId('leaf-1'),
      },
    );
    expect(dashed(prims)).toHaveLength(1);
    // 選択済み頂点のハンドルだけが cap を生き残る (既存契約)。
    expect(vertexHandles(prims)).toHaveLength(1);
  });

  it('点情報のオーナーには点線を出さない (輪郭が無い — リングだけが状態を語る)', () => {
    const pt = pointFeature('pt-1', '首都', 50, 30);
    const root: DomainProject = {
      histories: [
        singleAnchorHistory('pt-1', [pt.feature], createVertexStore([pt.vertex]), 0),
      ],
      settings: DEFAULT_SETTINGS,
      baseMap: DEFAULT_BASEMAP,
    };
    const prims = buildActiveFeatureHandlePrimitives(
      root,
      timePointYear(0),
      null,
      DISPLAY,
      null,
      undefined,
      undefined,
      undefined,
      DEFAULT_FILTER_STATE,
      { selectedVertexIds: new Set([pt.vertex.id]), ownerFeatureId: asFeatureId('pt-1') },
    );
    expect(lines(prims)).toHaveLength(0);
    // ハンドル自体は出る (86948d7 の挙動は不変) — 点線が無いだけ。
    expect(vertexHandles(prims).filter((h) => h.ring !== undefined)).toHaveLength(1);
  });
});

describe('buildContextOutlinePrimitives (FR-82 輪郭トレースは preview と同じ単一源)', () => {
  it('線情報を点線の折れ線としてトレースする', () => {
    const va = createVertex(asVertexId('cl-a'), createCoordinate(10, 20));
    const vb = createVertex(asVertexId('cl-b'), createCoordinate(30, 25));
    const line = createLineFeature(
      asFeatureId('ctx-line'),
      createBasicAttributes('線', 0, 50),
      createColorInfo(true, '#abcdef', '#fedcba', '#012345'),
      [va.id, vb.id],
    );
    const out = lines(buildContextOutlinePrimitives(line, createVertexStore([va, vb])));
    expect(out).toHaveLength(1);
    expect(out[0]!.points.map((p) => p.lon)).toEqual([10, 30]);
    expect(out[0]!.dashPx).toEqual(DEFAULT_CONTEXT_OUTLINE_STYLE.dashPx);
  });

  it('シームを跨ぐ環も preview と同一の連続化を通す (単一真実源)', () => {
    const rv = [
      createVertex(asVertexId('cs-0'), createCoordinate(170, 0)),
      createVertex(asVertexId('cs-1'), createCoordinate(-170, 0)),
      createVertex(asVertexId('cs-2'), createCoordinate(-170, 10)),
      createVertex(asVertexId('cs-3'), createCoordinate(170, 10)),
    ];
    const ring = createTerritoryRing(asRingId('cs-r'), rv.map((v) => v.id));
    const leaf = createLeafFeature(
      asFeatureId('ctx-seam-leaf'),
      createBasicAttributes('環礁', 0, 100),
      COLOR,
      createShape([ring]),
    );
    const store = createVertexStore(rv);
    const outline = lines(buildContextOutlinePrimitives(leaf, store))[0]!;
    const preview = lines(buildEditPreviewPrimitives(leaf, store))[0]!;
    // 同じトレーサ = 同じ点列。違うのはスタイル (点線) だけ。
    expect(outline.points).toEqual(preview.points);
    expect(maxAdjacentGap(outline.points)).toBeLessThanOrEqual(180);
  });

  it('点情報は輪郭を持たないので何も出さない (教訓 5.18 非存在は描画指示に現れない)', () => {
    const pt = pointFeature('ctx-pt', '首都', 50, 30);
    expect(
      buildContextOutlinePrimitives(pt.feature, createVertexStore([pt.vertex])),
    ).toEqual([]);
  });
});

// 敵対レビュー MEDIUM（実バグ）— FR-87 EdgeAdd: beginDrag が予約した新頂点 id は
// previewVertexStore で VertexStore に入るだけで feature レコードの id 列には入らず、
// computeHandles も buildEditPreviewPrimitives も id 列しか歩かないので、辺ハンドルを
// ドラッグしている間、新頂点のハンドル（=リングの取り付け先）もプレビュー輪郭の追従も
// 存在しなかった。
describe('buildActiveFeatureHandlePrimitives (FR-87 EdgeAdd の新頂点プレビュー)', () => {
  /** An EdgeAdd drag on the square leaf's leaf-1-0 → leaf-1-1 edge, pulled to (5,-4). */
  function edgeAddSession(): DragSession {
    return updateDrag(
      beginDrag(
        {
          tool: EDIT_TOOL.EdgeAdd,
          featureId: asFeatureId('leaf-1'),
          ringId: asRingId('leaf-1-r'),
          startVertexId: asVertexId('leaf-1-0'),
          endVertexId: asVertexId('leaf-1-1'),
          newVertexId: asVertexId('leaf-1-new'),
        } as const,
        { lon: 5, lat: 0 },
      ),
      { preview: { lon: 5, lat: -4 } },
    );
  }

  it('gives the in-flight new vertex a handle at the cursor with the DRAGGING ring', () => {
    const { root } = leafProject();
    const prims = buildActiveFeatureHandlePrimitives(
      root,
      timePointYear(0),
      asFeatureId('leaf-1'),
      DISPLAY,
      edgeAddSession(),
    );
    const vh = vertexHandles(prims);
    expect(vh).toHaveLength(5); // 4 committed + the one being born
    const born = vh.find((h) => h.at.lon === 5 && h.at.lat === -4);
    expect(born).toBeDefined();
    expect(born!.ring!.stroke).toBe(DEFAULT_EDIT_HANDLE_STYLE.draggingRing.stroke);
    // …and it is the ONLY ringed handle (the committed ones are not being dragged).
    expect(vh.filter((h) => h.ring !== undefined)).toHaveLength(1);
  });

  it('routes the preview OUTLINE through the new vertex (geometry follows the cursor)', () => {
    const { root } = leafProject();
    const prims = buildActiveFeatureHandlePrimitives(
      root,
      timePointYear(0),
      asFeatureId('leaf-1'),
      DISPLAY,
      edgeAddSession(),
    );
    const outline = lines(prims);
    expect(outline).toHaveLength(1);
    expect(outline[0]!.points.some((p) => p.lon === 5 && p.lat === -4)).toBe(true);
  });

  it('leaves the record UNCHANGED for a stale edge (no half insert, 教訓 5.18)', () => {
    const { root } = leafProject();
    const stale = updateDrag(
      beginDrag(
        {
          tool: EDIT_TOOL.EdgeAdd,
          featureId: asFeatureId('leaf-1'),
          ringId: asRingId('leaf-1-r'),
          startVertexId: asVertexId('leaf-1-0'),
          endVertexId: asVertexId('leaf-1-2'), // not adjacent
          newVertexId: asVertexId('leaf-1-new'),
        } as const,
        { lon: 5, lat: 5 },
      ),
      { preview: { lon: 6, lat: 6 } },
    );
    const prims = buildActiveFeatureHandlePrimitives(
      root,
      timePointYear(0),
      asFeatureId('leaf-1'),
      DISPLAY,
      stale,
    );
    expect(vertexHandles(prims)).toHaveLength(4);
    expect(vertexHandles(prims).some((h) => h.ring !== undefined)).toBe(false);
  });
});

// FR-110 視野内カウント (HandleView) — cap は「視野内に描くハンドル数」に掛かる。
// view を渡すと視野外の頂点/辺ハンドルは生成されず、cap 判定も視野内個数で行われる
// (デカい地物もズームインすれば編集できる)。view なしは従来どおり全数カウント。
describe('buildActiveFeatureHandlePrimitives (FR-110 視野内カウント HandleView)', () => {
  // viewport 100×100 / zoom 10px/deg / 中心 (0,0): square(0,0..10,10) の頂点のうち
  // (0,0) だけが画面内 (±32px マージン含む)。(10,0)→x150 / (10,10)→(150,-50) /
  // (0,10)→y-50 は全て外。辺中点は (5,0)→(100,50) と (0,5)→(50,0) の 2 つが内。
  const VIEW = {
    camera: { centerLon: 0, centerLat: 0, zoom: 10 },
    viewport: { widthCss: 100, heightCss: 100, devicePixelRatio: 1 },
  };

  it('view があると視野内のハンドルだけが生成される', () => {
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
      DEFAULT_FILTER_STATE,
      undefined,
      undefined,
      VIEW,
    );
    expect(vertexHandles(prims)).toHaveLength(1);
    expect(handles(prims)).toHaveLength(3); // 頂点1 + 辺中点2
  });

  it('cap は視野内個数に掛かる: 総頂点数 > cap でも視野内 <= cap なら描画される', () => {
    const { root } = leafProject(); // 総頂点 4
    const prims = buildActiveFeatureHandlePrimitives(
      root,
      timePointYear(0),
      asFeatureId('leaf-1'),
      DISPLAY,
      null,
      undefined,
      undefined,
      2, // 4 > 2 だが視野内は 1
      DEFAULT_FILTER_STATE,
      undefined,
      undefined,
      VIEW,
    );
    expect(vertexHandles(prims)).toHaveLength(1);
    // 同条件で view なしなら従来どおり全抑制 (回帰確認)
    const without = buildActiveFeatureHandlePrimitives(
      root,
      timePointYear(0),
      asFeatureId('leaf-1'),
      DISPLAY,
      null,
      undefined,
      undefined,
      2,
    );
    expect(handles(without)).toHaveLength(0);
  });

  it('視野内個数が cap を超えたら従来どおり全抑制 (しきい値であって先頭 N ではない)', () => {
    const { root } = leafProject();
    const prims = buildActiveFeatureHandlePrimitives(
      root,
      timePointYear(0),
      asFeatureId('leaf-1'),
      DISPLAY,
      null,
      undefined,
      undefined,
      0, // 視野内 1 > 0
      DEFAULT_FILTER_STATE,
      undefined,
      undefined,
      VIEW,
    );
    expect(handles(prims)).toHaveLength(0);
  });

  it('選択済み頂点は視野外でも生き残る (常時スタイル契約は視野フィルタより優先)', () => {
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
      DEFAULT_FILTER_STATE,
      {
        // (10,10) = 視野外の頂点を選択
        selectedVertexIds: new Set([asVertexId('leaf-1-2')]),
        ownerFeatureId: asFeatureId('leaf-1'),
      },
      undefined,
      VIEW,
    );
    // 視野外 (10,10) の選択頂点のハンドルが位置で確認できること
    expect(
      vertexHandles(prims).some((h) => h.at.lon === 10 && h.at.lat === 10),
    ).toBe(true);
    expect(vertexHandles(prims)).toHaveLength(2); // 視野内 1 + 選択済み視野外 1
  });

  it('ワールドラップ: 1 周先のカメラからも同じ頂点が視野内と判定される (FR-07)', () => {
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
      DEFAULT_FILTER_STATE,
      undefined,
      undefined,
      {
        camera: { centerLon: 360, centerLat: 0, zoom: 10 },
        viewport: { widthCss: 100, heightCss: 100, devicePixelRatio: 1 },
      },
    );
    expect(vertexHandles(prims)).toHaveLength(1);
  });
});
