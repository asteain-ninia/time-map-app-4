// UI layer — live domain-lookup helpers over the committed DomainProject root.
//
// WHY THIS FILE EXISTS (single truth source, 教訓 5.29):
// Several composition-root seams need "the features / vertices effective at the
// current time" and "which leaf is under this world point" computed against the
// LIVE domain root: the U13 consistency binding (spatial detection /
// resolution write-back) and the U26 knife domain-lookup ports
// (resolveFeature / resolveStore / featureAtPoint). Computing those in two
// places would create a二重真実源 that could drift (e.g. the binding resolves a
// feature the hit-test cannot find). This module owns the rule ONCE; both seams
// import it. It is pure (no React, no store) — callers pass the root + time.

import { resolveAt } from '../domain/anchor-series';
import type { Feature, LeafFeature } from '../domain/feature';
import { FEATURE_KIND } from '../domain/feature';
import type { FeatureId } from '../domain/ids';
import type { DomainProject } from '../domain/persistence/index';
import { getCalendar, type Calendar } from '../domain/time/calendar';
import type { TimePoint } from '../domain/time/time-point';
import { createVertexStore, type Vertex, type VertexStore } from '../domain/vertex';
import { resolveLeafShape } from '../domain/hierarchy/resolve-shape';
import { pointInPolygon, POINT_LOCATION } from '../domain/geometry/predicates';
import type { WorldCoordinate } from '../domain/coordinate';

/** The active calendar (gregorian — matches the rest of the composite). */
const calendar: Calendar = getCalendar('gregorian');

/**
 * Every feature effective at `time` across all histories (U09 resolveAt). The
 * union of each present anchor's snapshot features.
 */
export function featuresAt(root: DomainProject, time: TimePoint): Feature[] {
  const out: Feature[] = [];
  for (const history of root.histories) {
    const resolution = resolveAt(history.series, time, calendar);
    if (resolution.kind !== 'present') continue;
    for (const f of resolution.entry.anchor.snapshot.features) out.push(f);
  }
  return out;
}

/** The vertex store effective at `time` (union of every present anchor's store). */
export function verticesAt(root: DomainProject, time: TimePoint): VertexStore {
  const all: Vertex[] = [];
  for (const history of root.histories) {
    const resolution = resolveAt(history.series, time, calendar);
    if (resolution.kind !== 'present') continue;
    for (const v of resolution.entry.anchor.snapshot.vertices.byId.values()) all.push(v);
  }
  return createVertexStore(all);
}

/**
 * Resolve a single feature by id at `time` (the knife `resolveFeature` port).
 * Returns `undefined` when no feature with that id is effective at the time.
 */
export function featureByIdAt(
  root: DomainProject,
  time: TimePoint,
  featureId: FeatureId,
): Feature | undefined {
  return featuresAt(root, time).find((f) => f.id === featureId);
}

/**
 * Hit-test a world point against the LEAF features effective at `time`, returning
 * the id of the topmost leaf whose resolved shape contains the point, else null
 * (the knife `featureAtPoint` port). Only leaf features are split targets
 * (FR-44 / 教訓 5.25), so aggregates / points / lines are skipped here — the
 * geometry path never sees a non-leaf. The domain `pointInPolygon` predicate is
 * the single containment rule (穴透過 honoured); a point on a hole edge or inside
 * a hole is NOT a hit.
 *
 * Iteration order: later histories win on overlap (drawn-on-top wins), matching
 * the paint order; a tie is rare because terminal overlaps are conflicts.
 */
export function leafAtPoint(
  root: DomainProject,
  time: TimePoint,
  point: WorldCoordinate,
): FeatureId | null {
  const vertices = verticesAt(root, time);
  const leaves: LeafFeature[] = featuresAt(root, time).filter(
    (f): f is LeafFeature => f.kind === FEATURE_KIND.Leaf,
  );
  // The renderer draws each polygon at its canonical longitude AND at ±360°
  // replicas (a polygon spanning the antimeridian, e.g. 179..181, is shown wrapped
  // as a −179.5 replica). The hit-test must agree with what the user sees, so we
  // probe the click point in each ±360° longitude frame as well as the canonical
  // one. Testing the POINT at ±360 (rather than re-wrapping every polygon) covers
  // every replica with the same containment rule (穴透過 honoured). 単一真実源.
  const probes: WorldCoordinate[] = [
    point,
    { lon: point.lon + 360, lat: point.lat },
    { lon: point.lon - 360, lat: point.lat },
  ];
  let hit: FeatureId | null = null;
  for (const leaf of leaves) {
    const shape = resolveLeafShape(leaf.shape, vertices);
    if (shape === undefined) continue;
    const inside = shape.some((polygon) =>
      probes.some((p) => pointInPolygon(p, polygon) === POINT_LOCATION.Inside),
    );
    if (inside) hit = leaf.id; // keep scanning; a later leaf on top wins
  }
  return hit;
}

/**
 * The resolved multipolygon shape of the leaf `featureId` at `time` (for knife
 * target emphasis), or undefined when it is absent / not a leaf.
 */
export function leafShapeAt(
  root: DomainProject,
  time: TimePoint,
  featureId: FeatureId,
): ReturnType<typeof resolveLeafShape> {
  const feature = featureByIdAt(root, time, featureId);
  if (feature === undefined || feature.kind !== FEATURE_KIND.Leaf) return undefined;
  return resolveLeafShape(feature.shape, verticesAt(root, time));
}
