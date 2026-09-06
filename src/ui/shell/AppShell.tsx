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
import { CommandRegistry, type CommandId } from './commands';
import { MapSizeStore } from './map-resize';
import { buildDefaultKeymap } from './default-keymap';
import { useShortcuts } from './useShortcuts';

import { MenuBar } from './MenuBar';
import { LockButton } from './LockButton';
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
  /**
   * Top-bar slot: a full-width horizontal strip BELOW the menu bar and ABOVE the
   * main row (FR-12 経度シフト の上部表示, ユーザー要望「経度シフトを上部表示に」). Unlike
   * `mapOverlay` (which floats over the map and historically stole map clicks —
   * HB-15 / 8d1ce75), this is a NORMAL flow row in the shell grid, so it can never
   * sit over the map input layer or trap pointer events (教訓 5.14). Empty ⇒ the row
   * collapses (auto height).
   */
  readonly topBar?: ReactNode;
  /**
   * アプリバーの素性表示スロット（設計書 §H.6: 世界名・ファイル名・未保存の印）。メニューの
   * 右隣・`topBar` の左に置く。`topBar` と同じくメニューバー行の中の通常フロー要素なので、
   * 地図には一切重ならない。
   */
  readonly appIdentity?: ReactNode;
  /**
   * オプションバー行のスロット（設計書 §C.4）。アプリバーの下・主行の上に積む **地図セルの
   * 外のシェル行** なので、`mapOverlay` と違って地図セルの DOM の入れ子（結合点 #1 / T-3）に
   * 触れず、地図のクリックを奪うこともない（K-2 / K-4）。空なら行は潰れる（`topBar` と同じ）。
   */
  readonly optionBar?: ReactNode;
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
  /**
   * Suspend the global keyboard-shortcut dispatcher (bughunt3). The host raises this
   * while something else owns the keyboard — a modal is open (Ctrl+Z must not undo a
   * domain op THROUGH the modal, H1) or an Add/Knife tool is mid-drawing (its own
   * Ctrl+Z owns vertex-undo, so the global EditUndo must NOT also fire, H2). It is the
   * SINGLE source of truth (modalOpen || toolDrawing); the global window listener
   * never runs while raised, so the fix is robust regardless of listener registration
   * order (a later tool handler's stopImmediatePropagation could not unwind an already-
   * fired global undo). Defaults to false (always live).
   */
  readonly suspended?: boolean;
  /**
   * 止めている間でも通すコマンド（増分 3）。**道具が鍵盤を持っているとき**だけ呼び出し側が
   * 渡す（保存は道具に関係なく効いてほしい ―― 増分 1 の申し送り）。ダイアログが持って
   * いるときは渡さない。
   */
  readonly alwaysAllowedShortcuts?: ReadonlySet<CommandId> | undefined;
  /**
   * 止めている間に「効かなかった」ことを伝える口（増分 3）。**ダイアログが鍵盤を
   * 持っているときだけ**呼び出し側が渡す。
   */
  readonly onSuspendedShortcut?: ((id: CommandId) => void) | undefined;
  /**
   * メニューが開いた／閉じたことの報せ（増分 5 の手直し D4 / 設計書 §D.1 の「鍵盤の
   * 持ち主」）。メニューを開いているあいだは鍵盤の持ち主がメニューになるので、呼び出し
   * 側が `focusOwner` を 1 か所で導出できるように口だけ開けておく。
   */
  readonly onMenuOpenChange?: (open: boolean) => void;
}

export function AppShell<S>(props: AppShellProps<S>): JSX.Element {
  const {
    store,
    sidebar,
    topBar,
    appIdentity,
    optionBar,
    timeline,
    status,
    onMapMount,
    overlay,
    mapOverlay,
    suspended = false,
    alwaysAllowedShortcuts,
    onSuspendedShortcut,
    onMenuOpenChange,
  } = props;

  const registry = useMemo(() => props.registry ?? new CommandRegistry(), [props.registry]);
  const sizeStore = useMemo(() => props.sizeStore ?? new MapSizeStore(), [props.sizeStore]);
  const keymap = useMemo(() => buildDefaultKeymap(), []);

  const mode = useStore(store, (s) => s.mode);

  // Single shortcut dispatcher, gated by the same enabled judgement as the menu
  // (教訓 5.13). The host SUSPENDS it (bughunt3) while a modal owns the keyboard or
  // an Add/Knife tool is mid-drawing, so global EditUndo/EditDelete neither leak
  // THROUGH a modal (H1) nor double-fire alongside the tool's own Ctrl+Z (H2).
  useShortcuts({
    keymap,
    registry,
    mode,
    suspended,
    ...(alwaysAllowedShortcuts ? { alwaysAllowed: alwaysAllowedShortcuts } : {}),
    ...(onSuspendedShortcut ? { onSuspendedRefusal: onSuspendedShortcut } : {}),
  });

  return (
    <div className="app-shell" data-testid="app-shell">
      <header className="app-shell__menubar">
        <MenuBar
          registry={registry}
          mode={mode}
          {...(onMenuOpenChange ? { onOpenChange: onMenuOpenChange } : {})}
        />
        {/* 設計書 §H.6: どのファイルを開いていて未保存かどうかが常に見えるようにする。
            メニューバー行の通常フロー要素なので、地図には重ならない。 */}
        {appIdentity != null && (
          <div className="app-shell__identity" data-testid="app-shell-identity">
            {appIdentity}
          </div>
        )}
        {/* FR-12 経度シフト の上部表示 (ユーザー要望): a compact strip on the RIGHT of the
            menu bar row — a NORMAL flow element, NOT a map overlay, so it cannot cover
            the map or steal its clicks the way the old .map-area__overlay panel did
            (教訓 5.14 / HB-15 / 8d1ce75). この行にネストしている理由として以前「新しい
            グリッド行を足すとツールオーバーレイのミラーが崩れるから」と書いていたが、その
            ミラーは第6工程の ROOT FIX で撤去済みで、いまは行を足してよい（下の
            app-shell__optionbar がその実例）。 */}
        {topBar != null && (
          <div className="app-shell__topbar" data-testid="app-shell-topbar">
            {topBar}
          </div>
        )}

        {/* 鍵（設計書 §C.1 の 4）。**アプリバーのいちばん右の 96px の固定枠**に置く。
            **K-6 の唯一の判定点**で、閉めると変更経路がまとめて止まる（顔ぶれの表は
            `view-only-gate.test.tsx` の `CHANGE_PATHS`。**数はここに書かない** ――
            経路は増えるものなので、書くと必ず古くなる）。
            2 状態（読むだけ／直せる）とも同じ 96px の枠に文字が切れずに収まる
            （寸法は `shell.css` の `.app-shell__lock` が持つ）。
            増分 5 の手直し D1 まではここではなく左のレールの一番上に居て、それが
            レールが縦にあふれる根だった（道具 12 個ぶんの高さを鍵が削っていた）。
            `topBar` が `margin-left: auto` で右へ寄るので、鍵はそのさらに右になる。 */}
        <div className="app-shell__lock" data-testid="app-shell-lock">
          <LockButton store={store} />
        </div>
      </header>

      {/* 設計書 §C.4 のオプションバー行。地図セルの外の通常フロー行なので、地図の入力層を
          覆うことも、地図セルの入れ子（T-3 の data-zoom/-pan-x/-pan-y の取り付け先）を
          崩すこともない。 */}
      {optionBar != null && (
        <div className="app-shell__optionbar" data-testid="app-shell-optionbar">
          {optionBar}
        </div>
      )}

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
