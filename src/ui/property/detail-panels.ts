// UI layer (U32 / property panel): the open-detail-panels model (FR-99後段).
//
// Multiple detail panels can be open at once, each bound to a feature, each with
// its own position + open state, each independently closable (FR-99). This is a
// PURE model over a list so the open/close/move logic is unit-tested without the
// DOM (NFR 5.8). The transient drag位置 lives in the component (DraggablePanel /
// useDrag) and is discarded on unmount (教訓 5.2); this model holds only the
// persistent "which panels are open and where".

import type { FeatureId } from '../../domain/ids';

import type { Point } from '../shell/drag';

/** One open detail panel: its stable id, the feature it shows, its position. */
export interface DetailPanelEntry {
  /** Stable panel id (= the feature id; one detail panel per feature). */
  readonly id: string;
  readonly featureId: FeatureId;
  readonly position: Point;
}

/** The open-detail-panels state: the list of open panels (back-to-front order). */
export interface DetailPanelsState {
  readonly panels: readonly DetailPanelEntry[];
}

export const EMPTY_DETAIL_PANELS: DetailPanelsState = { panels: [] };

/** The panel id for a feature (one detail panel per feature, idempotent open). */
export function panelIdFor(featureId: FeatureId): string {
  return `detail-${featureId}`;
}

/**
 * Open a detail panel for a feature. Idempotent: opening an already-open feature
 * is a no-op (FR-99: each panel independent, but only one per feature). New
 * panels are appended (front-most). The position cascades so a second panel does
 * not perfectly cover the first.
 */
export function openPanel(
  state: DetailPanelsState,
  featureId: FeatureId,
  basePosition: Point,
): DetailPanelsState {
  const id = panelIdFor(featureId);
  if (state.panels.some((p) => p.id === id)) return state;
  const offset = state.panels.length * DETAIL_PANEL_CASCADE_PX;
  const entry: DetailPanelEntry = {
    id,
    featureId,
    position: { x: basePosition.x + offset, y: basePosition.y + offset },
  };
  return { panels: [...state.panels, entry] };
}

/** The cascade offset (px) applied to each newly opened panel. */
export const DETAIL_PANEL_CASCADE_PX = 24;

/** Close a detail panel by id. No-op if absent. */
export function closePanel(
  state: DetailPanelsState,
  id: string,
): DetailPanelsState {
  if (!state.panels.some((p) => p.id === id)) return state;
  return { panels: state.panels.filter((p) => p.id !== id) };
}

/** True iff a detail panel is open for the feature. */
export function isPanelOpen(
  state: DetailPanelsState,
  featureId: FeatureId,
): boolean {
  return state.panels.some((p) => p.id === panelIdFor(featureId));
}

/**
 * **その年に居ない地物のパネルを閉じる**（増分 8E の手直し。設計適合 S2-3・反証 2-3）。
 * `presentIds` は、いまの年に居る地物の id（地図に描くのと同じ `featuresAt` の解決）。
 * 閉じるものが無ければ同じ参照を返す（宿主の描き直しを増やさない）。
 *
 * 以前の掃除は「その id の **系列** がドメインにあるか」で見ていたので、
 *   - まとめ役の子（自分の系列を持たず、まとめ役の系列の中に居る）のパネルは、関係のない
 *     編集でドメインが差し替わるたびに閉じていた
 *   - 年を動かして居なくなった地物のパネルは、閉じずに隠れていた（戻ると開いた位置に
 *     また出る。ドラッグした位置は失われ、隠れている間も重ねずらしの枚数に数えた）
 * 一覧のチェックの裁定（2026-09-07「その年に居ない州のチェックは外し、戻しても付け直さない」）
 * と揃えて、**居ない年へ動いたら閉じ、戻っても開き直さない**。
 */
export function keepPanelsPresent(
  state: DetailPanelsState,
  presentIds: ReadonlySet<FeatureId>,
): DetailPanelsState {
  if (state.panels.length === 0) return state;
  const live = state.panels.filter((p) => presentIds.has(p.featureId));
  return live.length === state.panels.length ? state : { panels: live };
}
