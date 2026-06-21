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

import {
  FEATURE_KIND,
  isDrawableLineVertexCount,
  type Feature,
} from '../../domain/feature';
import type { ColorInfo } from '../../domain/attributes';
import type { FeatureId } from '../../domain/ids';
import type { DomainProject } from '../../domain/persistence/index';
import type { TimePoint } from '../../domain/time/time-point';
import { getVertex } from '../../domain/vertex';
import { unwrapLonSequence } from '../../domain/geo/longitude';
import type { ResolvedDisplayShapes } from '../../domain/display';

import type { DisplayControlInput } from '../../render/display-pipeline';
import { toEvaluatedAreas, type PresentationFor } from '../../render/display-bridge';
import type {
  EvaluatedFeature,
  EvaluatedLine,
  EvaluatedPoint,
  FeatureStyle,
} from '../../render/feature-layer';

import { resolveDisplayFor } from './display-resolution-cache';

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
 * Build the U19 area draw set from the SHARED U34-resolved display shapes (FR-42 /
 * FR-43). The geometry / verdict resolution is the cached `resolveDisplayFor` bundle —
 * the SAME single computation the live hit-test reuses (教訓 5.29: 描画と同じ単一真実源
 * is also a single COMPUTATION, not two recomputations per interaction). This step is
 * just the selection-dependent presentation mapping (style / label / selected), which
 * is why it stays here rather than in the cache: the resolved shapes do not depend on
 * `selectedId`, so caching them while mapping presentation per call keeps the memo
 * selection-independent. Presentation comes from the resolved feature's own `ColorInfo`
 * + name; the focus-emphasis verdict (FR-43) reuses the selected color so an emphasized
 * region stands out without U34 owning the palette.
 */
function buildAreas(
  resolved: ResolvedDisplayShapes,
  areaFeatures: readonly Feature[],
  selectedId: FeatureId | null,
): EvaluatedFeature[] {
  const byId = new Map<FeatureId, Feature>(areaFeatures.map((f) => [f.id, f]));
  const presentationFor: PresentationFor = (shape) => {
    const feature = byId.get(shape.featureId);
    const style = feature ? styleOf(feature.color) : FALLBACK_STYLE;
    const selected = shape.featureId === selectedId;
    return {
      style,
      label: feature ? labelOf(feature) : '',
      // FR-82 selection + FR-43 emphasis both paint the highlight color; the ring
      // structure never changes (教訓 5.25 — single shape resolution).
      selected: selected || shape.emphasized,
    };
  };
  return toEvaluatedAreas(resolved, presentationFor);
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
 *
 * OUTPUT MEMO (bughunt2 perf): the shared `resolveDisplayFor` cache already keeps a
 * camera-only frame from re-running the U34 forest/display pipeline, but the per-frame
 * PRESENTATION rebuild (style/label/selected mapping + the per-line `unwrapLonSequence`
 * allocations below) still ran on EVERY composite — and `ports.redraw()` re-reads this
 * getter once per drawn frame, so a sustained pan/zoom at the FR-110 cap re-derived the
 * entire `EvaluatedFeature[]` each frame even though none of its four inputs changed.
 * This function is PURE over `(root, time, selectedId, displayControl)` — all four are
 * immutable U16 store references swapped wholesale, never mutated — so we memoize the
 * built batch keyed by their IDENTITY: a camera-only frame (same four references) now
 * returns the SAME already-built array instead of rebuilding it. A real change to any
 * of the four (commit / time-drag / selection / slider) is an identity miss and rebuilds
 * identically, so the result is never stale. Callers treat the array as read-only (it is
 * shared), matching the existing "builds fresh arrays; inputs never mutated" contract.
 */
export function buildCommittedFeatures(
  root: DomainProject,
  time: TimePoint,
  selectedId: FeatureId | null,
  displayControl: DisplayControlInput,
): EvaluatedFeature[] {
  for (let i = 0; i < outputCache.length; i += 1) {
    const entry = outputCache[i]!;
    if (
      entry.root === root &&
      entry.time === time &&
      entry.selectedId === selectedId &&
      entry.control === displayControl
    ) {
      // Promote to most-recently-used so the live generation, hit most often (every
      // camera-only frame), is the last to be evicted.
      if (i !== outputCache.length - 1) {
        outputCache.splice(i, 1);
        outputCache.push(entry);
      }
      return entry.value;
    }
  }
  const value = computeCommittedFeatures(root, time, selectedId, displayControl);
  outputCache.push({ root, time, selectedId, control: displayControl, value });
  if (outputCache.length > OUTPUT_CACHE_CAPACITY) outputCache.shift();
  return value;
}

/** One built-batch memo entry: the four identity keys plus the batch they produced. */
interface OutputCacheEntry {
  readonly root: DomainProject;
  readonly time: TimePoint;
  readonly selectedId: FeatureId | null;
  readonly control: DisplayControlInput;
  readonly value: EvaluatedFeature[];
}

// A tiny bounded LRU over the BUILT batch. Capacity 2 absorbs the only realistic
// alternation — the live (root, time, selectedId, displayControl) generation served to
// the renderer every frame, occasionally interleaved with a transient generation (a
// selection toggle, the help-search corpus read) — without ever growing unbounded.
// Stale generations are never queried again (the store swaps the references forward), so
// a larger cache would only retain memory.
const OUTPUT_CACHE_CAPACITY = 2;
const outputCache: OutputCacheEntry[] = [];

/**
 * Drop every memoized batch. The memo keys on input IDENTITY, so a stale entry can never
 * be served while the store holds new references — this exists ONLY for test isolation
 * (a test that asserts the un-cached rebuild count must start clean).
 */
export function clearCommittedFeaturesCache(): void {
  outputCache.length = 0;
}

/**
 * Build the committed-feature draw batch for `(root, time, selectedId, displayControl)` —
 * the EXACT computation `buildCommittedFeatures` ran inline before the output memo.
 * Exposed for tests that want the un-cached result; production code goes through the
 * memoized {@link buildCommittedFeatures}.
 */
export function computeCommittedFeatures(
  root: DomainProject,
  time: TimePoint,
  selectedId: FeatureId | null,
  displayControl: DisplayControlInput,
): EvaluatedFeature[] {
  // The SHARED resolution: featuresAt / verticesAt / forest / U34-resolved shapes,
  // computed ONCE and reused by the live hit-test for this same (root, time,
  // displayControl) generation (教訓 5.29, bughunt2 perf). The selection-dependent
  // presentation mapping is applied below, so the memo stays selection-independent.
  const { features, vertices, resolved } = resolveDisplayFor(
    root,
    time,
    displayControl,
  );

  // The AREA features (leaf + aggregate) — points / lines carry no hierarchy rollup
  // and are emitted directly below (the area pipeline would resolve them to an empty
  // shape and never draw them), so they are excluded from the presentation map.
  const areaFeatures = features.filter(
    (f) => f.kind === FEATURE_KIND.Leaf || f.kind === FEATURE_KIND.Aggregate,
  );

  // Areas (面情報) through U34 —集約形状 / depth / focus honoured.
  const out: EvaluatedFeature[] = buildAreas(resolved, areaFeatures, selectedId);

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
        // A line needs ≥2 resolved vertices to be a real polyline (FR-19). A
        // 1-vertex line (corrupt load / mid-edit transient) renders to NOTHING in
        // the renderer (`buildLinePrimitives` needs points.length≥2), so it must
        // not be emitted as an `EvaluatedLine` here either — otherwise the hit-test
        // would offer its single, invisible vertex for selection (clip ⊇ draw ⊇ hit
        // 違反). The「2頂点未満は描かない」rule is the SINGLE domain predicate
        // `isDrawableLineVertexCount` (教訓 5.30), shared with the hit-test.
        if (!resolvable || !isDrawableLineVertexCount(raw.length)) break;
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
