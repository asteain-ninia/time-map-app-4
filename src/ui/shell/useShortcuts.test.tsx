// U20 — useShortcuts suspension contract (bughunt3).
//
// The global window-keydown shortcut dispatcher MUST stand down when something else
// owns the keyboard (a modal is open, or an Add/Knife tool is mid-drawing). The hook
// already has a `suspended` option; these tests lock that contract: while suspended
// it dispatches NOTHING and never preventDefaults, and it re-arms the moment the flag
// clears. This is the single mechanism that fixes BOTH H1 (undo through a modal) and
// H2 (Ctrl+Z double-fire during drawing) — proven robust against listener order
// because the global listener never runs at all while suspended (no reliance on
// stopImmediatePropagation in a later-registered handler).

/// <reference types="@testing-library/jest-dom" />

import { fireEvent } from '@testing-library/react';
import { renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { useShortcuts } from './useShortcuts';
import { CommandRegistry, COMMAND_ID } from './commands';
import { buildDefaultKeymap } from './default-keymap';
import { EDIT_MODE } from '../state/session';

function makeRegistry(): { registry: CommandRegistry; run: ReturnType<typeof vi.fn> } {
  const registry = new CommandRegistry();
  const run = vi.fn();
  registry.register(COMMAND_ID.EditUndo, { run });
  return { registry, run };
}

describe('useShortcuts suspension (bughunt3 — single source for H1/H2)', () => {
  it('dispatches Ctrl+Z (EditUndo) when NOT suspended and editable', () => {
    const { registry, run } = makeRegistry();
    renderHook(() =>
      useShortcuts({ keymap: buildDefaultKeymap(), registry, mode: EDIT_MODE.Edit }),
    );
    fireEvent.keyDown(window, { key: 'z', ctrlKey: true });
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('dispatches NOTHING while suspended (modal open / tool drawing)', () => {
    const { registry, run } = makeRegistry();
    renderHook(() =>
      useShortcuts({
        keymap: buildDefaultKeymap(),
        registry,
        mode: EDIT_MODE.Edit,
        suspended: true,
      }),
    );
    fireEvent.keyDown(window, { key: 'z', ctrlKey: true });
    expect(run).not.toHaveBeenCalled();
  });

  it('does NOT preventDefault a bound chord while suspended (event passes through)', () => {
    const { registry } = makeRegistry();
    renderHook(() =>
      useShortcuts({
        keymap: buildDefaultKeymap(),
        registry,
        mode: EDIT_MODE.Edit,
        suspended: true,
      }),
    );
    const ev = new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, cancelable: true });
    window.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(false);
  });

  it('re-arms when suspended flips back to false', () => {
    const { registry, run } = makeRegistry();
    const keymap = buildDefaultKeymap();
    const { rerender } = renderHook(
      ({ suspended }: { suspended: boolean }) =>
        useShortcuts({ keymap, registry, mode: EDIT_MODE.Edit, suspended }),
      { initialProps: { suspended: true } },
    );
    fireEvent.keyDown(window, { key: 'z', ctrlKey: true });
    expect(run).not.toHaveBeenCalled();

    rerender({ suspended: false });
    fireEvent.keyDown(window, { key: 'z', ctrlKey: true });
    expect(run).toHaveBeenCalledTimes(1);
  });
});
