// U20 pure-logic tests: standard menu structure (FR-111, 受け入れ基準 1).

import { describe, expect, it } from 'vitest';

import { isCommandId } from './commands';
import { MENU_KEY, STANDARD_MENUS } from './menu';
import { TOOLTIPS } from './strings';
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

describe('メニュー項目には説明文がある（2026-09-06、2 回目の手直し）', () => {
  // `MenuBar` は `TOOLTIPS[id] ?? it.label` なので、説明文の無い項目はラベルがそのまま
  // 吹き出しになる ―― **見た目は破綻しないので気づけない**。増分 2〜4 で足した 6 項目が
  // そのまま説明無しで出ていた。網羅は機械に見張らせる。
  it('すべてのメニュー項目が TOOLTIPS に載っている', () => {
    const missing: string[] = [];
    for (const menu of STANDARD_MENUS) {
      for (const item of menu.items) {
        if (TOOLTIPS[item.commandId] === undefined) missing.push(item.commandId);
      }
    }
    expect(missing).toEqual([]);
  });

  it('説明文はラベルの写しではない（説明になっている）', () => {
    for (const menu of STANDARD_MENUS) {
      for (const item of menu.items) {
        expect(TOOLTIPS[item.commandId]).not.toBe(item.label);
      }
    }
  });
});
