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
import {
  buildBaseMapPrimitive,
  buildGridPrimitives,
  DEFAULT_GRID_STYLE,
} from '../../render/grid-layer';
import {
  buildFeaturePrimitives,
  selectVisibleFeatures,
  DEFAULT_LABEL_THRESHOLDS,
  DEFAULT_SCREEN_SIZES,
  type EvaluatedFeature,
  type LabelThresholds,
} from '../../render/feature-layer';
import type { Camera, Viewport } from '../../render/camera';
import { loadPresetBaseMap, PRESET_BASEMAP_META } from '../map/base-map-asset';

/**
 * Inputs the host needs to composite the COMMITTED feature layer (P0-A): a getter
 * for the U19 `EvaluatedFeature[]` effective at the current timeline instant. The
 * host reads it on EVERY paint, so the latest committed truth is always drawn
 * (single truth source — the host never caches a stale copy, 教訓 5.6). When absent
 * the host behaves exactly as before (base + grid + overlay only).
 */
export interface CreateAddHostPortsOptions {
  /**
   * Return the committed features to draw THIS frame, resolved at the current time
   * with the current selection (FR-82). Called on every composite; a domain / time
   * / selection change is reflected by calling {@link AddHostPorts.redraw}.
   */
  readonly committedFeatures?: () => readonly EvaluatedFeature[];
  /**
   * Return the CURRENT label-visibility thresholds (FR-86 / FR-109). Read on every
   * composite so a project-setting change (e.g. `areaLabelOccupancyThreshold`)
   * reflects at once when the host redraws (教訓 5.35). Defaults to
   * {@link DEFAULT_LABEL_THRESHOLDS} when absent.
   */
  readonly labelThresholds?: () => LabelThresholds;
  /**
   * Notified after every live camera change (pan / wheel zoom, HB-1). The
   * composition root uses it to mirror the live pan offset + zoom into DOM
   * observation hooks (data-pan-x / data-pan-y / data-zoom) so a behavioural E2E
   * can assert the camera actually moved (既存 app-active-feature マーカーと同方式).
   */
  readonly onCameraChange?: (camera: Camera) => void;
  /**
   * Notified after every composite with the number of committed features that
   * SURVIVED the period-aware view clip this frame (HB-14 — 拡大すると地物が消える).
   * The composition root mirrors it into the `data-visible-feature-count`
   * observation hook so a behavioural E2E can assert the clipped/candidate set
   * never falls to 0 while a committed feature is still on screen during zoom-in
   * (既存 app-active-feature 方式). It reflects EXACTLY the set
   * {@link composeFrame} drew (the same {@link selectVisibleFeatures} call), never
   * a recomputed estimate, so the hook and the draw cannot drift (教訓 5.29).
   */
  readonly onVisibleFeatureCount?: (count: number) => void;
}

export interface AddHostPorts {
  /** Pointer client coords → world coordinate (U17 transform). */
  screenToWorld(clientX: number, clientY: number): WorldCoordinate;
  /** Paint the provisional add layer (FR-78). */
  drawAdd(primitives: readonly DrawPrimitive[]): void;
  /** Paint the provisional knife layer (U26: overlay / 対象面強調 / 分断線 / 固定円). */
  drawKnife(primitives: readonly DrawPrimitive[]): void;
  /**
   * Re-composite the whole frame (base + grid + COMMITTED features + the last tool
   * overlay) from the CURRENT inputs. Called by the composition root whenever the
   * committed domain / current time / selection changes so an added / edited /
   * split feature draws at once (P0-A / 教訓 5.5).
   */
  redraw(): void;
  /** The current camera zoom (CSS px per degree) — the固定円 radius input (FR-17). */
  zoom(): number;
  /**
   * Read the LIVE camera + viewport the renderer is drawing with (HB-1 pan/zoom
   * wiring). The U40 {@link CameraPort} reads this on each pan press so a drag
   * computes against a fresh viewport, and the wheel reads it for the cursor-anchored
   * zoom — the renderer owns the only camera the draw uses (単一の真実源, 教訓 5.29).
   */
  readCamera(): { readonly camera: Camera; readonly viewport: Viewport };
  /**
   * Write a new camera and re-composite at once (HB-1). The U40 pan/wheel path calls
   * this on every move/notch; it sets the renderer camera, re-paints the frame with
   * the last overlay, and notifies {@link CreateAddHostPortsOptions.onCameraChange}
   * so the composition root can mirror the live pan/zoom into observation hooks.
   */
  writeCamera(camera: Camera): void;
  /**
   * Supply the currently-effective zoom CLAMP range to U17 (FR-10 / U39). The
   * camera applies the clamp; this only hands it the {minZoom, maxZoom} value so
   * a settings change takes effect at once (FR-109 即時反映). U39's `zoomRangeOf`
   * derives the value; the bridge calls this on every settings change.
   */
  setZoomRange(range: ZoomRange): void;
  /**
   * The zoom clamp ACTUALLY in effect (the U16-supplied range with the fit-world
   * floor applied). The U40 wheel path reads this live on every notch so a settings
   * change AND the fit floor reach the wheel zoom against the SAME range the
   * renderer draws with (HB-1 / FR-10, 単一真実源 — no second clamp source).
   */
  effectiveZoomRange(): ZoomRange;
  /** Tear down the renderer + canvas on unmount. */
  dispose(): void;
}

/** The inputs to {@link composeFrame} for ONE frame's primitive composition. */
export interface FrameInputs {
  /** The decoded base-map image, or null until decoded / on decode failure. */
  readonly baseImage: CanvasImageSource | null;
  /** The committed features effective at the current time (P0-A). */
  readonly committed: readonly EvaluatedFeature[];
  /** The current tool-overlay primitives (FR-78 provisional add / knife). */
  readonly overlay: readonly DrawPrimitive[];
  /** The camera + viewport the grid / committed features are projected with. */
  readonly camera: Camera;
  readonly viewport: Viewport;
  /** Label-visibility thresholds (FR-86); defaults to {@link DEFAULT_LABEL_THRESHOLDS}. */
  readonly thresholds?: LabelThresholds;
}

/**
 * Compose ONE frame's draw primitives in back-to-front order (P0-A / 教訓 §4 single
 * base source): base map → graticule → COMMITTED features → tool overlay. Pure, so
 * the layer ORDER and the committed-feature inclusion are unit-testable without a
 * DOM / Canvas; the host below delegates to it on every paint. The committed
 * features go through U19's `buildFeaturePrimitives` (view-clip + LOD ON), so what
 * draws is exactly what U19 decides (single truth source, 教訓 5.29).
 */
export function composeFrame(inputs: FrameInputs): DrawPrimitive[] {
  const primitives: DrawPrimitive[] = [];
  if (inputs.baseImage !== null) {
    primitives.push(buildBaseMapPrimitive(inputs.baseImage, PRESET_BASEMAP_META));
  }
  primitives.push(
    ...buildGridPrimitives(true, DEFAULT_GRID_STYLE, inputs.camera, inputs.viewport),
  );
  if (inputs.committed.length > 0) {
    primitives.push(
      ...buildFeaturePrimitives(inputs.committed, {
        camera: inputs.camera,
        viewport: inputs.viewport,
        sizes: DEFAULT_SCREEN_SIZES,
        thresholds: inputs.thresholds ?? DEFAULT_LABEL_THRESHOLDS,
      }),
    );
  }
  primitives.push(...inputs.overlay);
  return primitives;
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
export function createAddHostPorts(
  mount: HTMLElement,
  options: CreateAddHostPortsOptions = {},
): AddHostPorts {
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
  // map area is never empty.
  //
  // BASE MAP IMAGE (FR-03 陸地輪郭): the bundled preset 出界図 (land-only
  // equirectangular SVG) is decoded asynchronously; until it is ready we paint the
  // graticule alone, and once `loadPresetBaseMap` resolves we store the decoded
  // image and re-composite so the land appears UNDER the grid (背景 → 最背面). A
  // decode failure leaves `baseImage` null → graticule-only fallback (読込失敗 →
  // グリッド維持), no console noise.
  let baseImage: CanvasImageSource | null = null;
  let disposed = false;
  // The last tool-overlay primitives (FR-78 provisional add / knife). Held so a
  // committed-feature redraw or the async base-map decode re-composites with the
  // overlay still on top, never wiping an in-progress tool draft (教訓 5.6).
  let lastOverlay: readonly DrawPrimitive[] = [];

  const paintWith = (overlay: readonly DrawPrimitive[]): void => {
    lastOverlay = overlay;
    // Read the committed getter fresh so the latest domain / time / selection truth
    // is drawn (single truth source, 教訓 5.6). Capture it ONCE so the
    // visible-count hook below reports the SAME list the frame composes (no drift).
    const committed = options.committedFeatures?.() ?? [];
    const camera = renderer.getCamera();
    const viewport = renderer.getViewport();
    // Compose the frame (base → grid → COMMITTED features → overlay) for the
    // CURRENT camera/viewport.
    const primitives = composeFrame({
      baseImage,
      committed,
      overlay,
      camera,
      viewport,
      thresholds: options.labelThresholds?.() ?? DEFAULT_LABEL_THRESHOLDS,
    });
    renderer.drawBatch({ primitives });
    // HB-14 観測フック: publish how many committed features survived the period-aware
    // view clip THIS frame (the SAME selector `buildFeaturePrimitives` uses), so a
    // zoom-in E2E can assert the candidate/clip set never wrongly drops to 0 while a
    // feature is still on screen (再発防止, 既存 app-active-feature 方式).
    if (options.onVisibleFeatureCount !== undefined) {
      const visible = selectVisibleFeatures(
        committed,
        camera,
        viewport,
        DEFAULT_SCREEN_SIZES,
      );
      options.onVisibleFeatureCount(visible.length);
    }
  };
  // Initial paint: the graticule + any committed features are visible immediately.
  paintWith([]);
  // Seed the observation hooks with the initial camera so data-pan-x/y/zoom exist
  // from first mount (a behavioural E2E reads a baseline before it pans, HB-1).
  options.onCameraChange?.(renderer.getCamera());
  // Kick off the base-map decode; re-composite when it lands (unless disposed),
  // keeping the last overlay so an in-progress tool draft is not wiped.
  void loadPresetBaseMap(mount.ownerDocument).then((img) => {
    if (disposed || img === null) return;
    baseImage = img;
    paintWith(lastOverlay);
  });

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
    redraw(): void {
      // Re-composite with the latest committed features + the last tool overlay.
      paintWith(lastOverlay);
    },
    zoom(): number {
      return renderer.getCamera().zoom;
    },
    readCamera(): { readonly camera: Camera; readonly viewport: Viewport } {
      return { camera: renderer.getCamera(), viewport: renderer.getViewport() };
    },
    writeCamera(camera: Camera): void {
      // Mirror the new camera into the renderer (the single camera the draw uses),
      // re-composite with the last overlay so the pan/zoom is visible at once, and
      // notify the host so it can reflect the live pan/zoom into observation hooks.
      renderer.setCamera(camera);
      paintWith(lastOverlay);
      options.onCameraChange?.(camera);
    },
    setZoomRange(range: ZoomRange): void {
      renderer.setZoomRange(range);
    },
    effectiveZoomRange(): ZoomRange {
      return renderer.effectiveZoomRange();
    },
    dispose(): void {
      disposed = true;
      canvas.remove();
    },
  };
}
