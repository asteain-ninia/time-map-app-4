// UI layer (U20 / shell): public barrel.
//
// The app layout shell, the mode/tool/toolbar/menu chrome, the operability
// infrastructure (draggable panel, tooltip, context menu, shortcuts), and the
// single edit-permission gate (教訓 5.13). Later units mount their content into
// the slots and register their commands.

// --- layout components ------------------------------------------------------
export { AppShell, type AppShellProps } from './AppShell';
export { MenuBar, type MenuBarProps } from './MenuBar';
export { Toolbar, type ToolbarProps } from './Toolbar';
export { MapContainer, type MapContainerProps } from './MapContainer';
export {
  Sidebar,
  type SidebarProps,
  type SidebarSection,
  SIDEBAR_SECTION,
} from './Sidebar';
export { StatusBar, type StatusBarProps } from './StatusBar';

// --- operability primitives -------------------------------------------------
export { Tooltip, type TooltipProps } from './Tooltip';
export { DraggablePanel, type DraggablePanelProps } from './DraggablePanel';
export {
  ContextMenu,
  type ContextMenuProps,
  type ContextMenuItem,
} from './ContextMenu';

// --- hooks ------------------------------------------------------------------
export { useShell, type ShellBinding } from './useShell';
export { useDrag, type UseDragResult } from './useDrag';
export { useShortcuts, type UseShortcutsOptions } from './useShortcuts';

// --- commands / shortcuts / permissions -------------------------------------
export {
  COMMAND_ID,
  type CommandId,
  type CommandHandler,
  CommandRegistry,
  isCommandId,
} from './commands';
export {
  type Shortcut,
  type KeyChord,
  type DispatchResult,
  type Platform,
  DISPATCH_RESULT,
  Keymap,
  buildKeymap,
  chordOf,
  chordOfEvent,
  keyChordFromEvent,
  dispatchChord,
  detectPlatform,
  formatShortcut,
} from './shortcuts';
export { buildDefaultKeymap } from './default-keymap';
export {
  canEdit,
  isEditingCommand,
  resolveCommandEnabled,
  type EnabledInput,
} from './permissions';

// --- menu / tools / strings -------------------------------------------------
export {
  STANDARD_MENUS,
  MENU_KEY,
  type MenuKey,
  type MenuDef,
  type MenuItemDef,
} from './menu';
export { TOOL_ID, toolsForMode, toolBelongsToMode } from './tools';
export * from './strings';

// --- map resize / drag model / z-order / window config ----------------------
export {
  MapSizeStore,
  type MapSize,
  type MapSizeListener,
  type ThrottleClock,
  throttleTrailing,
  BROWSER_CLOCK,
} from './map-resize';
export {
  type DragState,
  type DragEvent,
  type Point,
  IDLE_DRAG,
  DRAG_THRESHOLD_PX,
  dragReducer,
  wasClick,
} from './drag';
export { ZOrder } from './z-order';
export {
  MIN_WINDOW_WIDTH,
  MIN_WINDOW_HEIGHT,
  MIN_WINDOW_SIZE,
} from './window-config';
