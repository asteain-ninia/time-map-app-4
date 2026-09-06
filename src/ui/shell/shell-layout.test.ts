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
import { RAIL_GROUP_WIDTH } from '../time/rail-fold';
import { ALL_TOOLS, TOOL_GROUPS } from './tools';

// 改行は `readSourceText` が LF に揃える。この作業ツリーは CRLF と LF が混ざり、しかも
// その違いは git の差分に現れないので、揃えないと複数行セレクタの照合が環境次第で外れる。
const here = dirname(fileURLToPath(import.meta.url));
const shellCss = readSourceText(resolve(here, 'shell.css'));
// 測量の帯は自分の CSS を持つ（`ui/survey/survey.css`）。**折り返さないこと**は
// アプリバーの高さが動かないための条件なので、置き場が別でもここで一緒に固定する。
const surveyCss = readSourceText(resolve(here, '../survey/survey.css'));

/**
 * セレクタ（またはセレクタ列の先頭）が完全一致する最初の規則の本体 `{ ... }` を取り出す。
 *
 * **直前が `}` かコメントの閉じ `/` か文字列先頭であることを要求する。** 行頭を許すと、
 * 複数セレクタを並べた規則の **最後の行**（`… ,\n.option-bar__commit {`）にも当たってしまい、
 * 別の規則の本体を読んで「宣言が無い」と誤判定する（実際に一度これで落とした）。
 */
function ruleBody(selector: string, css: string = shellCss): string {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(?:^|[}/])\\s*${esc}\\s*\\{([^}]*)\\}`);
  const m = re.exec(css);
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

/** `12px` のような宣言値を数にする（単位が px でなければ落とす）。 */
function px(value: string | undefined, what: string): number {
  const m = /^(-?[\d.]+)px$/.exec(value ?? '');
  if (m === null) throw new Error(`px で書かれていない: ${what} = ${String(value)}`);
  return Number(m[1]);
}

describe('オプションバーの寸法契約（K-3, 設計書 §C.4 / §B.4）', () => {
  it('行は 40px 固定・折り返さない・はみ出さない', () => {
    const bar = ruleBody('.option-bar');
    expect(decl(bar, 'display')).toBe('flex');
    // 高さが固定でないと、中身が増えた瞬間に地図の上端が下がる（§1.3 の事故）。
    // **増分 5a で真実源をシェルの変数 1 か所へ寄せた**（行そのものと帯の両方が読む）。
    expect(decl(bar, 'height')).toBe('var(--shell-optionbar-h)');
    expect(decl(ruleBody('.app-shell'), '--shell-optionbar-h')).toBe('40px');
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

  it('伸縮するのは「次の一手」だけで、設定欄は縮まない（畳みの予算をそのまま嵌めるため）', () => {
    expect(decl(ruleBody('.option-bar__next'), 'flex')).toBe('1 1 auto');
    // **設定欄は縮まない**（増分 5 の手直し 2 回目）。旧版の `0 1 auto` は「次の一手」と
    // 基準幅に比例して縮み合うので、畳みの予算（「次の一手」に 160px を見込む）と実寸が
    // ずれ、いちばん右の「≫」が欄の外へこぼれた。縮まない区画にしたうえで、予算を
    // `max-width` として `OptionBar.tsx` が嵌める。ここが `0 1 auto` に戻ると再発する。
    expect(decl(ruleBody('.option-bar__settings'), 'flex')).toBe('0 0 auto');
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
    // 縮む役は「次の一手」が持つ。**0 でなければならない**（共有規則の `min-width: 0`
    // をそのまま、または明示的に 0 で書く）。増分 4 の手直し E1 で、この枠は
    // 「文 ＋ ボタン」の flex になったので、下限 0 をこの規則にも明示している。
    expect(decl(ruleBody('.option-bar__next'), 'min-width') ?? '0').toBe('0');
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
    expect(decl(bar, 'height')).toBe('var(--shell-status-h)');
    expect(decl(ruleBody('.app-shell'), '--shell-status-h')).toBe('28px');
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
  it('.app-shell は 5 行で、アプリバー・オプションバー・状態行の高さが固定（増分 5a）', () => {
    // **窓幅を変えても地図セルの上端が動かない**ことの単一真実源。アプリバーが `auto`
    // だった頃は、中身が増えるたびに 54 → 81.2 → 149.2px と段が増え、地図の上端が
    // 最大 95px 飛んだ（現状分析 §1.3）。**増分 6 で時刻レールも固定（112px）にした** ――
    // これで 5 行のうち可変なのはオプションバー行（渡さなければ潰れる）と主行だけになる。
    expect(decl(ruleBody('.app-shell'), 'grid-template-rows')).toBe(
      'var(--shell-appbar-h) auto minmax(0, 1fr) var(--shell-timeline-h) var(--shell-status-h)',
    );
    expect(decl(ruleBody('.app-shell'), '--shell-appbar-h')).toBe('32px');
  });

  it('アプリバーは高さ 32px 固定で折り返さない（測量や深さで段が増えない）', () => {
    const bar = ruleBody('.app-shell__menubar');
    expect(decl(bar, 'height')).toBe('var(--shell-appbar-h)');
    expect(decl(bar, 'box-sizing')).toBe('border-box');
    expect(decl(bar, 'flex-wrap')).toBe('nowrap');
    expect(decl(bar, 'overflow')).toBe('hidden');
    // 中の帯（メニューの右）も折り返さない。ここが `wrap` だと段が増える。
    expect(decl(ruleBody('.app-shell__topbar'), 'flex-wrap')).toBe('nowrap');
    expect(decl(ruleBody('.longitude-shift'), 'flex-wrap')).toBe('nowrap');
    expect(decl(ruleBody('.survey-controls', surveyCss), 'flex-wrap')).toBe('nowrap');
  });

  it('オプションバー行の高さもシェルの変数 1 か所で決まる', () => {
    const row = ruleBody('.app-shell__optionbar');
    expect(decl(row, 'height')).toBe('var(--shell-optionbar-h)');
    expect(decl(row, 'box-sizing')).toBe('border-box');
  });

  it('中心経度の畳みは窓幅だけで決まる（選択状態・道具・時刻に依存しない）', () => {
    // 設計書 §B.4 の畳み表。**どの段でも「読めて ◀▶ で動かせる」ことは残す。**
    const wide = mediaBlock('max-width: 1179px');
    expect(wide).toContain(".longitude-shift input[type='range']");
    expect(wide).toContain('.longitude-shift__presets');
    const narrow = mediaBlock('max-width: 959px');
    expect(narrow).toContain('.longitude-shift__absolute');
    // 読み出しと ◀▶ はどの段でも落とさない。
    expect(wide).not.toContain('.longitude-shift__readout');
    expect(wide).not.toContain('.longitude-shift__buttons');
    expect(narrow).not.toContain('.longitude-shift__readout');
    expect(narrow).not.toContain('.longitude-shift__buttons');
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

describe('右パネルの上段は、中の器がスクロールする（教訓 5.61 / 5.62）', () => {
  it('上段（地物一覧）の器はスクロールしない', () => {
    // 一覧は自分の中に `.ledger__scroller` を持つ。外にもう 1 つスクロールを作ると
    // 「行は在るのに区画の外」になる（既定の窓で 1 行も見えなかった原因）。
    expect(
      decl(ruleBody(".sidebar__panel[data-testid='sidebar-panel-list'] > .sidebar__panel-body"), 'overflow-y'),
    ).toBe('hidden');
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

// ---------------------------------------------------------------------------
// 増分 5 の手直し D — シェルの寸法と畳み
// ---------------------------------------------------------------------------

describe('鍵はアプリバー右端の 96px 固定枠（手直し D1 / 設計書 §C.1 の 4）', () => {
  it('枠は 96px 固定で、中身の長さで占有幅が変わらない', () => {
    // **2 状態で文字数が違う**（`🔒 読むだけ` は 4 文字、`🔓 直せる` は 3 文字）。枠を
    // 中身に合わせると、鍵を開け閉めするたびにアプリバーの右端が動き、隣の 経度シフト の
    // 畳み段まで変わる（K-3）。だから枠は固定で、中身だけ差し替える。
    const lock = ruleBody('.app-shell__lock');
    expect(decl(lock, 'flex')).toBe('0 0 var(--shell-lock-w)');
    expect(decl(lock, 'width')).toBe('var(--shell-lock-w)');
    expect(decl(lock, 'box-sizing')).toBe('border-box');
    expect(decl(lock, 'overflow')).toBe('hidden');
    // 幅そのものはシェルの変数 1 か所で決める（素性表示・レールと同じ作法）。
    expect(decl(ruleBody('.app-shell'), '--shell-lock-w')).toBe('96px');
  });

  it('鍵のボタンは枠いっぱいで、折り返さない（アプリバーの 32px を突き破らない）', () => {
    const button = ruleBody('.app-shell__lock-button');
    expect(decl(button, 'width')).toBe('100%');
    expect(decl(button, 'box-sizing')).toBe('border-box');
    expect(decl(button, 'white-space')).toBe('nowrap');
    expect(decl(button, 'overflow')).toBe('hidden');
  });

  it('アプリバーの高さは 32px のまま（鍵が入っても行は伸びない）', () => {
    expect(decl(ruleBody('.app-shell'), '--shell-appbar-h')).toBe('32px');
    expect(decl(ruleBody('.app-shell__menubar'), 'height')).toBe('var(--shell-appbar-h)');
  });

  it('レールに鍵の規則がもう無い（引っ越しの取り残しが無い）', () => {
    // 引っ越したのに古い規則が残ると、次に読む人がどちらが現物か分からなくなる。
    expect(shellCss).not.toContain('.toolbar__lock');
  });
});

describe('左のレールは道具 12 個が縦に収まる（手直し D2 / 設計書 §C.3）', () => {
  /**
   * 時刻レールの高さ。**増分 6 で 201.2px → 112px になった**（設計書 §C.7）。旧版は
   * 行が `auto` で中身が高さを決めていたので実測値を置くしかなかったが、いまは
   * `--shell-timeline-h` が真実源である（内訳は 上下余白 2+2 ＋ 読み取り 24 ＋
   * 錨レーン 28 ＋ 目盛り 22 ＋ 操作列 32 ＋ 枠線 1×2）。
   *
   * **道具のレールの縦の余裕が 89.2px 増えた。** ボタンを 36px（設計書 §C.3 の既定）へ
   * 戻せるかは `docs/現状.md` の B56 で追う。
   */
  const TIMELINE_H = 112;

  /** 群ごとのボタンの数（レールの並びの単一の真実源から引く）。 */
  const groupSizes = [...TOOL_GROUPS.map((g) => g.tools.length), 1 /* 調べる（測る） */];

  it('レールの幅は 88px（シェルの変数 1 か所）', () => {
    expect(decl(ruleBody('.app-shell'), '--shell-toolbar-w')).toBe('88px');
    expect(decl(ruleBody('.app-shell__main'), 'grid-template-columns')).toBe(
      'var(--shell-toolbar-w) minmax(0, 1fr) var(--shell-sidebar-w)',
    );
  });

  it('道具のボタンは padding と枠線を高さの内側に入れる（border-box）', () => {
    // **これが手直し D2 の本体である。** `box-sizing` が既定（content-box）だと
    // `min-height: 32px` は「中身だけで 32px」の意味になり、実物は 32 ＋ padding 8 ＋
    // 枠線 2 ＝ 42px になる。12 個で 120px の差になり、既定の窓でもレールがあふれた。
    const button = ruleBody('.toolbar button');
    expect(decl(button, 'box-sizing')).toBe('border-box');
    // U-8 の下限（高さ 30px 以上）は守る。
    expect(px(decl(button, 'min-height'), '.toolbar button の min-height')).toBeGreaterThanOrEqual(
      30,
    );
  });

  it('12 個ぶんの高さが 1366×768 のレールに収まる（縦スクロールバーが出ない）', () => {
    const shell = ruleBody('.app-shell');
    const toolbar = ruleBody('.toolbar');
    const tools = ruleBody('.toolbar__tools');
    const group = ruleBody('.toolbar__group');
    const button = ruleBody('.toolbar button');

    const buttonCount = groupSizes.reduce((a, b) => a + b, 0);
    // 道具 11 個（`ALL_TOOLS`）＋「測る」1 個。**数の真実源は tools.ts の側**なので、
    // 道具を足したらこの検査が自動で広がる（＝足した瞬間に予算が赤くなる）。
    expect(buttonCount).toBe(ALL_TOOLS.length + 1);

    const padTop = px(
      decl(toolbar, 'padding')?.split(' ')[0],
      '.toolbar の padding（縦）',
    );
    const content =
      padTop * 2 +
      px(decl(tools, 'gap'), '.toolbar__tools の gap') * (groupSizes.length - 1) +
      px(decl(group, 'gap'), '.toolbar__group の gap') *
        groupSizes.reduce((a, n) => a + (n - 1), 0) +
      px(decl(button, 'min-height'), '.toolbar button の min-height') * buttonCount;

    const fixedRows =
      px(decl(shell, '--shell-appbar-h'), '--shell-appbar-h') +
      px(decl(shell, '--shell-optionbar-h'), '--shell-optionbar-h') +
      px(decl(shell, '--shell-status-h'), '--shell-status-h') +
      TIMELINE_H;

    // 既定の窓（1280×800）と、いちばん縦の狭い実用窓（1366×768）の 2 つで見る。
    for (const height of [800, 768]) {
      const rail = height - fixedRows;
      expect(
        content,
        `窓の高さ ${height}px でレールがあふれる（中身 ${content}px / 枠 ${rail}px）`,
      ).toBeLessThanOrEqual(rail);
    }
  });

  it('最小の窓（800×600）は収まらないので「送れる」ようにしてある', () => {
    // 12 個を 298.8px に入れるとボタン 1 個 23px で、U-8 の下限（30px 以上）を割る。
    // **隠すのではなく送れるようにする**のがここでの決めごと（`overflow-y: auto`）。
    expect(decl(ruleBody('.app-shell__toolbar'), 'overflow-y')).toBe('auto');
    expect(decl(ruleBody('.app-shell__toolbar'), 'overflow-x')).toBe('hidden');
  });
});

describe('設定欄の畳み「≫」（手直し D3 / 設計書 §B.4）', () => {
  it('部品は縮まない（潰れて「入っている」ように見えない）', () => {
    // 縮む作りだと、幅が足りないときに部品が潰れて辻褄を合わせてしまい、
    // **入り切っていないことが実測に現れない** ―― 「≫」へ送る判断が誤読する。
    expect(decl(ruleBody('.option-bar__slot'), 'flex')).toBe('0 0 auto');
  });

  it('パネルは `[hidden]` の打ち消しを併記している（教訓 5.56 / K-2）', () => {
    // クラスの `display: flex` は属性セレクタの `[hidden] { display: none }` に勝つ。
    // 打ち消しを書き忘れると、閉じているのに画面左上に居座って下のクリックを奪う。
    expect(decl(ruleBody('.option-bar__overflow-panel[hidden]'), 'display')).toBe('none');
    const panel = ruleBody('.option-bar__overflow-panel');
    // 帯は `overflow: hidden` なので、`fixed` でないと下へ伸ばした瞬間に切れる。
    expect(decl(panel, 'position')).toBe('fixed');
  });

  it('「≫」ボタンは押せる大きさを持つ', () => {
    const button = ruleBody('.option-bar__overflow-button');
    expect(px(decl(button, 'min-height'), '≫ の min-height')).toBeGreaterThanOrEqual(24);
    expect(px(decl(button, 'min-width'), '≫ の min-width')).toBeGreaterThanOrEqual(24);
    expect(decl(button, 'flex')).toBe('0 0 auto');
  });
});

describe('時刻レールの寸法契約（設計書 §C.7。増分 6）', () => {
  // **なぜ CSS を直接読むのか**は冒頭の見出しと同じ ―― jsdom はレイアウトを持たないので
  // px を測ると常に 0 で一致し、テストが永久に緑になる（教訓 5.49）。実寸は E2E が見る。
  it('帯は 112px 固定で、中身が増えても伸びない', () => {
    const shell = ruleBody('.app-shell');
    // 高さの真実源はシェルの変数 1 か所（行そのものも中の `.rail` も同じ値を読む）。
    expect(decl(shell, '--rail-lane-h')).toBe('28px');
    expect(decl(shell, '--shell-timeline-h')).toBe(
      'calc(4px + 24px + var(--rail-lane-h) + 22px + 32px + 2px)',
    );
    // 4 + 24 + 28 + 22 + 32 + 2 = 112px（設計書 §C.7 の内訳）。
    const row = ruleBody('.app-shell__timeline');
    expect(decl(row, 'height')).toBe('var(--shell-timeline-h)');
    expect(decl(row, 'box-sizing')).toBe('border-box');
    // 旧版は `auto` ＋ `max-height: 40vh` で、入力エラーが出ると 200 → 220px に伸びた。
    expect(decl(row, 'max-height')).toBeUndefined();
    expect(decl(row, 'overflow')).toBe('hidden');
    const rail = ruleBody('.rail');
    expect(decl(rail, 'height')).toBe('var(--shell-timeline-h)');
    expect(decl(rail, 'overflow')).toBe('hidden');
  });

  it('4 段の高さが設計書どおり（読み取り 24 / レーン 28 / 目盛り 22 / 操作列 32）', () => {
    expect(px(decl(ruleBody('.rail__readout'), 'height'), '読み取り')).toBe(24);
    expect(decl(ruleBody('.rail__lane-box'), 'height')).toBe('var(--rail-lane-h)');
    expect(px(decl(ruleBody('.rail__ticks'), 'height'), '目盛り')).toBe(22);
    expect(px(decl(ruleBody('.rail__controls'), 'height'), '操作列')).toBe(32);
  });

  it('窓が低いとレーンが 20px に縮む（**窓の大きさだけで決まる**＝ K-3）', () => {
    const block = mediaBlock('max-height: 699px');
    expect(block).toContain('--rail-lane-h: 20px');
    // 選択状態や道具に依存する分岐がここに紛れ込んでいないこと。
    expect(block).not.toContain('active');
    expect(block).not.toContain('selected');
  });

  it('錨レーンと目盛りは同じ内寸を使う（印と目盛りがずれない）', () => {
    // 「単位: 年」の余白を **両方の行が同じ変数で** 読む。別々の値になった瞬間に、
    // 同じ軸の上で 2 つの写像が並ぶ。
    expect(decl(ruleBody('.rail__lane-box'), 'margin-right')).toBe('var(--rail-unit-gutter)');
    expect(decl(ruleBody('.rail__ticks-unit'), 'flex')).toBe('0 0 var(--rail-unit-gutter)');
    expect(decl(ruleBody('.app-shell'), '--rail-unit-gutter')).toBe('64px');
  });

  it('操作列は折り返さない（段が増えると地図の上端が動く）', () => {
    const controls = ruleBody('.rail__controls');
    expect(decl(controls, 'flex-wrap')).toBe('nowrap');
    expect(decl(controls, 'overflow')).toBe('hidden');
    expect(px(decl(controls, 'gap'), '操作列の gap')).toBe(8);
  });

  it('まとまりの幅は `rail-fold.ts` の見積りと同じ数を嵌める（教訓 5.74）', () => {
    /** `flex: 0 0 128px` の 3 つ目（基準幅）を読む。 */
    const basis = (selector: string, what: string): number =>
      px(decl(ruleBody(selector), 'flex')?.split(' ')[2], what);
    expect(basis('.rail__group--step1', '±1')).toBe(RAIL_GROUP_WIDTH.step1);
    expect(basis('.rail__group--step10', '10 年')).toBe(RAIL_GROUP_WIDTH.step10);
    expect(basis('.rail__group--step100', '100 年')).toBe(RAIL_GROUP_WIDTH.step100);
    expect(basis('.rail__year', '年入力')).toBe(RAIL_GROUP_WIDTH.year);
    expect(basis('.rail__ymd', '月日 ▾')).toBe(RAIL_GROUP_WIDTH.ymd);
    expect(basis('.rail__unit', 'ステップ単位')).toBe(RAIL_GROUP_WIDTH.unit);
    expect(basis('.rail__overflow', '≫')).toBe(RAIL_GROUP_WIDTH.overflow);
  });

  it('±1 の送りと再生は U-8 の下限（64×32）を守る', () => {
    const button = ruleBody('.timeline-step__button');
    expect(px(decl(button, 'min-height'), '±1 の min-height')).toBe(32);
    expect(px(decl(button, 'min-width'), '±1 の min-width')).toBe(64);
  });

  it('レールのポップオーバーは `[hidden]` の打ち消しを併記している（教訓 5.56 / K-2）', () => {
    expect(decl(ruleBody('.rail__popover[hidden]'), 'display')).toBe('none');
    expect(decl(ruleBody('.rail__popover'), 'position')).toBe('fixed');
  });

  it('束の吹き出しも画面座標で置く（帯の `overflow: hidden` で切れない）', () => {
    // `absolute` に戻すと、帯の子として上へ伸びたぶんが切り落とされ、**中の行が
    // 押せなくなる**（実際に一度そうなった）。押せるのは中のボタンだけ（N-01）。
    const bundle = ruleBody('.rail__bundle');
    expect(decl(bundle, 'position')).toBe('fixed');
    expect(decl(bundle, 'pointer-events')).toBe('none');
    expect(decl(ruleBody('.rail__bundle button'), 'pointer-events')).toBe('auto');
  });

  it('断りの読み上げは寸法を持たない（断りで帯が伸びない）', () => {
    const error = ruleBody('.rail__year-error');
    expect(decl(error, 'position')).toBe('absolute');
    expect(px(decl(error, 'width'), '断りの width')).toBe(1);
    expect(px(decl(error, 'height'), '断りの height')).toBe(1);
  });
});

describe('地図セルの中に置く部品（設計書 §B.5 の台帳 #10〜#12。増分 6）', () => {
  it('ズームと全体表示は右下 16px 内側・40px 幅（台帳の寸法どおり）', () => {
    const box = ruleBody('.map-view-controls');
    expect(px(decl(box, 'right'), 'right')).toBe(16);
    expect(px(decl(box, 'bottom'), 'bottom')).toBe(16);
    expect(px(decl(box, 'width'), 'width')).toBe(40);
    const button = ruleBody('.map-view-controls__button');
    expect(px(decl(button, 'width'), 'ボタンの width')).toBe(40);
    expect(px(decl(button, 'height'), 'ボタンの height')).toBe(40);
  });

  it('縮尺バーは **押せない**（表示だけ）', () => {
    // `.map-area__overlay > *` が押下を有効にする既定を、この 1 行で打ち消す。
    expect(decl(ruleBody('.map-area__overlay > .map-scale-bar'), 'pointer-events')).toBe(
      'none',
    );
    expect(px(decl(ruleBody('.map-scale-bar'), 'bottom'), '縮尺バーの bottom')).toBe(16);
    expect(px(decl(ruleBody('.map-scale-bar'), 'height'), '縮尺バーの height')).toBe(20);
  });

  it('頂点の候補一覧は一時部品で、幅は 216px（端で内側へ寄せる計算と同じ値）', () => {
    const box = ruleBody('.vertex-candidates');
    expect(decl(box, 'position')).toBe('absolute');
    expect(px(decl(box, 'width'), '候補一覧の width')).toBe(216);
    expect(px(decl(box, 'max-height'), '候補一覧の max-height')).toBe(180);
  });
});

describe('初回起動のガイド（FR-118 / 設計書 §H.3。増分 6）', () => {
  it('**地図には重ねない**（右パネルの下・時刻レールの上）', () => {
    const box = ruleBody('.first-run-guide');
    expect(decl(box, 'bottom')).toBe(
      'calc(var(--shell-status-h) + var(--shell-timeline-h) + 12px)',
    );
    // 器そのものは押下を通し、押せるのは中の板だけ（K-2 の型の事故を作らない）。
    expect(decl(box, 'pointer-events')).toBe('none');
    expect(decl(ruleBody('.first-run-guide__panel'), 'pointer-events')).toBe('auto');
  });
});
