// U20 pure-logic tests: the keyboard focus-target guard (バグハント第10波 #1/#4).
//
// A window-level keydown dispatcher must STAND DOWN when a text-editing element
// owns the focus — otherwise Delete/Backspace deletes the selected feature's
// anchors and Ctrl+Z/Ctrl+Y fire domain undo/redo instead of native input
// editing. `isEditableTarget` is the pure predicate; it is DOM-free (takes a
// minimal descriptor) so it is unit-tested without a document (教訓 5.41).

import { describe, expect, it } from 'vitest';

import {
  blocksGlobalShortcuts,
  consumesSpaceNatively,
  isEditableTarget,
  type EditableTargetDescriptor,
} from './focus-guard';

function target(over: Partial<EditableTargetDescriptor>): EditableTargetDescriptor {
  return { tagName: 'DIV', inputType: null, isContentEditable: false, pristine: false, ...over };
}

describe('isEditableTarget (focus guard for global shortcuts)', () => {
  it('treats a plain <input> (default text) as editable', () => {
    expect(isEditableTarget(target({ tagName: 'INPUT', inputType: null }))).toBe(true);
  });

  it('treats text-family <input> types as editable', () => {
    for (const inputType of ['text', 'number', 'search', 'url', 'email', 'tel', 'password']) {
      expect(isEditableTarget(target({ tagName: 'INPUT', inputType }))).toBe(true);
    }
  });

  it('is case-insensitive on the input type', () => {
    expect(isEditableTarget(target({ tagName: 'INPUT', inputType: 'TEXT' }))).toBe(true);
    expect(isEditableTarget(target({ tagName: 'INPUT', inputType: 'Number' }))).toBe(true);
  });

  it('treats <textarea> and <select> as editable', () => {
    expect(isEditableTarget(target({ tagName: 'TEXTAREA' }))).toBe(true);
    expect(isEditableTarget(target({ tagName: 'SELECT' }))).toBe(true);
  });

  it('treats a contenteditable element as editable regardless of tag', () => {
    expect(isEditableTarget(target({ tagName: 'DIV', isContentEditable: true }))).toBe(true);
    expect(isEditableTarget(target({ tagName: 'SPAN', isContentEditable: true }))).toBe(true);
  });

  it('does NOT treat non-text <input> types as editable (range/checkbox/radio/button)', () => {
    for (const inputType of ['range', 'checkbox', 'radio', 'button', 'submit', 'color']) {
      expect(isEditableTarget(target({ tagName: 'INPUT', inputType }))).toBe(false);
    }
  });

  it('does NOT treat ordinary elements as editable', () => {
    expect(isEditableTarget(target({ tagName: 'DIV' }))).toBe(false);
    expect(isEditableTarget(target({ tagName: 'BUTTON' }))).toBe(false);
    expect(isEditableTarget(target({ tagName: 'BODY' }))).toBe(false);
  });

  it('treats a null / missing descriptor as NOT editable (no focus context)', () => {
    expect(isEditableTarget(null)).toBe(false);
  });
});

// --- A4: 「文字を編集できるか」と「大域の打鍵を遮るか」は **別の問い** -----------
//
// 増分 5 の手直し A4 / 設計書 §D.4。つまみ（`input[type=range]`）は矢印・Home / End・
// PageUp / PageDown を **自分で使う**が、文字は打たない。だから
// {@link isEditableTarget}（native の文字編集を邪魔しないための問い）では偽のまま、
// {@link blocksGlobalShortcuts}（この control が鍵盤を使っているかの問い）では真に
// ならなければならない ―― 偽のままだと、深さ・不透明度・経度シフトのつまみを触って
// いるつもりで Delete が背後の地物を消す。
//
// 2 つの述語が別物であることが読める形にするため、**同じ表の同じ行で両方の答えを
// 並べて**確かめる（片方だけの表を 2 つ作ると、ずれても気づけない）。

/** 表の 1 行: 焦点の当たっている要素と、2 つの述語それぞれの期待。 */
interface GuardRow {
  /** 何に焦点があるか（読んで分かる名前。画面の文言ではない）。 */
  readonly name: string;
  readonly target: EditableTargetDescriptor | null;
  /** 文字を編集できるか（native の編集を邪魔しないための問い）。 */
  readonly editable: boolean;
  /** 大域の割り振りを遮るか（この control が鍵盤を使っているかの問い）。 */
  readonly blocks: boolean;
}

const GUARD_TABLE: readonly GuardRow[] = [
  { name: 'input[type=text]', target: target({ tagName: 'INPUT', inputType: 'text' }), editable: true, blocks: true },
  { name: 'input[type=number]', target: target({ tagName: 'INPUT', inputType: 'number' }), editable: true, blocks: true },
  { name: 'textarea', target: target({ tagName: 'TEXTAREA' }), editable: true, blocks: true },
  { name: 'select', target: target({ tagName: 'SELECT' }), editable: true, blocks: true },
  {
    name: 'contenteditable な div',
    target: target({ tagName: 'DIV', isContentEditable: true }),
    editable: true,
    blocks: true,
  },
  // **ここが A4 の穴そのもの**: 文字は打たないが鍵盤は使う。2 つの答えが割れる唯一の行。
  { name: 'input[type=range]（つまみ）', target: target({ tagName: 'INPUT', inputType: 'range' }), editable: false, blocks: true },
  { name: 'input[type=checkbox]', target: target({ tagName: 'INPUT', inputType: 'checkbox' }), editable: false, blocks: false },
  { name: 'button', target: target({ tagName: 'BUTTON' }), editable: false, blocks: false },
  { name: 'div', target: target({ tagName: 'DIV' }), editable: false, blocks: false },
  { name: '焦点なし (null)', target: null, editable: false, blocks: false },
];

describe('blocksGlobalShortcuts vs isEditableTarget（A4: 2 つの別々の問い）', () => {
  for (const row of GUARD_TABLE) {
    it(`${row.name}: 文字編集=${String(row.editable)} / 大域を遮る=${String(row.blocks)}`, () => {
      expect({
        editable: isEditableTarget(row.target),
        blocks: blocksGlobalShortcuts(row.target),
      }).toEqual({ editable: row.editable, blocks: row.blocks });
    });
  }

  it('つまみだけが 2 つの答えを違えている（表の中で「別物」が 1 行だけ立つ）', () => {
    // 表を作り直したときに「両方とも真」へ寄せてしまうと（＝つまみを文字の欄扱いに
    // すると）ここが落ちる。A4 の要点は「同じにしない」ことなので、**違いが残って
    // いること自体**を 1 つの検査にしておく。
    const split = GUARD_TABLE.filter((r) => isEditableTarget(r.target) !== blocksGlobalShortcuts(r.target));
    expect(split.map((r) => r.name)).toEqual(['input[type=range]（つまみ）']);
  });

  it('大文字の type でも遮る（type は大小を区別しない）', () => {
    expect(blocksGlobalShortcuts(target({ tagName: 'INPUT', inputType: 'RANGE' }))).toBe(true);
  });

  it('INPUT 以外のタグは、type の見かけがどうであれ遮らない', () => {
    // `inputType` は INPUT のときしか意味を持たない。DIV に range を持たせても遮らない。
    expect(blocksGlobalShortcuts(target({ tagName: 'DIV', inputType: 'range' }))).toBe(false);
  });
});

describe('consumesSpaceNatively（増分 6: Space ＝ 再生／一時停止）', () => {
  // 焦点のあるボタンは空白で **自分が押される**。そこへ大域の再生を重ねると、
  // 1 回の空白で 2 つ起きる。止める理由は「その control が空白を使う」ことなので、
  // 打鍵の入口 1 か所で見る（教訓 5.75）。
  it('ボタン・リンク・summary は空白を自分で使う', () => {
    expect(consumesSpaceNatively(target({ tagName: 'BUTTON' }))).toBe(true);
    expect(consumesSpaceNatively(target({ tagName: 'A' }))).toBe(true);
    expect(consumesSpaceNatively(target({ tagName: 'SUMMARY' }))).toBe(true);
  });

  it('チェックボックス・ラジオ・ボタン型の input も同じ', () => {
    for (const type of ['button', 'submit', 'reset', 'checkbox', 'radio', 'file', 'color']) {
      expect(
        consumesSpaceNatively(target({ tagName: 'INPUT', inputType: type })),
        type,
      ).toBe(true);
    }
  });

  it('地図・つまみ・文字の欄は「空白を使う control」ではない', () => {
    // つまみと文字の欄は別の述語（blocksGlobalShortcuts）が先に止める。
    expect(consumesSpaceNatively(target({ tagName: 'DIV' }))).toBe(false);
    expect(consumesSpaceNatively(target({ tagName: 'CANVAS' }))).toBe(false);
    expect(consumesSpaceNatively(target({ tagName: 'INPUT', inputType: 'range' }))).toBe(false);
    expect(consumesSpaceNatively(target({ tagName: 'INPUT', inputType: 'text' }))).toBe(false);
    expect(consumesSpaceNatively(null)).toBe(false);
  });
});
