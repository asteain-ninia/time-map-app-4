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
import { DEFAULT_ZOOM_RANGE } from './camera';
import type {
  BaseMapPrimitive,
  DrawPrimitive,
  GridLinePrimitive,
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
  initialCamera,
  screenToWorld,
  worldToScreen,
  wrapTurnsForViewport,
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
    return zoomStepAtCursor(this.camera, this.viewport, cursor, factor, this.zoomRange);
  }

  // -- draw -------------------------------------------------------------------

  drawBatch(batch: RenderBatch): void {
    const { ctx } = this;
    const dpr = this.viewport.devicePixelRatio > 0 ? this.viewport.devicePixelRatio : 1;

    // Reset transform, scale by dpr ONCE so all subsequent coords are CSS px.
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, this.viewport.widthCss, this.viewport.heightCss);

    // The ±360° offsets needed to tile the viewport across the seam (U05 period).
    const turns = wrapTurnsForViewport(this.camera, this.viewport);

    for (const turn of turns) {
      const lonOffset = turn * LONGITUDE_PERIOD;
      for (const primitive of batch.primitives) {
        this.drawPrimitive(primitive, lonOffset);
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

/** Compile-time exhaustiveness guard for the primitive union. */
function assertNeverPrimitive(value: never): void {
  throw new Error(`Canvas2DMapRenderer: unhandled primitive ${JSON.stringify(value)}`);
}
