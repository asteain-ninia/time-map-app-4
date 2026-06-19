// UI/session state layer: the volatile session value types.
//
// These are NOT the domain truth (features / anchors / trees): they are the
// "where / when / which mode / what is selected" of the current viewing
// session (spec §目的). They live in Zustand, never in the domain core, so the
// domain stays React/Zustand/Canvas-free (技術方針 2.5 / 2.13).

import type { FeatureId, VertexId } from '../../domain/ids';

// --- Mode + tool (FR-75) -----------------------------------------------------

/**
 * The exclusive interaction mode (FR-75). View mode disables all editing
 * actions through ONE mode check (教訓 5.13: do not scatter per-widget
 * permission checks).
 */
export const EDIT_MODE = {
  /** Display-only: editing actions are disabled wholesale. */
  View: 'view',
  /** Adding new features. */
  Add: 'add',
  /** Editing existing features. */
  Edit: 'edit',
} as const;

export type EditMode = (typeof EDIT_MODE)[keyof typeof EDIT_MODE];

/**
 * The active tool identifier. A branded string routed through a factory so tool
 * branching never uses a bare literal (教訓 5.19). Individual tools are
 * registered by their owning units; `null` == no active tool.
 */
declare const ToolIdBrand: unique symbol;
export type ToolId = string & { readonly [ToolIdBrand]: 'ToolId' };

export function asToolId(raw: string): ToolId {
  return raw as ToolId;
}

// --- Selection (FR-79 / FR-80 / FR-81) --------------------------------------

/**
 * The active feature (FR-79): always 0 or 1. Modeled as `FeatureId | null` so
 * "nothing selected" is explicit and a multi-active state is unrepresentable.
 */
export type ActiveFeature = FeatureId | null;

/**
 * The vertex-selection context (FR-81): the set of selected vertex IDs plus the
 * feature that OWNS them (derived from the selection, 教訓 5.3 — derived from
 * display state, not by scanning the whole data source). When the set becomes
 * empty the context is resolved away (the whole value becomes `null`).
 */
export interface VertexSelectionContext {
  /** The feature whose vertices are selected (the derived owner, FR-81). */
  readonly ownerFeatureId: FeatureId;
  /** The selected vertex IDs (FR-80). Non-empty whenever the context exists. */
  readonly vertexIds: ReadonlySet<VertexId>;
}

// --- Camera + longitude shift (FR-12) ---------------------------------------

/**
 * Zoom / camera in WORLD coordinates (spec: 倍率・中心座標・パン位置). This is
 * what the Canvas subscribes to (技術方針 2.3): it is NOT React state, so the
 * 60FPS draw path never goes through a React re-render.
 */
export interface Camera {
  /** Magnification (world units per screen unit inverse). */
  readonly zoom: number;
  /** Camera center longitude (world coordinate). */
  readonly centerLon: number;
  /** Camera center latitude (world coordinate). */
  readonly centerLat: number;
  /** Pan offset X in world units. */
  readonly panX: number;
  /** Pan offset Y in world units. */
  readonly panY: number;
}

export const DEFAULT_CAMERA: Camera = {
  zoom: 1,
  centerLon: 0,
  centerLat: 0,
  panX: 0,
  panY: 0,
};
