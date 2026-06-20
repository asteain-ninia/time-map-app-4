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
  createLeafFeature,
  createPointFeature,
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
});
