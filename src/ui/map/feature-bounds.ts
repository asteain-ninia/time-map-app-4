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

import { FEATURE_KIND, type Feature } from '../../domain/feature';
import { shortestLonDeltaDeg, wrapLonDeg } from '../../domain/geo/longitude';
import { alignMultiPolygon } from '../../domain/geo/seam';
import { isMultiPolygonEmpty } from '../../domain/geometry/types';
import { buildForest } from '../../domain/hierarchy/forest';
import { resolveFeatureArea } from '../../domain/hierarchy/resolve-shape';
import type { FeatureId } from '../../domain/ids';
import type { DomainProject } from '../../domain/persistence/index';
import { multiPolygonBBox, type BBox } from '../../domain/spatial/bbox';
import type { TimePoint } from '../../domain/time/time-point';
import type { WorldCoordinate } from '../../domain/coordinate';
import { WORLD_LON_SPAN_DEG, type WorldBounds } from '../../render';

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
  return boundsOfFeature(root, time, feature, features);
}

/**
 * {@link featureBoundsAt} for a feature ALREADY resolved out of `features` (the
 * `featuresAt(root, time)` list it belongs to). Split out so a batch caller
 * ({@link allFeaturesBoundsAt}) can iterate the list ONCE instead of re-scanning it
 * per feature — the public entry point stays the id-keyed one, and both share this
 * single extent derivation (単一真実源).
 */
function boundsOfFeature(
  root: DomainProject,
  time: TimePoint,
  feature: Feature,
  features: readonly Feature[],
): WorldBounds | null {
  const featureId = feature.id;
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

/**
 * Shift a box by whole ±360° turns so its CENTER lands on the branch nearest `ref`.
 * The span is preserved exactly (both edges move together), so an antimeridian-
 * straddling feature keeps the short-way width `featureBoundsAt` gave it.
 *
 * The ±360° step rule itself is NOT re-derived here — it is `shortestLonDeltaDeg`
 * (U04), the same single helper the seam alignment and the geodesy use (単一真実源).
 * Anchoring by the box CENTER mirrors `unwrapRingAnchored`'s mean-anchoring rule:
 * anchoring by an edge would pull a >180°-wide box a whole turn away.
 */
function alignBoxLonToBranch(box: WorldBounds, ref: number): WorldBounds {
  const center = (box.minLon + box.maxLon) / 2;
  const shift = ref + shortestLonDeltaDeg(ref, center) - center;
  if (shift === 0) return box;
  return { ...box, minLon: box.minLon + shift, maxLon: box.maxLon + shift };
}

/** Options for {@link allFeaturesBoundsAt}. */
export interface AllFeaturesBoundsOptions {
  /**
   * The FR-113 母集合 gate: return false for a feature that is NOT drawn (filtered out,
   * 個別非表示, 種別オフ, 深度フィルタ). 全体表示 must frame what the user can SEE — including
   * a hidden feature's extent would zoom out onto empty space. Omitted ⇒ every effective
   * feature counts (the inert-filter fast path; the caller pays nothing).
   */
  readonly isVisible?: (featureId: FeatureId) => boolean;
}

/**
 * The world bounding box covering EVERY feature effective at `time` (optionally
 * restricted to the FR-113 visible母集合, see {@link AllFeaturesBoundsOptions}) — the
 * extent the 表示 →「全体表示」command frames (現在の視点から全地物が収まる視点へ一発で戻る)
 * — or `null` when nothing is effective / visible / resolvable at that time (the caller
 * then falls back to the FR-11 既定視点).
 *
 * Reuses the SAME per-feature extent derivation as {@link featureBoundsAt} rather than
 * a second bbox path, so a shape that frames correctly from the 錨一覧 frames identically
 * here (単一真実源, 教訓 5.29 — one extent resolution, one padding/clamp policy). The
 * `featuresAt` list is walked ONCE and each feature handed to the shared derivation
 * directly, so the command is O(features) (not O(features²) through an id lookup).
 *
 * AGGREGATES are skipped: an aggregate's extent IS the union of its (already visited)
 * descendant leaves, so including it would only re-derive the same box through the
 * expensive U08 union resolution — with no loss of coverage (a childless aggregate has
 * no extent at all).
 *
 * SEAM (review fix): the union is taken on a COMMON longitude branch, not by a naive
 * `Math.min`/`Math.max`. Each feature's own box is already a continuous run, but those
 * runs may sit whole turns apart — a feature stored at lon 176 and its neighbour stored
 * at −179 are 5° apart ACROSS the seam, and an infinite-scroll click never folds
 * longitude (U03 / coords-format), so a face drawn while scrolling east is stored at
 * lon≈370 even though it paints exactly where lon≈10 does. A raw min/max would frame the
 * 357° long way in the first case and a 362° band — WIDER than the world — in the second.
 * So every box is folded to a representative branch and then anchored to the running
 * union's center by the shortest arc, and the final span is capped at the world's 360°
 * (a project genuinely covering the globe frames the whole world, never more).
 */
export function allFeaturesBoundsAt(
  root: DomainProject,
  time: TimePoint,
  options: AllFeaturesBoundsOptions = {},
): WorldBounds | null {
  const { isVisible } = options;
  const features = featuresAt(root, time);
  let out: WorldBounds | null = null;
  for (const feature of features) {
    if (feature.kind === FEATURE_KIND.Aggregate) continue;
    if (isVisible !== undefined && !isVisible(feature.id)) continue;
    const raw = boundsOfFeature(root, time, feature, features);
    if (raw === null) continue;
    if (out === null) {
      // Seed on the REPRESENTATIVE branch so a +360k-turn first feature does not drag
      // the whole framing a world away from where it is painted.
      out = alignBoxLonToBranch(raw, wrapLonDeg((raw.minLon + raw.maxLon) / 2));
      continue;
    }
    const box = alignBoxLonToBranch(raw, (out.minLon + out.maxLon) / 2);
    out = {
      minLon: Math.min(out.minLon, box.minLon),
      maxLon: Math.max(out.maxLon, box.maxLon),
      minLat: Math.min(out.minLat, box.minLat),
      maxLat: Math.max(out.maxLat, box.maxLat),
    };
  }
  if (out === null) return out;
  // Features spread all the way round accumulate to (at most) the world; never past it.
  if (out.maxLon - out.minLon > WORLD_LON_SPAN_DEG) {
    const center = (out.minLon + out.maxLon) / 2;
    return {
      ...out,
      minLon: center - WORLD_LON_SPAN_DEG / 2,
      maxLon: center + WORLD_LON_SPAN_DEG / 2,
    };
  }
  return out;
}
