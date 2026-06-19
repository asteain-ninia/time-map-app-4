// Domain layer: framework-free constants shared across layers.
//
// The minimum window/layout dimensions (FR-114). These live in `domain` — the
// one layer BOTH `ui` (layout CSS / shell) and `shell` (Electron main window)
// may import — so the 800×600 minimum is a SINGLE source honoured on both sides
// and cannot drift (教訓 5.33 / §4 単一の真実源). The numbers carry no framework
// dependency, so placing them here keeps the dependency direction inward.

/** The minimum window/layout width in pixels (FR-114). */
export const MIN_WINDOW_WIDTH = 800;

/** The minimum window/layout height in pixels (FR-114). */
export const MIN_WINDOW_HEIGHT = 600;

/** The min-size object in the Electron BrowserWindow option shape. */
export const MIN_WINDOW_SIZE = {
  minWidth: MIN_WINDOW_WIDTH,
  minHeight: MIN_WINDOW_HEIGHT,
} as const;
