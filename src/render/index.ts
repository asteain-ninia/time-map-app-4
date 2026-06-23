// Render layer public barrel (U17).
//
// The map drawing layer: the renderer-independent `MapRenderer` contract
// (技術方針 2.4 / R1), the pure world↔screen VTransform (FR-05 / 07 / 08 / 11 /
// 17), the camera/viewport value types (camera STATE truth lives in U16), and the
// default Canvas 2D backend. Callers (UI / state) depend on the INTERFACE and the
// pure transform — never on the Canvas 2D concrete type directly (受け入れ基準 5).
//
// Import direction is render → domain only (lint-enforced).

export const RENDER_LAYER = 'render' as const;

// Camera / viewport value types + zoom clamp.
export {
  type Camera,
  type Viewport,
  type ZoomRange,
  DEFAULT_ZOOM_RANGE,
  WORLD_LON_SPAN_DEG,
  WORLD_LAT_SPAN_DEG,
  WORLD_LAT_MIN_DEG,
  WORLD_LAT_MAX_DEG,
  clampZoom,
  clampLat,
} from './camera';

// Pure VTransform (renderer-independent; reusable by any backend).
export {
  type ScreenPoint,
  type WorldPoint,
  worldToScreen,
  screenToWorld,
  fitWorldZoom,
  initialCamera,
  zoomAtCursor,
  zoomStepAtCursor,
  wrapTurnsForViewport,
  wrapTurnsForLonSpan,
  representativeCenterLon,
} from './vtransform';

// The renderer-independent drawing contract + batch / hit-test shapes.
export {
  type MapRenderer,
  type RenderBatch,
  type DrawPrimitive,
  type PointPrimitive,
  type LinePrimitive,
  type PolygonPrimitive,
  type PolygonShapePrimitive,
  type GridLinePrimitive,
  type HandlePrimitive,
  type LabelPrimitive,
  type BaseMapPrimitive,
  type HitTestResult,
} from './map-renderer';

// The default Canvas 2D backend (the concrete implementation; swappable via R1).
export { Canvas2DMapRenderer, type CanvasSurface } from './canvas2d-renderer';

// U18: grid + base-map batch building (FR-03 / FR-06 / FR-07 / FR-13 / FR-17).
// Pure: turns the U18 domain grid model + camera/viewport into declarative
// primitives for the MapRenderer (no Canvas API here).
export {
  type GridStyle,
  DEFAULT_GRID_STYLE,
  withOpacity,
  buildBaseMapPrimitive,
  viewportLonSpan,
  buildGridPrimitives,
} from './grid-layer';

// U19: feature drawing (点/線/面・穴透過・飛び地独立・派生集約形状・ラベル・LOD・
// 視野クリッピング). Pure: evaluated state + camera/viewport → declarative primitives
// (FR-17 / FR-21 / FR-71 / FR-86, NFR 5.1 / 5.2). No Canvas API here.
export {
  type ScreenSizes,
  type LabelThresholds,
  type FeatureStyle,
  type EvaluatedPoint,
  type EvaluatedLine,
  type EvaluatedArea,
  type EvaluatedFeature,
  type WorldRect,
  type BuildOptions,
  type LodLevel,
  DEFAULT_SCREEN_SIZES,
  DEFAULT_LABEL_THRESHOLDS,
  LOD_LEVEL,
  viewportWorldRect,
  worldRectsIntersect,
  worldRectIntersectsViewWrapped,
  inflateViewRect,
  pointRect,
  pointsRect,
  shapeRect,
  featureIntersectsViewport,
  clipViewRect,
  selectVisibleFeatures,
  lodLevelForZoom,
  lodToleranceDeg,
  simplifyRing,
  simplifyShape,
  pointLabelVisible,
  projectedLengthPx,
  lineLabelVisible,
  projectedRingAreaPx,
  ringOccupancy,
  areaRingLabelVisible,
  ringCentroid,
  buildFeaturePrimitives,
  buildFeaturePrimitivesWithVisible,
} from './feature-layer';
export type { FeaturePrimitivesResult } from './feature-layer';

// U34 → U19 render-boundary bridge: feeds U34's U08-resolved 集約/実形状
// (`ResolvedDisplayShape.shape`) verbatim into U19's `EvaluatedArea.shape`, so the
// shape U19 fills / hit-tests / labels is byte-for-byte the one U34 resolved
// (受け入れ基準 5, 教訓 5.29 / 5.1 / 5.33). Dependency direction render → domain.
export {
  type DisplayPresentation,
  type PresentationFor,
  toEvaluatedArea,
  toEvaluatedAreas,
  evaluatedAreaId,
} from './display-bridge';

// U34 display pipeline: turns the store's display-control inputs (global depth N /
// individual focus M) into the U19 `EvaluatedArea[]` draw batch, so a slider change
// re-generates the draw instructions end to end (FR-42 / FR-43, 教訓 5.5 / 5.29).
export {
  type DisplayControlInput,
  resolveDisplayControl,
  buildDisplayAreas,
} from './display-pipeline';

// U19: single-rAF redraw throttling (FR-71 / FR-110, 受け入れ基準 5).
export {
  type FrameSchedulerOptions,
  type ScheduleFrame,
  type CancelFrame,
  FrameScheduler,
  clampFps,
} from './frame-scheduler';

// U19: synthetic-data FPS / cost harness (NFR 5.1 / 5.2, 受け入れ基準 5).
export {
  type FrameMeasurement,
  type BenchmarkReport,
  generateSyntheticFeatures,
  measureFrame,
  runBenchmark,
} from './feature-benchmark';

// U23: provisional add-session drawing (FR-78 仮表示 / 面クロージング線半透明 /
// FR-17 一定サイズ). Pure: turns the U23 add-session domain state into declarative
// provisional primitives, distinct from confirmed features. No Canvas API here.
export {
  type AddStyle,
  DEFAULT_ADD_STYLE,
  buildAddPrimitives,
} from './add-batch';

// U24 → render: edit-handles drawing (FR-87 / FR-17, HB3-9). Pure: turns the domain
// `computeHandles` output (world coords) into screen-fixed `HandlePrimitive`s for the
// selected feature, composited only in 編集 mode with an active feature. No Canvas API.
export {
  type EditHandleStyle,
  DEFAULT_EDIT_HANDLE_STYLE,
  buildEditHandlePrimitives,
} from './edit-handles-layer';

// U26: knife-tool provisional drawing (FR-90 薄オーバーレイ＋対象面強調 / FR-78 分断線
// 仮表示 / FR-92 + FR-17 ズーム非依存固定円). Pure: turns the knife session state +
// host-resolved target shape + zoom into declarative primitives. No Canvas API here.
export {
  type KnifeStyle,
  type KnifeBatchInput,
  DEFAULT_KNIFE_STYLE,
  buildKnifePrimitives,
} from './knife-batch';
