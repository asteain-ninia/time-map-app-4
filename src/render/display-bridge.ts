// U34 → U19 render-boundary bridge (受け入れ基準5, 教訓5.29 / 5.1 / 5.33).
//
// THE SEAM THAT CLOSES THE DRIFT. U34 (domain) decides, per feature, a display
// verdict and resolves — through U08's SINGLE `resolveFeatureArea` — the集約形状
// (`ResolvedDisplayShape.shape`) that should be drawn. U19 (render) draws an
// `EvaluatedArea` whose `.shape` is the geometry it actually fills / hit-tests /
// labels. Left unconnected, U34's resolved geometry was a dead output: U19 had no
// way to receive it, and "U34 が選んだ丸め先" と "U19 が描く形状" could drift — the
// very 対概念矛盾 教訓5.29 forbids (描画されているのに違う形状でヒットテスト/ラベル).
//
// This module is the ONE typed adapter that feeds `ResolvedDisplayShape.shape`
// straight into `EvaluatedArea.shape`. The geometry is handed through VERBATIM
// (same `GeoMultiPolygon` reference / value, all 飛び地 pieces intact — 教訓5.1);
// we never re-resolve, re-union, or re-pick a source here. Because the shape is
// passed unchanged, what U19 draws is byte-for-byte what U34 resolved, so the two
// judgements are the SAME source by construction (教訓5.29 規約固定).
//
// LAYER / DEPENDENCY DIRECTION (技術方針 2.13): the bridge lives in `render`, not
// `domain`, so the dependency points render → domain (inward). `domain/display`
// stays free of any render type; `render` imports the domain `ResolvedDisplayShape`
// and emits the render `EvaluatedArea` (教訓5.33 偶然の構造一致に頼らず型で明示).
//
// PURITY: builds and returns a fresh array; inputs are never mutated.

import type {
  ResolvedDisplayShape,
  ResolvedDisplayShapes,
} from '../domain/display';
import type { FeatureId } from '../domain/ids';

import type { EvaluatedArea, FeatureStyle } from './feature-layer';

/**
 * The render-side trimmings U34's decision does NOT carry: the resolved style
 * (colors decided upstream by FR-100/101), the label text, and whether the
 * feature is selected. U34 supplies geometry + verdict + emphasis; U19 supplies
 * presentation. This callback joins the two WITHOUT letting either re-derive the
 * other's responsibility (教訓5.30 過剰共有の戒め: geometry source stays single).
 *
 * `emphasized` is forwarded from the decision so the presentation layer can honor
 * FR-43 強調 (e.g. swap to a highlight color) without U34 owning the color.
 */
export interface DisplayPresentation {
  readonly style: FeatureStyle;
  /** Label text; empty string ⇒ no label even when the threshold passes. */
  readonly label: string;
  readonly selected: boolean;
}

/**
 * Resolve the per-feature presentation for one drawable. Receives the whole
 * `ResolvedDisplayShape` so the caller can branch on `verdict` / `emphasized` /
 * `geometrySourceId` (e.g. emphasize the focus region, FR-43) while the GEOMETRY
 * is never the caller's to choose — it is fixed to `shape` below.
 */
export type PresentationFor = (resolved: ResolvedDisplayShape) => DisplayPresentation;

/**
 * Bridge ONE U34-resolved drawable into a U19 `EvaluatedArea`. The geometry is
 * `resolved.shape` PASSED THROUGH UNCHANGED — the single guarantee that the shape
 * U19 fills / hit-tests / labels is identical to the one U34 resolved via U08
 * (教訓5.29). The id is the branded `FeatureId` flattened to the plain string id
 * U19's renderer-independent contract uses (教訓5.33: an explicit, typed bridge —
 * not an accidental structural match). Presentation (style/label/selected) is
 * supplied by the caller; geometry is NOT. Pure.
 */
export function toEvaluatedArea(
  resolved: ResolvedDisplayShape,
  presentation: DisplayPresentation,
): EvaluatedArea {
  return {
    kind: 'area',
    id: resolved.featureId as string,
    // VERBATIM hand-through: the byte-for-byte same geometry U34 resolved (教訓5.1
    // 飛び地全片保持; 教訓5.29 単一由来). No re-union, no piece-dropping, no re-pick.
    shape: resolved.shape,
    style: presentation.style,
    label: presentation.label,
    selected: presentation.selected,
  };
}

/**
 * Bridge ALL of U34's resolved drawables into U19 `EvaluatedArea`s, in order, so
 * `buildFeaturePrimitives` draws exactly the集約/実形状 U34 selected (受け入れ基準5).
 * `failures` are intentionally NOT bridged: a feature whose U08 resolution failed
 * has no geometry and simply does not appear in the draw batch (受け入れ基準1: 省略
 * は描画指示に現れない; 教訓5.18 absence, not a crash). Pure: fresh array, no input
 * mutated.
 */
export function toEvaluatedAreas(
  resolved: ResolvedDisplayShapes,
  presentationFor: PresentationFor,
): EvaluatedArea[] {
  return resolved.shapes.map((s) => toEvaluatedArea(s, presentationFor(s)));
}

/** Convenience: the plain string id U19 uses for a branded U34 `FeatureId`. */
export function evaluatedAreaId(featureId: FeatureId): string {
  return featureId as string;
}
