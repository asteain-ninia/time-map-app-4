// U20 pure-logic tests: standard menu structure (FR-111, 受け入れ基準 1).

import { describe, expect, it } from 'vitest';

import { isCommandId } from './commands';
import { MENU_KEY, STANDARD_MENUS } from './menu';
import { MIN_WINDOW_HEIGHT, MIN_WINDOW_WIDTH } from './window-config';

describe('STANDARD_MENUS (FR-111)', () => {
  it('has the five standard menus in order', () => {
    expect(STANDARD_MENUS.map((m) => m.key)).toEqual([
      MENU_KEY.File,
      MENU_KEY.Edit,
      MENU_KEY.View,
      MENU_KEY.Tools,
      MENU_KEY.Help,
    ]);
  });

  it('every item references a known command id and a non-empty label', () => {
    for (const menu of STANDARD_MENUS) {
      expect(menu.title.length).toBeGreaterThan(0);
      for (const item of menu.items) {
        expect(isCommandId(item.commandId)).toBe(true);
        expect(item.label.length).toBeGreaterThan(0);
      }
    }
  });

  it('command ids are unique across all menus', () => {
    const ids = STANDARD_MENUS.flatMap((m) => m.items.map((i) => i.commandId));
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('minimum window size contract (FR-114)', () => {
  it('is 800×600', () => {
    expect(MIN_WINDOW_WIDTH).toBe(800);
    expect(MIN_WINDOW_HEIGHT).toBe(600);
  });
});
