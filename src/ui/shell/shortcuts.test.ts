// U20 pure-logic tests: shortcut chord normalisation, resolve, dispatch gating
// (受け入れ基準 7 / 9; 教訓 5.13 / 5.33).

import { afterEach, describe, expect, it, vi } from 'vitest';

import { EDIT_MODE } from '../state/session';
import { COMMAND_ID, CommandRegistry } from './commands';
import { STANDARD_MENUS } from './menu';
import { buildDefaultKeymap } from './default-keymap';
import {
  DISPATCH_RESULT,
  Keymap,
  chordOf,
  detectPlatform,
  dispatchChord,
  formatShortcut,
  type KeyChord,
} from './shortcuts';

function chord(over: Partial<KeyChord> & { key: string }): KeyChord {
  return { ctrlOrMeta: false, shift: false, alt: false, ...over };
}

describe('chordOf normalisation', () => {
  it('lower-cases single letters and orders modifiers deterministically', () => {
    expect(chordOf({ key: 'Z', ctrlOrMeta: true })).toBe('mod+z');
    expect(chordOf({ key: 'z', ctrlOrMeta: true, shift: true })).toBe('mod+shift+z');
    expect(chordOf({ key: 'Delete' })).toBe('Delete');
  });
});

describe('formatShortcut platform resolution (HB-2)', () => {
  it('resolves ctrlOrMeta to "Ctrl" on Windows/Linux — never "Mod"', () => {
    const label = formatShortcut({ key: 's', ctrlOrMeta: true }, 'other');
    expect(label).toBe('Ctrl+S');
    expect(label).not.toContain('Mod');
    expect(label).not.toContain('mod');
  });

  it('resolves ctrlOrMeta to "⌘" on macOS', () => {
    expect(formatShortcut({ key: 's', ctrlOrMeta: true }, 'mac')).toBe('⌘S');
  });

  it('orders and labels modifiers per platform (shift, alt)', () => {
    expect(formatShortcut({ key: 's', ctrlOrMeta: true, shift: true }, 'other')).toBe(
      'Ctrl+Shift+S',
    );
    expect(formatShortcut({ key: 'z', ctrlOrMeta: true, shift: true }, 'mac')).toBe('⌘⇧Z');
    expect(formatShortcut({ key: 'a', alt: true }, 'other')).toBe('Alt+A');
    expect(formatShortcut({ key: 'a', alt: true }, 'mac')).toBe('⌥A');
  });

  it('uppercases single letters and renders named keys verbatim', () => {
    expect(formatShortcut({ key: 'Delete' }, 'other')).toBe('Delete');
    expect(formatShortcut({ key: 'n', ctrlOrMeta: true }, 'other')).toBe('Ctrl+N');
  });

  it('renders the zoom-in "=" chord as a "+" sign', () => {
    expect(formatShortcut({ key: '=', ctrlOrMeta: true }, 'other')).toBe('Ctrl++');
  });

  it('no standard menu accelerator ever displays "Mod" on Windows', () => {
    for (const menu of STANDARD_MENUS) {
      for (const item of menu.items) {
        if (item.shortcut === undefined) continue;
        const label = formatShortcut(item.shortcut, 'other');
        expect(label.toLowerCase()).not.toContain('mod');
        if (item.shortcut.ctrlOrMeta === true) expect(label).toContain('Ctrl');
      }
    }
  });
});

describe('detectPlatform navigator classification (HB-2)', () => {
  const original = (globalThis as { navigator?: unknown }).navigator;

  function setNavigator(nav: unknown): void {
    Object.defineProperty(globalThis, 'navigator', {
      value: nav,
      configurable: true,
      writable: true,
    });
  }

  afterEach(() => {
    if (original === undefined) {
      delete (globalThis as { navigator?: unknown }).navigator;
    } else {
      setNavigator(original);
    }
  });

  it("returns 'other' when navigator is undefined (non-DOM context)", () => {
    delete (globalThis as { navigator?: unknown }).navigator;
    expect(detectPlatform()).toBe('other');
  });

  it("classifies Windows as 'other' (→ Ctrl)", () => {
    setNavigator({
      platform: 'Win32',
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
    });
    expect(detectPlatform()).toBe('other');
  });

  it("classifies Linux as 'other' (→ Ctrl)", () => {
    setNavigator({ platform: 'Linux x86_64', userAgent: 'Mozilla/5.0 (X11; Linux x86_64)' });
    expect(detectPlatform()).toBe('other');
  });

  it("classifies macOS as 'mac' via navigator.platform", () => {
    setNavigator({
      platform: 'MacIntel',
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
    });
    expect(detectPlatform()).toBe('mac');
  });

  it("classifies macOS as 'mac' via userAgentData.platform", () => {
    setNavigator({ userAgentData: { platform: 'macOS' }, platform: '', userAgent: '' });
    expect(detectPlatform()).toBe('mac');
  });
});

describe('Keymap resolve', () => {
  it('resolves a bound chord to its command id', () => {
    const km = new Keymap();
    km.bind({ key: 's', ctrlOrMeta: true }, COMMAND_ID.FileSave);
    expect(km.resolve(chord({ key: 's', ctrlOrMeta: true }))).toBe(COMMAND_ID.FileSave);
    expect(km.resolve(chord({ key: 's' }))).toBeUndefined();
  });
});

describe('default keymap mirrors the menu accelerators (教訓 5.33)', () => {
  it('every menu shortcut resolves back to its own command id', () => {
    const km = buildDefaultKeymap();
    for (const menu of STANDARD_MENUS) {
      for (const item of menu.items) {
        if (item.shortcut === undefined) continue;
        const c: KeyChord = {
          key: item.shortcut.key,
          ctrlOrMeta: item.shortcut.ctrlOrMeta ?? false,
          shift: item.shortcut.shift ?? false,
          alt: item.shortcut.alt ?? false,
        };
        expect(km.resolve(c)).toBe(item.commandId);
      }
    }
  });
});

describe('dispatchChord gating (受け入れ基準 7 / 9)', () => {
  it('an unbound chord passes through (Unbound)', () => {
    const km = new Keymap();
    const r = new CommandRegistry();
    expect(dispatchChord(chord({ key: 'q' }), km, r, EDIT_MODE.Edit)).toBe(
      DISPATCH_RESULT.Unbound,
    );
  });

  it('a bound but unregistered command is a safe no-op (Disabled)', () => {
    const km = buildDefaultKeymap();
    const r = new CommandRegistry();
    expect(
      dispatchChord(chord({ key: 's', ctrlOrMeta: true }), km, r, EDIT_MODE.Edit),
    ).toBe(DISPATCH_RESULT.Disabled);
  });

  it('an editing shortcut is Disabled in view-only mode even when registered (教訓 5.13)', () => {
    const km = buildDefaultKeymap();
    const r = new CommandRegistry();
    const run = vi.fn();
    r.register(COMMAND_ID.EditUndo, { run });
    expect(
      dispatchChord(chord({ key: 'z', ctrlOrMeta: true }), km, r, EDIT_MODE.View),
    ).toBe(DISPATCH_RESULT.Disabled);
    expect(run).not.toHaveBeenCalled();
  });

  it('an editing shortcut runs in an editable mode (Ran)', () => {
    const km = buildDefaultKeymap();
    const r = new CommandRegistry();
    const run = vi.fn();
    r.register(COMMAND_ID.EditUndo, { run });
    expect(
      dispatchChord(chord({ key: 'z', ctrlOrMeta: true }), km, r, EDIT_MODE.Edit),
    ).toBe(DISPATCH_RESULT.Ran);
    expect(run).toHaveBeenCalledTimes(1);
  });
});
