// UI layer (map): resolve a feature's world bounding box at a time (HB5-3).
//
// The camera-fit導線 (App: an「錨一覧」/ timeline-origin selection) needs the
// selected feature's world extent so it can frame the view onto it. This module
// owns that resolution ONCE (教訓 5.29 単一真実源): it resolves the feature's
// geometry against the SAME live domain root the renderer / hit-test draw from
// (featuresAt / verticesAt / leafShapeAt), and reduces it to a continuous-longitude
// {@link WorldBounds}. Pure (no React, no store) — callers pass the root + time.
//
// WRAP (task HB5-3 反子午線): a feature straddling the antimeridian must frame the
// SHORT way, not a ~340° band. Leaf shapes come through `leafShapeAt`, which already
// aligns each polygon piece to a CONTINUOUS run (the display path's rule); the
// aggregate path applies the SAME per-piece `alignMultiPolygon`. Points / lines read
// their raw stored coordinates (a single point has no seam; a line's own vertices are
// stored on one continuous branch). The resulting bbox is therefore a continuous-lon
// box whose midpoint is the natural short-way center.

import { FEATURE_KIND } from '../../domain/feature';
import { alignMultiPolygon } from '../../domain/geo/seam';
import { isMultiPolygonEmpty } from '../../domain/geometry/types';
import { buildForest } from '../../domain/hierarchy/forest';
import { resolveFeatureArea } from '../../domain/hierarchy/resolve-shape';
import type { FeatureId } from '../../domain/ids';
import type { DomainProject } from '../../domain/persistence/index';
import { multiPolygonBBox, type BBox } from '../../domain/spatial/bbox';
import type { TimePoint } from '../../domain/time/time-point';
import type { WorldCoordinate } from '../../domain/coordinate';
import type { WorldBounds } from '../../render';

import { featuresAt, verticesAt, leafShapeAt } from '../live-lookup';

/** BBox (minX=lon, minY=lat) → the render-layer WorldBounds framing shape. */
function boundsOfBBox(box: BBox): WorldBounds {
  return { minLon: box.minX, maxLon: box.maxX, minLat: box.minY, maxLat: box.maxY };
}

/** WorldBounds covering a set of world coordinates, or null when empty. */
function boundsOfCoords(coords: readonly WorldCoordinate[]): WorldBounds | null {
  let out: WorldBounds | null = null;
  for (const c of coords) {
    out =
      out === null
        ? { minLon: c.lon, maxLon: c.lon, minLat: c.lat, maxLat: c.lat }
        : {
            minLon: Math.min(out.minLon, c.lon),
            maxLon: Math.max(out.maxLon, c.lon),
            minLat: Math.min(out.minLat, c.lat),
            maxLat: Math.max(out.maxLat, c.lat),
          };
  }
  return out;
}

/**
 * The world bounding box of the feature `featureId` at `time`, in continuous
 * (lon, lat) coordinates — or `null` when the feature is not effective at the time
 * or its geometry is unresolvable / empty (an absent id, a missing vertex, a
 * childless aggregate). Point → its vertex; line → its resolved vertices; leaf →
 * its aligned resolved shape; aggregate → the U08 child-union area (aligned).
 */
export function featureBoundsAt(
  root: DomainProject,
  time: TimePoint,
  featureId: FeatureId,
): WorldBounds | null {
  const features = featuresAt(root, time);
  const feature = features.find((f) => f.id === featureId);
  if (feature === undefined) return null;

  switch (feature.kind) {
    case FEATURE_KIND.Point: {
      const vertex = verticesAt(root, time).byId.get(feature.vertexId);
      return vertex === undefined ? null : boundsOfCoords([vertex.coordinate]);
    }
    case FEATURE_KIND.Line: {
      const store = verticesAt(root, time);
      const coords: WorldCoordinate[] = [];
      for (const id of feature.vertexIds) {
        const v = store.byId.get(id);
        if (v !== undefined) coords.push(v.coordinate);
      }
      return boundsOfCoords(coords);
    }
    case FEATURE_KIND.Leaf: {
      // leafShapeAt aligns each piece to a continuous run (反子午線を短い方で).
      const shape = leafShapeAt(root, time, featureId);
      if (shape === undefined) return null;
      const box = multiPolygonBBox(shape);
      return box === undefined ? null : boundsOfBBox(box);
    }
    case FEATURE_KIND.Aggregate: {
      // The derived area = U08 union of children (the SAME source the map draws).
      const areaFeatures = features.filter(
        (f) => f.kind === FEATURE_KIND.Leaf || f.kind === FEATURE_KIND.Aggregate,
      );
      const forest = buildForest(areaFeatures);
      const resolution = resolveFeatureArea(forest, verticesAt(root, time), featureId);
      if (resolution.status === 'failed' || isMultiPolygonEmpty(resolution.area)) {
        return null;
      }
      // Per-piece align to a continuous run (parity with leafShapeAt / the display path).
      const aligned = resolution.area.map((polygon) => alignMultiPolygon([polygon])[0]!);
      const box = multiPolygonBBox(aligned);
      return box === undefined ? null : boundsOfBBox(box);
    }
    default:
      return null;
  }
}
