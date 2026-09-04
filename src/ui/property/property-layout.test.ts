// 素性欄の寸法契約を CSS の実物で固定する（実装計画 増分 2 の中身 1d・5 / 設計書 §C.6）。
//
// **なぜ CSS を直接読むのか**: jsdom はレイアウトを計算しないので、`getBoundingClientRect()`
// は常に 0 を返す。コンポーネントテストで「保存ボタンが見えている」「行が 28px」を px で
// 測ると、中身が何であっても一致して **必ず緑になる**（開発ガイド §5.49）。そこで
// `shell/shell-layout.test.ts` と同じ作法で、寸法ロジックの単一真実源である CSS の宣言
// そのものを読む。実寸での検査は E2E（`e2e/sidebar-property.spec.ts`）が担う。
//
// ここが赤くなるのは次のときで、どれも実機で静かに壊れる種類である。
//   ① 保存列の下端固定（sticky）が外れた ⇒ 保存ボタンがまた初期表示の外へ落ちる（BH1-03）。
//   ② 見出し＋編集時刻バッジの上端固定が外れた ⇒ スクロールすると「いま何年か」が消える。
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

describe('保存列は素性欄の下端に固定される（中身 1d / C7 / BH1-03）', () => {
  const body = ruleBody('.property-panel__save-bar');

  it('sticky で下端に貼り付く', () => {
    expect(decl(body, 'position')).toBe('sticky');
    expect(decl(body, 'bottom')).toBe('0');
  });

  it('下の中身が透けない（背景を必ず塗る）', () => {
    // 背景が無いと、スクロールした中身が保存ボタンの裏を通って読めなくなる。
    expect(decl(body, 'background')).toBeDefined();
  });

  it('中身より前面にいる', () => {
    expect(Number(decl(body, 'z-index'))).toBeGreaterThan(0);
  });
});

describe('見出しと編集時刻バッジは上端に固定される（設計書 §C.6）', () => {
  const head = ruleBody('.property-panel__head');

  it('sticky で上端に貼り付き、背景を塗る', () => {
    expect(decl(head, 'position')).toBe('sticky');
    expect(decl(head, 'top')).toBe('0');
    expect(decl(head, 'background')).toBeDefined();
  });

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
