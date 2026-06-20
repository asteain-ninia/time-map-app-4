// U23 — app-level add host ports backed by the live U17 renderer.
//
// The App root mounts a real {@link Canvas2DMapRenderer} into the map area on
// `onMapMount` (技術方針 2.3: imperative, off the React render path). This module
// builds that renderer and exposes the two capabilities the add-tool controller
// depends on as plain closures (教訓 5.33 契約越し):
//   - `screenToWorld(clientX, clientY)`: pointer client coords → world, via the
//     renderer's shared transform (教訓 5.29 — the SAME transform draw uses, so
//     "clicked here ⇒ placed here" cannot diverge);
//   - `drawAdd(primitives)`: paint the provisional add layer (FR-78 仮表示) by
//     handing the primitives straight to the renderer's declarative `drawBatch`.
//
// This is the render接続 the lens flagged as missing: `buildAddPrimitives` now
// reaches the MapRenderer through here.

import { Canvas2DMapRenderer } from '../../render/canvas2d-renderer';
import type { DrawPrimitive } from '../../render/map-renderer';
import type { ZoomRange } from '../../render/camera';
import type { WorldCoordinate } from '../../domain/coordinate';
import { buildGridPrimitives, DEFAULT_GRID_STYLE } from '../../render/grid-layer';

export interface AddHostPorts {
  /** Pointer client coords → world coordinate (U17 transform). */
  screenToWorld(clientX: number, clientY: number): WorldCoordinate;
  /** Paint the provisional add layer (FR-78). */
  drawAdd(primitives: readonly DrawPrimitive[]): void;
  /** Paint the provisional knife layer (U26: overlay / 対象面強調 / 分断線 / 固定円). */
  drawKnife(primitives: readonly DrawPrimitive[]): void;
  /** The current camera zoom (CSS px per degree) — the固定円 radius input (FR-17). */
  zoom(): number;
  /**
   * Supply the currently-effective zoom CLAMP range to U17 (FR-10 / U39). The
   * camera applies the clamp; this only hands it the {minZoom, maxZoom} value so
   * a settings change takes effect at once (FR-109 即時反映). U39's `zoomRangeOf`
   * derives the value; the bridge calls this on every settings change.
   */
  setZoomRange(range: ZoomRange): void;
  /** Tear down the renderer + canvas on unmount. */
  dispose(): void;
}

/**
 * Create the live add host ports for a mount element. A `<canvas>` is inserted
 * into `mount`, sized to its client box, and driven by a {@link Canvas2DMapRenderer}.
 * The element's bounding rect converts client pointer coords to canvas-relative
 * screen px before the world transform. On `dispose` the canvas is removed.
 *
 * In environments without a 2D context (e.g. some headless test runners) the
 * renderer construction throws; callers that may run there should guard. The app
 * always runs in Electron's Chromium where a 2D context is available.
 */
export function createAddHostPorts(mount: HTMLElement): AddHostPorts {
  const canvas = mount.ownerDocument.createElement('canvas');
  canvas.style.width = '100%';
  canvas.style.height = '100%';
  mount.appendChild(canvas);

  const rect = mount.getBoundingClientRect();
  const widthCss = rect.width || mount.clientWidth || 0;
  const heightCss = rect.height || mount.clientHeight || 0;
  const dpr = mount.ownerDocument.defaultView?.devicePixelRatio ?? 1;

  const renderer = new Canvas2DMapRenderer(canvas, {
    viewport: { widthCss, heightCss, devicePixelRatio: dpr },
  });

  // The base layer (出界図 / グリッド): the FR-03 background drawn under everything.
  // `drawBatch` clears the surface every call (canvas2d-renderer), so the add /
  // knife provisional draws would otherwise WIPE the map to blank between frames.
  // We hold the base primitives here and re-composite them UNDER every overlay
  // draw (single base source, 教訓 §4), and paint them once on mount so the central
  // map area is never empty. The graticule is fully synchronous (no async image
  // decode), satisfying「base-map 相当 or グリッド」without an offline asset fetch.
  const paintWith = (overlay: readonly DrawPrimitive[]): void => {
    // Rebuild the grid for the CURRENT camera/viewport so a resize / future pan
    // re-tiles correctly; the base stays under the overlay primitives.
    const base = buildGridPrimitives(
      true,
      DEFAULT_GRID_STYLE,
      renderer.getCamera(),
      renderer.getViewport(),
    );
    renderer.drawBatch({ primitives: [...base, ...overlay] });
  };
  // Initial paint: the base map is visible immediately on mount (no blank area).
  paintWith([]);

  return {
    screenToWorld(clientX, clientY): WorldCoordinate {
      const box = canvas.getBoundingClientRect();
      const world = renderer.screenToWorld({ x: clientX - box.left, y: clientY - box.top });
      return { lon: world.lon, lat: world.lat };
    },
    drawAdd(primitives): void {
      paintWith(primitives);
    },
    drawKnife(primitives): void {
      paintWith(primitives);
    },
    zoom(): number {
      return renderer.getCamera().zoom;
    },
    setZoomRange(range: ZoomRange): void {
      renderer.setZoomRange(range);
    },
    dispose(): void {
      canvas.remove();
    },
  };
}
