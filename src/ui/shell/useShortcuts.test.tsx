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
import { afterEach, describe, expect, it, vi } from 'vitest';

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

function makeEditRegistry(): {
  registry: CommandRegistry;
  undo: ReturnType<typeof vi.fn>;
  redo: ReturnType<typeof vi.fn>;
  del: ReturnType<typeof vi.fn>;
} {
  const registry = new CommandRegistry();
  const undo = vi.fn();
  const redo = vi.fn();
  const del = vi.fn();
  registry.register(COMMAND_ID.EditUndo, { run: undo });
  registry.register(COMMAND_ID.EditRedo, { run: redo });
  registry.register(COMMAND_ID.EditDelete, { run: del });
  return { registry, undo, redo, del };
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

describe('useShortcuts focus guard (バグハント第10波 #1 Delete / #4 Ctrl+Z through text input)', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  function mountFocused(
    el: HTMLElement,
  ): { registry: CommandRegistry; undo: ReturnType<typeof vi.fn>; redo: ReturnType<typeof vi.fn>; del: ReturnType<typeof vi.fn> } {
    const parts = makeEditRegistry();
    document.body.appendChild(el);
    el.focus();
    renderHook(() =>
      useShortcuts({ keymap: buildDefaultKeymap(), registry: parts.registry, mode: EDIT_MODE.Edit }),
    );
    return parts;
  }

  it('does NOT dispatch EditDelete when a text <input> is focused (#1: anchors survive)', () => {
    const input = document.createElement('input');
    input.type = 'text';
    const { del } = mountFocused(input);
    fireEvent.keyDown(input, { key: 'Delete' });
    fireEvent.keyDown(input, { key: 'Backspace' });
    expect(del).not.toHaveBeenCalled();
  });

  it('does NOT preventDefault Delete on a focused input (native edit passes through)', () => {
    const input = document.createElement('input');
    input.type = 'number';
    mountFocused(input);
    const ev = new KeyboardEvent('keydown', { key: 'Delete', cancelable: true, bubbles: true });
    input.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(false);
  });

  it('does NOT dispatch EditUndo / EditRedo when a text <input> is focused (#4)', () => {
    const input = document.createElement('input');
    input.type = 'text';
    const { undo, redo } = mountFocused(input);
    fireEvent.keyDown(input, { key: 'z', ctrlKey: true });
    fireEvent.keyDown(input, { key: 'y', ctrlKey: true });
    expect(undo).not.toHaveBeenCalled();
    expect(redo).not.toHaveBeenCalled();
  });

  it('does NOT preventDefault Ctrl+Z on a focused input (native undo passes through)', () => {
    const input = document.createElement('input');
    input.type = 'text';
    mountFocused(input);
    const ev = new KeyboardEvent('keydown', {
      key: 'z',
      ctrlKey: true,
      cancelable: true,
      bubbles: true,
    });
    input.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(false);
  });

  it('does NOT dispatch when a <textarea> is focused', () => {
    const ta = document.createElement('textarea');
    const { undo, del } = mountFocused(ta);
    fireEvent.keyDown(ta, { key: 'z', ctrlKey: true });
    fireEvent.keyDown(ta, { key: 'Delete' });
    expect(undo).not.toHaveBeenCalled();
    expect(del).not.toHaveBeenCalled();
  });

  it('does NOT dispatch when a contenteditable element is focused', () => {
    const div = document.createElement('div');
    div.setAttribute('contenteditable', 'true');
    div.tabIndex = 0;
    const { undo, del } = mountFocused(div);
    fireEvent.keyDown(div, { key: 'z', ctrlKey: true });
    fireEvent.keyDown(div, { key: 'Delete' });
    expect(undo).not.toHaveBeenCalled();
    expect(del).not.toHaveBeenCalled();
  });

  it('STILL dispatches from a non-editable focused element (button — no regression)', () => {
    const button = document.createElement('button');
    const { del } = mountFocused(button);
    fireEvent.keyDown(button, { key: 'Delete' });
    expect(del).toHaveBeenCalledTimes(1);
  });

  it('STILL dispatches when a non-text input (range) is focused (range is not text-editing)', () => {
    const slider = document.createElement('input');
    slider.type = 'range';
    const { del } = mountFocused(slider);
    fireEvent.keyDown(slider, { key: 'Delete' });
    expect(del).toHaveBeenCalledTimes(1);
  });
});
