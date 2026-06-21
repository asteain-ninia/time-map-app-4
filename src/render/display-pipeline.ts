// U34 display pipeline selector — the render-boundary wiring (FR-42 / FR-43,
// 受け入れ基準1 / 3 / 5, 教訓5.5 / 5.29 / 5.33).
//
// THE END-TO-END CONNECTION. The UI/session store (U16) holds the display-control
// inputs (`globalDepth` N, the individual `focus` M / origin / emphasize) on a
// SEPARATE axis from mode/selection (FR-42 非干渉). This module is the one place
// those inputs are turned into a U19-ready draw batch, so changing the slider
// value actually re-generates the draw instructions (教訓5.5: dependent state is
// re-derived on every change) — it is no longer a dead control.
//
// The flow, all through SINGLE sources (no re-implementation):
//   displayControl + forest  → buildDisplayDecisions   (U34: depth/focus → verdicts)
//                            → resolveDisplayShapes     (U34→U08: geometry per verdict)
//                            → toEvaluatedAreas         (render bridge → U19 input)
//
// CLAMPING (FR-117 / 受け入れ基準1): N and M are clamped to the forest's derivable
// depth range here, so an out-of-range slider value never produces a broken batch.
//
// STALE FOCUS (受け入れ基準3 / 教訓5.2 / 5.5): a focus origin that is absent from
// the forest (e.g. the selected feature ceased to exist at the new time) yields an
// empty vertical region inside `buildDisplayDecisions`, so the whole forest falls
// back to global N only — the focus is effectively dropped, never carried stale.
//
// LAYER (技術方針 2.13): lives in `render`, depends inward on `domain`. It takes a
// plain `DisplayControlInput` (the store's display slice flattened to domain ids)
// so it never imports the `ui` layer — the store calls THIS, not the reverse.
//
// PURITY: builds and returns a fresh array; no input is mutated.

import {
  buildDisplayDecisions,
  clampThreshold,
  depthRange,
  resolveDisplayShapes,
  type DisplayShapeCache,
  type FocusConfig,
  type ResolvedDisplayShapes,
} from '../domain/display';
import type { Forest } from '../domain/hierarchy/forest';
import { derivedDepths, isDepthUndefined } from '../domain/hierarchy';
import type { FeatureId } from '../domain/ids';
import type { VertexStore } from '../domain/vertex';

import {
  toEvaluatedAreas,
  type PresentationFor,
} from './display-bridge';
import type { EvaluatedArea } from './feature-layer';

/**
 * The display-control inputs this pipeline consumes (the store's `displayControl`
 * slice, expressed in domain ids). Kept as a plain structural input so `render`
 * never imports the `ui` session types (教訓5.33: an explicit typed boundary).
 */
export interface DisplayControlInput {
  /** The global hierarchy-depth threshold N (FR-42). Clamped here to the forest. */
  readonly globalDepth: number;
  /** The individual focus (FR-43): origin / per-focus depth M / emphasize. */
  readonly focus: {
    readonly originId: FeatureId | null;
    readonly depth: number;
    readonly emphasize: boolean;
  };
}

/**
 * Resolve the display-control inputs into U34's `ResolvedDisplayShapes` — the
 * verdict-joined, U08-resolved geometry per drawable feature. N and M are clamped
 * to the forest's derivable depth range first (FR-117). This is the geometry layer
 * of the pipeline, exposed separately so a caller can inspect failures / sources
 * before bridging to U19. Pure.
 *
 * Pass an optional {@link DisplayShapeCache} (held across pipeline runs by the caller —
 * e.g. the shared display-resolution memo) to make the per-feature U08 boolean-union
 * geometry resolution INCREMENTAL (bughunt3): a slider tick that swaps only
 * `control` while `forest` / `store` stay reference-identical reuses every drawable's
 * resolved geometry instead of re-deriving the whole union tree from the leaves. The
 * cache is correctness-safe and yields byte-for-byte the un-cached result.
 */
export function resolveDisplayControl(
  forest: Forest,
  store: VertexStore,
  control: DisplayControlInput,
  geometryCache?: DisplayShapeCache,
): ResolvedDisplayShapes {
  // ONE O(n) memoised depth pass (教訓5.30 過少共有の戒め): the derived-depth map
  // feeds BOTH the range clamp (its max) AND buildDisplayDecisions. Without this,
  // maxDerivedDepth would run derivedDepths once for the range and then
  // buildDisplayDecisions would re-walk each feature individually via derivedDepth
  // (O(n·depth) ~ O(n²) on a chain-shaped forest). Computing it here once and
  // passing it through keeps the whole pipeline call O(n).
  const depths = derivedDepths(forest);
  let maxDepth = 0;
  for (const d of depths.values()) {
    if (!isDepthUndefined(d) && d > maxDepth) maxDepth = d;
  }
  const range = depthRange(maxDepth);
  const globalThreshold = clampThreshold(control.globalDepth, range);
  const focus: FocusConfig = {
    originId: control.focus.originId,
    depth: clampThreshold(control.focus.depth, range),
    emphasize: control.focus.emphasize,
  };

  const decisions = buildDisplayDecisions({ forest, depths, globalThreshold, focus });
  return resolveDisplayShapes(forest, store, decisions, geometryCache);
}

/**
 * The full pipeline: display-control inputs → the U19 `EvaluatedArea[]` draw
 * batch. Every change to N / M / origin / emphasize (or to the forest / vertices)
 * re-runs this and re-feeds U19, so the slider drives the actual render (教訓5.5).
 * The geometry U19 draws is byte-for-byte what U34 resolved via U08 (受け入れ基準5,
 * 教訓5.29), because `toEvaluatedAreas` hands `ResolvedDisplayShape.shape` through
 * verbatim. `presentationFor` supplies style/label/selected per feature (it may
 * branch on `verdict` / `emphasized` for FR-43 強調). Pure.
 */
export function buildDisplayAreas(
  forest: Forest,
  store: VertexStore,
  control: DisplayControlInput,
  presentationFor: PresentationFor,
): EvaluatedArea[] {
  const resolved = resolveDisplayControl(forest, store, control);
  return toEvaluatedAreas(resolved, presentationFor);
}
