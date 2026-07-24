// U41 — the SINGLE display-state resolution (FR-113, 受け入れ基準1, 教訓 5.29).
//
// 機能宣言: 表示状態の最終算出 (フィルター・透明度・強調・現在時刻存在) を「単一の解決
// 判定」へ集約する。描画・ヒットテスト・検索ハイライトが同じ判定を共有し、「描画されて
// いるのに検索に出ない／選択できない」対概念矛盾を作らない。
//
// 適用 (教訓 5.29「派生形状は単一の解決判定で全経路を動かす」, 引用: 表示状態の最終算出を
// 単一の解決判定へ集約し、描画・ヒットテスト・検索ハイライトが同じ判定を共有する):
// `resolveFeatureDisplay` がその単一判定であり、本ユニットの検索母集合 (search.ts) も
// この判定の `visible` を真実として用いる。FR-42 集約表示との非干渉: 本判定は「個々の
// 地物を描くか・どの見え方か」だけを決め、集約形状の算出母集合 (U08/U34) には踏み込まない
// (合成規則は現状.md に保留として記録)。
//
// 純粋: 入力 (フィルター状態 + 地物メタ + 現在時刻存在) から表示結果を返すのみ。Canvas /
// React / Zustand に依存しない (技術方針 2.13, NFR 5.8).

import type { FeatureId } from '../../domain/ids';

import { kindAxisOf, type DomainFeatureKind } from './axes';
import {
  emphasisActive,
  type FilterState,
  OPACITY_MIN,
} from './filter-state';

/**
 * The minimal per-feature metadata the resolution needs. Supplied by the
 * dependency adapter (U32 表示状態) — NOT the domain truth duplicated here. Depth
 * is U08's derived value (single source); we never recompute it (単一の真実源).
 */
export interface FeatureDisplayMeta {
  readonly id: FeatureId;
  readonly kind: DomainFeatureKind;
  /** U08 derived hierarchy depth (最上位=0). `null` when undefined/not an area. */
  readonly depth: number | null;
}

/** The dim factor applied to non-emphasized features while emphasis is active. */
export const DIM_OPACITY_FACTOR = 0.25;

/**
 * The resolved display state of ONE feature — the single truth every consumer
 * (draw / hit-test / search highlight) reads:
 *   - `visible`     : whether the feature renders at all (kind ∧ depth ∧ not
 *                     individually hidden ∧ present-at-time).
 *   - `opacity`     : the effective opacity (base opacity, dimmed if emphasis is
 *                     active and this feature is not emphasized). 0 when hidden.
 *   - `emphasized`  : whether this feature is in an emphasized set/kind/depth.
 */
export interface ResolvedFeatureDisplay {
  readonly featureId: FeatureId;
  readonly visible: boolean;
  readonly opacity: number;
  readonly emphasized: boolean;
}

/** Does the feature pass the kind axis? */
function passesKind(state: FilterState, meta: FeatureDisplayMeta): boolean {
  return state.kindVisible[kindAxisOf(meta.kind)];
}

/** Does the feature pass the depth axis? (null threshold ⇒ always passes.) */
function passesDepth(state: FilterState, meta: FeatureDisplayMeta): boolean {
  if (state.depthThreshold === null) return true;
  if (meta.depth === null) return true; // non-area: depth axis does not apply.
  return meta.depth <= state.depthThreshold;
}

/**
 * Is the feature emphasized by a channel OTHER than the per-feature `emphasizedIds` set —
 * i.e. the 種別軸 / 深度軸 (or the legacy per-feature override flag)?
 *
 * This is the HALF of the emphasis judgement that the右クリック「この地物を強調」/「強調を
 * 解除」item CANNOT change: that item writes `emphasizedIds` only. The context menu asks
 * this (through filtered-display → the adapter's AxisEmphasisLookup) to decide whether the
 * item would be a visual no-op and must therefore be shown DISABLED (出す=起きる, 教訓 5.6).
 * Exported so the menu and the draw path share ONE definition of「別軸で強調されている」
 * rather than each re-deriving it (教訓 5.29).
 */
export function isEmphasizedByOtherAxis(
  state: FilterState,
  meta: FeatureDisplayMeta,
): boolean {
  if (state.emphasizedKinds.has(kindAxisOf(meta.kind))) return true;
  if (
    state.emphasizedDepth !== null &&
    meta.depth !== null &&
    meta.depth >= state.emphasizedDepth
  ) {
    return true;
  }
  return state.individual.get(meta.id)?.emphasized === true;
}

/** Is the feature emphasized by ANY active emphasis (set / kind / depth / override)? */
function isEmphasized(state: FilterState, meta: FeatureDisplayMeta): boolean {
  return state.emphasizedIds.has(meta.id) || isEmphasizedByOtherAxis(state, meta);
}

/**
 * THE single resolution (教訓 5.29). Combine every axis + emphasis + existence
 * into one verdict. `presentAtTime` is the U16/U32 "does this feature exist at
 * the current time" answer (injected; never recomputed — 教訓 5.15 / 単一の真実
 * 源). A feature hidden by ANY axis, individually hidden, or absent at the
 * current time is `visible:false` with opacity 0 — so a non-visible feature can
 * never leak into draw / hit-test / search.
 */
export function resolveFeatureDisplay(
  state: FilterState,
  meta: FeatureDisplayMeta,
  presentAtTime: boolean,
): ResolvedFeatureDisplay {
  const override = state.individual.get(meta.id);
  const forcedHidden = override?.hidden === true;

  const visible =
    presentAtTime &&
    !forcedHidden &&
    passesKind(state, meta) &&
    passesDepth(state, meta);

  if (!visible) {
    return {
      featureId: meta.id,
      visible: false,
      opacity: OPACITY_MIN,
      emphasized: false,
    };
  }

  // `emphasized` folds EVERY channel (set / kind / depth / per-feature override) through
  // the one `isEmphasized`; `emphasisActive` is the matching whole-state predicate over the
  // SAME channels, so「この地物は強調されているか」and「強調中か」can never disagree (the
  // asymmetry that made the panel's escape hatch unreachable for the override channel).
  const emphasized = isEmphasized(state, meta);
  const anyEmphasis = emphasisActive(state);

  // Dim non-emphasized features only while emphasis is active (受け入れ基準1).
  const opacity =
    anyEmphasis && !emphasized
      ? state.opacity * DIM_OPACITY_FACTOR
      : state.opacity;

  return { featureId: meta.id, visible: true, opacity, emphasized };
}

/**
 * Resolve a whole batch and return only the VISIBLE features' resolutions, in
 * input order. This is the search母集合 / draw母集合 source (single judgement):
 * search.ts filters its candidates to ids appearing here.
 */
export function resolveVisible(
  state: FilterState,
  features: readonly FeatureDisplayMeta[],
  presentAtTime: (id: FeatureId) => boolean,
): ResolvedFeatureDisplay[] {
  const out: ResolvedFeatureDisplay[] = [];
  for (const meta of features) {
    const resolved = resolveFeatureDisplay(state, meta, presentAtTime(meta.id));
    if (resolved.visible) out.push(resolved);
  }
  return out;
}

/** The set of currently-visible feature ids (the search/draw母集合 keys). */
export function visibleIdSet(
  state: FilterState,
  features: readonly FeatureDisplayMeta[],
  presentAtTime: (id: FeatureId) => boolean,
): Set<FeatureId> {
  const ids = new Set<FeatureId>();
  for (const r of resolveVisible(state, features, presentAtTime)) {
    ids.add(r.featureId);
  }
  return ids;
}
