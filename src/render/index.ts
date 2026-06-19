// Render layer placeholder.
//
// The map drawing layer (Canvas 2D, the `MapRenderer` interface, camera
// transforms, hit-testing) is implemented in later units. This file only
// reserves the layer so its existence and import direction (render -> domain
// only) are established and lint-enforced from the start.

export const RENDER_LAYER = 'render' as const;
