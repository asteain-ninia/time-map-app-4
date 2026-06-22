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
  type GridStyle,
} from '../../render/grid-layer';
import {
  buildFeaturePrimitivesWithVisible,
  DEFAULT_LABEL_THRESHOLDS,
  DEFAULT_SCREEN_SIZES,
  type EvaluatedFeature,
  type LabelThresholds,
} from '../../render/feature-layer';
import type { Camera, Viewport } from '../../render/camera';
import { initialCamera } from '../../render/vtransform';
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
   * Return the CURRENT graticule style (FR-13 / FR-109 間隔・色・不透明度・表示). Read
   * on every composite so a project-setting change to the grid spacing / color /
   * opacity reflects at once when the host redraws (教訓 5.35, the SAME即時反映
   * mechanism as {@link labelThresholds}). The composition root derives this from
   * `projectSettings.gridSpacingDeg / gridColor / gridOpacity` (settings.ts) so the
   * GridSettingsPanel truth reaches the draw — without it the grid drew with a fixed
   * {@link DEFAULT_GRID_STYLE} and panel changes were invisible. Defaults to
   * {@link DEFAULT_GRID_STYLE} when absent (legacy callers / pre-mount).
   */
  readonly gridStyle?: () => GridStyle;
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
  /**
   * Return the EDIT-HANDLE primitives to composite over the committed features THIS
   * frame (HB3-9 / FR-87). The composition root computes them from
   * `computeHandles(activeFeature, vertexStore)` (domain) → `buildEditHandlePrimitives`
   * (render) ONLY when in 編集 mode with an active feature, and returns an empty array
   * otherwise. Read on EVERY composite so the handles re-project against the live
   * camera and stay screen-fixed (FR-17) while the feature's fill scales with zoom; a
   * selection / time / domain / display change re-runs the getter on the next redraw
   * (教訓 5.5). Defaults to none when absent (legacy callers / pre-mount). The handles
   * draw ABOVE the committed features but UNDER the tool overlay (FR-78 仮表示 stays on
   * top), matching the back-to-front layer contract.
   */
  readonly editHandles?: () => readonly DrawPrimitive[];
  /**
   * Notified after every composite with a summary of the frame actually drawn THIS
   * paint (HB3-9 観測フック). The composition root mirrors it into the `window.__E2E__`
   * render-observation hook so a BEHAVIOURAL E2E (real pointer events) can assert the
   * frame's primitive content — e.g. that selecting a face in 編集 mode produced
   * `handle` primitives, that a live tool draft produced `preview` (overlay) primitives,
   * and the per-kind counts. It reflects EXACTLY the primitives passed to
   * `renderer.drawBatch` (never a recomputed estimate), so the hook and the pixels
   * cannot drift (教訓 5.29). Holds NO truth — a pure mirror of the drawn frame.
   */
  readonly onFrameComposed?: (summary: FrameSummary) => void;
}

/**
 * A per-frame render summary for the HB3-9 `__E2E__` observation hook: the count of each
 * primitive KIND actually drawn this paint, plus a convenience `preview` count (the tool
 * overlay primitives = FR-78 仮表示 / knife / add draft) and whether any live preview is
 * present. Kept renderer-independent (plain counts), so a behavioural E2E reads it the
 * same way regardless of backend.
 */
export interface FrameSummary {
  /** Edit-handle primitives drawn this frame (HB3-9 vertex / edge handles). */
  readonly handle: number;
  /** Label primitives drawn this frame (FR-86 ラベル). */
  readonly label: number;
  /** Polygon-shape primitives drawn this frame (面情報 fills). */
  readonly shape: number;
  /** Point primitives drawn this frame (点情報 markers). */
  readonly point: number;
  /** Line primitives drawn this frame (線情報 polylines). */
  readonly line: number;
  /** Tool-overlay (仮表示 / preview) primitives drawn this frame (add / knife draft). */
  readonly preview: number;
  /** True iff any live preview (tool overlay) primitive is present this frame. */
  readonly hasLivePreview: boolean;
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
  /**
   * Inject the throttled redraw requester (FR-110 / 受け入れ基準 5). After this is
   * set, the high-frequency repaint paths — `writeCamera` (pan / wheel zoom),
   * `drawAdd` / `drawKnife` (tool-draft moves) and `resyncViewport` — stop calling
   * the synchronous full-frame recomposition directly and instead route through this
   * requester, whose draw closure re-enters {@link AddHostPorts.redraw}. That funnels
   * EVERY repaint through the single {@link FrameScheduler} the composition root owns,
   * so the configured render FPS caps even the highest-frequency interactions and N
   * input events within one frame collapse to ONE composite (受け入れ基準 5). Until it
   * is set the host paints synchronously (the legacy behaviour, so pre-mount paints
   * and tests without a scheduler still draw at once).
   *
   * IMPORTANT: this throttles only the COMPOSITE (the expensive
   * buildGrid/buildFeature/selectVisible recomposition). The camera state itself is
   * still written to the renderer SYNCHRONOUSLY inside `writeCamera`, and
   * `onCameraChange` still fires synchronously, so `readCamera` / `screenToWorld` /
   * hit-tests and the observation hooks always see the live camera at once — only the
   * pixels are rate-capped (単一真実源 — the throttle never desyncs the camera truth).
   */
  setRedrawRequester(request: () => void): void;
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
  /**
   * Re-sync the renderer VIEWPORT (CSS width/height + device-pixel-ratio) to the
   * canvas's LIVE on-screen box and re-composite at once (P1 リサイズ座標ズレ root
   * fix). The viewport is otherwise fixed at mount, so after a window / layout
   * resize the renderer's screen↔world transform AND every hit-test still used the
   * STALE mount-time box — a click at a known screen position then resolved to the
   * wrong world point (add / select 両経路の同根). This reads the canvas box (the
   * SAME box `screenToWorld` subtracts for the client→surface offset) so the
   * transform and the hit-test always match the live canvas (単一真実源 — the
   * renderer viewport is the only size truth, re-derived from the live box, never a
   * second cached dimension). The camera (center + zoom) is PRESERVED — only the
   * viewport box changes — so the same world point stays under the surface centre.
   * Idempotent: a no-op when the box is unchanged, so it is cheap to call on every
   * ResizeObserver tick.
   */
  resyncViewport(): void;
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
  /**
   * The edit-handle primitives for the active feature (HB3-9 / FR-87), composited
   * ABOVE the committed features and UNDER the {@link overlay}. Empty when not editing
   * / no active feature. Defaults to none.
   */
  readonly editHandles?: readonly DrawPrimitive[];
  /** The camera + viewport the grid / committed features are projected with. */
  readonly camera: Camera;
  readonly viewport: Viewport;
  /** Label-visibility thresholds (FR-86); defaults to {@link DEFAULT_LABEL_THRESHOLDS}. */
  readonly thresholds?: LabelThresholds;
  /**
   * Graticule style (FR-13 / FR-109 間隔・色・不透明度); defaults to
   * {@link DEFAULT_GRID_STYLE}. The composition root supplies the live project
   * setting so a panel change reflects in the draw (単一真実源, 教訓 5.29).
   */
  readonly grid?: GridStyle;
}

/**
 * The result of {@link composeFrameWithCount}: the back-to-front primitive array
 * PLUS the count of committed features that survived the period-aware view clip in
 * the SAME compose pass (HB-14). The count is read straight off
 * `buildFeaturePrimitivesWithVisible`, so the frame is built and the visible count
 * is known in ONE O(n) clip pass — never a second `selectVisibleFeatures` over the
 * committed set just to publish the observation hook (bughunt round-2: paintWith no
 * longer does double feature work per frame).
 */
export interface ComposedFrame {
  readonly primitives: DrawPrimitive[];
  /** Committed features that survived this frame's view clip (HB-14 hook source). */
  readonly visibleCount: number;
}

/**
 * Compose ONE frame's draw primitives in back-to-front order (P0-A / 教訓 §4 single
 * base source): base map → graticule → COMMITTED features → tool overlay, AND report
 * the committed-feature view-clip survivor count from the SAME pass. Pure, so the
 * layer ORDER, committed-feature inclusion, and the visible count are unit-testable
 * without a DOM / Canvas; the host below delegates to it on every paint. The
 * committed features go through U19's `buildFeaturePrimitivesWithVisible`
 * (view-clip + LOD ON), so what draws — and the count published to the HB-14
 * observation hook — is exactly what U19's ONE clip pass decides (single truth
 * source, 教訓 5.29; no double O(n) feature work per frame, bughunt round-2).
 */
export function composeFrameWithCount(inputs: FrameInputs): ComposedFrame {
  const primitives: DrawPrimitive[] = [];
  if (inputs.baseImage !== null) {
    primitives.push(buildBaseMapPrimitive(inputs.baseImage, PRESET_BASEMAP_META));
  }
  primitives.push(
    ...buildGridPrimitives(
      true,
      inputs.grid ?? DEFAULT_GRID_STYLE,
      inputs.camera,
      inputs.viewport,
    ),
  );
  let visibleCount = 0;
  if (inputs.committed.length > 0) {
    const built = buildFeaturePrimitivesWithVisible(inputs.committed, {
      camera: inputs.camera,
      viewport: inputs.viewport,
      sizes: DEFAULT_SCREEN_SIZES,
      thresholds: inputs.thresholds ?? DEFAULT_LABEL_THRESHOLDS,
    });
    primitives.push(...built.primitives);
    visibleCount = built.visibleCount;
  }
  // HB3-9: the active feature's edit handles draw ABOVE the committed features (so a
  // handle sits on top of the shape it edits) but UNDER the tool overlay (FR-78 仮表示
  // / knife stays on top). Empty when not editing / no active feature.
  if (inputs.editHandles !== undefined) primitives.push(...inputs.editHandles);
  primitives.push(...inputs.overlay);
  return { primitives, visibleCount };
}

/**
 * Compose ONE frame's draw primitives in back-to-front order (see
 * {@link composeFrameWithCount}). Thin wrapper returning ONLY the primitive array
 * for callers that do not need the HB-14 visible count (e.g. the pure
 * layer-order/inclusion unit tests). Pure.
 */
export function composeFrame(inputs: FrameInputs): DrawPrimitive[] {
  return composeFrameWithCount(inputs).primitives;
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

  // Size the renderer from the CANVAS box (not the mount box) so the construction
  // viewport, the resync viewport, and the `screenToWorld` client→surface offset all
  // measure the SAME element — one size truth, no mount-vs-canvas mismatch.
  const initialRect = canvas.getBoundingClientRect();
  const widthCss = initialRect.width || canvas.clientWidth || mount.clientWidth || 0;
  const heightCss = initialRect.height || canvas.clientHeight || mount.clientHeight || 0;
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
    // CURRENT camera/viewport, AND get back the view-clip survivor count from the
    // SAME compose pass (no second O(n) clip just for the hook, bughunt round-2).
    const { primitives, visibleCount } = composeFrameWithCount({
      baseImage,
      committed,
      overlay,
      // HB3-9: the active feature's edit handles, recomputed fresh per frame so they
      // re-project against the live camera and stay screen-fixed (FR-17). Empty when
      // not editing / no active feature (the getter returns []).
      editHandles: options.editHandles?.() ?? [],
      camera,
      viewport,
      thresholds: options.labelThresholds?.() ?? DEFAULT_LABEL_THRESHOLDS,
      grid: options.gridStyle?.() ?? DEFAULT_GRID_STYLE,
    });
    renderer.drawBatch({ primitives });
    // HB3-9 観測フック: summarise the frame ACTUALLY drawn (per-kind primitive counts +
    // the tool-overlay/preview count) so a behavioural E2E can assert handles appear on
    // selection, a tool draft shows a live preview, etc. Counted over the SAME array
    // passed to drawBatch (no recomputed estimate, 教訓 5.29); `preview` is the overlay
    // primitive count (FR-78 仮表示), which the per-kind counts above also include.
    if (options.onFrameComposed !== undefined) {
      let handle = 0;
      let label = 0;
      let shape = 0;
      let point = 0;
      let line = 0;
      for (const p of primitives) {
        switch (p.kind) {
          case 'handle':
            handle += 1;
            break;
          case 'label':
            label += 1;
            break;
          case 'shape':
            shape += 1;
            break;
          case 'point':
            point += 1;
            break;
          case 'line':
            line += 1;
            break;
          default:
            break;
        }
      }
      options.onFrameComposed({
        handle,
        label,
        shape,
        point,
        line,
        preview: overlay.length,
        hasLivePreview: overlay.length > 0,
      });
    }
    // HB-14 観測フック: publish how many committed features survived the period-aware
    // view clip THIS frame. The count comes from the SAME `selectVisibleFeatures`
    // pass `buildFeaturePrimitivesWithVisible` already ran to build the primitives —
    // never a recomputed estimate (教訓 5.29) and never a second clip pass per frame
    // — so a zoom-in E2E can assert the candidate/clip set never wrongly drops to 0
    // while a feature is still on screen (再発防止, 既存 app-active-feature 方式).
    options.onVisibleFeatureCount?.(visibleCount);
  };

  // FR-110 throttle seam. The high-frequency repaint paths (pan / wheel via
  // writeCamera, tool-draft moves via drawAdd / drawKnife, resyncViewport, the
  // setZoomRange re-clamp) call `requestPaint()` instead of `paintWith` directly so
  // EVERY repaint can be coalesced and rate-capped by the composition root's single
  // FrameScheduler. Default: paint synchronously with the last overlay (legacy
  // behaviour, used pre-mount, during the async base-map decode, and in tests that
  // build the host without a scheduler). `setRedrawRequester` swaps in the
  // scheduler-backed requester, whose draw closure re-enters `redraw()` → the SAME
  // synchronous `paintWith(lastOverlay)`, so the deferred composite always uses the
  // overlay/camera/viewport state that the caller stashed synchronously BEFORE the
  // request (no second draw rule — one paint function, gated; no lost update, 教訓 5.6).
  let requestPaint = (): void => paintWith(lastOverlay);

  /**
   * Measure the canvas's LIVE on-screen box as a {@link Viewport}. This is the
   * SAME `getBoundingClientRect()` the `screenToWorld` offset uses, so the
   * transform/hit-test and the renderer viewport are derived from one source and
   * cannot drift after a resize (P1 root fix, 単一真実源). dpr is read live so a
   * window move between monitors of different density re-scales the backing buffer.
   */
  const measureViewport = (): Viewport => {
    const box = canvas.getBoundingClientRect();
    return {
      widthCss: box.width || canvas.clientWidth || 0,
      heightCss: box.height || canvas.clientHeight || 0,
      devicePixelRatio: mount.ownerDocument.defaultView?.devicePixelRatio ?? 1,
    };
  };

  /**
   * Re-sync the renderer viewport to the live canvas box and re-composite, but
   * ONLY when the box actually changed (idempotent — cheap on every observer tick).
   * The camera is preserved; `setViewport` re-sizes the backing buffer (dpr-aware)
   * and the next paint redraws through the SAME transform the hit-test reads.
   */
  const resyncViewport = (): void => {
    if (disposed) return;
    const next = measureViewport();
    const cur = renderer.getViewport();
    if (
      next.widthCss === cur.widthCss &&
      next.heightCss === cur.heightCss &&
      next.devicePixelRatio === cur.devicePixelRatio
    ) {
      return;
    }
    // Zero-size recovery: if the canvas first mounted UNMEASURED (0×0 — layout not
    // yet settled), the initial camera fit-zoom was 0 and `screenToWorld` would
    // divide by zero forever (病的入力). On the FIRST transition to a positive-size
    // box, re-seed the FR-11 fit-all camera for the real viewport so the transform
    // is well-defined. A user pan/zoom only happens after a measured mount, so this
    // cannot clobber a deliberate camera (the unmeasured camera is never interacted
    // with). Ordinary resizes (already-measured → measured) keep the camera (Codex:
    // do NOT re-fit on every resize — FR-11 fits at startup only).
    const wasUnmeasured = cur.widthCss <= 0 || cur.heightCss <= 0;
    const nowMeasured = next.widthCss > 0 && next.heightCss > 0;
    renderer.setViewport(next);
    if (wasUnmeasured && nowMeasured) {
      renderer.setCamera(initialCamera(next));
      options.onCameraChange?.(renderer.getCamera());
    }
    // Route through the throttle: a ResizeObserver can fire at raw layout rate during a
    // window drag, so the (expensive) recomposition is coalesced/capped like pan/zoom.
    // The viewport + camera are already updated synchronously above, so a deferred frame
    // composes against the fresh box (the next paint redraws through the SAME transform
    // the hit-test reads — no stale-frame gap).
    requestPaint();
  };

  // P1 ROOT FIX — keep the renderer viewport synced to the LIVE canvas box. The
  // viewport was set ONCE at mount, so any later window / layout resize left the
  // screen↔world transform AND every hit-test resolving against the STALE box: a
  // click at a known screen position then mapped to the wrong world point (add /
  // select 両経路の同根). A ResizeObserver on the canvas re-syncs on every box change
  // (the SAME signal U20's MapContainer already throttles for layout); a window
  // `resize` listener additionally catches a device-pixel-ratio change (monitor
  // move) that does not alter the CSS box. Both funnel through the idempotent
  // `resyncViewport` so there is ONE size-truth path (no double management).
  const view = mount.ownerDocument.defaultView;
  let resizeObserver: ResizeObserver | null = null;
  if (typeof view?.ResizeObserver === 'function') {
    resizeObserver = new view.ResizeObserver(() => resyncViewport());
    resizeObserver.observe(canvas);
  }
  const onWindowResize = (): void => resyncViewport();
  view?.addEventListener('resize', onWindowResize);

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
      // Stash the new overlay synchronously so a deferred frame composes it, then route
      // the (throttled) repaint through the single scheduler (FR-110). A tool-draft move
      // fires on every pointermove; coalescing keeps the draw rate at the configured cap.
      lastOverlay = primitives;
      requestPaint();
    },
    drawKnife(primitives): void {
      lastOverlay = primitives;
      requestPaint();
    },
    redraw(): void {
      // Re-composite with the latest committed features + the last tool overlay. This is
      // the scheduler's draw target (the throttled requester re-enters here), so it stays
      // a SYNCHRONOUS paint — the single place the composite actually runs.
      paintWith(lastOverlay);
    },
    setRedrawRequester(request): void {
      requestPaint = request;
    },
    zoom(): number {
      return renderer.getCamera().zoom;
    },
    readCamera(): { readonly camera: Camera; readonly viewport: Viewport } {
      return { camera: renderer.getCamera(), viewport: renderer.getViewport() };
    },
    writeCamera(camera: Camera): void {
      // Mirror the new camera into the renderer SYNCHRONOUSLY (the single camera the
      // draw / hit-test / screenToWorld read — they must see the live pan/zoom at once,
      // 教訓 5.29) and notify the host so it reflects the live pan/zoom into the store
      // truth + observation hooks immediately. Only the (expensive) re-composite is
      // routed through the throttle: pan fires writeCamera on EVERY pointermove and the
      // wheel on every notch, so coalescing/capping the paint here is exactly what
      // FR-110 caps — without it pan/zoom repaint at raw input rate (bughunt round-2).
      renderer.setCamera(camera);
      options.onCameraChange?.(camera);
      requestPaint();
    },
    setZoomRange(range: ZoomRange): void {
      // FR-10 / FR-109 即時反映: applying a new clamp may re-clamp the LIVE camera
      // (e.g. zoomed to 50× then max lowered to 10×). The renderer re-clamps its own
      // camera inside `setZoomRange`; if that changed the zoom, the screen must update
      // and U16's store mirror (via onCameraChange) must reflect the bounded zoom at
      // once — otherwise the old 50× frame lingers until the next wheel notch. We diff
      // the camera around the call (the renderer keeps identity stable on a no-op
      // change) so an in-range range update stays a silent no-op (no spurious repaint /
      // notify), while a real re-clamp repaints and mirrors through the SAME single
      // onCameraChange path the wheel/pan use (no duplicated store-mirror logic).
      const before = renderer.getCamera();
      renderer.setZoomRange(range);
      const after = renderer.getCamera();
      if (after.zoom !== before.zoom) {
        // Mirror the bounded zoom at once (FR-10 即時反映) and route the re-composite
        // through the throttle like every other repaint (single paint path).
        options.onCameraChange?.(after);
        requestPaint();
      }
    },
    effectiveZoomRange(): ZoomRange {
      return renderer.effectiveZoomRange();
    },
    resyncViewport(): void {
      resyncViewport();
    },
    dispose(): void {
      disposed = true;
      resizeObserver?.disconnect();
      view?.removeEventListener('resize', onWindowResize);
      canvas.remove();
    },
  };
}
