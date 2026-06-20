// U41 — the session-only display-control state (FR-113, ui layer, pure types).
//
// 機能宣言: フィルター状態 (表示/非表示・透明度・強調) はセッション固有の表示状態として
// 保持し、描画レイヤが購読して反映する。これはドメインの真実 (地物データ・保存対象スタイル)
// を書き換えない (受け入れ基準1). FR-42 のグローバル階層深度集約表示とは別軸であり、
// 本状態は「どの地物を・どの見え方で描くか」のみを表す。
//
// 適用 (技術方針 2.3 / NFR 5.1): この状態は Zustand セッションスライスとして公開する
// 想定で、ここでは純粋な型と既定値・純粋な更新ヘルパーのみを定義する。React state には
// 載せない (描画は購読のみで反映)。
//
// すべての更新ヘルパーはイミュータブル (新しい値を返す) で、副作用なく Vitest で検証可能
// (NFR 5.8, 教訓 5.41).

import type { FeatureId } from '../../domain/ids';

import {
  ALL_FEATURE_KIND_AXES,
  type FeatureKindAxis,
} from './axes';

/** The opacity range [0, 1]. 0 = fully transparent, 1 = fully opaque. */
export const OPACITY_MIN = 0;
export const OPACITY_MAX = 1;

/**
 * The per-feature individual override. `null` (= absence in the map) means the
 * feature follows the kind + depth axes. Explicit values override those axes:
 *   - `hidden: true` force-hides regardless of kind/depth (個別非表示).
 *   - `hidden: false` is a no-op flag kept for symmetry; visibility still needs
 *     kind/depth to pass. Use the map presence only to carry `emphasized`.
 */
export interface IndividualOverride {
  /** Force this feature hidden irrespective of the kind/depth axes. */
  readonly hidden: boolean;
  /** Emphasize this feature (others dim) — display-only (FR-113 強調). */
  readonly emphasized: boolean;
}

/**
 * The complete display-control filter state (FR-113). Session-only; never the
 * domain truth. Held whole in the store; the draw layer subscribes to it.
 *
 *   - `kindVisible`     : per-kind-axis visibility (点 / 線 / 面).
 *   - `depthThreshold`  : show features whose derived depth ≤ this value;
 *                         `null` ⇒ no depth filter (all depths pass this axis).
 *   - `individual`      : per-feature overrides (force-hide / emphasize).
 *   - `opacity`         : the display opacity applied to passing features.
 *   - `emphasisActive`  : true when ANY emphasis is in effect (kind/depth/set);
 *                         when true, non-emphasized features are dimmed.
 *   - `emphasizedKinds` : kind-axes to emphasize (others dim).
 *   - `emphasizedDepth` : emphasize features at/above this depth, or `null`.
 */
export interface FilterState {
  readonly kindVisible: Readonly<Record<FeatureKindAxis, boolean>>;
  readonly depthThreshold: number | null;
  readonly individual: ReadonlyMap<FeatureId, IndividualOverride>;
  readonly opacity: number;
  readonly emphasizedKinds: ReadonlySet<FeatureKindAxis>;
  readonly emphasizedDepth: number | null;
  readonly emphasizedIds: ReadonlySet<FeatureId>;
}

function allKindsVisible(): Record<FeatureKindAxis, boolean> {
  const out = {} as Record<FeatureKindAxis, boolean>;
  for (const axis of ALL_FEATURE_KIND_AXES) out[axis] = true;
  return out;
}

/** The default: everything visible, full opacity, no filter, no emphasis. */
export const DEFAULT_FILTER_STATE: FilterState = {
  kindVisible: allKindsVisible(),
  depthThreshold: null,
  individual: new Map(),
  opacity: OPACITY_MAX,
  emphasizedKinds: new Set(),
  emphasizedDepth: null,
  emphasizedIds: new Set(),
};

// --- pure immutable updates (副作用なし, 教訓 5.41) --------------------------

/** Toggle a kind-axis visibility (FR-113 種別単位の表示切替). */
export function setKindVisible(
  state: FilterState,
  axis: FeatureKindAxis,
  visible: boolean,
): FilterState {
  return { ...state, kindVisible: { ...state.kindVisible, [axis]: visible } };
}

/** Set the depth threshold (FR-113 階層深度単位). `null` clears the depth axis. */
export function setDepthThreshold(
  state: FilterState,
  threshold: number | null,
): FilterState {
  return { ...state, depthThreshold: threshold };
}

/** Set the display opacity (already validated/clamped by the caller). */
export function setOpacity(state: FilterState, opacity: number): FilterState {
  return { ...state, opacity };
}

/** Force-hide / unhide one feature (FR-113 個別地物単位). */
export function setIndividualHidden(
  state: FilterState,
  featureId: FeatureId,
  hidden: boolean,
): FilterState {
  const next = new Map(state.individual);
  const prev = next.get(featureId);
  next.set(featureId, { hidden, emphasized: prev?.emphasized ?? false });
  return { ...state, individual: next };
}

/** Replace the explicitly-emphasized feature set (FR-113 地物集合の強調). */
export function setEmphasizedIds(
  state: FilterState,
  ids: Iterable<FeatureId>,
): FilterState {
  return { ...state, emphasizedIds: new Set(ids) };
}

/** Replace the emphasized kind-axes (FR-113 種別の強調). */
export function setEmphasizedKinds(
  state: FilterState,
  kinds: Iterable<FeatureKindAxis>,
): FilterState {
  return { ...state, emphasizedKinds: new Set(kinds) };
}

/** Emphasize features at/above a depth, or `null` to clear depth emphasis. */
export function setEmphasizedDepth(
  state: FilterState,
  depth: number | null,
): FilterState {
  return { ...state, emphasizedDepth: depth };
}

/** Clear every emphasis (set / kind / depth) — others stop dimming. */
export function clearEmphasis(state: FilterState): FilterState {
  return {
    ...state,
    emphasizedKinds: new Set(),
    emphasizedDepth: null,
    emphasizedIds: new Set(),
  };
}

/**
 * Whether ANY emphasis is currently in effect. When true, the resolution dims
 * features that are not emphasized; when false, every passing feature renders at
 * the plain opacity (受け入れ基準1: 強調が無いときは減衰しない).
 */
export function emphasisActive(state: FilterState): boolean {
  return (
    state.emphasizedIds.size > 0 ||
    state.emphasizedKinds.size > 0 ||
    state.emphasizedDepth !== null
  );
}
