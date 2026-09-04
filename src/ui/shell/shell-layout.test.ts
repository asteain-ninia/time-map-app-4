// オプションバーと状態行の寸法契約（K-3 / 設計書 §B.4 / §C.8）を CSS の実物で固定する。
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

import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { readSourceText } from '../../test-support/read-source-text';

// 改行は `readSourceText` が LF に揃える。この作業ツリーは CRLF と LF が混ざり、しかも
// その違いは git の差分に現れないので、揃えないと複数行セレクタの照合が環境次第で外れる。
const here = dirname(fileURLToPath(import.meta.url));
const shellCss = readSourceText(resolve(here, 'shell.css'));

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

/**
 * `@media (<condition>) { ... }` の中身をそのまま返す。`ruleBody` の `[^}]*` は
 * 入れ子の `}` で止まってしまうので、こちらは括弧の対応を数えて切り出す。
 */
function mediaBlock(condition: string): string {
  const esc = condition.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`@media\\s*\\(\\s*${esc}\\s*\\)\\s*\\{`);
  const m = re.exec(shellCss);
  if (m === null) throw new Error(`@media rule not found: ${condition}`);
  let depth = 1;
  let i = m.index + m[0].length;
  const start = i;
  while (i < shellCss.length && depth > 0) {
    const ch = shellCss[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') depth -= 1;
    i += 1;
  }
  return shellCss.slice(start, i - 1);
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

  it('伸縮するのは「次の一手」と「設定」だけ', () => {
    expect(decl(ruleBody('.option-bar__next'), 'flex')).toBe('1 1 auto');
    // 設定欄は中身の量で決まるが、伸びて他を押し出すことはない（0 1 auto）。
    expect(decl(ruleBody('.option-bar__settings'), 'flex')).toBe('0 1 auto');
  });

  it('設定欄には下限がある（「次の一手」が長くても部品 2 個ぶんは読める）', () => {
    // 実測で捕まえた潰れ: 「次の一手」に長い拒否理由を入れると、`flex: 0 1 auto` の
    // 設定欄が縮む側に回り、72px → 35px まで潰れて「吸着 ▾」が読めなくなった。
    // 共有規則の `min-width: 0`（次項）をこの規則で上書きして下限を切る。ここが 0 に
    // 戻ると同じ潰れが再発する。縮む役は `min-width: 0` のままの「次の一手」が持つ。
    //
    // 下限は **いま実際に載っている 2 部品**（吸着 ▾ と［1 つ戻す］）が並ぶ幅で決める
    // （増分 3 の手直し C1）。1 部品ぶん（72px）だと［1 つ戻す］が切り落とされた。
    expect(decl(ruleBody('.option-bar__settings'), 'min-width')).toBe('136px');
    expect(decl(ruleBody('.option-bar__next'), 'min-width')).toBeUndefined();
  });

  it('5 区画すべてが min-width:0 + overflow:hidden（中身が枠を押し広げられない）', () => {
    // 共有規則の宣言そのものを読む。設定欄だけは後続の個別規則が min-width を
    // 上書きする（前項）が、それは「押し広げない」上限の話ではなく下限の話なので、
    // ここが 0 であることは引き続き必要（中身の min-content が外へ効かない）。
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

describe('状態行の寸法契約（K-3 と同じ規則, 設計書 §C.8）', () => {
  it('行は 28px 固定・折り返さない・はみ出さない', () => {
    const bar = ruleBody('.statusbar');
    expect(decl(bar, 'height')).toBe('28px');
    expect(decl(bar, 'box-sizing')).toBe('border-box');
    expect(decl(bar, 'flex-wrap')).toBe('nowrap');
    expect(decl(bar, 'overflow')).toBe('hidden');
  });

  it('5 枠の幅は固定（座標 240 / 縮尺 160 / 直前の結果 1fr / 取り消し 160 / 最終保存 160）', () => {
    expect(decl(ruleBody('.statusbar__frame--coords'), 'flex')).toBe('0 0 240px');
    expect(decl(ruleBody('.statusbar__frame--scale'), 'flex')).toBe('0 0 160px');
    expect(decl(ruleBody('.statusbar__frame--result'), 'flex')).toBe('1 1 auto');
    expect(decl(ruleBody('.statusbar__frame--undo'), 'flex')).toBe('0 0 160px');
    expect(decl(ruleBody('.statusbar__frame--saved'), 'flex')).toBe('0 0 160px');
  });

  it('枠は中身に押し広げられない（min-width:0 + overflow:hidden + nowrap）', () => {
    const frame = ruleBody('.statusbar__frame');
    expect(decl(frame, 'min-width')).toBe('0');
    expect(decl(frame, 'overflow')).toBe('hidden');
    expect(decl(frame, 'white-space')).toBe('nowrap');
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

describe('アプリバーの素性表示と主行の列（K-3 / B1 / B2）', () => {
  it('素性表示は固定幅（中身の長さで占有幅が変わらない）', () => {
    // **未保存の印が付いた瞬間に地図が 34px 飛んだ**（窓幅 1340 / 1500 で実測）。
    // 原因は素性表示が `flex: 0 0 auto` ＋ `max-width` で、実幅が中身で変わったこと。
    // 中身が変わっても占有幅が動かない = 上部バーの折り返し段数が中身で変わらない。
    const identity = ruleBody('.app-identity');
    expect(decl(identity, 'flex')).toBe('0 0 var(--shell-identity-w)');
    expect(decl(identity, 'width')).toBe('var(--shell-identity-w)');
    expect(decl(identity, 'box-sizing')).toBe('border-box');
    expect(decl(identity, 'overflow')).toBe('hidden');
    expect(decl(identity, 'white-space')).toBe('nowrap');
    // 幅そのものはシェルの変数 1 か所で決める。
    expect(decl(ruleBody('.app-shell'), '--shell-identity-w')).toBe('240px');
  });

  it('未保存の印は「付いていなくても枠が残る」', () => {
    // 要素ごと出し入れすると、印が付いた瞬間に素性表示が広がる。枠を常に確保して
    // 中身だけ出し入れする（部品側は data-dirty で状態を出す）。
    const dirty = ruleBody('.app-identity__dirty');
    expect(decl(dirty, 'flex')).toBe('0 0 10px');
    expect(decl(dirty, 'width')).toBe('10px');
  });

  it('主行の中央列は minmax(0, 1fr)、両脇のセルに min-width の下限を書かない', () => {
    // **「プロパティ」タブを押すと画面全体が 0.8px 左へずれて戻らなかった**（実測、
    // devicePixelRatio 1.25）。列が `1fr` で、各セルに書かれた `min-width` のほうが
    // 下限として効き、行の合計が窓幅 1280 → 1280.8px になっていた（開発ガイド §5.50）。
    expect(decl(ruleBody('.app-shell__main'), 'grid-template-columns')).toBe(
      'var(--shell-toolbar-w) minmax(0, 1fr) var(--shell-sidebar-w)',
    );
    // 列幅の真実源は grid-template-columns 1 か所。セル側に同じ値を書かない。
    expect(decl(ruleBody('.app-shell__map'), 'min-width')).toBe('0');
    expect(decl(ruleBody('.app-shell__sidebar'), 'min-width')).toBe('0');
  });
});

describe('狭い窓での状態行（D2 — 最小窓で「直前の結果」が潰れない）', () => {
  it('「直前の結果」の枠に下限がある', () => {
    // 800×600 では 座標 240 ＋ 縮尺 160 ＋ 取り消し 160 ＋ 最終保存 160 ＝ 720px を
    // 固定枠が取り、いちばん大事な「直前の結果」が実測 28px まで潰れて 1 文字も
    // 読めなかった。
    expect(decl(ruleBody('.statusbar__frame--result'), 'min-width')).toBe('200px');
  });

  it('狭い窓では両端の 4 枠を詰める（枠を消さずに幅だけ詰める）', () => {
    // V12 の合格条件（開いているファイル・未保存の印・最終保存時刻が見える）は
    // 狭い窓でも守るので、`display: none` で消さずに幅を詰める。
    const media = mediaBlock('max-width: 1180px');
    expect(media).toContain('.statusbar__frame--coords');
    expect(media).toContain('.statusbar__frame--scale');
    expect(media).toContain('.statusbar__frame--undo');
    expect(media).toContain('.statusbar__frame--saved');
    expect(media).not.toContain('display: none');
    // 800px で収まる合計であること（余白 20 ＋ 隙間 32 ＋ 4 枠 ＋ 下限 200 ≦ 800）。
    const widths = [...media.matchAll(/flex:\s*0\s+0\s+(\d+)px/g)].map((m) => Number(m[1]));
    expect(widths).toHaveLength(4);
    const total = widths.reduce((a, b) => a + b, 0);
    expect(total + 200 + 32 + 20).toBeLessThanOrEqual(800);
  });
});
