// 回帰テスト: Canvas 再描画購読の WATCH 集合 (教訓 5.35 / 5.7 結線漏れ).
//
// 現物バグ (敵対レビュー HIGH): 合成ルートの `editHandles` getter は
// `selection.vertexIds` / `selection.transient` を読むのに、その getter を再評価させる
// 唯一の store 購読が比較していたのは domain / currentTime / activeFeature / mode /
// displayControl / filter / グリッド系だけだった。頂点選択は activeFeature を変えない
// (reducer の HIT_KIND.Vertex 分岐は activeFeature を触らない) ので、地物が既に active
// な状態で頂点をクリックしても watch 対象が全て不変 → 早期 return → requestRedraw() が
// 呼ばれず、シアンの選択リングは「他の入力が動いた瞬間」まで出なかった。
//
// 根治: 「どの状態が描画に効くか」を手書きの let 変数列ではなく **純粋関数** に集約し、
// ここで固定する。getter が読む値は必ずこの WATCH に現れる、が不変条件。

import { describe, expect, it } from 'vitest';

import { asFeatureId, asVertexId } from '../../domain/ids';

import { redrawWatch, redrawWatchChanged, type RedrawWatchInput } from './redraw-watch';

/** 最小の watch 入力 (構造スライス — store 全体には依存しない, 教訓 5.34). */
function baseState(): RedrawWatchInput {
  return {
    domain: { tag: 'domain' },
    currentTime: { tag: 'time' },
    selection: {
      activeFeature: null,
      vertexIds: new Set(),
      vertexOwner: null,
      transient: { phase: 'idle' },
    },
    activeFeature: null,
    mode: 'edit',
    activeTool: null,
    displayControl: { tag: 'display' },
    filter: { tag: 'filter' },
    projectSettings: {
      areaLabelOccupancyThreshold: 0.2,
      gridSpacingDeg: 10,
      gridColor: '#888888',
      gridOpacity: 0.5,
      gridVisible: true,
    },
    appSettings: { vertexMarkerCap: 2000 },
  };
}

/** SelectionState を「頂点セットだけ差し替えた」新しい値に (store は丸ごと差し替える). */
function withVertices(s: RedrawWatchInput, ids: readonly string[]): RedrawWatchInput {
  return {
    ...s,
    selection: {
      ...s.selection,
      vertexIds: new Set(ids.map((id) => asVertexId(id))),
      vertexOwner: ids.length === 0 ? null : asFeatureId('leaf-1'),
    },
  };
}

describe('redrawWatch (Canvas 再描画の watch 集合)', () => {
  it('無変化なら再描画を要求しない (同一値 = 早期 return)', () => {
    const s = baseState();
    expect(redrawWatchChanged(redrawWatch(s), redrawWatch(s))).toBe(false);
  });

  it('【回帰】activeFeature が不変でも頂点選択が変われば再描画を要求する', () => {
    // これがレビュー指摘そのもの: 地物 A が既に active な状態で A の頂点をクリック
    // → activeFeature / mode / displayControl / filter は全て不変。
    const before = baseState();
    const after = withVertices(before, ['leaf-1-0']);
    expect(after.activeFeature).toBe(before.activeFeature);
    expect(redrawWatchChanged(redrawWatch(before), redrawWatch(after))).toBe(true);
  });

  it('【回帰】別の頂点への選択切り替え / 選択解除も再描画を要求する', () => {
    const one = withVertices(baseState(), ['leaf-1-0']);
    const other = withVertices(baseState(), ['leaf-1-1']);
    const none = withVertices(baseState(), []);
    expect(redrawWatchChanged(redrawWatch(one), redrawWatch(other))).toBe(true);
    expect(redrawWatchChanged(redrawWatch(one), redrawWatch(none))).toBe(true);
  });

  it('【回帰】transient (矩形ドラフト / 頂点ドラッグ) の遷移も再描画を要求する', () => {
    const before = baseState();
    const after: RedrawWatchInput = {
      ...before,
      selection: { ...before.selection, transient: { phase: 'vertexDrag' } },
    };
    expect(redrawWatchChanged(redrawWatch(before), redrawWatch(after))).toBe(true);
  });

  it('アクティブ地物 / モード / ツールの変化を検出する', () => {
    const s = baseState();
    expect(
      redrawWatchChanged(
        redrawWatch(s),
        redrawWatch({ ...s, activeFeature: asFeatureId('leaf-1') }),
      ),
    ).toBe(true);
    expect(redrawWatchChanged(redrawWatch(s), redrawWatch({ ...s, mode: 'view' }))).toBe(
      true,
    );
    // FR-110 / HB3-6: ナイフ等の専用オーバーレイを持つツールに切り替えると編集ハンドルは
    // 消える (editHandles が activeTool を読む) ので、ツール変更も watch 対象。
    expect(
      redrawWatchChanged(redrawWatch(s), redrawWatch({ ...s, activeTool: 'edit-knife' })),
    ).toBe(true);
  });

  it('既存の watch 軸 (domain / 時刻 / 表示制御 / フィルタ / グリッド / 面積閾値) を維持する', () => {
    const s = baseState();
    const changed: RedrawWatchInput[] = [
      { ...s, domain: { tag: 'domain2' } },
      { ...s, currentTime: { tag: 'time2' } },
      { ...s, displayControl: { tag: 'display2' } },
      { ...s, filter: { tag: 'filter2' } },
      { ...s, projectSettings: { ...s.projectSettings, areaLabelOccupancyThreshold: 0.9 } },
      { ...s, projectSettings: { ...s.projectSettings, gridSpacingDeg: 5 } },
      { ...s, projectSettings: { ...s.projectSettings, gridColor: '#ff0000' } },
      { ...s, projectSettings: { ...s.projectSettings, gridOpacity: 0.1 } },
      { ...s, projectSettings: { ...s.projectSettings, gridVisible: false } },
    ];
    for (const next of changed) {
      expect(redrawWatchChanged(redrawWatch(s), redrawWatch(next))).toBe(true);
    }
  });

  it('FR-110 頂点マーカー表示上限の変更も即時反映される (editHandles が読む値)', () => {
    const s = baseState();
    const after: RedrawWatchInput = { ...s, appSettings: { vertexMarkerCap: 0 } };
    expect(redrawWatchChanged(redrawWatch(s), redrawWatch(after))).toBe(true);
  });

  it('watch は固定長で、値の同一性 (===) だけで比較する', () => {
    const s = baseState();
    const a = redrawWatch(s);
    const b = redrawWatch({ ...s });
    expect(a).toHaveLength(b.length);
    // 値が同一参照なら「変化なし」— 値等価な別オブジェクトは変化として扱う (store は
    // スライスを丸ごと差し替える契約なので、参照一致 == 値一致, store.ts の identity
    // stability 記述と同じ規律)。
    expect(redrawWatchChanged(a, b)).toBe(false);
    expect(
      redrawWatchChanged(a, redrawWatch({ ...s, displayControl: { tag: 'display' } })),
    ).toBe(true);
  });
});
