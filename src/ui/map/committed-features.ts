// UI layer (map): committed-feature → U19 render-input bridge (P0-A / CONVERGE-2).
//
// WHY THIS FILE EXISTS (the missing render接続):
// The base map + graticule are composited by the host (host-ports.ts) and the
// add / knife tools feed their PROVISIONAL primitives, but the CONFIRMED
// (committed) domain features the user added / edited / split were never turned
// into draw primitives — so a feature the user committed did not appear on the
// map. This module is the ONE place that turns the committed `DomainProject`,
// resolved at the current timeline instant, into U19 `EvaluatedFeature[]`. The
// host then runs U19's `buildFeaturePrimitives` over the result and composites it
// UNDER the tool overlays, so a committed feature draws and a time change re-draws.
//
// AREAS GO THROUGH U34 (集約形状 / depth / focus — 二重真実源を作らない, 教訓 5.29):
// 面情報 (leaf + aggregate) are NOT drawn one-leaf-at-a-time here. They flow through
// the U34 display pipeline (`buildDisplayAreas`), which applies the store's
// display-control (global depth N + individual focus M, FR-42 / FR-43) and resolves
// each drawable's集約/実形状 through U08's SINGLE `resolveFeatureArea`. So with the
// default N=0 the map shows top-level aggregates rolled up (not every leaf), the
// slider re-derives the batch (教訓 5.5), and the shape U19 fills is byte-for-byte
// what U34 resolved (受け入れ基準 5). Points and lines have NO hierarchy rollup (they
// carry no area), so they are emitted directly — they would resolve to an empty
// multipolygon through the area pipeline and never draw.
//
// SINGLE TRUTH SOURCES:
//   - "which features / vertices are effective at the current time" is U09's
//     resolution, reached through the SAME `featuresAt` / `verticesAt` helpers the
//     hit-test (live-lookup) uses, so what is drawn and what is hit cannot disagree.
//   - "a feature's resolved area" is U08's `resolveFeatureArea`, via U34's pipeline.
//   - the per-feature COLOR is the feature's own persisted `ColorInfo` (FR-100/101),
//     mapped to U19's `FeatureStyle`; the NAME label is `attributes.name` (FR-40 /
//     FR-86), never the FR-40 `kindLabel` (種別) which is usually unset.
//
// PURITY: builds fresh arrays; inputs are never mutated.

import { FEATURE_KIND, type Feature } from '../../domain/feature';
import type { ColorInfo } from '../../domain/attributes';
import type { FeatureId } from '../../domain/ids';
import type { DomainProject } from '../../domain/persistence/index';
import type { TimePoint } from '../../domain/time/time-point';
import { getVertex } from '../../domain/vertex';
import { unwrapLonSequence } from '../../domain/geo/longitude';
import { buildForest } from '../../domain/hierarchy/forest';

import {
  buildDisplayAreas,
  type DisplayControlInput,
} from '../../render/display-pipeline';
import type { PresentationFor } from '../../render/display-bridge';
import type {
  EvaluatedFeature,
  EvaluatedLine,
  EvaluatedPoint,
  FeatureStyle,
} from '../../render/feature-layer';

import { featuresAt, verticesAt } from '../live-lookup';

/** Map a domain `ColorInfo` (FR-100/101) to U19's render `FeatureStyle`. */
function styleOf(color: ColorInfo): FeatureStyle {
  return {
    fill: color.fillColor,
    stroke: color.borderColor,
    selectedColor: color.selectedColor,
  };
}

/** The display label for a feature: its name (FR-40 / FR-86), or empty. */
function labelOf(feature: Feature): string {
  return feature.attributes.name;
}

/**
 * Build the U19 area draw set through the U34 display pipeline (FR-42 / FR-43).
 * Presentation (style / label / selected) comes from the resolved feature's own
 * `ColorInfo` + name; geometry is U34's single-resolved shape (教訓 5.29). The
 * focus-emphasis verdict (FR-43) reuses the selected color so an emphasized region
 * stands out without U34 owning the palette.
 */
function buildAreas(
  features: readonly Feature[],
  store: ReturnType<typeof verticesAt>,
  control: DisplayControlInput,
  selectedId: FeatureId | null,
): EvaluatedFeature[] {
  // Only面情報 (leaf + aggregate) are part of the hierarchy / area pipeline. Points
  // and lines carry no area; if left in the forest they would each yield an EMPTY
  // EvaluatedArea (a phantom that draws nothing but doubles the feature). They are
  // emitted directly by the caller instead, so exclude them here.
  const areaFeatures = features.filter(
    (f) => f.kind === FEATURE_KIND.Leaf || f.kind === FEATURE_KIND.Aggregate,
  );
  const forest = buildForest(areaFeatures);
  const byId = new Map<FeatureId, Feature>(areaFeatures.map((f) => [f.id, f]));
  const presentationFor: PresentationFor = (resolved) => {
    const feature = byId.get(resolved.featureId);
    const style = feature ? styleOf(feature.color) : FALLBACK_STYLE;
    const selected = resolved.featureId === selectedId;
    return {
      style,
      label: feature ? labelOf(feature) : '',
      // FR-82 selection + FR-43 emphasis both paint the highlight color; the ring
      // structure never changes (教訓 5.25 — single shape resolution).
      selected: selected || resolved.emphasized,
    };
  };
  return buildDisplayAreas(forest, store, control, presentationFor);
}

/** Style used only if a resolved area's source feature cannot be found (defensive). */
const FALLBACK_STYLE: FeatureStyle = {
  fill: '#888888',
  stroke: '#333333',
  selectedColor: '#00e5ff',
};

/**
 * The committed-feature draw input: the area set (leaf + aggregate, depth/focus
 * applied) via U34, PLUS every committed point / line effective at `time` resolved
 * directly. `selectedId` paints the active selection color (FR-82). The host runs
 * `buildFeaturePrimitives` over the result and composites it under the tool
 * overlays. Pure — the same root + time + selection + display-control yields the
 * same list.
 */
export function buildCommittedFeatures(
  root: DomainProject,
  time: TimePoint,
  selectedId: FeatureId | null,
  displayControl: DisplayControlInput,
): EvaluatedFeature[] {
  const features = featuresAt(root, time);
  const vertices = verticesAt(root, time);

  // Areas (面情報) through U34 —集約形状 / depth / focus honoured.
  const out: EvaluatedFeature[] = buildAreas(
    features,
    vertices,
    displayControl,
    selectedId,
  );

  // Points / lines directly: they have no hierarchy rollup (no own area), so the
  // area pipeline would resolve them to an empty shape and never draw them.
  for (const feature of features) {
    const selected = feature.id === selectedId;
    const style = styleOf(feature.color);
    const label = labelOf(feature);
    switch (feature.kind) {
      case FEATURE_KIND.Point: {
        const v = getVertex(vertices, feature.vertexId);
        if (v === undefined) break;
        const point: EvaluatedPoint = {
          kind: 'point',
          id: feature.id as string,
          at: { lon: v.coordinate.lon, lat: v.coordinate.lat },
          style,
          label,
          selected,
        };
        out.push(point);
        break;
      }
      case FEATURE_KIND.Line: {
        const raw: { lon: number; lat: number }[] = [];
        let resolvable = true;
        for (const id of feature.vertexIds) {
          const v = getVertex(vertices, id);
          if (v === undefined) {
            resolvable = false;
            break;
          }
          raw.push({ lon: v.coordinate.lon, lat: v.coordinate.lat });
        }
        if (!resolvable || raw.length === 0) break;
        // HB-14 / FR-07: a line whose vertices straddle the antimeridian must be a
        // CONTINUOUS run, not two stored representatives [179, -179] (which the render
        // layer's continuous-longitude contract — feature-layer EvaluatedLine.points —
        // requires "U05 wrap-展開 already applied"). Without this the polyline's bbox
        // spans ~358° and its segment is drawn the long way round, and near-seam
        // zoom-in dropped/misdrew it. U04's `unwrapLonSequence` is the single source
        // of ±360° turn-counting unwrap (技術方針 R3 単一真実源) — we delegate, never
        // re-derive the rule. Latitude is never wrapped.
        const unwrappedLons = unwrapLonSequence(raw.map((p) => p.lon));
        const points = raw.map((p, i) => ({ lon: unwrappedLons[i]!, lat: p.lat }));
        const line: EvaluatedLine = {
          kind: 'line',
          id: feature.id as string,
          points,
          style,
          label,
          selected,
        };
        out.push(line);
        break;
      }
      // Leaf / aggregate areas are owned by the U34 path above.
      default:
        break;
    }
  }

  return out;
}
