// U20 / shell — HB5-4 選択解除 (Escape → edit.deselect) priority contract.
//
// Escape clears the active-feature + vertex selection through the SINGLE U22
// clearSelection path, routed through the SAME global dispatcher (useShortcuts) as
// the other 編集 commands. That dispatcher STANDS DOWN while a modal / tool-draft
// owns the keyboard (suspended), so a live draft-cancel / modal-close keeps Escape
// priority — this is the mechanism the task requires. These tests lock:
//   1. the keymap binds Escape → edit.deselect (single source: STANDARD_MENUS);
//   2. Escape clears the selection in 編集 mode with a live selection;
//   3. Escape does NOTHING while suspended (draft / modal wins) — priority;
//   4. Escape does NOTHING in 表示専用 mode (EDITING_COMMAND gate);
//   5. a no-selection Escape is a safe no-op (canRun false).

/// <reference types="@testing-library/jest-dom" />

import { fireEvent, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { CommandRegistry, COMMAND_ID } from './commands';
import { buildDefaultKeymap } from './default-keymap';
import { useShortcuts } from './useShortcuts';
import { createSessionStore } from '../state/store';
import { EDIT_MODE } from '../state/session';
import { asFeatureId } from '../../domain/ids';

/** A store with an opaque domain and an optional initial active-feature selection. */
function makeStore(selected: boolean) {
  return createSessionStore<Record<string, never>>({
    initialDomain: {},
    ...(selected ? { initial: { activeFeature: asFeatureId('f-1') } } : {}),
  });
}

/** Register edit.deselect exactly as App.tsx does (run = clearSelection, canRun = hasSelection). */
function registerDeselect(
  registry: CommandRegistry,
  store: ReturnType<typeof makeStore>,
): void {
  registry.register(COMMAND_ID.EditDeselect, {
    run: () => store.getState().clearSelection(),
    canRun: () => {
      const sel = store.getState().selection;
      return sel.activeFeature !== null || (sel.vertexIds.size > 0 && sel.vertexOwner !== null);
    },
  });
}

describe('HB5-4 選択解除 — Escape binding + priority', () => {
  it('the default keymap binds Escape → edit.deselect', () => {
    const keymap = buildDefaultKeymap();
    const commandId = keymap.resolve({
      key: 'Escape',
      ctrlOrMeta: false,
      shift: false,
      alt: false,
    });
    expect(commandId).toBe(COMMAND_ID.EditDeselect);
  });

  it('Escape clears the selection in 編集 mode with a live selection', () => {
    const store = makeStore(true);
    const registry = new CommandRegistry();
    registerDeselect(registry, store);
    renderHook(() =>
      useShortcuts({ keymap: buildDefaultKeymap(), registry, mode: EDIT_MODE.Edit }),
    );
    expect(store.getState().activeFeature).toBe(asFeatureId('f-1'));

    fireEvent.keyDown(window, { key: 'Escape' });

    expect(store.getState().activeFeature).toBeNull();
  });

  it('Escape does NOTHING while suspended — a draft / modal keeps priority', () => {
    const store = makeStore(true);
    const registry = new CommandRegistry();
    registerDeselect(registry, store);
    renderHook(() =>
      useShortcuts({
        keymap: buildDefaultKeymap(),
        registry,
        mode: EDIT_MODE.Edit,
        suspended: true,
      }),
    );

    fireEvent.keyDown(window, { key: 'Escape' });

    // The selection SURVIVES: the global dispatcher stood down so the draft / modal's
    // own Escape handler owns the keystroke (task HB5-4 優先順位).
    expect(store.getState().activeFeature).toBe(asFeatureId('f-1'));
  });

  it('Escape does NOTHING in 表示専用 mode (edit.deselect is gated off)', () => {
    const store = makeStore(true);
    const registry = new CommandRegistry();
    registerDeselect(registry, store);
    renderHook(() =>
      useShortcuts({ keymap: buildDefaultKeymap(), registry, mode: EDIT_MODE.View }),
    );

    fireEvent.keyDown(window, { key: 'Escape' });

    expect(store.getState().activeFeature).toBe(asFeatureId('f-1'));
  });

  it('Escape with no selection is a safe no-op (canRun false, no throw)', () => {
    const store = makeStore(false);
    const registry = new CommandRegistry();
    registerDeselect(registry, store);
    renderHook(() =>
      useShortcuts({ keymap: buildDefaultKeymap(), registry, mode: EDIT_MODE.Edit }),
    );

    expect(() => fireEvent.keyDown(window, { key: 'Escape' })).not.toThrow();
    expect(store.getState().activeFeature).toBeNull();
  });
});
