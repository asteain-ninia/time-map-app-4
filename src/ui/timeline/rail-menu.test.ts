// 時刻レールの右クリックの中身（設計書 §I.3 / 増分 7 の手直し 項目 6）の可否と理由を固定する。

import { describe, expect, it } from 'vitest';

import { RAIL_MENU_ITEM, composeRailMenu } from './rail-menu';
import { RAIL_STRINGS } from './rail-strings';

function ids(items: ReturnType<typeof composeRailMenu>): string[] {
  return items.map((i) => i.id);
}

describe('composeRailMenu — 錨の印の上', () => {
  it('自分の系列の錨: 移動・開始年を変える・消す が並び、全部押せる', () => {
    const items = composeRailMenu({
      kind: 'anchor',
      editable: true,
      inheritedOwner: null,
      soleAnchor: false,
    });
    expect(ids(items)).toEqual([
      RAIL_MENU_ITEM.JumpToAnchor,
      RAIL_MENU_ITEM.ChangeAnchorStart,
      RAIL_MENU_ITEM.DeleteAnchor,
    ]);
    expect(items.every((i) => i.enabled)).toBe(true);
  });

  it('最後の 1 本は消せない（理由つき）が、開始年は変えられる', () => {
    const items = composeRailMenu({
      kind: 'anchor',
      editable: true,
      inheritedOwner: null,
      soleAnchor: true,
    });
    const del = items.find((i) => i.id === RAIL_MENU_ITEM.DeleteAnchor)!;
    expect(del.enabled).toBe(false);
    expect(del.reason).toBe(RAIL_STRINGS.menuReasonSoleAnchor);
    expect(items.find((i) => i.id === RAIL_MENU_ITEM.ChangeAnchorStart)!.enabled).toBe(true);
  });

  it('上位領域から借りた印は、移動だけ押せて、直す項目は持ち主の名前つきの理由で灰色', () => {
    const items = composeRailMenu({
      kind: 'anchor',
      editable: true,
      inheritedOwner: 'デーレ共和国',
      soleAnchor: false,
    });
    expect(items.find((i) => i.id === RAIL_MENU_ITEM.JumpToAnchor)!.enabled).toBe(true);
    for (const id of [RAIL_MENU_ITEM.ChangeAnchorStart, RAIL_MENU_ITEM.DeleteAnchor]) {
      const it_ = items.find((i) => i.id === id)!;
      expect(it_.enabled).toBe(false);
      expect(it_.reason).toContain('デーレ共和国');
    }
  });

  it('読むだけのあいだは直す項目が灰色（移動は押せる）', () => {
    const items = composeRailMenu({
      kind: 'anchor',
      editable: false,
      inheritedOwner: null,
      soleAnchor: false,
    });
    expect(items.filter((i) => i.enabled).map((i) => i.id)).toEqual([RAIL_MENU_ITEM.JumpToAnchor]);
    expect(items.find((i) => i.id === RAIL_MENU_ITEM.DeleteAnchor)!.reason).toBe(
      RAIL_STRINGS.menuReasonViewOnly,
    );
  });
});

describe('composeRailMenu — 空白', () => {
  it('移動・錨を作る・左端にする・全体表示 の 4 つ', () => {
    const items = composeRailMenu({
      kind: 'empty',
      editable: true,
      hasSelection: true,
      anchorAtYear: false,
    });
    expect(ids(items)).toEqual([
      RAIL_MENU_ITEM.JumpHere,
      RAIL_MENU_ITEM.CreateAnchorHere,
      RAIL_MENU_ITEM.MakeLeftEdge,
      RAIL_MENU_ITEM.FitAll,
    ]);
    expect(items.every((i) => i.enabled)).toBe(true);
  });

  it.each([
    [{ editable: false, hasSelection: true, anchorAtYear: false }, RAIL_STRINGS.menuReasonViewOnly],
    [{ editable: true, hasSelection: false, anchorAtYear: false }, RAIL_STRINGS.menuReasonNoSelection],
    [{ editable: true, hasSelection: true, anchorAtYear: true }, RAIL_STRINGS.menuReasonAnchorExists],
  ])('「この年に錨を作る」が押せない局面は理由を言う（%o）', (facts, reason) => {
    const items = composeRailMenu({ kind: 'empty', ...facts });
    const create = items.find((i) => i.id === RAIL_MENU_ITEM.CreateAnchorHere)!;
    expect(create.enabled).toBe(false);
    expect(create.reason).toBe(reason);
    // 見る側の 3 つは局面に依らず押せる。
    expect(items.filter((i) => i.id !== RAIL_MENU_ITEM.CreateAnchorHere).every((i) => i.enabled)).toBe(
      true,
    );
  });
});
