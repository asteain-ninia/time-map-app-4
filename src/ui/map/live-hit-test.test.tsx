// HB-15 — live map hit-test unit lens. Asserts the screen click → U22 HitResult
// rule: 頂点優先 (nearest vertex within the screen-px radius), then leaf body (world
// containment), then point/line proximity, then empty (受け入れ基準: 頂点→地物). The
// resolution reuses live-lookup's featuresAt/verticesAt/leafAtPoint, so what is hit
// matches what is drawn / resolved (二重真実源を作らない, 教訓 5.29).

import { describe, expect, it } from 'vitest';

import { liveHitTestAt } from './live-hit-test';
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
import { createVertex, type Vertex } from '../../domain/vertex';
import { asFeatureId, asRingId, asVertexId } from '../../domain/ids';
import { createGeoParams } from '../../domain/geo/geo-params';
import type { AddSnapshot } from '../../domain/add/index';
import { worldToScreen } from '../../render';
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
});
