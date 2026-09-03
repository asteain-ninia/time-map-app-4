// オプションバーの寸法契約（K-3 / 設計書 §B.4）を CSS の実物で固定する。
//
// **なぜ CSS を直接読むのか**: K-3 が守りたいのは「選択のたびに帯の寸法が動いて地図が上下に
// ずれない」こと。ところが jsdom はレイアウトを持たず `getBoundingClientRect()` が常に
// 0 を返すので、コンポーネントテストで px を測ると中身が何であっても一致し、**常に緑の
// テスト**になる（設計書 §O の B-13 が指摘した失敗の型そのもの）。そこで
// `add/add-input-layout.test.tsx` と同じ作法で、寸法ロジックの単一真実源である CSS の
// 宣言そのものを読む。実寸での検査は E2E（`e2e/option-bar.spec.ts`）が担う。
//
// ここが赤くなるのは「固定幅の枠に入れて中身だけ差し替える」という守り方が崩れたときで、
// 具体的には ①行の高さが可変になった ②`flex-wrap` が復活した ③区画が伸縮するように
// なった ④`overflow: hidden` が外れて中身が枠を押し広げられるようになった、の 4 つ。

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const shellCss = readFileSync(resolve(here, 'shell.css'), 'utf8');

/**
 * セレクタ（またはセレクタ列の先頭）が完全一致する最初の規則の本体 `{ ... }` を取り出す。
 *
 * **直前が `}` かコメントの閉じ `/` か文字列先頭であることを要求する。** 行頭を許すと、
 * 複数セレクタを並べた規則の **最後の行**（`… ,\n.option-bar__commit {`）にも当たってしまい、
 * 別の規則の本体を読んで「宣言が無い」と誤判定する（実際に一度これで落とした）。
 */
function ruleBody(selector: string): string {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(?:^|[}/])\\s*${esc}\\s*\\{([^}]*)\\}`);
  const m = re.exec(shellCss);
  if (m === null) throw new Error(`CSS rule not found: ${selector}`);
  return m[1] ?? '';
}

/** 規則本体から `prop: value;` を 1 つ読む（空白は正規化）。 */
function decl(body: string, prop: string): string | undefined {
  const re = new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]+?)\\s*(?:;|$)`, 'm');
  const m = re.exec(body);
  return m ? m[1]?.replace(/\s+/g, ' ').trim() : undefined;
}

describe('オプションバーの寸法契約（K-3, 設計書 §C.4 / §B.4）', () => {
  it('行は 40px 固定・折り返さない・はみ出さない', () => {
    const bar = ruleBody('.option-bar');
    expect(decl(bar, 'display')).toBe('flex');
    // 高さが固定でないと、中身が増えた瞬間に地図の上端が下がる（§1.3 の事故）。
    expect(decl(bar, 'height')).toBe('40px');
    expect(decl(bar, 'box-sizing')).toBe('border-box');
    // 窓幅で折り返すと段数が変わり、やはり地図の上端が動く。
    expect(decl(bar, 'flex-wrap')).toBe('nowrap');
    expect(decl(bar, 'overflow')).toBe('hidden');
  });

  it('固定幅の 3 区画は中身の有無で外寸が変わり得ない（対象欄は 0 件でも 240px）', () => {
    expect(decl(ruleBody('.option-bar__tool'), 'flex')).toBe('0 0 112px');
    expect(decl(ruleBody('.option-bar__target'), 'flex')).toBe('0 0 240px');
    expect(decl(ruleBody('.option-bar__commit'), 'flex')).toBe('0 0 176px');
  });

  it('伸縮するのは「次の一手」と「設定」だけで、どちらも縮みきれる', () => {
    expect(decl(ruleBody('.option-bar__next'), 'flex')).toBe('1 1 auto');
    // 設定欄は中身の量で決まるが、伸びて他を押し出すことはない（0 1 auto）。
    expect(decl(ruleBody('.option-bar__settings'), 'flex')).toBe('0 1 auto');
  });

  it('5 区画すべてが min-width:0 + overflow:hidden（中身が枠を押し広げられない）', () => {
    const shared = ruleBody(
      '.option-bar__tool,\n.option-bar__target,\n.option-bar__next,\n.option-bar__settings,\n.option-bar__commit',
    );
    expect(decl(shared, 'min-width')).toBe('0');
    expect(decl(shared, 'overflow')).toBe('hidden');
    expect(decl(shared, 'white-space')).toBe('nowrap');
    expect(decl(shared, 'height')).toBe('100%');
  });

  it('確定ボタンは U-8 の下限（高さ 30px・幅 60px）を満たす', () => {
    const button = ruleBody('.option-bar__commit-button');
    expect(decl(button, 'min-height')).toBe('30px');
    expect(decl(button, 'min-width')).toBe('60px');
  });
});

describe('シェルの行割り（オプションバーは地図セルの外のシェル行, K-4 / 結合点 #1）', () => {
  it('.app-shell は 5 行（メニュー / オプションバー / 主行 / 時刻レール / 状態行）', () => {
    expect(decl(ruleBody('.app-shell'), 'grid-template-rows')).toBe('auto auto 1fr auto auto');
  });

  it('列は minmax(0, 1fr) — 行の中身が列幅（＝地図セルの幅）に効かない', () => {
    // `1fr` のままだと、折り返さない長い文字を持つ行が 1 本あるだけで列が窓幅を超えて
    // 広がり、地図セルまで一緒に広がる（実測: 940px → 2,254px、上端 y も 121 → 72）。
    // K-3 の機械検査（e2e/option-bar.spec.ts）が実際にこれを捕まえた。
    expect(decl(ruleBody('.app-shell'), 'grid-template-columns')).toBe('minmax(0, 1fr)');
    const optionRow = ruleBody('.app-shell__optionbar');
    expect(decl(optionRow, 'min-width')).toBe('0');
    expect(decl(optionRow, 'overflow')).toBe('hidden');
  });

  it('行番号がずれていない（オプションバーは 2 行目、地図の主行は 3 行目）', () => {
    expect(decl(ruleBody('.app-shell__menubar'), 'grid-row')).toBe('1');
    expect(decl(ruleBody('.app-shell__optionbar'), 'grid-row')).toBe('2');
    expect(decl(ruleBody('.app-shell__main'), 'grid-row')).toBe('3');
    expect(decl(ruleBody('.app-shell__timeline'), 'grid-row')).toBe('4');
    expect(decl(ruleBody('.app-shell__statusbar'), 'grid-row')).toBe('5');
  });

  it('地図セルの中の入れ子は触っていない（T-3 の取り付け先が生きている）', () => {
    // `.map-area` の中は canvas 取付要素・入力層・オーバーレイの 3 枚のままで、
    // オプションバーはここに一切現れない（現れると onMapMount の querySelector が
    // 兄弟を取り違え、data-zoom / data-pan-x / data-pan-y が静かに壊れる）。
    expect(decl(ruleBody('.map-area'), 'position')).toBe('absolute');
    expect(decl(ruleBody('.map-area__canvas-mount'), 'inset')).toBe('0');
    expect(decl(ruleBody('.map-area__input'), 'inset')).toBe('0');
    expect(shellCss).not.toMatch(/\.map-area[^{}]*\.option-bar/);
  });
});
