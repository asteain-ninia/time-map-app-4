// The `MapRenderer` interface — the layer-crossing contract that decouples the
// callers (UI / session state) from the concrete drawing backend (U17,
// 技術方針 2.4 / R1, 開発ガイド §5.33 両側テストで固定).
//
// PURPOSE (spec §目的 1): abstract the drawing layer so that, if the default
// Canvas 2D backend misses a performance target by measurement, a WebGL backend
// can be swapped in WITHOUT changing the domain / UI / state (the R1退避路). To
// keep that promise the contract is expressed only in renderer-INDEPENDENT terms:
//   - it exposes NO `CanvasRenderingContext2D` (or any Canvas-only type);
//   - the draw input is a declarative BATCH (world coordinates + visual
//     attributes), so the same batch yields the same look on any backend;
//   - hit-testing is expressed via the shared world↔screen transform, the SAME
//     transform used for drawing (教訓 5.29: one transform for all paths, so
//     "drawn here ⇒ hit here" can never diverge).
//
// SCOPE (spec §やること / §やらないこと): this is the CONTRACT plus the minimal
// batch/hit-test shapes. The business drawing (auto-color, selection feedback,
// edge-slide, hole transparency, per-type label visibility) and the geometric
// hit-test predicates (point-in-polygon, nearest-vertex) are LATER units that
// build a batch / use this transform — they are deliberately out of scope here.

import type { Camera, Viewport, ZoomRange } from './camera';
import type { ScreenPoint, WorldPoint } from './vtransform';

// --- Batch: the declarative description of one frame -------------------------
//
// A batch is "what to draw", in WORLD coordinates plus SCREEN-space sizes. The
// renderer transforms positions with the current camera but keeps sizes fixed in
// screen space (FR-17): position moves with zoom, size does not. The size fields
// (radiusPx / widthPx / fontPx) are the SINGLE place a size is declared, so a
// point, a line and a label cannot each invent their own zoom-dependent size
// (教訓 §4 単一真実源, spec §一定サイズ表示).

/** A point feature drawn at a constant on-screen radius (FR-17). */
export interface PointPrimitive {
  readonly kind: 'point';
  /** World position; transformed by the camera each frame. */
  readonly at: WorldPoint;
  /** Constant on-screen radius in CSS pixels (NOT derived from zoom). */
  readonly radiusPx: number;
  /** Fill color (CSS color string; business coloring is a later unit's input). */
  readonly fill: string;
}

/** A polyline drawn at a constant on-screen stroke width (FR-17). */
export interface LinePrimitive {
  readonly kind: 'line';
  /** World-space vertices (continuous-scalar longitudes); positions transform. */
  readonly points: readonly WorldPoint[];
  /** Constant on-screen stroke width in CSS pixels (NOT derived from zoom). */
  readonly widthPx: number;
  readonly stroke: string;
}

/**
 * A filled polygon ring. Its FILL scales with the map (position transform), which
 * is correct: FR-17 fixes the size of points / line widths / label fonts, NOT the
 * area of a filled region (開発ガイド §5.25: do not widen FR-17 beyond its named
 * targets). Stroke width, when present, is screen-fixed like a line.
 */
export interface PolygonPrimitive {
  readonly kind: 'polygon';
  /** Outer ring world vertices; positions transform with the camera. */
  readonly ring: readonly WorldPoint[];
  readonly fill: string;
  /** Optional outline; its width is screen-fixed in CSS pixels when present. */
  readonly stroke?: string;
  readonly strokeWidthPx?: number;
}

/**
 * A filled polygon WITH holes and enclaves (FR-20 / FR-21). This is the primitive
 * the feature layer (U19) emits for面情報: a list of CLOSED rings where index 0 of
 * every piece is a territory (filled) ring and the rest are holes (cut out).
 *
 * The renderer fills with the EVEN-ODD rule so a hole punched inside a territory
 * is透過 (no fill) and a territory nested inside a hole (an enclave) is filled
 * again — exactly the交互 alternation FR-24 fixes, achieved by the fill rule, with
 * NO per-ring color difference and NO artificial connector line (FR-21). All
 * territory rings of one面情報 share one `fill`/`stroke` so a飛び地 is never
 * recolored (FR-101). Stroke width is screen-fixed like a line (FR-17).
 *
 * `pieces` mirrors the domain `GeoMultiPolygon` shape (piece = [outer, ...holes])
 * but is held as plain `WorldPoint` rings so the renderer stays domain-agnostic.
 */
export interface PolygonShapePrimitive {
  readonly kind: 'shape';
  /** Each piece: index 0 = territory outer ring, indices 1.. = hole rings. */
  readonly pieces: readonly (readonly (readonly WorldPoint[])[])[];
  readonly fill: string;
  /** Optional outline; screen-fixed width in CSS px when present. */
  readonly stroke?: string;
  readonly strokeWidthPx?: number;
}

/**
 * A grid line (lat/lon graticule) drawn at a constant on-screen width.
 *
 * `wrap` opts OUT of the renderer's ±360° turn-loop (FR-07): the grid layer already
 * enumerates meridians across the FULL continuous viewport span (so the graticule
 * is self-tiled across the seam). Re-tiling it would re-issue every line/label once
 * per world turn — O(turns²) path work at deep zoom-out AND, because grid strokes
 * are translucent (FR-109 opacity), drawing the same pixels N times COMPOUNDS the
 * alpha and darkens the grid (Codex high #2). `wrap === false` ⇒ draw exactly once
 * at offset 0; omitted/`true` ⇒ the renderer tiles it like a feature primitive.
 */
export interface GridLinePrimitive {
  readonly kind: 'gridline';
  readonly points: readonly WorldPoint[];
  readonly widthPx: number;
  readonly stroke: string;
  /** Opt out of the seam turn-loop when the primitive is already continuous-tiled. */
  readonly wrap?: boolean;
}

/** A text label anchored at a world point, drawn at a constant on-screen font px (FR-17). */
export interface LabelPrimitive {
  readonly kind: 'label';
  readonly at: WorldPoint;
  readonly text: string;
  /** Constant on-screen font size in CSS pixels (NOT derived from zoom). */
  readonly fontPx: number;
  readonly fill: string;
  /**
   * Opt out of the seam turn-loop (see {@link GridLinePrimitive.wrap}). Grid labels
   * are anchored at continuous-span longitudes already, so re-tiling would stack
   * duplicate text and (for translucent labels) compound alpha (Codex high #2).
   */
  readonly wrap?: boolean;
}

/**
 * A base-map image to draw under everything, spanning a world rectangle. The
 * renderer wrap-replicates it across the seam like every other primitive (FR-07).
 * The image SOURCE acquisition/validation belongs to a later unit (spec §やらない
 * こと); the renderer only paints a supplied image at supplied world bounds.
 */
export interface BaseMapPrimitive {
  readonly kind: 'basemap';
  /** Opaque image source the backend can paint (e.g. an ImageBitmap/HTMLImage). */
  readonly image: CanvasImageSource;
  /** World longitude of the image's left/right edges (continuous scalar). */
  readonly lonWest: number;
  readonly lonEast: number;
  /** World latitude of the image's top/bottom edges. */
  readonly latNorth: number;
  readonly latSouth: number;
}

export type DrawPrimitive =
  | PointPrimitive
  | LinePrimitive
  | PolygonPrimitive
  | PolygonShapePrimitive
  | GridLinePrimitive
  | LabelPrimitive
  | BaseMapPrimitive;

/**
 * One frame's worth of primitives, drawn back-to-front in the declared order.
 * The arrays are explicit (an empty `primitives` is a real, valid empty frame —
 * 教訓 5.18 — drawn as a cleared surface, never skipped by a falsy short-circuit).
 */
export interface RenderBatch {
  readonly primitives: readonly DrawPrimitive[];
}

// --- Hit-test contract ------------------------------------------------------
//
// This unit defines the SHAPE and the transform-backed minimum; feature-level
// hit predicates (point-in-polygon, nearest vertex, selection priority) are a
// later unit that consumes `worldAt` + the shared transform (spec §やらないこと).

/**
 * The result of a screen-space hit test. `world` is the continuous-scalar world
 * point under the screen position (via the shared `screenToWorld`); later units
 * resolve which feature, if any, occupies that point. Returned even when no
 * feature is hit (the world point is always defined), so callers branch on their
 * own predicate, not on a null world (教訓 5.18).
 */
export interface HitTestResult {
  /** The world point under the queried screen position. */
  readonly world: WorldPoint;
}

// --- The renderer contract --------------------------------------------------

/**
 * The renderer-independent drawing contract. The DEFAULT implementation is Canvas
 * 2D (`Canvas2DMapRenderer`); a WebGL implementation can satisfy the same
 * interface and be swapped in without touching callers (R1). Callers depend on
 * THIS interface only — never on a concrete backend (受け入れ基準 5).
 */
export interface MapRenderer {
  // -- camera / viewport (the transform契約) --------------------------------
  /** Set the current camera (the truth lives in U16; the renderer mirrors it). */
  setCamera(camera: Camera): void;
  /** Get the camera the renderer is currently drawing with. */
  getCamera(): Camera;
  /** Set the viewport size (CSS px + dpr). dpr scales the backing buffer only. */
  setViewport(viewport: Viewport): void;
  /** Get the current viewport. */
  getViewport(): Viewport;
  /** Set the zoom clamp range applied to cursor-zoom (U16-supplied; FR-10 default otherwise). */
  setZoomRange(range: ZoomRange): void;

  // -- transform (shared by draw AND hit-test, 教訓 5.29) -------------------
  /** World → screen (CSS px) with the current camera + viewport. */
  worldToScreen(world: WorldPoint): ScreenPoint;
  /** Screen (CSS px) → world with the current camera + viewport. */
  screenToWorld(screen: ScreenPoint): WorldPoint;

  // -- draw -----------------------------------------------------------------
  /** Draw one frame from a declarative batch (wrap-replicated across the seam). */
  drawBatch(batch: RenderBatch): void;

  // -- hit-test -------------------------------------------------------------
  /** Resolve the world point (and transform context) under a screen position. */
  hitTest(screen: ScreenPoint): HitTestResult;

  // -- interaction helper (cursor-anchored wheel zoom, FR-08) ---------------
  /**
   * Compute (without applying) the NEW camera for a cursor-anchored wheel zoom by
   * `factor`. Returns a fresh camera for the caller to push into U16 (the render
   * layer does not own camera state — 単一真実源). Pure w.r.t. renderer state.
   */
  cameraForWheelZoom(cursor: ScreenPoint, factor: number): Camera;
  /**
   * The zoom clamp ACTUALLY applied to cursor-zoom: the U16-supplied range with the
   * floor lowered to the fit-world zoom when that is smaller than the configured
   * minimum (so the FR-11 fit-all initial camera stays in range). Exposed so an
   * external wheel path (U40 dispatcher, HB-1) clamps against the SAME effective
   * range the renderer uses — no second clamp source (単一真実源, 教訓 5.29).
   */
  effectiveZoomRange(): ZoomRange;
}
