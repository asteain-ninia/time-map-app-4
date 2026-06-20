// U20 pure-logic tests: shortcut chord normalisation, resolve, dispatch gating
// (受け入れ基準 7 / 9; 教訓 5.13 / 5.33).

import { afterEach, describe, expect, it, vi } from 'vitest';

import { EDIT_MODE } from '../state/session';
import { COMMAND_ID, CommandRegistry, type CommandId } from './commands';
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

describe('no chord is bound to two different commands (HB-10 alias safety)', () => {
  it('every primary AND alias accelerator across the standard menus is collision-free', () => {
    const km = buildDefaultKeymap();
    const byChord = new Map<string, CommandId>();
    for (const menu of STANDARD_MENUS) {
      for (const it of menu.items) {
        const shortcuts = [
          ...(it.shortcut !== undefined ? [it.shortcut] : []),
          ...(it.extraShortcuts ?? []),
        ];
        for (const s of shortcuts) {
          const c: KeyChord = {
            key: s.key,
            ctrlOrMeta: s.ctrlOrMeta ?? false,
            shift: s.shift ?? false,
            alt: s.alt ?? false,
          };
          // The keymap resolves this chord back to THIS command (not silently
          // overridden by a later binding for the same chord).
          expect(km.resolve(c)).toBe(it.commandId);
          const chordKey = chordOf(s);
          const existing = byChord.get(chordKey);
          // Each chord maps to exactly one command id across the whole menu set.
          if (existing !== undefined) expect(existing).toBe(it.commandId);
          byChord.set(chordKey, it.commandId);
        }
      }
    }
  });
});

describe('redo accelerators (HB-10): Ctrl+Y is the default, Ctrl+Shift+Z is an alias', () => {
  it('Ctrl+Y resolves to edit.redo', () => {
    const km = buildDefaultKeymap();
    expect(km.resolve(chord({ key: 'y', ctrlOrMeta: true }))).toBe(COMMAND_ID.EditRedo);
  });

  it('Ctrl+Shift+Z still resolves to edit.redo (alias kept)', () => {
    const km = buildDefaultKeymap();
    expect(km.resolve(chord({ key: 'z', ctrlOrMeta: true, shift: true }))).toBe(
      COMMAND_ID.EditRedo,
    );
  });

  it('the redo menu item advertises Ctrl+Y as its primary accelerator', () => {
    const edit = STANDARD_MENUS.find((m) => m.key === 'edit');
    const redo = edit?.items.find((it) => it.commandId === COMMAND_ID.EditRedo);
    expect(redo?.shortcut).toEqual({ key: 'y', ctrlOrMeta: true });
    expect(formatShortcut(redo!.shortcut!, 'other')).toBe('Ctrl+Y');
  });

  it('both redo accelerators dispatch the registered redo handler (Ran)', () => {
    const km = buildDefaultKeymap();
    const r = new CommandRegistry();
    const run = vi.fn();
    r.register(COMMAND_ID.EditRedo, { run });
    expect(
      dispatchChord(chord({ key: 'y', ctrlOrMeta: true }), km, r, EDIT_MODE.Edit),
    ).toBe(DISPATCH_RESULT.Ran);
    expect(
      dispatchChord(chord({ key: 'z', ctrlOrMeta: true, shift: true }), km, r, EDIT_MODE.Edit),
    ).toBe(DISPATCH_RESULT.Ran);
    expect(run).toHaveBeenCalledTimes(2);
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
