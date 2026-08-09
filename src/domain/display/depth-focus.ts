// U34 hierarchy depth focus & display control (FR-42 / FR-43, domain layer, pure).
//
// This module decides, for every evaluated feature, ONE final display decision:
//   - draw it or omit it,
//   - draw it with its OWN real shape or as an AGGREGATE (rounded) shape, and if
//     aggregate, WHICH feature it is rounded to (the roll-up target whose U08
//     derived shape — 下位領域の和 — should be drawn),
//   - emphasize it or not.
//
// It does NOT compute aggregate geometry: the actual 集約形状 (boolean union of
// sub-regions) is U08's single derived-shape resolution (resolveFeatureArea).
// This unit only SELECTS which feature is the roll-up target at a given depth
// threshold; the consumer (U19) resolves that target's geometry through the SAME
// U08 resolution that drives draw / hit-test / label (教訓5.29). We never union
// anything here and never invent a separate shape judgement (spec §やらないこと).
//
// It also does NOT own selection, mode, time evaluation or the spatial index. It
// takes an ALREADY-EVALUATED forest (the features present at the selected time),
// the derived depth of each feature (U08), the depth thresholds, and an optional
// focus origin (a selected feature id), and returns a plain decision map.
//
// PURITY (受け入れ基準6): every function is pure — inputs (forest / depth map /
// sets) are never mutated and the same input yields the same decisions.

import {
  descendantIds,
  hasChildren,
  walkToRoot,
  type Forest,
} from '../hierarchy/forest';
import { derivedDepth, isDepthUndefined } from '../hierarchy/depth';
import { FEATURE_KIND } from '../feature';
import type { FeatureId } from '../ids';

// --- per-feature display decision (the中間表現 handed to U19) ----------------

/**
 * How a single feature should be drawn at the chosen depth threshold. The three
 * verdicts are mutually exclusive and exhaustive (a feature is exactly one):
 *   - Real:      draw the feature with its OWN resolved shape (a leaf, or an
 *                aggregate whose children are themselves drawn deeper, i.e. d < T:
 *                this feature is NOT the terminal — its children carry the area).
 *   - Aggregate: draw the feature ROUNDED to a roll-up target's derived shape
 *                (下位領域の和). This is the terminal at depth T: deeper features
 *                are absorbed into THIS feature's集約形状. The roll-up target is
 *                this feature itself.
 *   - Omitted:   not drawn as a standalone feature (it sits below the terminal
 *                depth and is absorbed into an ancestor's aggregate shape).
 */
export const DISPLAY_VERDICT = {
  /** Draw the feature's own real shape (leaf own shape, or expanded aggregate). */
  Real: 'real',
  /** Draw the feature rounded to its own aggregate (集約形状) shape. */
  Aggregate: 'aggregate',
  /** Not drawn standalone — absorbed into an ancestor aggregate. */
  Omitted: 'omitted',
} as const;

export type DisplayVerdict =
  (typeof DISPLAY_VERDICT)[keyof typeof DISPLAY_VERDICT];

/**
 * The final display decision for one feature. `rollUpTargetId` is set ONLY when
 * `verdict === Aggregate`: it names the feature whose U08 derived shape (下位領域
 * の和) should be drawn for this feature. The consumer (U19) resolves that
 * target's geometry via U08's single resolution (教訓5.29) — this unit never
 * carries geometry. `emphasized` is the强調 flag (FR-43 / FR-82); it is a
 * display-only effect and never changes selection/domain truth.
 */
export interface DisplayDecision {
  readonly featureId: FeatureId;
  readonly verdict: DisplayVerdict;
  /** Present iff verdict === Aggregate: the roll-up target (= featureId itself). */
  readonly rollUpTargetId?: FeatureId;
  readonly emphasized: boolean;
}

/** The integrated decision map: one decision per evaluated feature. */
export type DisplayDecisionMap = ReadonlyMap<FeatureId, DisplayDecision>;

// --- the SHARED depth threshold judgement (教訓5.30 過少共有の戒め) ----------
//
// ONE implementation of "集約/省略 by depth threshold" is shared by both the
// global threshold N and the per-focus threshold M (spec 実装方針). The global
// path and the focus path differ ONLY in which threshold they feed in here.

/**
 * Classify ONE feature against a depth threshold `T`, given its derived depth
 * `d` and whether it has children (result-state aggregate, 教訓5.6):
 *   - `d` undefined (cyclic) → Omitted (no derivable depth, spec教訓5.28 safety).
 *   - `d > T`               → Omitted (below the terminal depth; absorbed).
 *   - `d === T`             → terminal: Aggregate if it has children (draw its
 *                             集約形状), else Real (a leaf draws its own shape).
 *   - `d < T`               → Real: above the terminal depth. An aggregate here
 *                             is EXPANDED (its children carry the area); a leaf
 *                             above the terminal simply draws its own shape.
 *
 * This is a PURE classification with no forest walk — it is the single rule both
 * thresholds run through (教訓5.29 規約固定).
 */
export function classifyAtThreshold(
  depth: number,
  threshold: number,
  featureHasChildren: boolean,
  ownsShape = true,
): DisplayVerdict {
  if (isDepthUndefined(depth)) return DISPLAY_VERDICT.Omitted;
  if (depth > threshold) return DISPLAY_VERDICT.Omitted;
  if (depth === threshold) {
    return featureHasChildren ? DISPLAY_VERDICT.Aggregate : DISPLAY_VERDICT.Real;
  }
  // d < T — EXPANDED: the drawing DESCENDS to this feature's children (仕様 U34 §31
  // 「d < N の集約地物: …その地物の子をさらに展開できる…より深い階層の描画へ降りる」、
  // 括弧書きで「集約地物自体の派生形状ではなく」と明記)。
  //
  // A pure 集約地物 owns NO shape of its own (FR-35: its area IS the union of its
  // children), so drawing it here would paint that union ON TOP of the very children
  // that are also drawn — covering them and, because the hit-test shares this drawable
  // set (教訓 5.29), ABSORBING every click meant for a child. 実データ(デーレ共和国+63州)
  // で再現: 深度を上げても子が一切選べない。The area is already fully carried by the
  // children, so the expanded aggregate contributes nothing but an occluding duplicate.
  //
  // A LEAF that has acquired children (FR-35 の末端→集約 中間状態) is DIFFERENT: it owns
  // real rings that its children do not carry, so it keeps drawing its own shape.
  if (featureHasChildren && !ownsShape) return DISPLAY_VERDICT.Omitted;
  return DISPLAY_VERDICT.Real;
}

// --- threshold clamping to the forest's derivable range (受け入れ基準1) ------

/**
 * The valid inclusive range for a depth threshold over `forest`: 0 .. maxDepth.
 * `maxDepth` is the forest-wide maximum DERIVABLE depth (cyclic features
 * excluded). Trees may each have a different max depth (FR-38); the range upper
 * bound is the global maximum so a single slider never exceeds the forest.
 */
export interface DepthRange {
  readonly min: number;
  readonly max: number;
}

/** Compute the threshold range from the forest's max derivable depth. */
export function depthRange(maxDerivableDepth: number): DepthRange {
  const max = Number.isFinite(maxDerivableDepth) && maxDerivableDepth > 0
    ? Math.floor(maxDerivableDepth)
    : 0;
  return { min: 0, max };
}

/** Clamp `value` into `[range.min, range.max]` (FR-117: 範囲外はクランプ). */
export function clampThreshold(value: number, range: DepthRange): number {
  if (!Number.isFinite(value)) return range.min;
  const v = Math.floor(value);
  if (v < range.min) return range.min;
  if (v > range.max) return range.max;
  return v;
}

// --- vertical region (縦方向領域) via U08 cycle-safe walks (教訓5.28) --------

/**
 * The縦方向領域 of `originId`: every ANCESTOR (up to the root) + the origin
 * ITSELF + every DESCENDANT, as a Set for O(1) membership (受け入れ基準6 /
 * NFR 5.2). Both walks route through U08's cycle-safe helpers (walkToRoot for the
 * upward chain, descendantIds for the subtree) so broken / cyclic data returns a
 * finite set rather than looping forever (教訓5.28). We never write an unguarded
 * recursion here.
 *
 * Returns an EMPTY set when `originId` is absent from the forest (a stale focus
 * origin — e.g. the selected feature no longer exists at the new time — so the
 * caller安全に falls back to the global threshold only, 教訓5.5 / 5.2).
 */
export function verticalRegion(forest: Forest, originId: FeatureId): Set<FeatureId> {
  const region = new Set<FeatureId>();
  if (!forest.byId.has(originId)) return region;

  // Upward: the origin + all ancestors (chain ends at the root, inclusive).
  const walk = walkToRoot(forest, originId);
  if (walk.cyclic) {
    for (const id of walk.cycle) region.add(id);
  } else {
    for (const id of walk.chain) region.add(id);
  }
  // Downward: every descendant of the origin (the origin itself already added).
  for (const id of descendantIds(forest, originId)) region.add(id);
  region.add(originId);
  return region;
}

// --- the integrated display decision (受け入れ基準4, 教訓5.29) ---------------

/**
 * The focus configuration. When `originId` is null the focus is INACTIVE and the
 * whole forest follows the global threshold. When set, the縦方向領域 of
 * `originId` follows `depth` (M) and is emphasized; everything else follows the
 * global threshold (N). One configuration object so a stale/absent origin yields
 * an empty region and a clean fallback (受け入れ基準3, 教訓5.2).
 */
export interface FocusConfig {
  /** The focus origin (a selected feature id), or null if no focus. */
  readonly originId: FeatureId | null;
  /** The per-focus depth threshold M (applied inside the vertical region). */
  readonly depth: number;
  /** Whether to emphasize the vertical-region features (FR-43 / FR-82). */
  readonly emphasize: boolean;
}

export const NO_FOCUS: FocusConfig = {
  originId: null,
  depth: 0,
  emphasize: false,
};

/** Inputs to {@link buildDisplayDecisions}; depths are supplied by U08 upstream. */
export interface DisplayDecisionInput {
  readonly forest: Forest;
  /**
   * Derived depth per feature (U08). Optional: when omitted, depth is computed
   * per feature through U08's cycle-safe `derivedDepth`. Supplying a precomputed
   * map (e.g. `derivedDepths(forest)`) keeps the pass O(n) under repeated calls.
   */
  readonly depths?: ReadonlyMap<FeatureId, number>;
  /** The global threshold N (already clamped by the caller / UI boundary). */
  readonly globalThreshold: number;
  /** The individual focus (縦方向領域 + M + 強調), or {@link NO_FOCUS}. */
  readonly focus?: FocusConfig;
}

/**
 * Build the SINGLE integrated decision per evaluated feature (受け入れ基準4):
 *   - a feature inside the active focus's vertical region follows M (focus.depth)
 *     and is emphasized (if focus.emphasize);
 *   - every other feature follows the global threshold N.
 * The priority rule is fixed (規約固定, 教訓5.29): 縦方向領域内は M、外は N. Both
 * paths run the SAME `classifyAtThreshold`, so global and focus can never drift
 * apart in how they round/omit (教訓5.30 過少共有の戒め). An Aggregate verdict
 * names its own id as the roll-up target; U19 resolves that geometry via U08.
 *
 * Pure: builds and returns a fresh Map; no input is mutated.
 */
export function buildDisplayDecisions(input: DisplayDecisionInput): DisplayDecisionMap {
  const { forest, globalThreshold } = input;
  const focus = input.focus ?? NO_FOCUS;

  // Focus is active only when its origin resolves to a present feature; a stale
  // origin yields an empty region → global-only fallback (受け入れ基準3, 教訓5.5).
  const region =
    focus.originId !== null
      ? verticalRegion(forest, focus.originId)
      : new Set<FeatureId>();
  const focusActive = region.size > 0;

  const decisions = new Map<FeatureId, DisplayDecision>();
  for (const featureId of forest.orderedIds) {
    const depth = input.depths?.get(featureId) ?? derivedDepth(forest, featureId);
    const inRegion = focusActive && region.has(featureId);
    const threshold = inRegion ? focus.depth : globalThreshold;
    // `ownsShape`: does this feature carry geometry its children do NOT? A pure
    // 集約地物 does not (FR-35 その領域は子の和); every other kind does. Read from the
    // forest's own feature map so the decision needs no extra input (単一真実源).
    const ownsShape = forest.byId.get(featureId)?.kind !== FEATURE_KIND.Aggregate;
    const verdict = classifyAtThreshold(
      depth,
      threshold,
      hasChildren(forest, featureId),
      ownsShape,
    );
    const emphasized = inRegion && focus.emphasize;

    decisions.set(
      featureId,
      verdict === DISPLAY_VERDICT.Aggregate
        ? { featureId, verdict, rollUpTargetId: featureId, emphasized }
        : { featureId, verdict, emphasized },
    );
  }
  return decisions;
}

/**
 * Convenience: the ids U19 should DRAW (verdict !== Omitted), in forest order.
 * Omitted features never appear in a draw command (受け入れ基準1: 省略は描画指示
 * に現れない).
 */
export function drawableIds(decisions: DisplayDecisionMap): FeatureId[] {
  const out: FeatureId[] = [];
  for (const [id, d] of decisions) {
    if (d.verdict !== DISPLAY_VERDICT.Omitted) out.push(id);
  }
  return out;
}
