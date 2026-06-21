// UI layer (U20 / shell): the root layout shell (FR-111 / FR-114).
//
// The fixed business-UI layout: top menu bar, left toolbar, central map area,
// right sidebar, bottom timeline slot + status bar (FR-111). The central map is
// fluid,周辺 panels follow (CSS grid in shell.css). Min size 800×600 is honoured
// by the layout CSS (root min-width/height) AND the Electron window (U17), both
// reading the same constants (window-config.ts, FR-114). Shortcuts are wired
// here via useShortcuts, gated by the single permission judgement (教訓 5.13).
// The shell holds NO map-draw state in React (技術方針 2.3); the map area only
// mounts the render layer + notifies size.

import { useMemo, type ReactNode } from 'react';
import { useStore } from 'zustand';
import type { StoreApi } from 'zustand/vanilla';

import type { SessionStore } from '../state/store';
import { CommandRegistry } from './commands';
import { MapSizeStore } from './map-resize';
import { buildDefaultKeymap } from './default-keymap';
import { useShortcuts } from './useShortcuts';

import { MenuBar } from './MenuBar';
import { Toolbar } from './Toolbar';
import { MapContainer } from './MapContainer';
import { Sidebar, type SidebarProps } from './Sidebar';
import { StatusBar } from './StatusBar';

export interface AppShellProps<S> {
  readonly store: StoreApi<SessionStore<S>>;
  /** Command registry (later units register handlers). Defaults to a fresh one. */
  readonly registry?: CommandRegistry;
  /** Map size store the render layer subscribes to. Defaults to a fresh one. */
  readonly sizeStore?: MapSizeStore;
  /** Sidebar section content slots (later units fill these). */
  readonly sidebar?: SidebarProps;
  /** Bottom timeline slot (U21 mounts the Timeline here). */
  readonly timeline?: ReactNode;
  /** Status bar content slot. */
  readonly status?: ReactNode;
  /** Called once with the map mount element so a render unit can attach. */
  readonly onMapMount?: (el: HTMLDivElement) => (() => void) | void;
  /** Floating panels / modals / context menu overlay (later units). */
  readonly overlay?: ReactNode;
  /**
   * Controls anchored to the MAP AREA only (FR-12 経度シフト 等). Unlike `overlay`
   * (which spans the whole shell), these render inside the map cell so they cannot
   * overlap the toolbar / sidebar / timeline chrome (教訓 5.14).
   */
  readonly mapOverlay?: ReactNode;
}

export function AppShell<S>(props: AppShellProps<S>): JSX.Element {
  const { store, sidebar, timeline, status, onMapMount, overlay, mapOverlay } = props;

  const registry = useMemo(() => props.registry ?? new CommandRegistry(), [props.registry]);
  const sizeStore = useMemo(() => props.sizeStore ?? new MapSizeStore(), [props.sizeStore]);
  const keymap = useMemo(() => buildDefaultKeymap(), []);

  const mode = useStore(store, (s) => s.mode);

  // Single shortcut dispatcher, gated by the same enabled judgement as the menu
  // (教訓 5.13). A later unit can suspend it when a modal owns the keyboard.
  useShortcuts({ keymap, registry, mode });

  return (
    <div className="app-shell" data-testid="app-shell">
      <header className="app-shell__menubar">
        <MenuBar registry={registry} mode={mode} />
      </header>

      <div className="app-shell__main">
        <div className="app-shell__toolbar">
          <Toolbar store={store} />
        </div>

        <div className="app-shell__map">
          <MapContainer
            sizeStore={sizeStore}
            {...(onMapMount ? { onMount: onMapMount } : {})}
            {...(mapOverlay != null ? { mapOverlay } : {})}
          />
        </div>

        <div className="app-shell__sidebar">
          <Sidebar {...(sidebar ?? {})} />
        </div>
      </div>

      <div className="app-shell__timeline">{timeline}</div>

      <div className="app-shell__statusbar">
        <StatusBar>{status}</StatusBar>
      </div>

      {/* Front overlay layer: floating panels / modals / context menu sit ABOVE
          the map input layer and take input first (教訓 5.14). */}
      {overlay != null && (
        <div className="app-shell__overlay" data-testid="app-shell-overlay">
          {overlay}
        </div>
      )}
    </div>
  );
}
