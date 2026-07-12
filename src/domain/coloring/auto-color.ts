// U33 auto-coloring orchestration (FR-100 / FR-101): turn an adjacency graph +
// palette + the set of auto-color-enabled area features into a deterministic
// "feature id -> {fill, selected}" color plan.
//
// PIPELINE (kept as separate stages — spec §配色「別段階として分け」):
//   1. assign a color INDEX per auto-color target via greedy graph coloring
//      (four-color.ts). Adjacent targets never share an index.
//   2. RESOLVE each index to a concrete color through the palette's deterministic
//      expansion (palette.colorAtIndex): base colors first, derived colors when
//      they run out (FR-101 不足時の決定的派生色).
//   3. DERIVE the selected color from the fill via the single selection rule
//      (color-math.deriveSelectedColor — 通常色より明るく鮮やか, FR-101 / 教訓 5.30).
//
// SCOPE of coloring (FR-101):
//   - Only auto-color-enabled features are colored. Manual features keep their
//     color and are NOT in the plan (the caller leaves them untouched).
//   - 飛び地 (multi-piece areas) get ONE color: the plan is per feature id, never
//     per ring, so all pieces of a feature share its color (FR-101 / FR-21).
//   - 穴 (holes) are never filled: this plan only carries fill/selected colors for
//     the feature; the rendering unit applies them to territory rings only and
//     leaves holes transparent (spec §やらないこと, 契約で U19 と整合).
//
// PURITY (受け入れ基準6 / NFR 5.8): pure, deterministic, inputs unmutated.

import type { FeatureId } from '../ids';
import { type AdjacencyGraph, neighborsOf } from './adjacency';
import { deriveSelectedColor } from './color-math';
import { baseColorCount, colorAtIndex, type Palette } from './palette';

/** An empty pin map (the default: no manual fixed-colour neighbours to avoid). */
const NO_PINS: ReadonlyMap<FeatureId, string> = new Map();

/** The resolved colors for one auto-colored feature. */
export interface FeatureColorPlan {
  /** Logical palette index assigned by greedy coloring (>=0). */
  readonly colorIndex: number;
  /** The fill color (base or deterministically derived). */
  readonly fillColor: string;
  /** The selected color: fill made brighter & more vivid (single rule). */
  readonly selectedColor: string;
}

/** The full auto-coloring result: auto-color target id -> its color plan. */
export type ColorPlan = ReadonlyMap<FeatureId, FeatureColorPlan>;

/**
 * Compute the deterministic color plan for the auto-color targets in `graph`.
 *
 * @param graph     the normalized adjacency graph at the selected time.
 * @param palette   the resolved palette (base colors + deterministic expansion).
 * @param autoColorTargets the feature ids whose auto-color is enabled. Only these
 *                  are colored; manual / absent features are excluded (FR-101).
 * @param pinnedFillByNode the FIXED fill of every manual (non-target) node, so an
 *                  auto target never resolves to a manual neighbour's colour —
 *                  four-color回避 must hold across the auto/manual boundary too,
 *                  not just auto/auto (FR-101 規約). Defaults to none.
 * @returns a map from each target id to its {colorIndex, fillColor, selectedColor}.
 */
export function computeColorPlan(
  graph: AdjacencyGraph,
  palette: Palette,
  autoColorTargets: ReadonlySet<FeatureId>,
  pinnedFillByNode: ReadonlyMap<FeatureId, string> = NO_PINS,
): ColorPlan {
  const plan = new Map<FeatureId, FeatureColorPlan>();
  // The resolved fill of each already-coloured auto target (its own greedy result),
  // so a later adjacent target avoids the concrete COLOUR — not merely the index —
  // which is also correct when a palette maps two indices to the same colour.
  const chosenFill = new Map<FeatureId, string>();
  // Process in the graph's stable node order (教訓 5.19 決定性): each auto target
  // takes the LOWEST palette index whose RESOLVED fill is used by no already-
  // coloured auto neighbour and equals no adjacent manual (pinned) neighbour's fill.
  for (const id of graph.nodes) {
    if (!autoColorTargets.has(id)) continue;
    const forbidden = new Set<string>();
    for (const neighbor of neighborsOf(graph, id)) {
      const assigned = chosenFill.get(neighbor);
      if (assigned !== undefined) {
        forbidden.add(assigned);
        continue;
      }
      const pinned = pinnedFillByNode.get(neighbor);
      if (pinned !== undefined) forbidden.add(pinned);
    }
    // The smallest index whose resolved colour is free. With distinct base colours
    // the free index is always within |forbidden|; the cap additionally guarantees
    // termination on a pathological duplicate-colour palette (best-effort there).
    const cap = forbidden.size + baseColorCount(palette) + 1;
    let index = 0;
    while (index < cap && forbidden.has(colorAtIndex(palette, index))) index += 1;
    const fillColor = colorAtIndex(palette, index);
    const selectedColor = deriveSelectedColor(fillColor);
    plan.set(id, { colorIndex: index, fillColor, selectedColor });
    chosenFill.set(id, fillColor);
  }
  return plan;
}

/**
 * Convenience: build the colorable set from features paired with their
 * auto-color flags, then compute the plan. Keeps the "only enabled features are
 * colored" rule single-sourced (FR-101).
 */
export function computeColorPlanFor(
  graph: AdjacencyGraph,
  palette: Palette,
  autoColorEnabledById: ReadonlyMap<FeatureId, boolean>,
): ColorPlan {
  const targets = new Set<FeatureId>();
  for (const [id, enabled] of autoColorEnabledById) {
    if (enabled) targets.add(id);
  }
  return computeColorPlan(graph, palette, targets);
}
