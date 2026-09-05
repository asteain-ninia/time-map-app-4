// 素性欄の寸法契約を CSS の実物で固定する（実装計画 増分 2 の中身 1d・5 / 設計書 §C.6）。
//
// **なぜ CSS を直接読むのか**: jsdom はレイアウトを計算しないので、`getBoundingClientRect()`
// は常に 0 を返す。コンポーネントテストで「保存ボタンが見えている」「行が 28px」を px で
// 測ると、中身が何であっても一致して **必ず緑になる**（開発ガイド §5.49）。そこで
// `shell/shell-layout.test.ts` と同じ作法で、寸法ロジックの単一真実源である CSS の宣言
// そのものを読む。実寸での検査は E2E（`e2e/sidebar-property.spec.ts`）が担う。
//
// ここが赤くなるのは次のときで、どれも実機で静かに壊れる種類である。
//   ① 保存列が最下段でなくなった ⇒ 保存ボタンがまた初期表示の外へ落ちる（BH1-03）。
//   ② 見出しが最上段でなくなった ⇒ スクロールすると「いま何年か」が消える。
//   ①' 見出し・本文・保存列の 3 段が崩れた（重ねる作りへ戻った）⇒ 保存列が育つ年に
//       本文が固定部品の下へ潜って **押せなくなる**（教訓 5.61 の再々発）。
//   ③ 錨表の行の高さが可変になった ⇒ 仮想スクロールの計算が成り立たなくなる。
//   ④ 行の高さの数字が CSS と TypeScript でずれた ⇒ 見えている行数がずれ、DOM 行数が増える。

import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { ANCHOR_ROW_HEIGHT } from './AnchorList';
import { readSourceText } from '../../test-support/read-source-text';

// 改行は `readSourceText` が LF に揃える（CRLF のチェックアウトで規則の照合が外れないように）。
const here = dirname(fileURLToPath(import.meta.url));
const css = readSourceText(resolve(here, 'property.css'));

/** セレクタが完全一致する最初の規則の本体を取り出す（shell-layout.test.ts と同じ作法）。 */
function ruleBody(selector: string): string {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(?:^|[}/])\\s*${esc}\\s*\\{([^}]*)\\}`);
  const m = re.exec(css);
  if (m === null) throw new Error(`CSS rule not found: ${selector}`);
  return m[1] ?? '';
}

/** 規則本体から `prop: value;` を 1 つ読む（空白は正規化）。 */
function decl(body: string, prop: string): string | undefined {
  const re = new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]+)`);
  const m = re.exec(body);
  return m === null ? undefined : (m[1] ?? '').trim().replace(/\s+/g, ' ');
}

// **2026-09-06（2 回目の手直し）: 重ねる作りをやめた。**
//
// 見出しを `sticky; top`、保存列を `sticky; bottom` にして中身の上に重ねる作りは、
// 器が低いか固定部品が育つと **あいだの帯が痩せて、中身が押せなくなる**。実測（1280×800、
// 錨のない 1500 年）で、器 198px・見出し 55px・保存列 103px・帯 **20px** となり、26px の
// 名前欄がどのスクロール位置でもマウスで押せなかった（教訓 5.61 の再々発）。
//
// いまは「見出し／本文／保存列」を **重ねずに縦へ並べ**、本文だけが残りを取ってスクロール
// する。保存列がいくら育っても、育ったぶん本文が縮むだけで、中身は必ず本文の中に出る。
describe('素性欄は「見出し／本文／保存列」の 3 段で、重ならない（教訓 5.61）', () => {
  const panel = ruleBody('.property-panel');
  const head = ruleBody('.property-panel__head');
  const body = ruleBody('.property-panel__body');
  const bar = ruleBody('.property-panel__save-bar');

  it('入れ物は縦の flex で、区画の高さいっぱいに広がる', () => {
    expect(decl(panel, 'display')).toBe('flex');
    expect(decl(panel, 'flex-direction')).toBe('column');
    expect(decl(panel, 'height')).toBe('100%');
    // flex の子として縮めるようにしておく（教訓 5.50）。
    expect(decl(panel, 'min-height')).toBe('0');
  });

  it('見出しと保存列は場所を取る側（伸び縮みしない）で、重ねない', () => {
    expect(decl(head, 'flex')).toBe('0 0 auto');
    expect(decl(bar, 'flex')).toBe('0 0 auto');
    // **`position: sticky` へ戻っていないこと**が、この検査のいちばんの目的である。
    expect(decl(head, 'position')).toBeUndefined();
    expect(decl(bar, 'position')).toBeUndefined();
  });

  it('スクロールするのは本文だけ（残りの高さを受け取る）', () => {
    expect(decl(body, 'flex')).toBe('1 1 auto');
    expect(decl(body, 'min-height')).toBe('0');
    expect(decl(body, 'overflow-y')).toBe('auto');
    // 横には伸びない（長い文で枠が広がると地図まで動く、教訓 5.50）。
    expect(decl(body, 'overflow-x')).toBe('hidden');
  });

  it('見出しと保存列は背景を塗る（下の中身が透けない）', () => {
    expect(decl(head, 'background')).toBeDefined();
    expect(decl(bar, 'background')).toBeDefined();
  });

  it('中身の下の「遊び」は要らなくなった（重ねていないので）', () => {
    // 重ねる作りのときは、保存列の下から中身を出すために `::after` で 96px の遊びを
    // 入れていた。3 段にしたら不要で、残すと本文の末尾に空白が居座る。
    expect(css).not.toContain('.property-panel::after');
  });
});

describe('見出しと編集時刻バッジ（設計書 §C.6）', () => {
  it('バッジの高さは固定（行き先が変わっても寸法が動かない）', () => {
    // 中身で高さが動くと下のフォームが上下に跳ねる（K-3 と同じ型の事故）。
    const badge = ruleBody('.property-panel__badge');
    expect(decl(badge, 'height')).toBe('22px');
    expect(decl(badge, 'overflow')).toBe('hidden');
  });

  it('長い説明文が枠を押し広げない（min-width: 0 を忘れない、教訓 5.50）', () => {
    const note = ruleBody('.property-panel__badge-note');
    expect(decl(note, 'min-width')).toBe('0');
    expect(decl(note, 'overflow')).toBe('hidden');
  });
});

describe('錨表の行は 28px 固定で、仮想スクロールが成り立つ（中身 5 / 設計書 §C.6）', () => {
  it('行の高さが CSS で固定されている', () => {
    expect(decl(ruleBody('.anchor-list__row'), 'height')).toBe('28px');
    expect(decl(ruleBody('.anchor-list__item'), 'height')).toBe('28px');
  });

  it('CSS の行の高さと、TypeScript が計算に使う値が同じ', () => {
    // **2 か所に同じ数字がある**状態なので、ずれたら静かに壊れる（見えている行数の
    // 計算が狂い、DOM 行数が増えるか、スクロールが飛ぶ）。ここが唯一の突き合わせ。
    expect(decl(ruleBody('.anchor-list__row'), 'height')).toBe(`${String(ANCHOR_ROW_HEIGHT)}px`);
  });

  it('一覧そのものが縦にスクロールする器である', () => {
    const list = ruleBody('.anchor-list');
    expect(decl(list, 'overflow-y')).toBe('auto');
    // 横には伸びない（長い差分の文で枠が広がると地図まで動く、教訓 5.50）。
    expect(decl(list, 'overflow-x')).toBe('hidden');
  });

  it('差分の文は枠を押し広げない', () => {
    const diff = ruleBody('.anchor-list__diff');
    expect(decl(diff, 'min-width')).toBe('0');
    expect(decl(diff, 'overflow')).toBe('hidden');
    expect(decl(diff, 'white-space')).toBe('nowrap');
  });
});
