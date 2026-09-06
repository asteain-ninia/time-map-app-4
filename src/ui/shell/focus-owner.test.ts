// 鍵盤の持ち主（`focusOwner`）の導出と、そこから決まる「何が通るか」（設計書 §D.1 / §D.4）。
//
// 旧実装は 11 項目を手で OR した 1 つの真偽値だったので、**足すたびに 3 か所を同時に
// 直す必要があり、実際に穴が空いていた**（道具を選んだだけで Ctrl+Z・Delete・Escape・
// 右クリックが全部止まる）。ここで固定するのは 2 つ:
//   1. **順序**（いちばん前にあるものが持つ）。同時に開いていても迷わない。
//   2. **持ち主ごとの可否の表**。特に「右クリックはダイアログのときだけ止まる」。

import { describe, expect, it } from 'vitest';

import {
  FOCUS_OWNER,
  deriveFocusOwner,
  explainsRefusal,
  suspendsContextMenu,
  suspendsShortcuts,
  type FocusOwner,
} from './focus-owner';

const NOTHING = {
  modalOpen: false,
  popoverOpen: false,
  textFocused: false,
  toolDrawing: false,
} as const;

describe('鍵盤の持ち主の導出（設計書 §D.1）', () => {
  it('何も開いていなければ地図が持つ', () => {
    expect(deriveFocusOwner(NOTHING)).toBe(FOCUS_OWNER.Map);
  });

  it('地図が載る前は none（map と区別する）', () => {
    expect(deriveFocusOwner({ ...NOTHING, mapReady: false })).toBe(FOCUS_OWNER.None);
  });

  it('いちばん前にあるものが持つ（同時に開いていても迷わない）', () => {
    // 全部開いている → モーダル。旧版はここが手書きの OR なので、順序は
    // 「たまたま先に書いた条件」で決まっていた。
    const all = {
      modalOpen: true,
      popoverOpen: true,
      textFocused: true,
      toolDrawing: true,
    };
    expect(deriveFocusOwner(all)).toBe(FOCUS_OWNER.Modal);
    expect(deriveFocusOwner({ ...all, modalOpen: false })).toBe(FOCUS_OWNER.Popover);
    expect(deriveFocusOwner({ ...all, modalOpen: false, popoverOpen: false })).toBe(
      FOCUS_OWNER.Text,
    );
    expect(
      deriveFocusOwner({
        ...all,
        modalOpen: false,
        popoverOpen: false,
        textFocused: false,
      }),
    ).toBe(FOCUS_OWNER.ToolDrawing);
  });
});

describe('持ち主ごとに何が通るか（設計書 §D.4 の表）', () => {
  const ALL_OWNERS: readonly FocusOwner[] = [
    FOCUS_OWNER.Modal,
    FOCUS_OWNER.Popover,
    FOCUS_OWNER.Text,
    FOCUS_OWNER.ToolDrawing,
    FOCUS_OWNER.Map,
    FOCUS_OWNER.None,
  ];

  it('大域の打鍵はモーダル・ポップオーバー・下書きのときだけ降りる', () => {
    expect(suspendsShortcuts(FOCUS_OWNER.Modal)).toBe(true);
    expect(suspendsShortcuts(FOCUS_OWNER.Popover)).toBe(true);
    expect(suspendsShortcuts(FOCUS_OWNER.ToolDrawing)).toBe(true);
    // 文字入力は `focus-guard` が担当する（ここで二重に止めると、打ちかけの無い欄で
    // Ctrl+Z を通す増分 4 の緩和が効かなくなる）。
    expect(suspendsShortcuts(FOCUS_OWNER.Text)).toBe(false);
    expect(suspendsShortcuts(FOCUS_OWNER.Map)).toBe(false);
    expect(suspendsShortcuts(FOCUS_OWNER.None)).toBe(false);
  });

  it('**右クリックはダイアログのときだけ止まる**（道具を持っていても開ける）', () => {
    // 設計書 §I.3 の原則①。旧版は打鍵と同じ 1 本の真偽値を使い回していたので、
    // 道具を構えているあいだ右クリックが死んでいた。
    for (const owner of ALL_OWNERS) {
      expect(suspendsContextMenu(owner), owner).toBe(owner === FOCUS_OWNER.Modal);
    }
  });

  it('断り文を出すのはダイアログのときだけ（道具のときは本当に効いている）', () => {
    for (const owner of ALL_OWNERS) {
      expect(explainsRefusal(owner), owner).toBe(owner === FOCUS_OWNER.Modal);
    }
  });

  it('確定した直後は地図が持つ ＝ Ctrl+Z が必ず効く（設計書 §D.4）', () => {
    // 確定すると下書きは空になり、板も閉じる。**「道具を構えたまま」でも持ち主は
    // 地図に戻る**のがこの設計の要点で、旧版は「道具を構えている」だけで降りていた。
    const afterCommit = { ...NOTHING, toolDrawing: false };
    expect(deriveFocusOwner(afterCommit)).toBe(FOCUS_OWNER.Map);
    expect(suspendsShortcuts(deriveFocusOwner(afterCommit))).toBe(false);
  });
});
