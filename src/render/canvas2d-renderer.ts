// The default Canvas 2D `MapRenderer` implementation (U17, 技術方針 2.4).
//
// This is the ONLY file in the render layer that touches Canvas-specific APIs
// (`CanvasRenderingContext2D`). The transform math lives in the pure
// `vtransform` module, so this class merely (a) mirrors camera/viewport state,
// (b) calls the pure transform to place things, and (c) issues draw commands.
// Swapping in a WebGL backend means re-implementing only this file against the
// same `MapRenderer` interface (the R1退避路, 受け入れ基準 5).
//
// HiDPI discipline (spec §HiDPI): the backing buffer is sized in PHYSICAL pixels
// (CSS × devicePixelRatio) and the context is scaled by dpr once per frame, so
// every subsequent draw uses CSS-pixel coordinates. devicePixelRatio NEVER enters
// the world↔screen transform (FR-17's constant on-screen size is device-stable).
//
// Seam wrap (FR-07): each frame, the renderer asks the pure transform for the set
// of ±360° turn offsets covering the viewport (U05's period — no private period
// constant here) and draws every primitive once per offset. A non-crossing frame
// draws exactly one pass (turns === [0]); a zoomed-out frame covering several
// world turns draws several, tiling without a gap (教訓 5.18: the single-offset
// case is handled by the same loop, not special-cased away).

import { LONGITUDE_PERIOD } from '../domain/geo/seam';

import type { Camera, Viewport, ZoomRange } from './camera';
import { clampZoom, DEFAULT_ZOOM_RANGE } from './camera';
import type {
  BaseMapPrimitive,
  DrawPrimitive,
  GridLinePrimitive,
  HandlePrimitive,
  HitTestResult,
  LabelPrimitive,
  LinePrimitive,
  MapRenderer,
  PointPrimitive,
  PolygonPrimitive,
  PolygonShapePrimitive,
  RenderBatch,
} from './map-renderer';
import type { ScreenPoint, WorldPoint } from './vtransform';
import {
  fitWorldZoom,
  initialCamera,
  screenToWorld,
  worldToScreen,
  wrapTurnsForLonSpan,
  zoomStepAtCursor,
} from './vtransform';

/**
 * The minimal Canvas surface this renderer drives. Declared structurally (not as
 * the DOM `HTMLCanvasElement`) so the renderer can be constructed against a test
 * double, but it is satisfied by a real `<canvas>` (HiDPI sizing needs the width/
 * height backing-buffer setters in physical px plus the CSS-px style size).
 */
export interface CanvasSurface {
  /** Backing-buffer width in PHYSICAL pixels. */
  width: number;
  /** Backing-buffer height in PHYSICAL pixels. */
  height: number;
  getContext(contextId: '2d'): CanvasRenderingContext2D | null;
}

const DEFAULT_VIEWPORT: Viewport = {
  widthCss: 0,
  heightCss: 0,
  devicePixelRatio: 1,
};

export class Canvas2DMapRenderer implements MapRenderer {
  private readonly ctx: CanvasRenderingContext2D;
  private readonly surface: CanvasSurface;
  private camera: Camera;
  private viewport: Viewport;
  private zoomRange: ZoomRange;

  constructor(surface: CanvasSurface, initial?: { camera?: Camera; viewport?: Viewport }) {
    const ctx = surface.getContext('2d');
    if (ctx === null) {
      throw new Error('Canvas2DMapRenderer: 2D context unavailable');
    }
    this.surface = surface;
    this.ctx = ctx;
    this.viewport = initial?.viewport ?? DEFAULT_VIEWPORT;
    // Initial camera defaults to FR-11 fit-all for the given viewport.
    this.camera = initial?.camera ?? initialCamera(this.viewport);
    this.zoomRange = DEFAULT_ZOOM_RANGE;
    this.applyBackingBufferSize();
  }

  // -- camera / viewport ------------------------------------------------------

  setCamera(camera: Camera): void {
    this.camera = camera;
  }

  getCamera(): Camera {
    return this.camera;
  }

  setViewport(viewport: Viewport): void {
    this.viewport = viewport;
    this.applyBackingBufferSize();
  }

  getViewport(): Viewport {
    return this.viewport;
  }

  setZoomRange(range: ZoomRange): void {
    this.zoomRange = range;
    // FR-10 / FR-109 即時反映: a settings change must take effect on the CURRENT
    // camera at once, not lazily on the next wheel notch. If the live zoom now sits
    // OUTSIDE the new clamp (e.g. zoomed to 50× then max lowered to 10), re-clamp the
    // camera into the effective range here so the very next paint shows the bounded
    // zoom. We clamp against `effectiveZoomRange()` (the SAME range wheel-zoom obeys,
    // i.e. with the fit-all floor applied) so the renderer never lands on a zoom the
    // wheel path could not reach. Only re-assign when the value actually changes so an
    // in-range range update is a no-op (callers diff `getCamera()` to decide whether to
    // re-paint / mirror — keeping the camera identity stable avoids a spurious notify).
    const clamped = clampZoom(this.camera.zoom, this.effectiveZoomRange());
    if (clamped !== this.camera.zoom) {
      this.camera = { ...this.camera, zoom: clamped };
    }
  }

  /** Size the backing buffer to physical px (CSS × dpr); store stays CSS-based. */
  private applyBackingBufferSize(): void {
    const dpr = this.viewport.devicePixelRatio > 0 ? this.viewport.devicePixelRatio : 1;
    this.surface.width = Math.max(0, Math.round(this.viewport.widthCss * dpr));
    this.surface.height = Math.max(0, Math.round(this.viewport.heightCss * dpr));
  }

  // -- transform (shared by draw + hit-test, 教訓 5.29) ----------------------

  worldToScreen(world: WorldPoint): ScreenPoint {
    return worldToScreen(world, this.camera, this.viewport);
  }

  screenToWorld(screen: ScreenPoint): WorldPoint {
    return screenToWorld(screen, this.camera, this.viewport);
  }

  hitTest(screen: ScreenPoint): HitTestResult {
    return { world: this.screenToWorld(screen) };
  }

  cameraForWheelZoom(cursor: ScreenPoint, factor: number): Camera {
    return zoomStepAtCursor(this.camera, this.viewport, cursor, factor, this.effectiveZoomRange());
  }

  /**
   * The zoom clamp actually applied to wheel zoom, with the floor lowered to the
   * fit-all zoom when that is smaller than the configured minimum (Codex medium #6).
   *
   * The initial camera is FR-11 fit-all (`initialCamera` → `fitWorldZoom`), which for
   * a small/short viewport (e.g. 300×100) can be BELOW `zoomRange.minZoom` (1). If
   * the clamp kept the configured min, the user's very first "zoom out" wheel notch
   * would clamp UP — i.e. zoom IN — a jarring inversion. Deriving the effective min
   * from the SAME fit policy as the initial camera keeps the fit-zoomed initial state
   * inside the allowed range, so the first zoom-out behaves as a zoom-out. The
   * configured max is untouched. When the fit zoom is degenerate (0, not-yet-
   * measured) the configured range is used unchanged.
   */
  effectiveZoomRange(): ZoomRange {
    const fit = fitWorldZoom(this.viewport);
    if (!Number.isFinite(fit) || fit <= 0 || fit >= this.zoomRange.minZoom) {
      return this.zoomRange;
    }
    return { minZoom: fit, maxZoom: this.zoomRange.maxZoom };
  }

  // -- draw -------------------------------------------------------------------

  drawBatch(batch: RenderBatch): void {
    const { ctx } = this;
    const dpr = this.viewport.devicePixelRatio > 0 ? this.viewport.devicePixelRatio : 1;

    // Reset transform, scale by dpr ONCE so all subsequent coords are CSS px.
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, this.viewport.widthCss, this.viewport.heightCss);

    // Iterate PRIMITIVES outer so a `wrap === false` primitive (one that is already
    // tiled across the continuous viewport span — e.g. the graticule, grid-layer)
    // is drawn EXACTLY ONCE instead of re-issued per turn. Re-tiling an already-
    // tiled, translucent primitive both wastes path work (~O(turns²) at zoom-out)
    // and COMPOUNDS its alpha over the same pixels (Codex high #2). Wrapping
    // primitives (features / base map) draw once per turn so every on-screen replica
    // tiles across the seam (FR-07).
    //
    // HB-14 ROOT FIX (拡大すると地物が消える): the per-primitive turn set is computed
    // from the primitive's OWN continuous longitude span via `wrapTurnsForLonSpan`,
    // not from the base-[-180,180) world span. A feature carries continuous-scalar
    // longitudes (U03 never folds them; `committed-features` passes them verbatim) —
    // e.g. a point at lon 360 or a seam-crossing line at lon∈[179,181]. With the old
    // base-range turn list, a zoomed-in single-turn view collapsed to `[0]` and such a
    // feature was painted far off-screen and VANISHED, even though the period-aware
    // view-clip (which checks every replica) kept it. Per-primitive turns make the
    // renderer paint exactly the replicas the clip keeps, so kept ⇒ drawn at any zoom.
    for (const primitive of batch.primitives) {
      if (primitiveWraps(primitive)) {
        const span = primitiveLonSpan(primitive);
        const turns =
          span === undefined
            ? [0]
            : wrapTurnsForLonSpan(span.min, span.max, this.camera, this.viewport);
        for (const turn of turns) {
          this.drawPrimitive(primitive, turn * LONGITUDE_PERIOD);
        }
      } else {
        this.drawPrimitive(primitive, 0);
      }
    }
  }

  private drawPrimitive(primitive: DrawPrimitive, lonOffset: number): void {
    switch (primitive.kind) {
      case 'basemap':
        this.drawBaseMap(primitive, lonOffset);
        return;
      case 'polygon':
        this.drawPolygon(primitive, lonOffset);
        return;
      case 'shape':
        this.drawShape(primitive, lonOffset);
        return;
      case 'line':
        this.drawLine(primitive, lonOffset);
        return;
      case 'gridline':
        this.drawGridLine(primitive, lonOffset);
        return;
      case 'point':
        this.drawPoint(primitive, lonOffset);
        return;
      case 'handle':
        this.drawHandle(primitive, lonOffset);
        return;
      case 'label':
        this.drawLabel(primitive, lonOffset);
        return;
      default:
        // Exhaustive: a new primitive kind must extend this switch (no silent skip).
        return assertNeverPrimitive(primitive);
    }
  }

  /** Project a world point with an applied ±360° longitude offset (seam replica). */
  private project(world: WorldPoint, lonOffset: number): ScreenPoint {
    return worldToScreen(
      { lon: world.lon + lonOffset, lat: world.lat },
      this.camera,
      this.viewport,
    );
  }

  private drawPoint(p: PointPrimitive, lonOffset: number): void {
    const { x, y } = this.project(p.at, lonOffset);
    const ctx = this.ctx;
    ctx.beginPath();
    // radiusPx is screen-fixed (FR-17): NOT multiplied by zoom.
    ctx.arc(x, y, p.radiusPx, 0, Math.PI * 2);
    ctx.fillStyle = p.fill;
    ctx.fill();
  }

  /**
   * Draw an EDIT HANDLE marker (FR-87 / HB3-9) at a CONSTANT on-screen size (FR-17 —
   * `radiusPx` / `strokeWidthPx` are screen-fixed, never multiplied by zoom, exactly
   * like {@link drawPoint}). A VERTEX handle is a filled disc (move / delete target);
   * an EDGE handle is a hollow square (add-a-new-vertex target) so the two read
   * differently. Both are stroked so they stand out over any base / fill color.
   */
  private drawHandle(p: HandlePrimitive, lonOffset: number): void {
    const { x, y } = this.project(p.at, lonOffset);
    const ctx = this.ctx;
    if (p.handleKind === 'edge') {
      // Hollow square for an edge-midpoint (add-vertex) handle.
      const s = p.radiusPx;
      ctx.beginPath();
      ctx.rect(x - s, y - s, s * 2, s * 2);
      ctx.fillStyle = p.fill;
      ctx.fill();
      ctx.lineWidth = p.strokeWidthPx;
      ctx.strokeStyle = p.stroke;
      ctx.stroke();
      return;
    }
    // Filled disc for a vertex (move / delete) handle.
    ctx.beginPath();
    ctx.arc(x, y, p.radiusPx, 0, Math.PI * 2);
    ctx.fillStyle = p.fill;
    ctx.fill();
    ctx.lineWidth = p.strokeWidthPx;
    ctx.strokeStyle = p.stroke;
    ctx.stroke();
  }

  private drawLine(p: LinePrimitive, lonOffset: number): void {
    if (p.points.length < 2) return;
    const ctx = this.ctx;
    ctx.beginPath();
    this.tracePath(p.points, lonOffset);
    ctx.lineWidth = p.widthPx; // screen-fixed (FR-17).
    ctx.strokeStyle = p.stroke;
    ctx.stroke();
  }

  private drawGridLine(p: GridLinePrimitive, lonOffset: number): void {
    if (p.points.length < 2) return;
    const ctx = this.ctx;
    ctx.beginPath();
    this.tracePath(p.points, lonOffset);
    ctx.lineWidth = p.widthPx; // screen-fixed (FR-17).
    ctx.strokeStyle = p.stroke;
    ctx.stroke();
  }

  private drawPolygon(p: PolygonPrimitive, lonOffset: number): void {
    if (p.ring.length < 3) return;
    const ctx = this.ctx;
    ctx.beginPath();
    this.tracePath(p.ring, lonOffset);
    ctx.closePath();
    ctx.fillStyle = p.fill;
    ctx.fill();
    if (p.stroke !== undefined && p.strokeWidthPx !== undefined) {
      ctx.lineWidth = p.strokeWidthPx; // screen-fixed even for fills.
      ctx.strokeStyle = p.stroke;
      ctx.stroke();
    }
  }

  /**
   * Draw a面情報 with holes/enclaves (FR-20 / FR-21). Every ring of every piece is
   * traced into ONE path, then filled with the EVEN-ODD rule: territory rings add
   * area, holes punched inside them cancel it (透過), enclaves inside a hole add it
   * back — the FR-24交互 alternation with a SINGLE fill color (no per-ring color,
   * no connector line). The outline, when present, strokes each ring at a
   * screen-fixed width (FR-17). Hole rings are stroked the same as territory rings
   * (the hole边界 is a real边界), but never filled separately — there is no second
   * fill style anywhere, which is what keeps飛び地 same-colored as本土 (FR-101).
   */
  private drawShape(p: PolygonShapePrimitive, lonOffset: number): void {
    const ctx = this.ctx;
    let any = false;
    ctx.beginPath();
    for (const piece of p.pieces) {
      for (const ring of piece) {
        if (ring.length < 3) continue;
        this.tracePath(ring, lonOffset);
        ctx.closePath();
        any = true;
      }
    }
    if (!any) return;
    ctx.fillStyle = p.fill;
    // even-odd: holes (odd nesting) are透過, enclaves (even nesting) refill (FR-21).
    ctx.fill('evenodd');
    if (p.stroke !== undefined && p.strokeWidthPx !== undefined) {
      ctx.lineWidth = p.strokeWidthPx; // screen-fixed (FR-17).
      ctx.strokeStyle = p.stroke;
      ctx.stroke();
    }
  }

  private drawLabel(p: LabelPrimitive, lonOffset: number): void {
    const { x, y } = this.project(p.at, lonOffset);
    const ctx = this.ctx;
    // fontPx is screen-fixed (FR-17): the font is set in CSS px, never zoomed.
    ctx.font = `${p.fontPx}px sans-serif`;
    // HB3-26: draw the halo FIRST (a contrasting outline) so the fill text on top stays
    // legible over a same-colored background. Rounded joins avoid spiky corners.
    if (p.halo !== undefined) {
      ctx.lineJoin = 'round';
      ctx.lineWidth = Math.max(2, p.fontPx / 5);
      ctx.strokeStyle = p.halo;
      ctx.strokeText(p.text, x, y);
    }
    ctx.fillStyle = p.fill;
    ctx.fillText(p.text, x, y);
  }

  private drawBaseMap(p: BaseMapPrimitive, lonOffset: number): void {
    const ctx = this.ctx;
    const nw = this.project({ lon: p.lonWest, lat: p.latNorth }, lonOffset);
    const se = this.project({ lon: p.lonEast, lat: p.latSouth }, lonOffset);
    const w = se.x - nw.x;
    const h = se.y - nw.y;
    ctx.drawImage(p.image, nw.x, nw.y, w, h);
  }

  private tracePath(points: readonly WorldPoint[], lonOffset: number): void {
    const ctx = this.ctx;
    let started = false;
    for (const pt of points) {
      const { x, y } = this.project(pt, lonOffset);
      if (!started) {
        ctx.moveTo(x, y);
        started = true;
      } else {
        ctx.lineTo(x, y);
      }
    }
  }
}

/**
 * Whether a primitive should be replicated by the seam turn-loop (FR-07). Only the
 * gridline/label primitives carry an explicit `wrap` opt-out (they may already be
 * tiled across the continuous viewport span by grid-layer); everything else wraps.
 * Default is `true` (wrap) so an omitted flag preserves the original tiling
 * behaviour (教訓 5.18: a missing flag is a named default, not a silent skip).
 */
function primitiveWraps(primitive: DrawPrimitive): boolean {
  if (primitive.kind === 'gridline' || primitive.kind === 'label') {
    return primitive.wrap ?? true;
  }
  return true;
}

/**
 * The continuous-longitude extent `[min, max]` a wrapping primitive's CONTENT spans,
 * or undefined when it has no positional extent (an empty geometry). Used to pick the
 * exact ±360° turns at which the primitive must be drawn so every on-screen replica is
 * painted regardless of how many turns its continuous longitude is wound (HB-14).
 *
 * A label / point is a single anchor (min === max). A line is its vertex span; a
 * polygon / shape is the span over every ring of every piece; a base map is its
 * declared lon edges. An empty point list / empty shape yields undefined ⇒ the caller
 * falls back to the identity turn (教訓 5.18: absence, not a crash).
 */
function primitiveLonSpan(p: DrawPrimitive): { min: number; max: number } | undefined {
  switch (p.kind) {
    case 'point':
    case 'handle':
    case 'label':
      return { min: p.at.lon, max: p.at.lon };
    case 'line':
    case 'gridline':
      return lonSpanOfPoints(p.points);
    case 'polygon':
      return lonSpanOfPoints(p.ring);
    case 'shape': {
      let span: { min: number; max: number } | undefined;
      for (const piece of p.pieces) {
        for (const ring of piece) {
          span = mergeSpan(span, lonSpanOfPoints(ring));
        }
      }
      return span;
    }
    case 'basemap':
      return { min: Math.min(p.lonWest, p.lonEast), max: Math.max(p.lonWest, p.lonEast) };
    default:
      return assertNeverPrimitiveSpan(p);
  }
}

// Longitude-span MEMOIZATION (bughunt3 #low: per-drawBatch recompute). `drawBatch`
// runs every frame (pan / zoom) and `primitiveLonSpan` walks every vertex of every
// ring of every shape primitive each time, even though the primitive geometry is
// IMMUTABLE between rebuilds (a feature's primitives are reconstructed only on a
// domain / selected-time / LOD change, NOT on a camera move). The span is a pure
// function of the vertex array, so we cache it KEYED BY THE ARRAY REFERENCE: the
// same `points` array reused across frames hits the cache; a rebuilt primitive
// brings a fresh array that misses and recomputes once. A WeakMap lets a primitive
// dropped on the next rebuild be GC'd with its cached span (no unbounded growth).
// `undefined` (empty list) is a valid cached value, distinguished via `.has`.
const lonSpanCache = new WeakMap<
  readonly WorldPoint[],
  { min: number; max: number } | undefined
>();

/** Longitude span of a vertex list, or undefined when empty. */
function lonSpanOfPoints(
  points: readonly WorldPoint[],
): { min: number; max: number } | undefined {
  if (lonSpanCache.has(points)) return lonSpanCache.get(points);
  const span = computeLonSpanOfPoints(points);
  lonSpanCache.set(points, span);
  return span;
}

function computeLonSpanOfPoints(
  points: readonly WorldPoint[],
): { min: number; max: number } | undefined {
  let min = Infinity;
  let max = -Infinity;
  for (const pt of points) {
    if (pt.lon < min) min = pt.lon;
    if (pt.lon > max) max = pt.lon;
  }
  return min === Infinity ? undefined : { min, max };
}

/** Union of two optional longitude spans (either may be undefined). */
function mergeSpan(
  a: { min: number; max: number } | undefined,
  b: { min: number; max: number } | undefined,
): { min: number; max: number } | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return { min: Math.min(a.min, b.min), max: Math.max(a.max, b.max) };
}

/** Compile-time exhaustiveness guard for the primitive union. */
function assertNeverPrimitive(value: never): void {
  throw new Error(`Canvas2DMapRenderer: unhandled primitive ${JSON.stringify(value)}`);
}

/** Exhaustiveness guard for {@link primitiveLonSpan}. */
function assertNeverPrimitiveSpan(value: never): undefined {
  throw new Error(`Canvas2DMapRenderer: unhandled primitive span ${JSON.stringify(value)}`);
}
