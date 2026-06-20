// U42 — domain→render measurement adapter (受け入れ基準 2 / integration seam).
//
// THE SEAM THAT MAKES THE PERF MEASUREMENT REAL. The harness entrypoint
// (`runPerfHarness`) measures the render frame cost, but the NFR 5.2 規模 it must
// actually run is "5,000 オブジェクト × 平均 10 錨" — and 錨 (anchors) only exist on
// the DOMAIN side (`DomainProject`, via `generateSyntheticProject`). The U19 render
// benchmark draws `EvaluatedFeature[]`, which carries NO anchor. Left unconnected,
// the harness measured anchor-free render fixtures, so the 錨 dimension of the NFR
// scale was never exercised and the stamped `scale` was a constant, not the data.
//
// This module is the ONE typed adapter that closes that gap: it takes a
// `DomainProject` (anchored), RESOLVES each feature's anchor series at a time point
// through the REAL domain resolution path (`resolveAt` — so every 錨 列 is actually
// traversed and the active full-state snapshot is selected, §5.8), flattens the
// resolved snapshots into render `EvaluatedFeature`s, AND reports the ACTUAL scale
// that was measured (resolved feature count + real mean anchors/feature). The
// harness then stamps the record with measured-from-data scale, never a constant
// (受け入れ基準 2: 規模が実測と一致する機械可読レコード).
//
// LAYER / DEPENDENCY DIRECTION (技術方針 2.13): lives in `render`, depends on
// `domain` only (inward). PURITY: builds fresh arrays; inputs are never mutated.

import { resolveAt } from '../../domain/anchor-series';
import type { Feature } from '../../domain/feature';
import { getCalendar } from '../../domain/time/calendar';
import type { Calendar } from '../../domain/time/calendar';
import { timePointYear } from '../../domain/time/time-point';
import type { TimePoint } from '../../domain/time/time-point';
import { getVertex } from '../../domain/vertex';
import type { VertexStore } from '../../domain/vertex';
import type { DomainProject } from '../../domain/persistence/serialize';
import { totalAnchorCount } from '../../domain/perf/synthetic';

import type {
  EvaluatedArea,
  EvaluatedFeature,
  EvaluatedLine,
  EvaluatedPoint,
  FeatureStyle,
} from '../feature-layer';

/** The presentation style the synthetic render features carry (cosmetic only). */
const SYNTHETIC_STYLE: FeatureStyle = {
  fill: '#3366cc',
  stroke: '#1a3366',
  selectedColor: '#00e5ff',
};

/** The result of evaluating a domain project for measurement. */
export interface ProjectFeatureScene {
  /** The render features drawn by the harness (one per resolved domain feature). */
  readonly features: readonly EvaluatedFeature[];
  /** The ACTUAL data scale the measurement ran at (NOT a constant). */
  readonly scale: { readonly objectCount: number; readonly meanAnchorsPerFeature: number };
}

/**
 * Convert ONE resolved domain `Feature` (with its snapshot's vertex store) into a
 * render `EvaluatedFeature`. Aggregates have no own geometry (their area is a
 * derived union owned by U08) so they are NOT emitted here — only the leaf bodies
 * they group are drawable (受け入れ基準: 省略は描画指示に現れない). A feature whose
 * vertices cannot be resolved is skipped (returns null). Pure.
 */
function toEvaluatedFeature(
  feature: Feature,
  vertices: VertexStore,
): EvaluatedFeature | null {
  switch (feature.kind) {
    case 'point': {
      const v = getVertex(vertices, feature.vertexId);
      if (v === undefined) return null;
      const point: EvaluatedPoint = {
        kind: 'point',
        id: feature.id as string,
        at: { lon: v.coordinate.lon, lat: v.coordinate.lat },
        style: SYNTHETIC_STYLE,
        label: feature.id as string,
        selected: false,
      };
      return point;
    }
    case 'line': {
      const pts: { lon: number; lat: number }[] = [];
      for (const id of feature.vertexIds) {
        const v = getVertex(vertices, id);
        if (v === undefined) return null;
        pts.push({ lon: v.coordinate.lon, lat: v.coordinate.lat });
      }
      const line: EvaluatedLine = {
        kind: 'line',
        id: feature.id as string,
        points: pts,
        style: SYNTHETIC_STYLE,
        label: feature.id as string,
        selected: false,
      };
      return line;
    }
    case 'leaf': {
      // Each territory ring (with its child holes) becomes one polygon piece, so
      // an enclave (territory inside a hole) is its OWN piece (教訓 5.1 全片保持).
      const territories = feature.shape.rings.filter((r) => r.kind === 'territory');
      const holes = feature.shape.rings.filter((r) => r.kind === 'hole');
      const polygons: { lon: number; lat: number }[][][] = [];
      for (const terr of territories) {
        const outer: { lon: number; lat: number }[] = [];
        for (const id of terr.vertexIds) {
          const v = getVertex(vertices, id);
          if (v === undefined) return null;
          outer.push({ lon: v.coordinate.lon, lat: v.coordinate.lat });
        }
        const childHoles = holes.filter((h) => h.parentRingId === terr.id);
        const rings: { lon: number; lat: number }[][] = [outer];
        for (const hole of childHoles) {
          const ring: { lon: number; lat: number }[] = [];
          for (const id of hole.vertexIds) {
            const v = getVertex(vertices, id);
            if (v === undefined) return null;
            ring.push({ lon: v.coordinate.lon, lat: v.coordinate.lat });
          }
          rings.push(ring);
        }
        polygons.push(rings);
      }
      if (polygons.length === 0) return null;
      const area: EvaluatedArea = {
        kind: 'area',
        id: feature.id as string,
        shape: polygons,
        style: SYNTHETIC_STYLE,
        label: feature.id as string,
        selected: false,
      };
      return area;
    }
    case 'aggregate':
      // No own geometry; its children (leaves in the same snapshot) are emitted.
      return null;
    default:
      return null;
  }
}

/**
 * Evaluate a synthetic {@link DomainProject} into the render scene the harness
 * measures, at the given time point. For every feature history this RESOLVES the
 * anchor series at `time` through the real domain path (`resolveAt`) — so the 錨 列
 * is actually traversed (the 錨 dimension of NFR 5.2 is exercised, not bypassed) —
 * and flattens the active anchor's full-state snapshot into render features.
 *
 * The returned `scale` is computed FROM THE DATA: `objectCount` is the number of
 * resolved drawable features, and `meanAnchorsPerFeature` is the project's real
 * total-anchor / history mean. The harness stamps records with THIS, never a
 * constant (受け入れ基準 2). Pure: no clock, no mutation.
 */
export function evaluateProjectForMeasurement(
  project: DomainProject,
  time: TimePoint,
  calendar: Calendar,
): ProjectFeatureScene {
  const features: EvaluatedFeature[] = [];
  for (const history of project.histories) {
    const resolution = resolveAt(history.series, time, calendar);
    if (resolution.kind !== 'present') continue;
    const snapshot = resolution.entry.anchor.snapshot;
    for (const feature of snapshot.features) {
      const evaluated = toEvaluatedFeature(feature, snapshot.vertices);
      if (evaluated !== null) features.push(evaluated);
    }
  }

  const historyCount = project.histories.length;
  const meanAnchorsPerFeature =
    historyCount === 0 ? 0 : totalAnchorCount(project) / historyCount;

  return {
    features,
    scale: {
      objectCount: features.length,
      meanAnchorsPerFeature,
    },
  };
}

/**
 * The default evaluation time for the synthetic harness: year 0, where every
 * generated feature's FIRST anchor (`timePointYear(0)`) is active, so the whole
 * project resolves to "present" and the full NFR scale is materialised. Exposed so
 * the harness and tests agree on the measurement time (単一の真実源).
 */
export function defaultMeasurementTime(): TimePoint {
  return timePointYear(0);
}

/** The synthetic project's calendar (gregorian, matching the generator). */
export function syntheticCalendar(): Calendar {
  return getCalendar('gregorian');
}
