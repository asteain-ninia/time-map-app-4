// HB-15 — live map hit-test unit lens. Asserts the screen click → U22 HitResult
// rule: 頂点優先 (nearest vertex within the screen-px radius), then leaf body (world
// containment), then point/line proximity, then empty (受け入れ基準: 頂点→地物). The
// resolution reuses live-lookup's featuresAt/verticesAt/leafAtPoint, so what is hit
// matches what is drawn / resolved (二重真実源を作らない, 教訓 5.29).

import { describe, expect, it } from 'vitest';

import { liveHitTestAt, drawnAreaAt, multiPolygonLonSpan } from './live-hit-test';
import type { GeoMultiPolygon } from '../../domain/geometry/index';
import { HIT_KIND } from '../../domain/selection';
import type { DomainRoot } from '../consistency-binding';
import { applyAddProposal } from '../../domain/editing/apply-proposal';
import { createEditProposal } from '../../domain/consistency/index';
import { timePointYear } from '../../domain/time/time-point';
import { createBasicAttributes, createColorInfo } from '../../domain/attributes';
import {
  createAggregateFeature,
  createLeafFeature,
  createLineFeature,
  createPointFeature,
  withParentId,
  type Feature,
} from '../../domain/feature';
import { createShape, createTerritoryRing } from '../../domain/ring';
import { createVertex, createVertexStore, type Vertex } from '../../domain/vertex';
import { asFeatureId, asRingId, asVertexId } from '../../domain/ids';
import { createGeoParams } from '../../domain/geo/geo-params';
import type { AddSnapshot } from '../../domain/add/index';
import { worldToScreen, screenToWorld, wrapTurnsForLonSpan } from '../../render';
import type { Camera, Viewport } from '../../render';

const color = createColorInfo(true, '#90caf9', '#ffb300', '#0d47a1');

function emptyProject(): DomainRoot {
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

/** A 4×4 square leaf with origin offset; corners at (ox,oy)…(ox+4,oy+4). */
function squareLeaf(
  idRaw: string,
  vPrefix: string,
  ox: number,
  oy: number,
): { feature: Feature; vertices: Vertex[] } {
  const corners = [
    [0, 0],
    [4, 0],
    [4, 4],
    [0, 4],
  ];
  const vertices = corners.map((c, i) =>
    createVertex(asVertexId(`${vPrefix}-${i}`), { lon: c[0]! + ox, lat: c[1]! + oy }),
  );
  const ring = createTerritoryRing(asRingId(`r-${idRaw}`), vertices.map((v) => v.id));
  const feature = createLeafFeature(
    asFeatureId(idRaw),
    createBasicAttributes(idRaw, 0, 0),
    color,
    createShape([ring]),
  );
  return { feature, vertices };
}

/** A `size`×`size` square leaf with origin offset; corners at (ox,oy)…(ox+size,oy+size). */
function bigSquareLeaf(
  idRaw: string,
  vPrefix: string,
  ox: number,
  oy: number,
  size: number,
): { feature: Feature; vertices: Vertex[] } {
  const corners = [
    [0, 0],
    [size, 0],
    [size, size],
    [0, size],
  ];
  const vertices = corners.map((c, i) =>
    createVertex(asVertexId(`${vPrefix}-${i}`), { lon: c[0]! + ox, lat: c[1]! + oy }),
  );
  const ring = createTerritoryRing(asRingId(`r-${idRaw}`), vertices.map((v) => v.id));
  const feature = createLeafFeature(
    asFeatureId(idRaw),
    createBasicAttributes(idRaw, 0, 0),
    color,
    createShape([ring]),
  );
  return { feature, vertices };
}

function pointFeature(
  idRaw: string,
  vRaw: string,
  lon: number,
  lat: number,
): { feature: Feature; vertices: Vertex[] } {
  const vertex = createVertex(asVertexId(vRaw), { lon, lat });
  const feature = createPointFeature(
    asFeatureId(idRaw),
    createBasicAttributes(idRaw, 0, 0),
    color,
    vertex.id,
  );
  return { feature, vertices: [vertex] };
}

/** A polyline through the given (lon,lat) world points. */
function lineFeature(
  idRaw: string,
  vPrefix: string,
  pts: readonly (readonly [number, number])[],
): { feature: Feature; vertices: Vertex[] } {
  const vertices = pts.map((p, i) =>
    createVertex(asVertexId(`${vPrefix}-${i}`), { lon: p[0]!, lat: p[1]! }),
  );
  const feature = createLineFeature(
    asFeatureId(idRaw),
    createBasicAttributes(idRaw, 0, 0),
    color,
    vertices.map((v) => v.id),
  );
  return { feature, vertices };
}

function commit(
  root: DomainRoot,
  f: { feature: Feature; vertices: Vertex[] },
  year: number,
): DomainRoot {
  const snapshot: AddSnapshot = {
    feature: f.feature,
    vertices: f.vertices,
    sharedCandidateIds: new Map(),
  };
  return applyAddProposal(
    root,
    createEditProposal(f.feature.id, timePointYear(year), snapshot),
  );
}

// A camera centred on the world origin, 10 px/deg, 200×200 viewport.
const camera: Camera = { centerLon: 2, centerLat: 2, zoom: 10 };
const viewport: Viewport = { widthCss: 200, heightCss: 200, devicePixelRatio: 1 };
const toScreen = (w: { lon: number; lat: number }) => worldToScreen(w, camera, viewport);

describe('liveHitTestAt', () => {
  const time = timePointYear(1000);

  it('returns a VERTEX hit when the click is within the screen-px radius of a vertex (頂点優先)', () => {
    const a = squareLeaf('f-a', 'va', 0, 0); // corner v at (0,0)
    const root = commit(emptyProject(), a, 1000);
    // Screen position of the (0,0) corner vertex.
    const corner = toScreen({ lon: 0, lat: 0 });
    const hit = liveHitTestAt(
      { root, time, toScreen, point: { x: corner.x + 1, y: corner.y - 1 } },
      { lon: 0, lat: 0 },
    );
    expect(hit.kind).toBe(HIT_KIND.Vertex);
    if (hit.kind === HIT_KIND.Vertex) {
      expect(hit.featureId).toBe(a.feature.id);
      expect(hit.vertexId).toBe(asVertexId('va-0'));
    }
  });

  it('returns a FEATURE BODY hit when the click is inside the leaf but not near a vertex', () => {
    const a = squareLeaf('f-a', 'va', 0, 0); // covers [0,4]×[0,4]
    const root = commit(emptyProject(), a, 1000);
    const centre = { lon: 2, lat: 2 };
    const screen = toScreen(centre);
    const hit = liveHitTestAt({ root, time, toScreen, point: screen }, centre);
    expect(hit.kind).toBe(HIT_KIND.FeatureBody);
    if (hit.kind === HIT_KIND.FeatureBody) expect(hit.featureId).toBe(a.feature.id);
  });

  it('returns EMPTY when the click is in empty space', () => {
    const a = squareLeaf('f-a', 'va', 0, 0);
    const root = commit(emptyProject(), a, 1000);
    const far = { lon: 50, lat: 50 };
    const hit = liveHitTestAt({ root, time, toScreen, point: toScreen(far) }, far);
    expect(hit.kind).toBe(HIT_KIND.Empty);
  });

  it('prefers a vertex over the enclosing body when both are under the cursor', () => {
    const a = squareLeaf('f-a', 'va', 0, 0);
    const root = commit(emptyProject(), a, 1000);
    // The (4,4) corner vertex is inside the leaf body too; the vertex must win.
    const corner = { lon: 4, lat: 4 };
    const hit = liveHitTestAt({ root, time, toScreen, point: toScreen(corner) }, corner);
    expect(hit.kind).toBe(HIT_KIND.Vertex);
  });

  it('selects a stand-alone POINT feature as a body when clicked near it', () => {
    const p = pointFeature('f-p', 'vp', 3, 3);
    const root = commit(emptyProject(), p, 1000);
    const at = { lon: 3, lat: 3 };
    const hit = liveHitTestAt({ root, time, toScreen, point: toScreen(at) }, at);
    // A point's own vertex is the nearest vertex → vertex hit on its owner.
    expect(hit.kind).toBe(HIT_KIND.Vertex);
    if (hit.kind === HIT_KIND.Vertex) expect(hit.featureId).toBe(p.feature.id);
  });

  // --- bughunt: 前面に描かれた line をクリックしても背面の area が選ばれる -------------
  //
  // The renderer paints AREAS first, then LINES, then POINTS (feature-layer
  // buildFeaturePrimitives `[...areas, ...lines, ...points, ...labels]`), so a line drawn
  // over an area sits visually ON TOP of it. Before the fix the body hit-test probed the
  // AREA body first and returned immediately, so a click on the middle of a line crossing
  // the area selected the BACK area, not the FRONT line (『見えている＝掴める』違反: 描画順
  // と hit-test 優先順位の不一致). The fix probes point / line bodies in REVERSE draw order
  // (before the area body), so the on-top feature is grabbed. Vertices still win over all.
  describe('body hit order = reverse draw order (line over area, point over area)', () => {
    it('clicking the middle of a LINE crossing an area selects the LINE, not the back area', () => {
      // A 10×10 area covering [0,10]², and a horizontal line at lat 5 crossing through
      // its interior from lon 1 to lon 9 (endpoints inside the area too).
      const area = bigSquareLeaf('f-area', 'var', 0, 0, 10); // [0,10]×[0,10]
      const line = lineFeature('f-line', 'vln', [
        [1, 5],
        [9, 5],
      ]);
      let root = commit(emptyProject(), area, 1000);
      root = commit(root, line, 1000);
      // Mid of the line segment (lon 5, lat 5): inside the area body AND on the line,
      // far (>8px at zoom 10) from every line endpoint and every area corner vertex.
      const mid = { lon: 5, lat: 5 };
      const hit = liveHitTestAt({ root, time, toScreen, point: toScreen(mid) }, mid);
      expect(hit.kind).toBe(HIT_KIND.FeatureBody);
      if (hit.kind === HIT_KIND.FeatureBody) expect(hit.featureId).toBe(line.feature.id);
    });

    it('clicking a POINT drawn over an area selects the POINT, not the back area', () => {
      // The point's own vertex is the nearest drawn vertex, so this also exercises the
      // vertex-first path landing on the point rather than the area body underneath.
      const area = bigSquareLeaf('f-area', 'var', 0, 0, 10); // [0,10]×[0,10]
      const point = pointFeature('f-pt', 'vpt', 5, 5); // inside the area
      let root = commit(emptyProject(), area, 1000);
      root = commit(root, point, 1000);
      const at = { lon: 5, lat: 5 };
      const hit = liveHitTestAt({ root, time, toScreen, point: toScreen(at) }, at);
      expect([HIT_KIND.Vertex, HIT_KIND.FeatureBody]).toContain(hit.kind);
      if (hit.kind === HIT_KIND.Vertex || hit.kind === HIT_KIND.FeatureBody) {
        expect(hit.featureId).toBe(point.feature.id);
      }
    });

    it('clicking the area where NO line/point overlaps still selects the area (no regression)', () => {
      // Same area + line, but click a spot inside the area well away (>8px) from the
      // line: the area body is the only thing under the cursor and must still be hit.
      const area = bigSquareLeaf('f-area', 'var', 0, 0, 10); // [0,10]×[0,10]
      const line = lineFeature('f-line', 'vln', [
        [1, 5],
        [9, 5],
      ]);
      let root = commit(emptyProject(), area, 1000);
      root = commit(root, line, 1000);
      // lon 5, lat 2: inside the area, ~3° (30 px) below the line at lat 5 — out of reach.
      const inAreaOnly = { lon: 5, lat: 2 };
      const hit = liveHitTestAt(
        { root, time, toScreen, point: toScreen(inAreaOnly) },
        inAreaOnly,
      );
      expect(hit.kind).toBe(HIT_KIND.FeatureBody);
      if (hit.kind === HIT_KIND.FeatureBody) expect(hit.featureId).toBe(area.feature.id);
    });
  });

  // --- bughunt: 日付変更線を跨ぐ line の描画位置と hit-test を一致させる ----------
  //
  // A line whose stored vertices straddle the antimeridian ([179, -179]) is DRAWN by
  // committed-features after U04 `unwrapLonSequence` → [179, 181] (a short ~2° run near
  // the seam). The line body hit-test must project that SAME unwrapped geometry. Before
  // the fix it projected the raw stored lon (-179), making the body a ~358° segment that
  // crossed the screen centre: a click on the drawn seam segment missed, and a click far
  // away (mid-screen) false-hit the line. These two assertions pin both halves.
  describe('antimeridian-straddling line (seam unwrap parity with the renderer)', () => {
    // Camera centred on the seam so the unwrapped run [179,181] sits on screen.
    const seamCamera = { centerLon: 180, centerLat: 0, zoom: 10 } as const;
    const seamToScreen = (w: { lon: number; lat: number }) =>
      worldToScreen(w, seamCamera, viewport);

    it('grabs the line where it is DRAWN (at the unwrapped seam position)', () => {
      const ln = lineFeature('f-seam', 'vseam', [
        [179, 0],
        [-179, 0], // stored representative; drawn unwrapped at lon 181
      ]);
      const root = commit(emptyProject(), ln, 1000);
      // The midpoint of the DRAWN segment is lon 180 (between 179 and 181), lat 0.
      const drawnMid = { lon: 180, lat: 0 };
      const hit = liveHitTestAt(
        { root, time, toScreen: seamToScreen, point: seamToScreen(drawnMid) },
        drawnMid,
      );
      expect(hit.kind).toBe(HIT_KIND.FeatureBody);
      if (hit.kind === HIT_KIND.FeatureBody) expect(hit.featureId).toBe(ln.feature.id);
    });

    it('does NOT false-hit the line far from where it is drawn', () => {
      const ln = lineFeature('f-seam', 'vseam', [
        [179, 0],
        [-179, 0],
      ]);
      const root = commit(emptyProject(), ln, 1000);
      // lon 175 is ~4° (40 px at zoom 10) from the drawn run [179,181] — well outside the
      // 8 px grab radius, and far from either drawn endpoint. With the WRONGLY-unwrapped
      // ~358° body [179,-179] this point sits squarely ON the giant segment (a false hit,
      // the bug's symptom). With the correctly drawn geometry it is empty space.
      const away = { lon: 175, lat: 0 };
      const hit = liveHitTestAt(
        { root, time, toScreen: seamToScreen, point: seamToScreen(away) },
        away,
      );
      expect(hit.kind).toBe(HIT_KIND.Empty);
    });
  });

  // --- Codex #2: 集約表示中は描画(集約形状)と hit-test を一致させる ----------------
  //
  // An aggregate parent over two child leaves, displayed at N=0 (the default): the
  // renderer draws the parent's 集約形状 and OMITS the children. The hit-test must
  // resolve the SAME set — a body click selects the AGGREGATE, and a hidden child's
  // vertex is NOT pickable (描画されていないものはクリックで選ばれない).
  describe('aggregate display (displayControl honoured)', () => {
    /** An aggregate `agg` over two child leaves at [0,4]² and [6,10]² (parented). */
    function aggregateHierarchy(): {
      root: DomainRoot;
      aggId: Feature['id'];
      childAId: Feature['id'];
      childBId: Feature['id'];
    } {
      const childA = squareLeaf('f-childA', 'vca', 0, 0); // [0,4]×[0,4]
      const childB = squareLeaf('f-childB', 'vcb', 6, 0); // [6,10]×[0,4]
      const aggId = asFeatureId('f-agg');
      // The display forest links parent↔child via parentId; set it on each child.
      const childAp = {
        feature: withParentId(childA.feature, aggId),
        vertices: childA.vertices,
      };
      const childBp = {
        feature: withParentId(childB.feature, aggId),
        vertices: childB.vertices,
      };
      const agg = createAggregateFeature(
        aggId,
        createBasicAttributes('f-agg', 0, 0),
        color,
        [childAp.feature.id, childBp.feature.id],
      );
      let root = commit(emptyProject(), { feature: agg, vertices: [] }, 1000);
      root = commit(root, childAp, 1000);
      root = commit(root, childBp, 1000);
      return { root, aggId, childAId: childAp.feature.id, childBId: childBp.feature.id };
    }

    const aggregatedControl = {
      globalDepth: 0,
      focus: { originId: null, depth: 0, emphasize: false },
    };

    it('a click on a hidden child body selects the AGGREGATE, not the child leaf', () => {
      const { root, aggId } = aggregateHierarchy();
      const inChildA = { lon: 2, lat: 2 }; // inside child A's drawn-as-aggregate area
      const hit = liveHitTestAt(
        { root, time, displayControl: aggregatedControl, toScreen, point: toScreen(inChildA) },
        inChildA,
      );
      expect(hit.kind).toBe(HIT_KIND.FeatureBody);
      if (hit.kind === HIT_KIND.FeatureBody) expect(hit.featureId).toBe(aggId);
    });

    it('a click on a hidden child VERTEX does NOT select the vertex (falls to the aggregate body)', () => {
      const { root, aggId } = aggregateHierarchy();
      // Just INSIDE child A's (4,4) corner vertex (within the screen-px grab radius of
      // it): if that vertex were drawn it would win as a vertex hit. But the child is
      // OMITTED, so its vertex is not drawn / not grabbable, and the cursor sits inside
      // the aggregate body → it resolves to the aggregate, never a vertex hit.
      const corner = { lon: 3.9, lat: 3.9 };
      const hit = liveHitTestAt(
        { root, time, displayControl: aggregatedControl, toScreen, point: toScreen(corner) },
        corner,
      );
      expect(hit.kind).not.toBe(HIT_KIND.Vertex);
      expect(hit.kind).toBe(HIT_KIND.FeatureBody);
      if (hit.kind === HIT_KIND.FeatureBody) expect(hit.featureId).toBe(aggId);
    });

    it('expanded (N high enough) restores child vertex + child body selection', () => {
      const { root, childAId } = aggregateHierarchy();
      const expandedControl = {
        globalDepth: 5, // deeper than the children → they draw their OWN shape
        focus: { originId: null, depth: 0, emphasize: false },
      };
      // Now child A draws its own shape: its (4,4) vertex is grabbable again, so a
      // click within the grab radius of it returns a vertex hit on the child.
      const corner = { lon: 3.9, lat: 3.9 };
      const hit = liveHitTestAt(
        { root, time, displayControl: expandedControl, toScreen, point: toScreen(corner) },
        corner,
      );
      expect(hit.kind).toBe(HIT_KIND.Vertex);
      if (hit.kind === HIT_KIND.Vertex) expect(hit.featureId).toBe(childAId);
    });

    it('a FOCUS on the aggregate (depth M) expands its children → child body + vertex selectable', () => {
      const { root, childAId } = aggregateHierarchy();
      const aggId = asFeatureId('f-agg');
      // N stays 0 (everything else rolled up), but the focus vertical region of the
      // aggregate follows M=5, so its children expand to their OWN real shape.
      const focusedControl = {
        globalDepth: 0,
        focus: { originId: aggId, depth: 5, emphasize: false },
      };
      // Child A body (centre, away from its vertices) → the now-Real child is selected.
      const inChildA = { lon: 2, lat: 2 };
      const bodyHit = liveHitTestAt(
        { root, time, displayControl: focusedControl, toScreen, point: toScreen(inChildA) },
        inChildA,
      );
      expect(bodyHit.kind).toBe(HIT_KIND.FeatureBody);
      if (bodyHit.kind === HIT_KIND.FeatureBody) expect(bodyHit.featureId).toBe(childAId);
      // And its (4,4) vertex is grabbable again under the focus.
      const corner = { lon: 3.9, lat: 3.9 };
      const vertHit = liveHitTestAt(
        { root, time, displayControl: focusedControl, toScreen, point: toScreen(corner) },
        corner,
      );
      expect(vertHit.kind).toBe(HIT_KIND.Vertex);
      if (vertHit.kind === HIT_KIND.Vertex) expect(vertHit.featureId).toBe(childAId);
    });

    it('a FOCUS on ONE tree leaves an UNFOCUSED tree still aggregated (its child not pickable)', () => {
      // Two independent aggregate trees: agg1{child1A,child1B} and agg2{child2}.
      const child1A = squareLeaf('f-c1a', 'v1a', 0, 0); // [0,4]²
      const child1B = squareLeaf('f-c1b', 'v1b', 6, 0); // [6,10]²
      const child2 = squareLeaf('f-c2', 'v2', 0, 20); // [0,4]×[20,24] (far away)
      const agg1Id = asFeatureId('f-agg1');
      const agg2Id = asFeatureId('f-agg2');
      const agg1 = createAggregateFeature(
        agg1Id,
        createBasicAttributes('f-agg1', 0, 0),
        color,
        [child1A.feature.id, child1B.feature.id],
      );
      const agg2 = createAggregateFeature(
        agg2Id,
        createBasicAttributes('f-agg2', 0, 0),
        color,
        [child2.feature.id],
      );
      let root = commit(emptyProject(), { feature: agg1, vertices: [] }, 1000);
      root = commit(root, { feature: agg2, vertices: [] }, 1000);
      root = commit(root, { feature: withParentId(child1A.feature, agg1Id), vertices: child1A.vertices }, 1000);
      root = commit(root, { feature: withParentId(child1B.feature, agg1Id), vertices: child1B.vertices }, 1000);
      root = commit(root, { feature: withParentId(child2.feature, agg2Id), vertices: child2.vertices }, 1000);

      // Focus agg1 (expand its subtree). agg2's subtree is OUTSIDE the focus region, so
      // it stays at global N=0 → agg2 aggregated, child2 omitted.
      const focusAgg1 = {
        globalDepth: 0,
        focus: { originId: agg1Id, depth: 5, emphasize: false },
      };
      // A click in agg2's child2 footprint selects the AGGREGATE agg2, never child2.
      const inChild2 = { lon: 2, lat: 22 };
      const hit = liveHitTestAt(
        { root, time, displayControl: focusAgg1, toScreen, point: toScreen(inChild2) },
        inChild2,
      );
      expect(hit.kind).toBe(HIT_KIND.FeatureBody);
      if (hit.kind === HIT_KIND.FeatureBody) expect(hit.featureId).toBe(agg2Id);
    });
  });

  // --- bughunt: ナイフの対象面探索が表示解決(displayControl)を無視して裏の非表示 leaf を選べる ---
  //
  // The knife `featureAtPoint` port (App.createKnifeBootstrap) USED to call
  // live-lookup.leafAtPoint, which tests every committed leaf body regardless of what is
  // DRAWN. With the default N=0 集約表示 the renderer draws the parent's 集約形状 and OMITS
  // the children — yet a click on the aggregate body returned a HIDDEN child leaf as the
  // split target (描画されていないものが選ばれる, 二重真実源). The fix routes the knife
  // through `drawnAreaAt` — the SAME resolveDisplayControl-based drawn-area set the
  // renderer fills and the main hit-test (`liveHitTestAt`) picks (単一真実源). These
  // assertions pin that drawnAreaAt obeys the display control exactly: a body click in a
  // hidden child's footprint resolves to the AGGREGATE the user sees (which the hook's
  // LEAF gate then rejects as unsplittable), never the undrawn child leaf — and once the
  // child is expanded, drawnAreaAt returns the child leaf so it becomes a valid target.
  describe('drawnAreaAt — knife featureAtPoint honours displayControl (単一真実源)', () => {
    /** An aggregate `agg` over two child leaves at [0,4]² and [6,10]² (parented). */
    function aggregateHierarchy(): {
      root: DomainRoot;
      aggId: Feature['id'];
      childAId: Feature['id'];
    } {
      const childA = squareLeaf('f-childA', 'vca', 0, 0); // [0,4]×[0,4]
      const childB = squareLeaf('f-childB', 'vcb', 6, 0); // [6,10]×[0,4]
      const aggId = asFeatureId('f-agg');
      const childAp = { feature: withParentId(childA.feature, aggId), vertices: childA.vertices };
      const childBp = { feature: withParentId(childB.feature, aggId), vertices: childB.vertices };
      const agg = createAggregateFeature(
        aggId,
        createBasicAttributes('f-agg', 0, 0),
        color,
        [childAp.feature.id, childBp.feature.id],
      );
      let root = commit(emptyProject(), { feature: agg, vertices: [] }, 1000);
      root = commit(root, childAp, 1000);
      root = commit(root, childBp, 1000);
      return { root, aggId, childAId: childAp.feature.id };
    }

    const aggregatedControl = {
      globalDepth: 0,
      focus: { originId: null, depth: 0, emphasize: false },
    };

    it('a click on a hidden child body resolves to the AGGREGATE, never the child leaf', () => {
      const { root, aggId, childAId } = aggregateHierarchy();
      // Inside child A's footprint, which at N=0 is drawn as the aggregate's 集約形状.
      const inChildA = { lon: 2, lat: 2 };
      const fid = drawnAreaAt(
        { root, time, displayControl: aggregatedControl },
        inChildA,
      );
      expect(fid).toBe(aggId);
      // Regression guard: the OLD leafAtPoint returned the hidden child leaf here.
      expect(fid).not.toBe(childAId);
    });

    it('expanded (N high enough) resolves the child LEAF (a valid split target)', () => {
      const { root, childAId } = aggregateHierarchy();
      const expandedControl = {
        globalDepth: 5, // deeper than the children → they draw their OWN shape
        focus: { originId: null, depth: 0, emphasize: false },
      };
      const inChildA = { lon: 2, lat: 2 };
      const fid = drawnAreaAt(
        { root, time, displayControl: expandedControl },
        inChildA,
      );
      expect(fid).toBe(childAId);
    });

    it('returns null on empty space (no drawn area under the cursor)', () => {
      const { root } = aggregateHierarchy();
      const far = { lon: 50, lat: 50 };
      expect(drawnAreaAt({ root, time, displayControl: aggregatedControl }, far)).toBeNull();
    });
  });

  // --- bughunt: ±360°ラップ複製で表示される点/頂点/線/面が掴めない -----------------
  //
  // The renderer draws every primitive once per ±360° turn its continuous-longitude
  // span overlaps the viewport (canvas2d-renderer drawBatch → wrapTurnsForLonSpan). A
  // feature whose CANONICAL longitude is off-screen but whose wrap REPLICA is on-screen
  // is therefore visible. Before the fix the hit-test projected ONLY the canonical
  // longitude for vertex/point/line proximity (and probed the area body at a fixed ±1
  // turn only), so a click on the visible replica resolved to nothing — 見えているのに
  // 掴めない. With `wrap` carrying the frame's camera/viewport the hit-test enumerates
  // the SAME turns the renderer drew (clip ⊇ draw ⊇ hit), so the replica is grabbable.
  //
  // Setup: camera centred a FULL world turn east (centerLon 360), so the on-screen lon
  // window is [350, 370]. A feature stored at canonical lon ~0–4 is OFF this window, but
  // its +360° replica lands at lon 360–364 — squarely on screen. Every assertion clicks
  // the REPLICA's screen position and expects the feature to be hit.
  describe('±360° wrap-replica is grabbable (renderer/hit-test wrap parity)', () => {
    // centerLon = 360 (one turn east); view window lon ∈ [350, 370] at zoom 10, w=200.
    const wrapCamera: Camera = { centerLon: 360, centerLat: 2, zoom: 10 };
    const wrapViewport: Viewport = viewport;
    const wrapToScreen = (w: { lon: number; lat: number }) =>
      worldToScreen(w, wrapCamera, wrapViewport);
    const wrap = { camera: wrapCamera, viewport: wrapViewport };

    it('grabs a VERTEX shown only as a +360° replica', () => {
      const a = squareLeaf('f-a', 'va', 0, 0); // canonical corner at lon 0; replica at 360
      const root = commit(emptyProject(), a, 1000);
      // The (0,0) corner's REPLICA is at lon 360, lat 0 — on screen under wrapCamera.
      const replicaCorner = wrapToScreen({ lon: 360, lat: 0 });
      const hit = liveHitTestAt(
        { root, time, toScreen: wrapToScreen, wrap, point: { x: replicaCorner.x + 1, y: replicaCorner.y - 1 } },
        // World coordinate of the click (canonical, off-window): screenToWorld returns
        // ~lon 360 here, but the body/vertex math wraps it — the click lands on the replica.
        screenToWorldFor({ x: replicaCorner.x + 1, y: replicaCorner.y - 1 }),
      );
      expect(hit.kind).toBe(HIT_KIND.Vertex);
      if (hit.kind === HIT_KIND.Vertex) {
        expect(hit.featureId).toBe(a.feature.id);
        expect(hit.vertexId).toBe(asVertexId('va-0'));
      }
    });

    it('grabs an AREA BODY shown only as a +360° replica', () => {
      const a = squareLeaf('f-a', 'va', 0, 0); // covers canonical [0,4]²; replica [360,364]²
      const root = commit(emptyProject(), a, 1000);
      // Centre of the replica body (lon 362, lat 2), away from any vertex.
      const replicaCentre = { lon: 362, lat: 2 };
      const screen = wrapToScreen(replicaCentre);
      const hit = liveHitTestAt(
        { root, time, toScreen: wrapToScreen, wrap, point: screen },
        screenToWorldFor(screen),
      );
      expect(hit.kind).toBe(HIT_KIND.FeatureBody);
      if (hit.kind === HIT_KIND.FeatureBody) expect(hit.featureId).toBe(a.feature.id);
    });

    it('grabs a POINT shown only as a +360° replica', () => {
      const p = pointFeature('f-p', 'vp', 3, 3); // canonical lon 3; replica lon 363
      const root = commit(emptyProject(), p, 1000);
      const at = { lon: 363, lat: 3 };
      const hit = liveHitTestAt(
        { root, time, toScreen: wrapToScreen, wrap, point: wrapToScreen(at) },
        screenToWorldFor(wrapToScreen(at)),
      );
      expect(hit.kind).toBe(HIT_KIND.Vertex);
      if (hit.kind === HIT_KIND.Vertex) expect(hit.featureId).toBe(p.feature.id);
    });

    it('grabs a LINE BODY (mid-segment) shown only as a +360° replica', () => {
      const ln = lineFeature('f-l', 'vl', [
        [0, 2],
        [4, 2],
      ]); // canonical horizontal seg lon 0→4; replica lon 360→364
      const root = commit(emptyProject(), ln, 1000);
      // Mid of the replica segment (lon 362, lat 2) — not near an endpoint.
      const mid = { lon: 362, lat: 2 };
      const hit = liveHitTestAt(
        { root, time, toScreen: wrapToScreen, wrap, point: wrapToScreen(mid) },
        screenToWorldFor(wrapToScreen(mid)),
      );
      expect(hit.kind).toBe(HIT_KIND.FeatureBody);
      if (hit.kind === HIT_KIND.FeatureBody) expect(hit.featureId).toBe(ln.feature.id);
    });

    it('grabs a deep zoom-out replica AREA BODY at +720° (turns are span-derived, not fixed ±1)', () => {
      // Zoom far OUT so the viewport spans more than two world turns: the area body must
      // be probed at the +2 turn, which the OLD fixed ±1 probe missed (lon=720 取りこぼし).
      // A WIDE square (160° across) so its replica centre is well clear of any corner
      // vertex in screen px — a genuine body hit, not a vertex hit. Width is kept
      // under 180° so the area's resolved ring is unambiguous: the display pipeline
      // now seam-UNWRAPS every area ring (parity with the line path), so a >180°
      // single edge would be re-read as the short way round — a genuinely wide area
      // is represented with each edge ≤ 180°.
      const big = bigSquareLeaf('f-big', 'vbig', 0, -80, 160); // canonical [0,160]×[-80,80]
      const root = commit(emptyProject(), big, 1000);
      const wideCamera: Camera = { centerLon: 820, centerLat: 0, zoom: 0.2 }; // view spans ~1000° (>2 turns)
      const wideToScreen = (w: { lon: number; lat: number }) =>
        worldToScreen(w, wideCamera, wrapViewport);
      const wideWrap = { camera: wideCamera, viewport: wrapViewport };
      // Centre of the +720° replica body (canonical centre lon 80 → replica lon 800).
      const replicaCentre = { lon: 800, lat: 0 };
      const screen = wideToScreen(replicaCentre);
      const hit = liveHitTestAt(
        { root, time, toScreen: wideToScreen, wrap: wideWrap, point: screen },
        worldToScreen2(screen, wideCamera),
      );
      expect(hit.kind).toBe(HIT_KIND.FeatureBody);
      if (hit.kind === HIT_KIND.FeatureBody) expect(hit.featureId).toBe(big.feature.id);
    });

    // --- bughunt3: drawnAreaAtPoint inline-probe parity (no probes[] allocation) -------
    //
    // drawnAreaAtPoint no longer materialises a per-area `probes[]` array; it probes each
    // ±360° offset INLINE and exits on the first matching (offset, polygon) pair. The
    // reorganised loop nests offset-OUTER / polygon-INNER (the original was
    // polygon-outer / probe-inner). Both are the SAME existential over (offset, polygon)
    // pairs, but the most demanding case to keep green is a MULTI-polygon area whose hit
    // is in a NON-first polygon at a NON-zero offset: it forces the inner polygon `.some`
    // past index 0 AND the outer offset `.some` past the canonical turn. An aggregate at
    // N=0 over two DISJOINT child squares draws exactly such a multi-polygon集約形状.
    it('grabs the SECOND polygon of a multi-polygon aggregate shown only as a +360° replica', () => {
      // Two disjoint child squares → aggregate集約形状 is a multi-polygon: [0,4]² and
      // [6,10]². The click lands in the SECOND polygon ([6,10]²), under the +360° replica.
      const childA = squareLeaf('f-mpa', 'vmpa', 0, 0); // first polygon [0,4]²
      const childB = squareLeaf('f-mpb', 'vmpb', 6, 0); // second polygon [6,10]²
      const aggId = asFeatureId('f-mpagg');
      const agg = createAggregateFeature(
        aggId,
        createBasicAttributes('f-mpagg', 0, 0),
        color,
        [childA.feature.id, childB.feature.id],
      );
      let root = commit(emptyProject(), { feature: agg, vertices: [] }, 1000);
      root = commit(root, { feature: withParentId(childA.feature, aggId), vertices: childA.vertices }, 1000);
      root = commit(root, { feature: withParentId(childB.feature, aggId), vertices: childB.vertices }, 1000);
      // Centre of the SECOND polygon's +360° replica body (canonical lon 8 → replica 368),
      // away from any vertex so it is a genuine body containment hit.
      const replicaCentre = { lon: 368, lat: 2 };
      const screen = wrapToScreen(replicaCentre);
      const hit = liveHitTestAt(
        {
          root,
          time,
          displayControl: { globalDepth: 0, focus: { originId: null, depth: 0, emphasize: false } },
          toScreen: wrapToScreen,
          wrap,
          point: screen,
        },
        screenToWorldFor(screen),
      );
      expect(hit.kind).toBe(HIT_KIND.FeatureBody);
      if (hit.kind === HIT_KIND.FeatureBody) expect(hit.featureId).toBe(aggId);
    });
  });

  // --- bughunt2: 病的ズームアウトでも hit-test は O(features × cursor-window) に収まる ---
  //
  // `wrapTurnsForLonSpan` is BOUNDED (MAX_WRAP_REPLICAS = 100_000) but at a pathological
  // full zoom-out (tiny zoom over a very wide covered span) it can still return TENS OF
  // THOUSANDS of turns. The hit-test used to probe EVERY such replica for EVERY vertex /
  // line-vertex / polygon-ring on every pointerdown — tens of millions of synchronous
  // projections that jank the UI thread. The fix clamps the per-drawable turn enumeration
  // to the few replicas whose footprint can reach the cursor (drawnLonOffsets TAIL-LATENCY
  // CLAMP), so the probe count is independent of how many turns the viewport spans — while
  // still resolving the SAME replica the renderer drew (clip ⊇ draw ⊇ hit unchanged).
  describe('extreme zoom-out hit-test is bounded (bughunt2 tail-latency clamp)', () => {
    it('probes only a handful of replicas yet still grabs the on-screen one', () => {
      // A point at canonical lon 0. A tiny-zoom frame whose covered span is millions of
      // degrees → `wrapTurnsForLonSpan` returns thousands of turns (well below the cap).
      const p = pointFeature('f-zp', 'vzp', 0, 0);
      const root = commit(emptyProject(), p, 1000);
      // A tiny zoom whose covered span is ~7.2 million degrees → tens of thousands of turns,
      // yet the 8px grab radius is only a small fraction of that span (so the cursor window
      // is a SMALL slice of the drawn turn list — the clamp's win is unambiguous here).
      const tinyCamera: Camera = { centerLon: 3_600_000, centerLat: 0, zoom: 5e-5 };
      const tinyViewport: Viewport = { widthCss: 360, heightCss: 360, devicePixelRatio: 1 };
      // Sanity: the renderer's own turn enumeration for this point's span is enormous, so
      // the OLD code would have done ~that many projections for this single vertex alone.
      const drawnTurns = wrapTurnsForLonSpan(0, 0, tinyCamera, tinyViewport);
      expect(drawnTurns.length).toBeGreaterThan(10_000);

      // Count projector invocations during ONE hit-test.
      let projections = 0;
      const countingToScreen = (w: { lon: number; lat: number }) => {
        projections += 1;
        return worldToScreen(w, tinyCamera, tinyViewport);
      };
      const wrap = { camera: tinyCamera, viewport: tinyViewport };
      // The replica nearest the camera centre is turn 10_000 (lon 3_600_000).
      const replica = { lon: 3_600_000, lat: 0 };
      const screen = worldToScreen(replica, tinyCamera, tinyViewport);
      const clickWorld = screenToWorld(screen, tinyCamera, tinyViewport);
      const hit = liveHitTestAt(
        { root, time, toScreen: countingToScreen, wrap, point: screen },
        { lon: clickWorld.lon, lat: clickWorld.lat },
      );

      // Still resolves the on-screen replica (clip ⊇ draw ⊇ hit unchanged).
      expect(hit.kind).toBe(HIT_KIND.Vertex);
      if (hit.kind === HIT_KIND.Vertex) expect(hit.featureId).toBe(p.feature.id);
      // The probe count is BOUNDED by the cursor window, NOT the turn list: the cursor
      // window is ~1 + 2·(radius/zoom)/period turns wide (a small fraction of the span), so
      // the projection count is a SMALL FRACTION of what the OLD full-turn probe did. The
      // point is probed in two passes (vertex-owner step 1 + point-body step 2), so the OLD
      // cost was ~2·drawnTurns.length; assert we are an order of magnitude below that.
      expect(projections).toBeLessThan(drawnTurns.length / 10);
    });

    it('still returns EMPTY when no replica lands under the cursor (no false hit from the clamp)', () => {
      // Same pathological frame, but click FAR from any replica of the point (a lat far off
      // the point's lat so no replica is within the grab radius). The clamp must not invent
      // a hit, and must not iterate the whole turn list to decide so.
      const p = pointFeature('f-zp2', 'vzp2', 0, 0);
      const root = commit(emptyProject(), p, 1000);
      const tinyCamera: Camera = { centerLon: 3_600_000, centerLat: 0, zoom: 5e-5 };
      const tinyViewport: Viewport = { widthCss: 360, heightCss: 360, devicePixelRatio: 1 };
      const drawnTurns = wrapTurnsForLonSpan(0, 0, tinyCamera, tinyViewport);
      const wrap = { camera: tinyCamera, viewport: tinyViewport };
      let projections = 0;
      const countingToScreen = (w: { lon: number; lat: number }) => {
        projections += 1;
        return worldToScreen(w, tinyCamera, tinyViewport);
      };
      // Click at the TOP edge: far in the y axis (lat) from the lat-0 point, so no replica
      // is within the grab radius regardless of longitude. The clamp must not invent a hit,
      // and must still bound the probe count rather than walking the whole turn list.
      const screen = { x: 180, y: 0 };
      const clickWorld = screenToWorld(screen, tinyCamera, tinyViewport);
      const hit = liveHitTestAt(
        { root, time, toScreen: countingToScreen, wrap, point: screen },
        { lon: clickWorld.lon, lat: clickWorld.lat },
      );
      expect(hit.kind).toBe(HIT_KIND.Empty);
      expect(projections).toBeLessThan(drawnTurns.length / 10);
    });
  });

  // --- bughunt: 一部の頂点が解決できない line は描画もヒットもされない ---------------
  //
  // committed-features draws a LINE all-or-nothing: if ANY of its vertexIds fails to
  // resolve in the live vertex store it sets resolvable=false and drops the WHOLE
  // primitive (a line [v1, missing, v2] is NOT drawn). The hit-test must mirror that
  // rule, but it used to diverge: vertexOwners claimed EVERY line vertexId (incl. the
  // surviving v1/v2) and the body path built per-contiguous-run geometry skipping the
  // gap — so an INVISIBLE, partially-corrupt line stayed selectable by clicking a
  // surviving endpoint or segment (描画とヒットの不一致, clip ⊇ draw ⊇ hit 違反).
  //
  // Repro: commit a 3-vertex line, then drop its MIDDLE vertex from the resolved store
  // (a partially-corrupt snapshot). The line is undrawn; neither its surviving
  // endpoints (vertex hit) nor its surviving segment (body hit) may select it.
  describe('partially-resolvable line (renderer/hit-test all-or-nothing parity)', () => {
    /** Rebuild `root` with `vid` removed from every anchor snapshot's vertex store. */
    function dropVertex(root: DomainRoot, vid: ReturnType<typeof asVertexId>): DomainRoot {
      return {
        ...root,
        histories: root.histories.map((h) => ({
          ...h,
          series: {
            ...h.series,
            entries: h.series.entries.map((e) => {
              const survivors: Vertex[] = [];
              for (const v of e.anchor.snapshot.vertices.byId.values()) {
                if (v.id !== vid) survivors.push(v);
              }
              return {
                ...e,
                anchor: {
                  ...e.anchor,
                  snapshot: {
                    ...e.anchor.snapshot,
                    vertices: createVertexStore(survivors),
                  },
                },
              };
            }),
          },
        })),
      };
    }

    // A 3-vertex horizontal line at lat 2: endpoints lon 0 & 4, middle lon 2.
    function corruptLineRoot(): { root: DomainRoot; lineId: ReturnType<typeof asFeatureId> } {
      const ln = lineFeature('f-corrupt', 'vcl', [
        [0, 2],
        [2, 2], // middle vertex — this one we drop
        [4, 2],
      ]);
      const committed = commit(emptyProject(), ln, 1000);
      const root = dropVertex(committed, asVertexId('vcl-1'));
      return { root, lineId: ln.feature.id };
    }

    it('does NOT select the line via a surviving ENDPOINT vertex', () => {
      const { root } = corruptLineRoot();
      // Click right on the surviving (0,2) endpoint. If vertexOwners still claimed it
      // this would be a vertex hit on the (invisible) line — the bug.
      const endpoint = { lon: 0, lat: 2 };
      const hit = liveHitTestAt(
        { root, time, toScreen, point: toScreen(endpoint) },
        endpoint,
      );
      expect(hit.kind).toBe(HIT_KIND.Empty);
    });

    it('does NOT select the line via a surviving BODY segment', () => {
      const { root } = corruptLineRoot();
      // Click the midpoint of the SURVIVING 0→? run. With the middle vertex gone the
      // only resolvable run that the old per-run body path built was the lone endpoint
      // at lon 0 / lon 4 (no drawable segment), but a 4-vertex variant would expose a
      // real surviving segment; either way the body must not hit. Probe lon 3.5 lat 2,
      // which lies on the original 2→4 drawn segment yet is far (>8px) from lon 4's
      // endpoint — a clean body-only probe.
      const onSegment = { lon: 3.5, lat: 2 };
      const hit = liveHitTestAt(
        { root, time, toScreen, point: toScreen(onSegment) },
        onSegment,
      );
      expect(hit.kind).toBe(HIT_KIND.Empty);
    });

    it('a FULLY-resolvable line IS still selectable (no regression)', () => {
      // Sanity: with NO vertex dropped the same line is drawn and grabbable, so the
      // all-or-nothing guard only suppresses the corrupt case.
      const ln = lineFeature('f-ok', 'vok', [
        [0, 2],
        [2, 2],
        [4, 2],
      ]);
      const root = commit(emptyProject(), ln, 1000);
      const endpoint = { lon: 0, lat: 2 };
      const hit = liveHitTestAt(
        { root, time, toScreen, point: toScreen(endpoint) },
        endpoint,
      );
      expect(hit.kind).toBe(HIT_KIND.Vertex);
      if (hit.kind === HIT_KIND.Vertex) expect(hit.featureId).toBe(ln.feature.id);
    });
  });

  // --- bughunt: 1 頂点だけの line は描画されないのに頂点として掴める -------------------
  //
  // committed-features draws a line all-or-nothing AND only when it has ≥2 resolved
  // vertices (feature-layer.buildLinePrimitives needs points.length≥2). A degenerate
  // 1-vertex line (corrupt load / mid-edit transient) therefore renders to NOTHING.
  // But the hit-test's lineFullyResolved used to return true for it (its single vertex
  // resolves), so vertexOwners registered that invisible vertex as grabbable and a
  // click near it selected the undrawn line (clip ⊇ draw ⊇ hit 違反). The fix shares
  // the SINGLE domain predicate isDrawableLineVertexCount(≥2) with committed-features,
  // so a sub-2-vertex line contributes NEITHER a grabbable vertex NOR a body.
  describe('degenerate 1-vertex line (renderer/hit-test minimum-vertex parity)', () => {
    /** A root holding one committed line with a SINGLE vertex at (lon,lat). */
    function soloLineRoot(
      lon: number,
      lat: number,
    ): { root: DomainRoot; lineId: ReturnType<typeof asFeatureId> } {
      // lineFeature builds a vertex per point; one point ⇒ a 1-vertex line.
      const ln = lineFeature('f-solo', 'vsolo', [[lon, lat]]);
      expect(ln.feature.kind === 'line' && ln.feature.vertexIds.length).toBe(1);
      return { root: commit(emptyProject(), ln, 1000), lineId: ln.feature.id };
    }

    it('does NOT select the line via its single (invisible) VERTEX', () => {
      const { root } = soloLineRoot(2, 2);
      // Click right on the lone vertex. With the bug this returned a vertex hit on the
      // undrawn line; the fix makes it empty (nothing drawn is grabbable here).
      const at = { lon: 2, lat: 2 };
      const hit = liveHitTestAt(
        { root, time, toScreen, point: toScreen(at) },
        at,
      );
      expect(hit.kind).toBe(HIT_KIND.Empty);
    });

    it('does NOT select the line via a BODY probe at its single vertex', () => {
      const { root } = soloLineRoot(2, 2);
      // A 1-vertex line has no segment, so even the body path must contribute nothing.
      // Probe a hair off the vertex (still inside the grab radius) — still empty.
      const near = toScreen({ lon: 2, lat: 2 });
      const hit = liveHitTestAt(
        { root, time, toScreen, point: { x: near.x + 1, y: near.y + 1 } },
        { lon: 2, lat: 2 },
      );
      expect(hit.kind).toBe(HIT_KIND.Empty);
    });
  });
});

describe('multiPolygonLonSpan memoization (bughunt3 #medium)', () => {
  // drawnAreaAtPoint calls multiPolygonLonSpan(area.shape) for EVERY area on EVERY
  // pointer event that reaches the area-body probe; the span is a triple-nested walk
  // over every vertex. The fix caches it keyed by the IMMUTABLE shape array reference
  // (the resolved shapes are shared across frames via the display-resolution memo). This
  // regression pins BOTH halves of that contract, mirroring feature-layer's shapeRect:
  //  (1) CORRECTNESS — the span equals a fresh full computation, AND
  //  (2) REFERENCE-KEYED CACHE — the SAME array reference returns the IDENTICAL result
  //      object (cache hit, no re-walk), while a structurally-equal but DIFFERENT
  //      reference yields an equal-but-distinct object (cache miss — never a stale span
  //      after the domain rebuilds the shape).
  it('caches the span per shape reference without serving a stale value', () => {
    const shape: GeoMultiPolygon = [
      [
        // Outer ring spanning lon [-10, 20].
        [
          { lon: -10, lat: -5 },
          { lon: 20, lat: -5 },
          { lon: 20, lat: 15 },
          { lon: -10, lat: 15 },
        ],
        // A hole ring INSIDE the outer lon range (must not widen the span).
        [
          { lon: 0, lat: 0 },
          { lon: 5, lat: 0 },
          { lon: 5, lat: 5 },
        ],
      ],
      // A second disjoint piece that DOES widen the span to lon=50 (片落とし禁止 教訓 5.1).
      [
        [
          { lon: 40, lat: 30 },
          { lon: 50, lat: 30 },
          { lon: 50, lat: 35 },
        ],
      ],
    ];
    const expected = { min: -10, max: 50 };
    const first = multiPolygonLonSpan(shape);
    expect(first).toEqual(expected);
    // Same reference ⇒ exact same object back (proves it was cached, not re-walked).
    expect(multiPolygonLonSpan(shape)).toBe(first);

    // Structurally identical but a NEW reference ⇒ recomputed (equal, not same).
    const cloned: GeoMultiPolygon = shape.map((piece) =>
      piece.map((ring) => ring.map((c) => ({ ...c }))),
    );
    const cloneSpan = multiPolygonLonSpan(cloned);
    expect(cloneSpan).toEqual(expected);
    expect(cloneSpan).not.toBe(first);

    // Empty shape caches `undefined` (教訓 5.18 absence, not a crash) — the sentinel
    // `.has` path must treat undefined as a real cached result, not a miss.
    const empty: GeoMultiPolygon = [];
    expect(multiPolygonLonSpan(empty)).toBeUndefined();
    expect(multiPolygonLonSpan(empty)).toBeUndefined();
  });
});

/** screenToWorld against the wrap test camera (centerLon 360). */
function screenToWorldFor(s: { x: number; y: number }): { lon: number; lat: number } {
  const w = screenToWorld(s, { centerLon: 360, centerLat: 2, zoom: 10 }, {
    widthCss: 200,
    heightCss: 200,
    devicePixelRatio: 1,
  });
  return { lon: w.lon, lat: w.lat };
}

/** screenToWorld against an arbitrary camera (for the wide zoom-out case). */
function worldToScreen2(
  s: { x: number; y: number },
  cam: Camera,
): { lon: number; lat: number } {
  const w = screenToWorld(s, cam, { widthCss: 200, heightCss: 200, devicePixelRatio: 1 });
  return { lon: w.lon, lat: w.lat };
}
