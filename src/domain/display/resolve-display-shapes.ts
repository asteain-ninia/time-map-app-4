// U34 → U08 → U19 shape-resolution adapter (受け入れ基準5, 教訓5.29 / 5.1 / 5.33).
//
// THE CONTRACT SEAM. U34's `buildDisplayDecisions` only SELECTS, per feature, a
// verdict and (when Aggregate) the roll-up target feature whose 集約形状 should be
// drawn. It never carries geometry. Left there, that selection is a dead output:
// the consumer (U19 / feature-layer) would have to re-derive which feature to
// round to and re-resolve its shape on its own, and the two judgements could
// drift (the very ドリフト 教訓5.29 forbids — 描画/ヒットテスト/ラベル の形状が
// U34 の丸め判定 と食い違う).
//
// This module closes that gap with ONE rule: for every drawable Aggregate
// decision, the geometry is `resolveFeatureArea(forest, store, rollUpTargetId)` —
// U08's SINGLE derived-shape resolution (下位領域の和). For a drawable Real
// decision the geometry is that feature's OWN resolved area (still through the
// same `resolveFeatureArea`, so leaf own-shape and aggregate union flow through
// ONE source). Omitted decisions produce nothing (受け入れ基準1: 省略は描画指示に
// 現れない). The result is the exact `GeoMultiPolygon` U19 fills / hit-tests /
// labels, so "U34 が選んだ丸め先" と "U19 が描く形状" は同一由来で固定される。
//
// We never union or invent geometry here (spec §やらないこと) — `resolveFeatureArea`
// is the only geometry source, and 飛び地（複数片）は片落とししない (教訓5.1) because
// we hand the resolution's `area` through verbatim, never collapsing pieces.
//
// PURITY (受け入れ基準6): reads forest + decisions + vertex store, returns a fresh
// list, mutates nothing.

import { alignMultiPolygon } from '../geo/seam';
import type { GeoMultiPolygon } from '../geometry/types';
import { resolveFeatureArea, type ShapeResolutionFailure } from '../hierarchy/resolve-shape';
import type { Forest } from '../hierarchy/forest';
import type { FeatureId } from '../ids';
import type { VertexStore } from '../vertex';

import {
  DISPLAY_VERDICT,
  type DisplayDecision,
  type DisplayDecisionMap,
} from './depth-focus';

/**
 * One resolved drawable: a display decision joined to the geometry U19 must use.
 * `geometrySourceId` records WHICH feature's U08 resolution produced `shape`:
 *   - Aggregate → the `rollUpTargetId` U34 chose (the feature it rounded to);
 *   - Real      → the feature itself (its own resolved area).
 * That id is the single proof that 描画形状 と U34 の丸め判定 are the same source
 * (教訓5.29). `shape` is whatever `resolveFeatureArea` returned, pieces intact.
 */
export interface ResolvedDisplayShape {
  readonly featureId: FeatureId;
  readonly verdict: typeof DISPLAY_VERDICT.Real | typeof DISPLAY_VERDICT.Aggregate;
  /** The feature whose U08 resolution produced `shape` (roll-up target / self). */
  readonly geometrySourceId: FeatureId;
  /**
   * The SINGLE U08-resolved geometry, all pieces kept (教訓5.1), with every ring
   * longitude-UNWRAPPED into a continuous run (U05 `unwrapRing`) so a seam-crossing
   * area draws / hit-tests the short way, never the false ~358° span (see
   * `unwrapShape`; parity with the line path in committed-features.ts).
   */
  readonly shape: GeoMultiPolygon;
  readonly emphasized: boolean;
}

/**
 * A decision whose U08 resolution failed (missing vertex / missing child /
 * rejected union). Surfaced as data, never thrown (教訓5.26), so the caller can
 * decide whether to skip the feature or report it; the drawable list simply omits
 * a feature whose geometry could not be resolved.
 */
export interface ResolvedDisplayFailure {
  readonly featureId: FeatureId;
  readonly geometrySourceId: FeatureId;
  readonly reason: ShapeResolutionFailure;
}

/** The outcome of resolving every drawable decision (受け入れ基準5). */
export interface ResolvedDisplayShapes {
  /** Drawable features with their U08-resolved geometry, in decision order. */
  readonly shapes: readonly ResolvedDisplayShape[];
  /** Drawable features whose U08 resolution failed (omitted from `shapes`). */
  readonly failures: readonly ResolvedDisplayFailure[];
}

/**
 * The feature whose U08 derived shape backs a decision: the roll-up target for an
 * Aggregate (the feature U34 rounded to), or the feature itself for a Real. This
 * is the ONE place the "which feature's geometry" question is answered, so U19 can
 * never pick a different source than U34 selected (教訓5.29 規約固定).
 */
export function geometrySourceFor(decision: DisplayDecision): FeatureId {
  return decision.verdict === DISPLAY_VERDICT.Aggregate
    ? decision.rollUpTargetId ?? decision.featureId
    : decision.featureId;
}

/**
 * Longitude-unwrap every ring of a resolved area into a CONTINUOUS run (U05's
 * `unwrapRing`, which delegates to U04's single ±360° turn-counting source).
 *
 * WHY (seam parity with the LINE path — HB-14 / FR-07 / 技術方針 R3 単一真実源):
 * a feature straddling the antimeridian is stored with FOLDED representatives
 * (e.g. lon 179 next to lon -179). U03's `WorldCoordinate` is a continuous scalar
 * that may already lie outside [-180,180) but is NOT guaranteed to be unwrapped.
 * U08's `resolveFeatureArea` resolves rings from RAW vertex coordinates with zero
 * seam handling, so a seam-crossing ring can come back with a ~358° longitude
 * span. The render layer's continuous-longitude contract (feature-layer +
 * canvas2d-renderer `primitiveLonSpan`, and the hit-test `multiPolygonLonSpan`)
 * then tiles ±360° wrap replicas off that FALSE span — painting / hit-testing the
 * polygon "the long way round" across the whole map. The LINE path already guards
 * exactly this case via `unwrapLonSequence` (committed-features.ts); the AREA path
 * did not. Unwrapping here — the ONE node both the renderer
 * (committed-features → buildDisplayAreas) and the hit-test
 * (live-hit-test → drawnAreas) consume — closes the asymmetry at a single source,
 * so draw and hit-test stay byte-for-byte consistent (教訓5.29). Per-ring unwrap
 * keeps each contiguous ring continuous without merging pieces (教訓5.1 飛び地保持).
 * The union math upstream is untouched (it still operates on raw representatives);
 * we only make the FINAL drawn/hit geometry continuous, exactly as the line path
 * unwraps its final points.
 *
 * PER-POLYGON ALIGNMENT (audit root cause A — H4 / M7 / M11 / L11): a plain
 * independent per-ring unwrap anchors EACH ring to its OWN first vertex, so a
 * seam-crossing outer ring and a hole (or enclave) whose vertex list starts on the
 * opposite seam side land ~360° apart even though they coincide geometrically — the
 * hole then punches at a false position one world-turn away and 穴透過 breaks, the
 * renderer/hit-test tile off a ~358° span, and the label centroid drifts. We funnel
 * through {@link alignMultiPolygon} (the single cross-ring alignment source of
 * truth) so every ring of a polygon piece is unwrapped AND shifted onto its own
 * outer ring's common world turn. 飛び地は片落とししない (教訓5.1): pieces are kept
 * intact; each PIECE is anchored to ITS OWN outer ring (alignMultiPolygon uses the
 * first piece's outer as the default reference, so we align per polygon piece to
 * keep disjoint enclaves on their own natural branch rather than forcing them onto
 * one global turn).
 */
function unwrapShape(shape: GeoMultiPolygon): GeoMultiPolygon {
  // Align each polygon piece independently: a piece's outer ring is the reference
  // for its own holes, so a hole sharing the outer's turn is correct, while a
  // separate enclave piece keeps its own natural branch (no false global merge).
  return shape.map((polygon) => alignMultiPolygon([polygon])[0]!);
}

/**
 * Resolve every DRAWABLE decision's geometry through U08's single resolution.
 * Omitted decisions are dropped (受け入れ基準1). For each remaining decision the
 * geometry is `resolveFeatureArea(forest, store, geometrySourceFor(decision))` —
 * the SAME resolution that drives draw / hit-test / label downstream — and the
 * returned `area` is handed through unchanged so 複数片（飛び地）が全反映される
 * (教訓5.1). Pure: builds and returns fresh arrays; no input is mutated.
 */
export function resolveDisplayShapes(
  forest: Forest,
  store: VertexStore,
  decisions: DisplayDecisionMap,
): ResolvedDisplayShapes {
  const shapes: ResolvedDisplayShape[] = [];
  const failures: ResolvedDisplayFailure[] = [];

  for (const [, decision] of decisions) {
    if (decision.verdict === DISPLAY_VERDICT.Omitted) continue;

    const geometrySourceId = geometrySourceFor(decision);
    const resolution = resolveFeatureArea(forest, store, geometrySourceId);
    if (resolution.status === 'failed') {
      failures.push({
        featureId: decision.featureId,
        geometrySourceId,
        reason: resolution.reason,
      });
      continue;
    }
    shapes.push({
      featureId: decision.featureId,
      verdict: decision.verdict,
      geometrySourceId,
      // Seam-unwrapped so a ring crossing the antimeridian is a CONTINUOUS run,
      // not folded representatives that span ~358° (parity with the line path —
      // see unwrapShape). 飛び地は片落とししない (教訓5.1): each ring is unwrapped
      // independently; no piece is merged or dropped.
      shape: unwrapShape(resolution.area),
      emphasized: decision.emphasized,
    });
  }

  return { shapes, failures };
}
