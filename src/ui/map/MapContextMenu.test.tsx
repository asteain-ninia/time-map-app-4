// MapContextMenu tests (FR-96 本結線): the DYNAMIC composeFor/onSelectItem render +
// the LEGACY (App-compat) static render.
//
// The dynamic path renders the U36 composed items with their own enabled/disable
// reason, fires onSelectItem(itemKind, model) on an enabled click, keeps a disabled
// item inert, appends the 表示専用モード切替 view command, and opens NOTHING for a
// NO_MENU. The legacy path (no composeFor) is the pre-existing 2-item static render so
// the current App call is unchanged.

/// <reference types="@testing-library/jest-dom" />

import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { EDIT_MODE } from '../state/session';
import { createSessionStore } from '../state/store';
import { COMMAND_ID, CommandRegistry } from '../shell/commands';
import { EMPTY_HIT, featureBodyHit } from '../../domain/selection/index';
import { asFeatureId } from '../../domain/ids';
import {
  DISABLE_REASON,
  FEATURE_KIND,
  MENU_ITEM_KIND,
  MENU_TARGET_KIND,
  NO_MENU,
  disableReasonMessage,
  disabledItem,
  enabledItem,
  type ContextMenuModel,
} from '../../domain/context-menu/index';
import { MapContextMenu, type ContextMenuOpener } from './MapContextMenu';
import type { ContextMenuRequest } from './live-context-menu-port';

interface TestDomain {
  readonly tag: string;
}

function makeRegistry(): CommandRegistry {
  const registry = new CommandRegistry();
  registry.register(COMMAND_ID.EditDelete, { run: vi.fn() });
  registry.register(COMMAND_ID.ViewToggleViewMode, { run: vi.fn() });
  return registry;
}

function makeStore() {
  return createSessionStore<TestDomain>({
    initialDomain: { tag: 'd0' },
    initial: { mode: EDIT_MODE.Edit },
  });
}

const leafModel: ContextMenuModel = {
  kind: 'menu',
  target: {
    kind: MENU_TARGET_KIND.Feature,
    featureId: asFeatureId('a'),
    featureKind: FEATURE_KIND.Leaf,
    vertexIds: new Set(),
    sharedVertexIds: new Set(),
  },
  position: { x: 10, y: 20 },
  items: [
    enabledItem(MENU_ITEM_KIND.Delete),
    enabledItem(MENU_ITEM_KIND.EditProperties),
    enabledItem(MENU_ITEM_KIND.Split),
    enabledItem(MENU_ITEM_KIND.ChangeAffiliation),
    disabledItem(MENU_ITEM_KIND.Merge, DISABLE_REASON.MergeNeedsMoreTargets),
    enabledItem(MENU_ITEM_KIND.Unshare),
  ],
};

const REQUEST: ContextMenuRequest = { clientX: 10, clientY: 20, hit: EMPTY_HIT };

/** Render, capture the opener the mount binds, and open with `request`. */
function renderAndOpen(
  props: Partial<Parameters<typeof MapContextMenu<TestDomain>>[0]>,
  request: ContextMenuRequest = REQUEST,
): { registry: CommandRegistry } {
  const registry = props.registry ?? makeRegistry();
  let opener: ContextMenuOpener | null = null;
  render(
    <MapContextMenu<TestDomain>
      store={props.store ?? makeStore()}
      registry={registry}
      bindOpener={(o) => {
        opener = o;
      }}
      {...(props.composeFor ? { composeFor: props.composeFor } : {})}
      {...(props.onSelectItem ? { onSelectItem: props.onSelectItem } : {})}
      {...(props.onOpenChange ? { onOpenChange: props.onOpenChange } : {})}
      {...(props.surveyItemsFor ? { surveyItemsFor: props.surveyItemsFor } : {})}
      {...(props.onRemoveSurveyLine ? { onRemoveSurveyLine: props.onRemoveSurveyLine } : {})}
    />,
  );
  act(() => {
    opener?.open(request);
  });
  return { registry };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('MapContextMenu — DYNAMIC path (composeFor)', () => {
  it('renders the composed items + a trailing view command', () => {
    renderAndOpen({ composeFor: () => leafModel, onSelectItem: vi.fn() });
    const menu = screen.getByTestId('context-menu');
    expect(menu).toHaveStyle({ left: '10px', top: '20px' });
    // All composed items present, in order.
    expect(menu.querySelector(`[data-item-kind="${MENU_ITEM_KIND.Delete}"]`)).not.toBeNull();
    expect(menu.querySelector(`[data-item-kind="${MENU_ITEM_KIND.Unshare}"]`)).not.toBeNull();
    // The trailing view-axis command.
    expect(menu.querySelector(`[data-command="${COMMAND_ID.ViewToggleViewMode}"]`)).not.toBeNull();
  });

  it('onOpenChange reports the open/closed boundary (Codex F1a suspension 境界)', () => {
    // The App ORs this into shortcutsSuspended (the onDrawingChange 同型): true at
    // open, false at close — and the capture-phase Escape STILL closes the menu
    // while suspended (the menu's own key handling is suspension-independent).
    const onOpenChange = vi.fn();
    renderAndOpen({ composeFor: () => leafModel, onSelectItem: vi.fn(), onOpenChange });
    expect(onOpenChange).toHaveBeenLastCalledWith(true);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByTestId('context-menu')).toBeNull();
    expect(onOpenChange).toHaveBeenLastCalledWith(false);
  });

  it('a disabled item (結合) is inert and shows its Japanese disable reason', () => {
    const onSelectItem = vi.fn();
    renderAndOpen({ composeFor: () => leafModel, onSelectItem });
    const merge = screen
      .getByTestId('context-menu')
      .querySelector(`[data-item-kind="${MENU_ITEM_KIND.Merge}"]`) as HTMLButtonElement;
    expect(merge.disabled).toBe(true);
    expect(merge.title).toBe(disableReasonMessage(DISABLE_REASON.MergeNeedsMoreTargets));
    fireEvent.click(merge);
    expect(onSelectItem).not.toHaveBeenCalled();
  });

  it('clicking an enabled item calls onSelectItem(itemKind, model) and closes', () => {
    const onSelectItem = vi.fn();
    renderAndOpen({ composeFor: () => leafModel, onSelectItem });
    fireEvent.click(
      screen
        .getByTestId('context-menu')
        .querySelector(`[data-item-kind="${MENU_ITEM_KIND.Split}"]`) as HTMLButtonElement,
    );
    expect(onSelectItem).toHaveBeenCalledWith(MENU_ITEM_KIND.Split, leafModel);
    // Menu closed after selection.
    expect(screen.queryByTestId('context-menu')).toBeNull();
  });

  it('Escape closes the menu AND is stopped before window bubble listeners (鍵盤の段階7)', () => {
    // The global shortcut dispatcher is a window BUBBLE keydown listener (useShortcuts:
    // Escape=EditDeselect). While the menu is open it must NOT see the Escape that
    // closes the menu — otherwise the same keypress deselects the feature the
    // right-click just promoted (実機で検出: メニューが閉じず選択だけ消えた).
    const bubbleSpy = vi.fn();
    window.addEventListener('keydown', bubbleSpy);
    try {
      renderAndOpen({ composeFor: () => leafModel, onSelectItem: vi.fn() });
      expect(screen.getByTestId('context-menu')).toBeInTheDocument();
      fireEvent.keyDown(window, { key: 'Escape' });
      expect(screen.queryByTestId('context-menu')).toBeNull();
      expect(bubbleSpy).not.toHaveBeenCalled();
      // A non-Escape key passes through untouched (the menu owns ONLY Escape).
      fireEvent.keyDown(window, { key: 'a' });
      expect(bubbleSpy).toHaveBeenCalledTimes(1);
    } finally {
      window.removeEventListener('keydown', bubbleSpy);
    }
  });

  it('a NO_MENU model still opens a menu with ONLY the view commands (item 5)', () => {
    renderAndOpen({ composeFor: () => NO_MENU, onSelectItem: vi.fn() });
    const menu = screen.getByTestId('context-menu');
    // No domain edit items, but the view-axis command stays available (a view-only
    // right-click can return to editing — matches the legacy always-a-menu behaviour).
    expect(menu.querySelector('[data-item-kind]')).toBeNull();
    expect(menu.querySelector(`[data-command="${COMMAND_ID.ViewToggleViewMode}"]`)).not.toBeNull();
  });

  it('**選んでいなくても「見る」側の項目が並ぶ**（増分 5 の手直し E3 / バグ狩り #20）', () => {
    // 設計書 §I.3 の原則①「右クリックはいつでも開ける ―― 中身が変わるだけ」。旧版は
    // 何も選んでいない・作図中の右クリックで **項目が 1 個しかない板**が出ていた。
    // 地物に依らない見る操作（全体表示・拡大・縮小）はどの局面でも意味があるので、
    // 常に並べる。可否はメニューバーと同じ 1 本（`resolveCommandEnabled`）を通す。
    renderAndOpen({ composeFor: () => NO_MENU, onSelectItem: vi.fn() });
    const menu = screen.getByTestId('context-menu');
    for (const id of [
      COMMAND_ID.ViewFitAll,
      COMMAND_ID.ViewZoomIn,
      COMMAND_ID.ViewZoomOut,
      COMMAND_ID.ViewToggleViewMode,
    ]) {
      expect(menu.querySelector(`[data-command="${id}"]`), id).not.toBeNull();
    }
  });
});

// --- 増分 8C: 測量の線の「この線を消す」（設計書 §E.1 V15）----------------------

describe('MapContextMenu — 測量の線の項目（増分 8C）', () => {
  const ITEMS = [
    { lineId: 4, label: '1,234km の線を消す' },
    { lineId: 2, label: '1,201km の線を消す' },
  ];

  it('要求が線の id を持てば、測量ごとに 1 項目ずつ先頭に並ぶ（どれか 1 つに決めない）', () => {
    const surveyItemsFor = vi.fn(() => ITEMS);
    renderAndOpen(
      { composeFor: () => leafModel, onSelectItem: vi.fn(), surveyItemsFor },
      { ...REQUEST, surveyLineIds: [4, 2] },
    );
    expect(surveyItemsFor).toHaveBeenCalledWith([4, 2]);
    const menu = screen.getByTestId('context-menu');
    const surveyButtons = [...menu.querySelectorAll('[data-survey-line-id]')];
    expect(surveyButtons.map((b) => b.getAttribute('data-survey-line-id'))).toEqual(['4', '2']);
    expect(surveyButtons.map((b) => b.textContent)).toEqual(ITEMS.map((i) => i.label));
    // 先頭（地物の項目より前）。
    expect(menu.querySelectorAll('[data-testid="context-menu-item"]')[0]).toBe(surveyButtons[0]);
  });

  // 増分 8C の手直し（反証 #1）: 線に当たった右クリックは地物を昇格しないので、地物の項目を
  // 組むと **押していない、いま選んでいる別の地物** が相手になる。線の項目と見る側の項目だけにする。
  it('線に当たった要求では地物の項目を組まない（composeFor を呼ばず、見る側の項目は残る）', () => {
    const composeFor = vi.fn(() => leafModel);
    renderAndOpen(
      { composeFor, onSelectItem: vi.fn(), surveyItemsFor: () => ITEMS },
      { ...REQUEST, hit: featureBodyHit(asFeatureId('under')), surveyLineIds: [4, 2] },
    );
    expect(composeFor).not.toHaveBeenCalled();
    const menu = screen.getByTestId('context-menu');
    expect(menu.querySelector('[data-item-kind]')).toBeNull();
    expect(menu.querySelectorAll('[data-survey-line-id]')).toHaveLength(2);
    expect(menu.querySelector(`[data-command="${COMMAND_ID.ViewFitAll}"]`)).not.toBeNull();
    expect(menu.querySelector(`[data-command="${COMMAND_ID.ViewToggleViewMode}"]`)).not.toBeNull();
  });

  it('線に当たっていなければ、従来どおり地物の項目を組む', () => {
    const composeFor = vi.fn(() => leafModel);
    renderAndOpen({ composeFor, onSelectItem: vi.fn(), surveyItemsFor: () => ITEMS });
    expect(composeFor).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('context-menu').querySelector('[data-item-kind]')).not.toBeNull();
  });

  it('押すと、その線の id で onRemoveSurveyLine を呼んで閉じる', () => {
    const onRemoveSurveyLine = vi.fn();
    renderAndOpen(
      {
        composeFor: () => leafModel,
        onSelectItem: vi.fn(),
        surveyItemsFor: () => ITEMS,
        onRemoveSurveyLine,
      },
      { ...REQUEST, surveyLineIds: [4, 2] },
    );
    fireEvent.click(
      screen.getByTestId('context-menu').querySelector('[data-survey-line-id="2"]') as HTMLButtonElement,
    );
    expect(onRemoveSurveyLine).toHaveBeenCalledWith(2);
    expect(onRemoveSurveyLine).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('context-menu')).toBeNull();
  });

  it('地物の項目が無い（NO_MENU・読むだけ）ときも出る', () => {
    renderAndOpen(
      { composeFor: () => NO_MENU, onSelectItem: vi.fn(), surveyItemsFor: () => ITEMS.slice(0, 1) },
      { ...REQUEST, surveyLineIds: [4] },
    );
    expect(
      screen.getByTestId('context-menu').querySelectorAll('[data-survey-line-id]'),
    ).toHaveLength(1);
  });

  it('線に当たっていない要求では呼ばず、項目も出ない', () => {
    const surveyItemsFor = vi.fn(() => ITEMS);
    renderAndOpen({ composeFor: () => leafModel, onSelectItem: vi.fn(), surveyItemsFor });
    expect(surveyItemsFor).not.toHaveBeenCalled();
    expect(screen.getByTestId('context-menu').querySelector('[data-survey-line-id]')).toBeNull();
  });
});

// 増分 8C の手直し（反証 #4）: 項目を二重クリックすると、2 回目が閉じたあとの地図に落ちて
// 測量の始点が置かれた。1 回目と同じ場所・短い間隔の次の押下を、離し・クリックごと飲み込む。
describe('MapContextMenu — 項目の二重クリックの 2 回目を地図へ落とさない（増分 8C の手直し）', () => {
  const ITEMS = [{ lineId: 4, label: 'この線を消す' }];

  function openAndClickItem(): HTMLDivElement {
    const map = document.createElement('div');
    document.body.appendChild(map);
    renderAndOpen(
      { composeFor: () => leafModel, onSelectItem: vi.fn(), surveyItemsFor: () => ITEMS, onRemoveSurveyLine: vi.fn() },
      { ...REQUEST, surveyLineIds: [4] },
    );
    const item = screen.getByTestId('context-menu').querySelector('[data-survey-line-id="4"]') as HTMLButtonElement;
    fireEvent.click(item, { detail: 1, clientX: 50, clientY: 60 });
    expect(screen.queryByTestId('context-menu')).toBeNull();
    return map;
  }

  it('同じ場所の次の押下と、それに続く離し・クリックは地図に届かない', () => {
    const map = openAndClickItem();
    const seen: string[] = [];
    for (const type of ['pointerdown', 'pointerup', 'click', 'dblclick']) {
      map.addEventListener(type, () => seen.push(type));
    }
    fireEvent.pointerDown(map, { button: 0, clientX: 51, clientY: 61 });
    fireEvent.pointerUp(map, { button: 0, clientX: 51, clientY: 61 });
    fireEvent.click(map, { button: 0, clientX: 51, clientY: 61 });
    fireEvent.dblClick(map, { button: 0, clientX: 51, clientY: 61 });
    expect(seen).toEqual([]);
    // 二重クリックの知らせで見張りは終わる（そのあとのクリックは届く）。
    fireEvent.click(map, { button: 0, clientX: 51, clientY: 61 });
    expect(seen).toEqual(['click']);
    map.remove();
  });

  it('離れた場所の押下は飲まず、そのあとも見張らない', () => {
    const map = openAndClickItem();
    const seen: string[] = [];
    map.addEventListener('pointerdown', () => seen.push('pointerdown'));
    map.addEventListener('click', () => seen.push('click'));
    fireEvent.pointerDown(map, { button: 0, clientX: 200, clientY: 200 });
    fireEvent.click(map, { button: 0, clientX: 200, clientY: 200 });
    fireEvent.pointerDown(map, { button: 0, clientX: 50, clientY: 60 });
    expect(seen).toEqual(['pointerdown', 'click', 'pointerdown']);
    map.remove();
  });

  it('鍵盤で押した（detail 0）ときは見張らない', () => {
    const map = document.createElement('div');
    document.body.appendChild(map);
    renderAndOpen(
      { composeFor: () => leafModel, onSelectItem: vi.fn(), surveyItemsFor: () => ITEMS, onRemoveSurveyLine: vi.fn() },
      { ...REQUEST, surveyLineIds: [4] },
    );
    const item = screen.getByTestId('context-menu').querySelector('[data-survey-line-id="4"]') as HTMLButtonElement;
    fireEvent.click(item, { detail: 0 });
    const seen: string[] = [];
    map.addEventListener('pointerdown', () => seen.push('pointerdown'));
    fireEvent.pointerDown(map, { button: 0, clientX: 0, clientY: 0 });
    expect(seen).toEqual(['pointerdown']);
    map.remove();
  });
});

describe('MapContextMenu — LEGACY path (no composeFor, App-compat)', () => {
  it('renders the static 削除 + 表示専用モード切替 via the shell ContextMenu', () => {
    renderAndOpen({});
    const menu = screen.getByTestId('context-menu');
    expect(menu.querySelector(`[data-command="${COMMAND_ID.EditDelete}"]`)).not.toBeNull();
    expect(menu.querySelector(`[data-command="${COMMAND_ID.ViewToggleViewMode}"]`)).not.toBeNull();
    // No dynamic domain-item buttons in the legacy render.
    expect(menu.querySelector('[data-item-kind]')).toBeNull();
  });
});
