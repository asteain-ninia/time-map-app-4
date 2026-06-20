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
