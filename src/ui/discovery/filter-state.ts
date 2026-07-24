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
 *   - `emphasisActive`  : true when ANY emphasis is in effect (set/kind/depth/override);
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

/**
 * Emphasize / un-emphasize ONE feature (FR-113 Phase 2 — 右クリック「この地物を強調」/
 * 「強調を解除」). `emphasizedIds` is THE per-feature emphasis channel the operation UI
 * writes (the {@link IndividualOverride.emphasized} flag is a legacy resolution input with
 * no writer — keeping ONE writable channel is what lets {@link emphasisActive} and
 * {@link reconcileToLiveFeatures} stay the single truth for「強調中か」).
 *
 * Identity-stable: a no-op write (emphasizing an already-emphasized feature, or clearing a
 * feature that was never emphasized) returns the SAME reference so the display memos
 * (resolveFilteredDisplay / the Canvas redraw subscription) do not see a new generation
 * (教訓 5.29, the same discipline as {@link clearIndividualOverrides}).
 */
export function setFeatureEmphasized(
  state: FilterState,
  featureId: FeatureId,
  emphasized: boolean,
): FilterState {
  if (state.emphasizedIds.has(featureId) === emphasized) return state;
  const next = new Set(state.emphasizedIds);
  if (emphasized) next.add(featureId);
  else next.delete(featureId);
  return { ...state, emphasizedIds: next };
}

/**
 * Emphasize / un-emphasize ONE kind axis (FR-113 Phase 2 — パネルの種別強調トグル). The
 * mirror of {@link setKindVisible} on the EMPHASIS axis: strictly orthogonal to visibility
 * (emphasizing 面 never changes `kindVisible[面]`). Identity-stable on a no-op write.
 */
export function setKindEmphasized(
  state: FilterState,
  axis: FeatureKindAxis,
  emphasized: boolean,
): FilterState {
  if (state.emphasizedKinds.has(axis) === emphasized) return state;
  const next = new Set(state.emphasizedKinds);
  if (emphasized) next.add(axis);
  else next.delete(axis);
  return { ...state, emphasizedKinds: next };
}

/** Emphasize features at/above a depth, or `null` to clear depth emphasis. */
export function setEmphasizedDepth(
  state: FilterState,
  depth: number | null,
): FilterState {
  return { ...state, emphasizedDepth: depth };
}

/**
 * Clear EVERY emphasis channel (set / kind / depth / per-feature override) — others stop
 * dimming. This is the panel's「強調をすべて解除」escape hatch: ONE action leaves the
 * dimmed-others mode no matter which channel got it there. It is the exact inverse of
 * {@link emphasisActive} — every channel that predicate counts is cleared here, so
 * `emphasisActive(clearEmphasis(s)) === false` for ANY state (no unreachable dimmed mode).
 * Visibility (`individual[].hidden`) / opacity / kind toggles are untouched (別軸).
 *
 * Identity-stable: returns the SAME reference when no emphasis is active, so pressing it
 * (or a defensive call) on an already-plain state never churns the display memos (教訓 5.29).
 */
export function clearEmphasis(state: FilterState): FilterState {
  if (!emphasisActive(state)) return state;
  // Strip the override emphasis flag while PRESERVING each override's `hidden` (個別非表示 is
  // the visibility axis and must survive「強調をすべて解除」).
  let individual = state.individual;
  for (const override of state.individual.values()) {
    if (!override.emphasized) continue;
    const next = new Map<FeatureId, IndividualOverride>();
    for (const [id, o] of state.individual) next.set(id, { ...o, emphasized: false });
    individual = next;
    break;
  }
  return {
    ...state,
    emphasizedKinds: new Set(),
    emphasizedDepth: null,
    emphasizedIds: new Set(),
    individual,
  };
}

/**
 * Re-evaluate the per-feature parts of the filter state against the CURRENT set
 * of live feature ids (教訓 5.5/5.6 + 教訓 5.11): drop any emphasized-id and any
 * `individual` override whose feature no longer exists. This is the SAME
 * criterion {@link reevaluateResult} (search.ts) applies to search hits — derived
 * from the live母集合, not gated on which command changed it.
 *
 * WHY (finding bughunt3 — dangling emphasized ids): the kind/depth axes are
 * value-keyed and self-heal, but `emphasizedIds` and `individual` are keyed by
 * `FeatureId`. When a feature is deleted (edit op / undo / redo), nothing prunes
 * those id-keyed sets, so a deleted id lingers. The ID generator never recycles a
 * live id, but undo/redo REPLAYS a recorded id, so the exact id can return on a
 * later structure change; the stale emphasis would then re-attach to whatever
 * feature now carries that id (cross-domain display-state corruption). Every
 * structure-changing path must funnel through this one reconciliation so a removed
 * id can never dangle. Pure / immutable: returns the SAME reference when nothing
 * changed (no needless identity churn for the display memos, cf. store identity
 * stability), else a fresh pruned state.
 */
export function reconcileToLiveFeatures(
  state: FilterState,
  liveFeatureIds: ReadonlySet<FeatureId>,
): FilterState {
  let emphasizedChanged = false;
  const emphasizedIds = new Set<FeatureId>();
  for (const id of state.emphasizedIds) {
    if (liveFeatureIds.has(id)) emphasizedIds.add(id);
    else emphasizedChanged = true;
  }

  let individualChanged = false;
  const individual = new Map<FeatureId, IndividualOverride>();
  for (const [id, override] of state.individual) {
    if (liveFeatureIds.has(id)) individual.set(id, override);
    else individualChanged = true;
  }

  if (!emphasizedChanged && !individualChanged) return state;
  return {
    ...state,
    ...(emphasizedChanged ? { emphasizedIds } : {}),
    ...(individualChanged ? { individual } : {}),
  };
}

/**
 * Whether ANY emphasis is currently in effect. When true, the resolution dims
 * features that are not emphasized; when false, every passing feature renders at
 * the plain opacity (受け入れ基準1: 強調が無いときは減衰しない).
 */
export function emphasisActive(state: FilterState): boolean {
  if (state.emphasizedIds.size > 0) return true;
  if (state.emphasizedKinds.size > 0) return true;
  if (state.emphasizedDepth !== null) return true;
  // The per-feature override flag is a FOURTH emphasis channel (a legacy resolution input
  // with no writer today). It MUST be counted here: `resolveFeatureDisplay` dims others
  // for it and `isFilterInert` treats it as non-inert, so leaving it out made「強調中か」
  // two different predicates — a state that visibly dims others while `clearEmphasis` and
  // the panel's「強調をすべて解除」button both consider it inert (no escape hatch). ONE
  // predicate over ALL FOUR channels (教訓 5.29 単一判定).
  for (const override of state.individual.values()) {
    if (override.emphasized) return true;
  }
  return false;
}

/**
 * Clear EVERY individual override (個別非表示 n 件を全て再表示 — the sidebar's
 * bulk "show all again" action). Returns the SAME reference when nothing is
 * overridden so an already-empty state does not churn the display memos
 * (identity stability, 教訓 5.29). Emphasis axes / opacity / kind toggles are
 * untouched — only the per-feature override map is emptied.
 */
export function clearIndividualOverrides(state: FilterState): FilterState {
  if (state.individual.size === 0) return state;
  return { ...state, individual: new Map() };
}

/**
 * Whether the filter is INERT — i.e. {@link resolveFeatureDisplay} would return
 * `{ visible: true, opacity: OPACITY_MAX, emphasized: false }` for EVERY feature,
 * so the draw / hit / search母集合 are exactly what they are with no filter at all.
 *
 * This is the COMPLETE short-circuit gate (技術方針 NFR 5.5 / 教訓 5.30 過少共有の
 * 戒めの逆 — ここは「既定状態でゼロ overhead」を守る単一判定): the display pipeline
 * consults it ONCE per (resolution, filter) generation and, when inert, skips the
 * per-feature resolution AND the O(n) derived-depth pass entirely, so the default
 * FilterState (全表示・不透明度1.0・強調なし) never regresses the hot draw path.
 *
 * Inert iff: opacity is full AND no depth axis AND every kind visible AND no
 * emphasis (set/kind/depth or per-feature) AND no per-feature force-hide.
 */
export function isFilterInert(state: FilterState): boolean {
  if (state.opacity !== OPACITY_MAX) return false;
  if (state.depthThreshold !== null) return false;
  for (const axis of ALL_FEATURE_KIND_AXES) {
    if (!state.kindVisible[axis]) return false;
  }
  // `emphasisActive` now covers ALL FOUR emphasis channels including the per-feature
  // override flag, so the loop below only has to check the VISIBILITY axis (個別非表示).
  if (emphasisActive(state)) return false;
  for (const override of state.individual.values()) {
    if (override.hidden) return false;
  }
  return true;
}
