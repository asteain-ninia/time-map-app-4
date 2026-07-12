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
import { EMPTY_HIT } from '../../domain/selection/index';
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

  it('a NO_MENU model opens nothing (view-only / nothing actionable)', () => {
    renderAndOpen({ composeFor: () => NO_MENU, onSelectItem: vi.fn() });
    expect(screen.queryByTestId('context-menu')).toBeNull();
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
