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
  clampZoom,
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
  type GridLinePrimitive,
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
