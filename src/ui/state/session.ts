// UI/session state layer: the volatile session value types.
//
// These are NOT the domain truth (features / anchors / trees): they are the
// "where / when / which mode / what is selected" of the current viewing
// session (spec §目的). They live in Zustand, never in the domain core, so the
// domain stays React/Zustand/Canvas-free (技術方針 2.5 / 2.13).

import type { FeatureId } from '../../domain/ids';
import type { ActiveFeature, SelectionState } from '../../domain/selection';

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
//
// The selection TRUTH is owned by U22 (domain/selection): its `SelectionState`
// is the single source for "what is selected" (spec §目的, 教訓 5.29 / 5.30).
// This UI layer must NOT re-declare a parallel selection type — that is the
// "二重の真実源" the lens flagged. We therefore re-export U22's `ActiveFeature`
// and DERIVE the read-only `VertexSelectionContext` view directly from U22's
// `SelectionState` (`vertexOwner` + `vertexIds`), so the layer-crossing contract
// is fixed in the type system (教訓 5.33 / 5.34) and the two cannot drift.

/**
 * The active feature (FR-79): always 0 or 1. Re-exported from U22 so the UI and
 * domain share ONE type (no parallel definition).
 */
export type { ActiveFeature };

/**
 * The vertex-selection context (FR-81): the read-only view the UI/panels consume
 * — the owning feature plus its selected vertex IDs. It is DERIVED from U22's
 * {@link SelectionState} (`vertexOwner` + `vertexIds`), never an independent
 * value, so it is `null` exactly when the selection has no vertices. The store
 * mirrors this from the reducer's output (技術方針 2.5).
 */
export interface VertexSelectionContext {
  /** The feature whose vertices are selected (= SelectionState.vertexOwner). */
  readonly ownerFeatureId: FeatureId;
  /** The selected vertex IDs (= SelectionState.vertexIds). Non-empty here. */
  readonly vertexIds: SelectionState['vertexIds'];
}

/**
 * Derive the read-only {@link VertexSelectionContext} view from U22's selection
 * truth. Returns `null` exactly when no vertices are selected (the U22 invariant
 * keeps `vertexOwner` non-null iff `vertexIds` is non-empty), so the UI's
 * "context resolved away" state maps directly from the domain value (教訓 5.18).
 */
export function vertexSelectionContextOf(
  selection: SelectionState,
): VertexSelectionContext | null {
  if (selection.vertexOwner === null || selection.vertexIds.size === 0) {
    return null;
  }
  return {
    ownerFeatureId: selection.vertexOwner,
    vertexIds: selection.vertexIds,
  };
}

// --- Display control: hierarchy depth focus (FR-42 / FR-43, U34) ------------
//
// This is a SEPARATE AXIS from mode/tool/selection (教訓 5.13 / FR-42 非干渉):
// changing the global depth or the individual focus must not touch edit/add mode
// or any in-progress draft, and switching mode must not destroy this state. It
// lives in its own slice so the two axes can never share a key.

/**
 * The individual focus (FR-43): a focus ORIGIN (a selected feature id) whose
 * vertical region (上位領域すべて＋自身＋下位領域すべて) is deep-dived at depth `M`
 * and emphasized. `originId` null ⇒ no focus (global depth only). This holds only
 * the CONTROL inputs; the vertical region itself is derived by the domain
 * (U34 `verticalRegion`) — never stored here (教訓 5.3).
 */
export interface DisplayFocus {
  /** The focus origin feature id, or null when no individual focus is active. */
  readonly originId: FeatureId | null;
  /** The per-focus depth threshold M (applied inside the vertical region). */
  readonly depth: number;
  /** Whether to emphasize the vertical-region features (FR-43 / FR-82). */
  readonly emphasize: boolean;
}

export const NO_DISPLAY_FOCUS: DisplayFocus = {
  originId: null,
  depth: 0,
  emphasize: false,
};

/**
 * The full display-control slice (FR-42 / FR-43): the one global depth threshold
 * `N` plus the individual focus. Default = N at 0 (everything rolled up to its
 * top-level aggregate) and no focus.
 */
export interface DisplayControl {
  /** The global hierarchy-depth threshold N (FR-42). Clamped at the UI boundary. */
  readonly globalDepth: number;
  /** The individual focus (FR-43), or {@link NO_DISPLAY_FOCUS}. */
  readonly focus: DisplayFocus;
}

export const DEFAULT_DISPLAY_CONTROL: DisplayControl = {
  globalDepth: 0,
  focus: NO_DISPLAY_FOCUS,
};

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

// --- 作図中の吸着の設定（増分 3 / 設計書 §C.4 の「吸着 ▾」・§N-6）-------------

/**
 * 作図中（面・線・点を描いている最中）の吸着の設定。
 *
 * **辺・交点への吸着はここに無い。** ドメインの `src/domain/add/snap.ts` の優先順位は
 * 「呼び出し側が解決済みの近接候補（FR-31）→ グリッド（FR-78）→ 生座標」の 3 段だけで、
 * 辺も交点も概念として存在しない。やるならドメインの新規実装で、しかも §N-6 の裁定待ち
 * なので、画面には灰色の項目として置くだけで、設定としては持たない（**持っていない値を
 * 設定として置くと「入れたのに効かない」になる**）。
 */
export interface SnapSettings {
  /** 吸着そのものの ON/OFF。OFF なら押した場所にそのまま置く。 */
  readonly enabled: boolean;
  /** 既存の頂点へ吸着する（いま効くのはこれだけ）。 */
  readonly vertex: boolean;
  /** 許容（画面上の px）。この距離までの頂点を候補にする。 */
  readonly tolerancePx: number;
}

/** 許容値の下限・上限（px）。上限は FR-31 の条文の 50px に合わせる。 */
export const SNAP_TOLERANCE_MIN_PX = 1;
export const SNAP_TOLERANCE_MAX_PX = 50;

/**
 * 許容値の既定 **12px**（設計書 §N-6 の 3 案を実データで比べて決めた。
 * 根拠は `scripts/measure-snap-tolerance.ts` の出力と `docs/ui-redesign/進捗/増分3.md` §4）。
 *
 * 要点だけ:
 *  - 許容値は「**どの頂点に付くか**」を決めない。選ばれるのは常に最近傍 1 個なので、
 *    許容を広げても付く相手は変わらない（実測: 狙った頂点が最近傍になる割合は
 *    許容 12px でも 50px でも同じで、**ズームだけ**で決まる ―― 全体表示 20% / ×4 で 59% /
 *    ×16 で 99%）。
 *  - 許容値が決めるのは「**付くか付かないか**」＝ 地図のどれだけの面積が吸着に食われるか。
 *    実データ（バアカ・アルラーク国）で、50px は地図の **52〜73%** を覆う。12px なら
 *    **6〜37%** に収まる。
 */
export const DEFAULT_SNAP_TOLERANCE_PX = 12;

export const DEFAULT_SNAP_SETTINGS: SnapSettings = {
  enabled: true,
  vertex: true,
  tolerancePx: DEFAULT_SNAP_TOLERANCE_PX,
};

/**
 * 許容値を使える範囲へ収める。**非有限値は既定へ落とす**（0 や NaN をそのまま通すと
 * 「吸着が黙って効かない」形で現れ、原因が吸着の実装に見える ―― 教訓 5.46）。
 */
export function clampSnapTolerancePx(raw: number): number {
  if (!Number.isFinite(raw)) return DEFAULT_SNAP_TOLERANCE_PX;
  return Math.min(SNAP_TOLERANCE_MAX_PX, Math.max(SNAP_TOLERANCE_MIN_PX, Math.round(raw)));
}
