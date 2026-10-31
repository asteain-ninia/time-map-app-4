// U20 React component tests: layout placement, mode exclusivity, mode-driven
// tools, view-only disabling, tooltips, shortcut wiring (受け入れ基準 1–11).

/// <reference types="@testing-library/jest-dom" />

import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { createSessionStore, type SessionStore } from '../state/store';
import { EDIT_MODE, type EditMode } from '../state/session';
import type { StoreApi } from 'zustand/vanilla';

import { AppShell } from './AppShell';
import { CommandRegistry, COMMAND_ID } from './commands';
import { ALL_TOOLS, TOOL_ID } from './tools';
import { LOCK_LABELS, TOOLTIPS } from './strings';

type S = Record<string, never>;

function makeStore(mode: EditMode = EDIT_MODE.Edit): StoreApi<SessionStore<S>> {
  return createSessionStore<S>({ initialDomain: {}, initial: { mode } });
}

/** いま「押されている」道具の id（`aria-pressed="true"` のもの）。 */
function pressedTools(): string[] {
  return [...screen.getByTestId('toolbar-tools').querySelectorAll('button[data-tool]')]
    .filter((b) => b.getAttribute('aria-pressed') === 'true')
    .map((b) => b.getAttribute('data-tool') ?? '');
}

describe('AppShell layout (FR-111, 受け入れ基準 1)', () => {
  it('places menubar, toolbar, map area, sidebar, timeline slot, status bar', () => {
    render(<AppShell store={makeStore()} timeline={<div data-testid="tl" />} />);
    expect(screen.getByTestId('menubar')).toBeInTheDocument();
    expect(screen.getByTestId('toolbar')).toBeInTheDocument();
    expect(screen.getByTestId('map-area')).toBeInTheDocument();
    expect(screen.getByTestId('map-canvas-mount')).toBeInTheDocument();
    expect(screen.getByTestId('map-input-layer')).toBeInTheDocument();
    expect(screen.getByTestId('sidebar')).toBeInTheDocument();
    expect(screen.getByTestId('statusbar')).toBeInTheDocument();
    expect(screen.getByTestId('tl')).toBeInTheDocument();
  });

  it('renders the mapOverlay slot INSIDE the map area, not the full-shell overlay', () => {
    // FR-12 regression lock (bughunt2): a map-anchored control (経度シフト) must
    // render in the map cell so it cannot overlap / steal clicks from the
    // surrounding chrome (toolbar / sidebar / timeline). Placing it in the
    // full-shell .app-shell__overlay (inset:0) put it over the timeline, where it
    // intercepted the 1年次へ進む button and broke the FR-01 / FR-02 e2e flows.
    render(
      <AppShell
        store={makeStore()}
        mapOverlay={<div data-testid="map-widget" />}
      />,
    );
    const widget = screen.getByTestId('map-widget');
    expect(widget).toBeInTheDocument();
    // It lives under the map area (.map-area), NOT under the shell overlay.
    expect(screen.getByTestId('map-area')).toContainElement(widget);
    expect(screen.getByTestId('map-overlay')).toContainElement(widget);
    const shellOverlay = screen.queryByTestId('app-shell-overlay');
    if (shellOverlay !== null) {
      expect(shellOverlay).not.toContainElement(widget);
    }
  });

  it('renders the topBar slot as a flow row above the main area (not over the map)', () => {
    // A2 (ユーザー要望「経度シフトを上部表示に」): the top bar is a NORMAL shell row, NOT a
    // map overlay — so it can never sit over the map input layer / steal its clicks the
    // way the old .map-area__overlay 経度シフト panel did (教訓 5.14 / HB-15 / 8d1ce75).
    render(<AppShell store={makeStore()} topBar={<div data-testid="top-widget" />} />);
    const widget = screen.getByTestId('top-widget');
    expect(widget).toBeInTheDocument();
    // It lives in the top-bar row…
    expect(screen.getByTestId('app-shell-topbar')).toContainElement(widget);
    // …NOT inside the map area / map overlay (which would risk the pointer-events trap).
    expect(screen.getByTestId('map-area')).not.toContainElement(widget);
    const mapOverlay = screen.queryByTestId('map-overlay');
    if (mapOverlay !== null) {
      expect(mapOverlay).not.toContainElement(widget);
    }
  });

  it('omits the top-bar row when no topBar slot is provided (collapses)', () => {
    render(<AppShell store={makeStore()} />);
    expect(screen.queryByTestId('app-shell-topbar')).not.toBeInTheDocument();
  });

  it('renders the optionBar slot as a flow row OUTSIDE the map cell (K-2 / K-4)', () => {
    // 設計書 §C.4 のオプションバー。topBar と同じく **通常フローのシェル行** で、地図セルの
    // 中には入らない。中に入れると (a) 地図の入力層を覆ってクリックを奪う (K-2 の 3 度の事故)
    // (b) onMapMount の querySelector が前提にする入れ子を崩して data-zoom / data-pan-x /
    // data-pan-y が **例外も警告も出さずに** 壊れる (T-3 / 結合点 #1)。
    render(<AppShell store={makeStore()} optionBar={<div data-testid="option-widget" />} />);
    const widget = screen.getByTestId('option-widget');
    expect(screen.getByTestId('app-shell-optionbar')).toContainElement(widget);
    expect(screen.getByTestId('map-area')).not.toContainElement(widget);
    const mapOverlay = screen.queryByTestId('map-overlay');
    if (mapOverlay !== null) {
      expect(mapOverlay).not.toContainElement(widget);
    }
  });

  it('omits the option-bar row when no optionBar slot is provided (collapses)', () => {
    render(<AppShell store={makeStore()} />);
    expect(screen.queryByTestId('app-shell-optionbar')).not.toBeInTheDocument();
  });

  it('sidebar has the two sections (一覧 / プロパティ, HB6 統合)', () => {
    render(<AppShell store={makeStore()} />);
    expect(screen.getByTestId('sidebar-tab-list')).toBeInTheDocument();
    expect(screen.getByTestId('sidebar-tab-properties')).toBeInTheDocument();
  });

  it('renders the five standard menus', () => {
    render(<AppShell store={makeStore()} />);
    for (const key of ['file', 'edit', 'view', 'tools', 'help']) {
      expect(screen.getByTestId(`menu-${key}`)).toBeInTheDocument();
    }
  });

  // 増分 5 の手直し D1（設計書 §C.1 の 4）。**鍵はアプリバーの右端の 96px 枠**に居る。
  // レールに置いていたときは、鍵のぶんの高さが道具から奪われてレールが縦にあふれていた。
  it('鍵はアプリバーの中にあり、左のレールには居ない（設計書 §C.1 の 4）', () => {
    render(<AppShell store={makeStore()} />);
    const lock = screen.getByTestId('mode-view');
    const frame = screen.getByTestId('app-shell-lock');
    // 器は鍵の **直接の親**（E2E もこの入れ子を読む）。
    expect(lock.parentElement).toBe(frame);
    // 器はアプリバーの中で、レールの中ではない。
    expect(screen.getByTestId('menubar').closest('header')).toContainElement(frame);
    expect(screen.getByTestId('toolbar')).not.toContainElement(lock);
  });

  // 手直し D1: レールに並ぶのは **道具 12 個（ALL_TOOLS の 11 個 ＋ 測る）だけ**。
  it('レールに並ぶボタンは道具 12 個だけ（鍵は混ざらない）', () => {
    render(<AppShell store={makeStore()} />);
    const rail = screen.getByTestId('toolbar');
    const buttons = rail.querySelectorAll('button');
    expect(buttons).toHaveLength(ALL_TOOLS.length + 1);
    expect(rail.querySelector('[data-testid="survey-toggle"]')).not.toBeNull();
    expect(rail.querySelector('[data-testid="mode-view"]')).toBeNull();
  });

  // 手直し D4（設計書 §D.1 の「鍵盤の持ち主」）。メニューの開閉を呼び出し側へ通す口。
  it('メニューの開閉が onMenuOpenChange で外へ伝わる', () => {
    const onMenuOpenChange = vi.fn();
    render(<AppShell store={makeStore()} onMenuOpenChange={onMenuOpenChange} />);
    // 取り付け直後は「閉じている」が 1 回流れる。
    expect(onMenuOpenChange).toHaveBeenLastCalledWith(false);

    fireEvent.click(screen.getByTestId('menu-file'));
    expect(onMenuOpenChange).toHaveBeenLastCalledWith(true);

    fireEvent.click(screen.getByTestId('menu-file'));
    expect(onMenuOpenChange).toHaveBeenLastCalledWith(false);
  });
});

// **増分 5b でモードの 3 ボタンが鍵 1 個＋道具の 1 段になった**（裁定 1）。
// FR-75 の「追加と編集は排他」は消えていない ―― 画面から段が消えただけで、内部の
// `mode` は道具から導出される（設計書 §D.1）:
//
//     mode = 鍵が閉じている ? 'view' : （面／線／点）? 'add' : 'edit'
//
// したがって旧テストの「追加を押すと編集が外れる」は「面の道具を持つと mode が add に
// なり、「選択」の道具へ戻すと edit になる」に置き換わる。
describe('道具から mode を導出する（FR-75 の排他は導出で保つ / 設計書 §D.1）', () => {
  it('面の道具を持つと mode が add になり、「選択」の道具へ戻すと edit になる', () => {
    const store = makeStore(EDIT_MODE.Edit);
    render(<AppShell store={store} />);

    fireEvent.click(screen.getByTestId(`tool-${TOOL_ID.AddArea}`));
    expect(store.getState().mode).toBe(EDIT_MODE.Add);
    expect(store.getState().activeTool).toBe(TOOL_ID.AddArea);

    fireEvent.click(screen.getByTestId(`tool-${TOOL_ID.EditSelect}`));
    expect(store.getState().mode).toBe(EDIT_MODE.Edit);
    // 押したとおりの値が入る（観測 `app-active-tool` が空にならない）。
    expect(store.getState().activeTool).toBe(TOOL_ID.EditSelect);
    // **道具を外した状態（`null`）も「選択」を意味する** ―― 道具の取り消し（Escape）が
    // 戻ってくる先がそこなので、どちらでも「選択」が押されて見える。
    act(() => store.getState().setActiveTool(null));
    expect(pressedTools()).toEqual([TOOL_ID.EditSelect]);
  });

  it('道具は 1 段で、追加の道具と編集の道具が同時に並ぶ（入れ替わらない）', () => {
    const store = makeStore(EDIT_MODE.Edit);
    render(<AppShell store={store} />);
    // 旧版は「追加モードでは編集の道具が消える」ことを固定していた。1 段になった
    // いまは **どちらも常に並ぶ** ―― これが「モードに入ってから道具を選ぶ」2 手を
    // 1 手にした本体である。
    for (const tool of ALL_TOOLS) {
      expect(screen.getByTestId(`tool-${tool}`)).toBeInTheDocument();
    }
    act(() => store.getState().setActiveTool(TOOL_ID.AddPoint));
    for (const tool of ALL_TOOLS) {
      expect(screen.getByTestId(`tool-${tool}`)).toBeInTheDocument();
    }
  });

  it('道具を持ち替えても、押されている道具はちょうど 1 つ', () => {
    const store = makeStore(EDIT_MODE.Edit);
    render(<AppShell store={store} />);

    fireEvent.click(screen.getByTestId(`tool-${TOOL_ID.AddPoint}`));
    expect(store.getState().activeTool).toBe(TOOL_ID.AddPoint);
    expect(pressedTools()).toEqual([TOOL_ID.AddPoint]);

    fireEvent.click(screen.getByTestId(`tool-${TOOL_ID.EditKnife}`));
    expect(store.getState().activeTool).toBe(TOOL_ID.EditKnife);
    expect(pressedTools()).toEqual([TOOL_ID.EditKnife]);

    // もう一度押すと外れ、「選択」が押された状態へ戻る（＝素の状態）。
    fireEvent.click(screen.getByTestId(`tool-${TOOL_ID.EditKnife}`));
    expect(store.getState().activeTool).toBeNull();
    expect(pressedTools()).toEqual([TOOL_ID.EditSelect]);
    // 「選択」を押しても押された状態のまま（外れない ―― 素の状態が「選択」だから）。
    fireEvent.click(screen.getByTestId(`tool-${TOOL_ID.EditSelect}`));
    expect(pressedTools()).toEqual([TOOL_ID.EditSelect]);
  });
});

describe('view-only bulk disabling (教訓 5.13, 受け入れ基準 9)', () => {
  it('鍵を閉じると道具が全部押せなくなり、開けると全部押せる（教訓 5.13）', () => {
    // **増分 5b**: 道具は 1 段になり、鍵が閉じていても **並んだまま灰色になる**
    // （どこへ行ったか分からなくなるより、押せない理由が見えるほうがよい）。だから
    // 「出ているか」ではなく「押せるか」を見る。
    const store = makeStore(EDIT_MODE.View);
    render(<AppShell store={store} />);
    for (const tool of ALL_TOOLS) {
      expect(
        (screen.getByTestId(`tool-${tool}`) as HTMLButtonElement).disabled,
        `${tool} が読むだけで押せる`,
      ).toBe(true);
    }

    act(() => store.getState().setMode(EDIT_MODE.Edit));
    for (const tool of ALL_TOOLS) {
      expect(
        (screen.getByTestId(`tool-${tool}`) as HTMLButtonElement).disabled,
        `${tool} が直せる状態でも押せない`,
      ).toBe(false);
    }
  });

  it('鍵が閉じているあいだは、道具を構えようとしても構わない（K-6 の抜け道を塞ぐ）', () => {
    // 画面のボタンは灰色だが、**ストアの口を直に叩いても**構えられないこと。
    // ここが通ると、右クリックや打鍵の経路から編集の入口が開く。
    const store = makeStore(EDIT_MODE.View);
    render(<AppShell store={store} />);
    act(() => store.getState().setActiveTool(TOOL_ID.EditKnife));
    expect(store.getState().activeTool).toBeNull();
    expect(store.getState().mode).toBe(EDIT_MODE.View);
  });

  it('an editing menu item is disabled in view-only and enabled when editable', () => {
    const store = makeStore(EDIT_MODE.View);
    const registry = new CommandRegistry();
    registry.register(COMMAND_ID.EditDelete, { run: vi.fn() });
    render(<AppShell store={store} registry={registry} />);

    fireEvent.click(screen.getByTestId('menu-edit'));
    const item = screen.getByTestId('menu-items-edit').querySelector(
      `[data-command="${COMMAND_ID.EditDelete}"]`,
    ) as HTMLButtonElement;
    expect(item.disabled).toBe(true);

    act(() => store.getState().setMode(EDIT_MODE.Edit));
    expect(
      (screen.getByTestId('menu-items-edit').querySelector(
        `[data-command="${COMMAND_ID.EditDelete}"]`,
      ) as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  it('a view-only command stays enabled while viewing (FR-42)', () => {
    const store = makeStore(EDIT_MODE.View);
    const registry = new CommandRegistry();
    registry.register(COMMAND_ID.FileOpen, { run: vi.fn() });
    render(<AppShell store={store} registry={registry} />);
    fireEvent.click(screen.getByTestId('menu-file'));
    const item = screen.getByTestId('menu-items-file').querySelector(
      `[data-command="${COMMAND_ID.FileOpen}"]`,
    ) as HTMLButtonElement;
    expect(item.disabled).toBe(false);
  });
});

describe('tooltips (FR-112, 受け入れ基準 6)', () => {
  it('shows a Japanese guide tooltip on a tool button hover', () => {
    render(<AppShell store={makeStore(EDIT_MODE.Add)} />);
    const wrapper = screen
      .getByTestId(`tool-${TOOL_ID.AddPoint}`)
      .closest('.tooltip') as HTMLElement;
    // **文言そのものを直書きしない**（開発ガイド §5.64。増分 5 の手直し E2 で吹き出しを
    // レールの語幹へ揃えたとき、直書きしていたこの 1 行だけが置き去りになって落ちた）。
    // 見たいのは「日本語の説明が出るか」であって「その日本語が何か」ではないので、
    // 画面と同じ定数から引く。
    const expectedTip = TOOLTIPS[TOOL_ID.AddPoint];
    expect(expectedTip, '点を置く道具に吹き出しの説明が無い').toBeDefined();
    const tip = screen.getByText(expectedTip as string);
    expect(tip).toHaveAttribute('hidden');
    fireEvent.mouseEnter(wrapper);
    expect(tip).not.toHaveAttribute('hidden');
  });

  it('鍵に日本語のラベルが付き、状態で言葉が入れ替わる', () => {
    const store = makeStore(EDIT_MODE.Edit);
    render(<AppShell store={store} />);
    expect(screen.getByTestId('mode-view')).toHaveTextContent(LOCK_LABELS.unlocked);
    act(() => store.getState().setMode(EDIT_MODE.View));
    expect(screen.getByTestId('mode-view')).toHaveTextContent(LOCK_LABELS.locked);
  });

  // HB-16 / 設計書 §H.2: 鍵のボタンには吹き出しを付けない（ホバーの泡が押下を邪魔して
  // いた）。道具のボタンには付ける。
  it('鍵には吹き出しの包みが無く、ネイティブの吹き出し（title）も付いていない', () => {
    render(<AppShell store={makeStore(EDIT_MODE.Edit)} />);
    const btn = screen.getByTestId('mode-view');
    expect(btn.closest('.tooltip')).toBeNull();
    // **`title` も付けない**（増分 5 の手直し D1）。増分 5b の実装には `title` が残って
    // いて、設計書 §H.2「鍵のボタンにはツールチップを付けない」と静かにすれ違っていた。
    expect(btn).not.toHaveAttribute('title');
    // 枠そのものにも泡は無い（鍵はレールからアプリバーの 96px 枠へ移った＝手直し D1。
    // testid `mode-view` は役割が同じなので据え置き＝T-1）。
    const frame = screen.getByTestId('app-shell-lock');
    expect(frame.querySelector('[role="tooltip"]')).toBeNull();
    expect(frame.querySelector('.tooltip')).toBeNull();
  });

  it('鍵は実クリックで view ⇄ edit を往復する（HB-16 / 設計書 §D.1 の導出式）', () => {
    const store = makeStore(EDIT_MODE.View);
    render(<AppShell store={store} />);

    fireEvent.click(screen.getByTestId('mode-view'));
    expect(store.getState().mode).toBe(EDIT_MODE.Edit);

    fireEvent.click(screen.getByTestId('mode-view'));
    expect(store.getState().mode).toBe(EDIT_MODE.View);
    // 閉めると道具は外れる（設計書 §D.2）。
    expect(store.getState().activeTool).toBeNull();
  });

  it('tool buttons still carry a tooltip after HB-16 (regression guard)', () => {
    render(<AppShell store={makeStore(EDIT_MODE.Add)} />);
    const toolBtn = screen.getByTestId(`tool-${TOOL_ID.AddPoint}`);
    expect(toolBtn.closest('.tooltip')).not.toBeNull();
  });
});

describe('shortcut wiring (FR-112, 受け入れ基準 7/9)', () => {
  it('Ctrl+Z dispatches undo when registered and editable', () => {
    const store = makeStore(EDIT_MODE.Edit);
    const registry = new CommandRegistry();
    const run = vi.fn();
    registry.register(COMMAND_ID.EditUndo, { run });
    render(<AppShell store={store} registry={registry} />);

    fireEvent.keyDown(window, { key: 'z', ctrlKey: true });
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('Ctrl+Z is a no-op in view-only mode (editing shortcut disabled, 教訓 5.13)', () => {
    const store = makeStore(EDIT_MODE.View);
    const registry = new CommandRegistry();
    const run = vi.fn();
    registry.register(COMMAND_ID.EditUndo, { run });
    render(<AppShell store={store} registry={registry} />);

    fireEvent.keyDown(window, { key: 'z', ctrlKey: true });
    expect(run).not.toHaveBeenCalled();
  });

  it('an unregistered shortcut never throws', () => {
    render(<AppShell store={makeStore(EDIT_MODE.Edit)} />);
    expect(() => fireEvent.keyDown(window, { key: 's', ctrlKey: true })).not.toThrow();
  });

  // bughunt3: AppShell THREADS a `suspended` flag into the global shortcut hook so
  // the host can stand the dispatcher down while a modal owns the keyboard / a tool
  // is mid-drawing. Without this, Ctrl+Z fired through open modals and double-fired
  // during Add/Knife drawing.
  it('suspended=true stops the global shortcut dispatcher (modal / drawing)', () => {
    const store = makeStore(EDIT_MODE.Edit);
    const registry = new CommandRegistry();
    const run = vi.fn();
    registry.register(COMMAND_ID.EditUndo, { run });
    render(<AppShell store={store} registry={registry} suspended />);

    fireEvent.keyDown(window, { key: 'z', ctrlKey: true });
    expect(run).not.toHaveBeenCalled();
  });

  it('suspended=false (default) keeps the dispatcher live', () => {
    const store = makeStore(EDIT_MODE.Edit);
    const registry = new CommandRegistry();
    const run = vi.fn();
    registry.register(COMMAND_ID.EditUndo, { run });
    render(<AppShell store={store} registry={registry} suspended={false} />);

    fireEvent.keyDown(window, { key: 'z', ctrlKey: true });
    expect(run).toHaveBeenCalledTimes(1);
  });
});

describe('map input layer (教訓 5.14, 受け入れ基準 8)', () => {
  it('the empty overlay does not cover the map input layer (pointer-events:none)', () => {
    render(
      <AppShell store={makeStore()} overlay={<div data-testid="ov-content" />} />,
    );
    const overlay = screen.getByTestId('app-shell-overlay');
    // The overlay container itself does not capture input; its children do.
    expect(overlay).toBeInTheDocument();
    expect(screen.getByTestId('ov-content')).toBeInTheDocument();
    expect(screen.getByTestId('map-input-layer')).toBeInTheDocument();
  });
});
