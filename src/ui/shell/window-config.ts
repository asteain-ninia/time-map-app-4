// UI layer (U20 / shell): re-export of the shared minimum-window-size contract.
//
// 800×600 is enforced TWICE (spec 実装方針): in the Electron window
// (BrowserWindow minWidth/minHeight, shell/main) AND in the layout CSS (root
// min-width/min-height, shell.css). Both reference the SAME constants, which
// live in `domain` (the one layer both `ui` and `shell` may import) so the two
// sides cannot drift (教訓 5.33 / §4 単一の真実源). This module re-exports them
// for `ui`-side consumers.

export {
  MIN_WINDOW_WIDTH,
  MIN_WINDOW_HEIGHT,
  MIN_WINDOW_SIZE,
} from '../../domain/window-constants';
