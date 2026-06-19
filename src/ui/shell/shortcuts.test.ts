// U20 pure-logic tests: shortcut chord normalisation, resolve, dispatch gating
// (受け入れ基準 7 / 9; 教訓 5.13 / 5.33).

import { describe, expect, it, vi } from 'vitest';

import { EDIT_MODE } from '../state/session';
import { COMMAND_ID, CommandRegistry } from './commands';
import { STANDARD_MENUS } from './menu';
import { buildDefaultKeymap } from './default-keymap';
import {
  DISPATCH_RESULT,
  Keymap,
  chordOf,
  dispatchChord,
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
