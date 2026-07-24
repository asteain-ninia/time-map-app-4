// U22 visual-classification tests — 受け入れ基準 6 (the four FR-82 categories are
// distinct and can co-exist; markers vs. selected vs. dragging precedence).

import { describe, expect, it } from 'vitest';

import { analyzeVertexContext } from './context';
import { ownerLookupFromMap } from './contracts';
import {
  EMPTY_SELECTION,
  POINTER_PHASE,
  withActiveFeature,
  withTransient,
  withVertexSet,
} from './state';
import {
  EMPTY_CONTEXT,
  type VertexContext,
} from './context';
import {
  FEATURE_HIGHLIGHT,
  VERTEX_HIGHLIGHT,
  classifyFeatureHighlights,
  classifyVisual,
} from './visual';
import { coord, fid, owners, vid, vidSet } from './fixtures';

describe('visual classification (FR-82, 教訓 5.29)', () => {
  it('active feature → Active highlight (thick cyan + fill)', () => {
    const cls = classifyVisual(
      withActiveFeature(EMPTY_SELECTION, fid('A')),
      EMPTY_CONTEXT,
    );
    expect(cls.features.get(fid('A'))).toBe(FEATURE_HIGHLIGHT.Active);
  });

  it('non-active single-owner context → Context (dashed) highlight only', () => {
    const ctx: VertexContext = analyzeVertexContext(
      vidSet('A-v0'),
      ownerLookupFromMap(owners(['A-v0', 'A'])),
    );
    const cls = classifyVisual(
      withVertexSet(EMPTY_SELECTION, fid('A'), vidSet('A-v0')),
      ctx,
    );
    expect(cls.features.get(fid('A'))).toBe(FEATURE_HIGHLIGHT.Context);
  });

  // FR-82 は「アクティブ地物」と「頂点選択コンテキスト地物」を別々の視覚状態として並べて
  // 規定しており、後者を「アクティブ地物が無いときだけ」に限定していない。U22 の頂点分岐は
  // オーナーを activeFeature へ昇格させないので、A をアクティブにしたまま B の頂点を掴む状態は
  // 実際に起こる (handle 層はその B のハンドルを描く)。その B が無強調のままだと「どの地物の
  // 頂点を掴んでいるのか」が画面から読めない。
  it('active A + 別地物 B の頂点選択 → A:Active と B:Context が同時に立つ', () => {
    const ctx: VertexContext = analyzeVertexContext(
      vidSet('B-v0'),
      ownerLookupFromMap(owners(['B-v0', 'B'])),
    );
    const cls = classifyVisual(
      withVertexSet(withActiveFeature(EMPTY_SELECTION, fid('A')), fid('B'), vidSet('B-v0')),
      ctx,
    );
    expect(cls.features.get(fid('A'))).toBe(FEATURE_HIGHLIGHT.Active);
    expect(cls.features.get(fid('B'))).toBe(FEATURE_HIGHLIGHT.Context);
  });

  it('an active feature is NOT downgraded to Context for the same feature', () => {
    const ctx: VertexContext = analyzeVertexContext(
      vidSet('A-v0'),
      ownerLookupFromMap(owners(['A-v0', 'A'])),
    );
    const cls = classifyVisual(
      withVertexSet(withActiveFeature(EMPTY_SELECTION, fid('A')), fid('A'), vidSet('A-v0')),
      ctx,
    );
    expect(cls.features.get(fid('A'))).toBe(FEATURE_HIGHLIGHT.Active);
  });

  it('selected vertices → Selected; the active feature markers → Marker', () => {
    const state = withVertexSet(
      withActiveFeature(EMPTY_SELECTION, fid('A')),
      fid('A'),
      vidSet('A-v0'),
    );
    const cls = classifyVisual(state, EMPTY_CONTEXT, {
      activeFeatureVertexIds: vidSet('A-v0', 'A-v1', 'A-v2'),
    });
    // selected vertex overrides marker:
    expect(cls.vertices.get(vid('A-v0'))).toBe(VERTEX_HIGHLIGHT.Selected);
    // other active-feature vertices are half-transparent markers (FR-79):
    expect(cls.vertices.get(vid('A-v1'))).toBe(VERTEX_HIGHLIGHT.Marker);
    expect(cls.vertices.get(vid('A-v2'))).toBe(VERTEX_HIGHLIGHT.Marker);
  });

  it('dragging vertices → Dragging (overrides Selected)', () => {
    const state = withTransient(
      withVertexSet(EMPTY_SELECTION, fid('A'), vidSet('A-v0', 'A-v1')),
      {
        phase: POINTER_PHASE.VertexDrag,
        ownerFeatureId: fid('A'),
        pressedVertexId: vid('A-v0'),
        origin: coord(0, 0),
        current: coord(1, 1),
      },
    );
    const cls = classifyVisual(state, EMPTY_CONTEXT);
    expect(cls.vertices.get(vid('A-v0'))).toBe(VERTEX_HIGHLIGHT.Dragging);
    expect(cls.vertices.get(vid('A-v1'))).toBe(VERTEX_HIGHLIGHT.Dragging);
  });

  it('marker cap: full vertex set ≤ cap → every marker is produced (FR-110)', () => {
    const state = withActiveFeature(EMPTY_SELECTION, fid('A'));
    const cls = classifyVisual(state, EMPTY_CONTEXT, {
      activeFeatureVertexIds: vidSet('A-v0', 'A-v1', 'A-v2'),
      cap: 3,
    });
    expect(cls.vertices.get(vid('A-v0'))).toBe(VERTEX_HIGHLIGHT.Marker);
    expect(cls.vertices.get(vid('A-v1'))).toBe(VERTEX_HIGHLIGHT.Marker);
    expect(cls.vertices.get(vid('A-v2'))).toBe(VERTEX_HIGHLIGHT.Marker);
  });

  it('marker cap: full vertex set > cap → NO markers are produced (perf gate, FR-110)', () => {
    const state = withActiveFeature(EMPTY_SELECTION, fid('A'));
    const cls = classifyVisual(state, EMPTY_CONTEXT, {
      activeFeatureVertexIds: vidSet('A-v0', 'A-v1', 'A-v2'),
      cap: 2,
    });
    expect(cls.vertices.get(vid('A-v0'))).toBeUndefined();
    expect(cls.vertices.get(vid('A-v1'))).toBeUndefined();
    expect(cls.vertices.get(vid('A-v2'))).toBeUndefined();
  });

  it('marker cap = 0: no markers at all (0 == show none, FR-110)', () => {
    const state = withActiveFeature(EMPTY_SELECTION, fid('A'));
    const cls = classifyVisual(state, EMPTY_CONTEXT, {
      activeFeatureVertexIds: vidSet('A-v0'),
      cap: 0,
    });
    expect(cls.vertices.get(vid('A-v0'))).toBeUndefined();
  });

  it('marker cap does NOT suppress selected / dragging vertices when exceeded', () => {
    // cap=1 is exceeded by the 3-vertex active feature, so the FR-79 half-
    // transparent markers are gated OFF — but a selected vertex (別経路) is still
    // styled Selected, and a dragged one still Dragging. The cap only gates the
    // FR-79 marker path, never the edit/selection highlight (概念).
    const dragging = withTransient(
      withVertexSet(
        withActiveFeature(EMPTY_SELECTION, fid('A')),
        fid('A'),
        vidSet('A-v0'),
      ),
      {
        phase: POINTER_PHASE.VertexDrag,
        ownerFeatureId: fid('A'),
        pressedVertexId: vid('A-v0'),
        origin: coord(0, 0),
        current: coord(1, 1),
      },
    );
    const cls = classifyVisual(dragging, EMPTY_CONTEXT, {
      activeFeatureVertexIds: vidSet('A-v0', 'A-v1', 'A-v2'),
      cap: 1,
    });
    // dragged vertex keeps its edit-path highlight despite the cap:
    expect(cls.vertices.get(vid('A-v0'))).toBe(VERTEX_HIGHLIGHT.Dragging);
    // the other active-feature vertices are gated OFF (no marker):
    expect(cls.vertices.get(vid('A-v1'))).toBeUndefined();
    expect(cls.vertices.get(vid('A-v2'))).toBeUndefined();

    // Same for a plain selected (non-dragging) vertex under an exceeded cap.
    const selected = withVertexSet(
      withActiveFeature(EMPTY_SELECTION, fid('A')),
      fid('A'),
      vidSet('A-v0'),
    );
    const selCls = classifyVisual(selected, EMPTY_CONTEXT, {
      activeFeatureVertexIds: vidSet('A-v0', 'A-v1', 'A-v2'),
      cap: 1,
    });
    expect(selCls.vertices.get(vid('A-v0'))).toBe(VERTEX_HIGHLIGHT.Selected);
    expect(selCls.vertices.get(vid('A-v1'))).toBeUndefined();
    expect(selCls.vertices.get(vid('A-v2'))).toBeUndefined();
  });

  it('omitted cap → markers are unlimited (backward-compatible default)', () => {
    const state = withActiveFeature(EMPTY_SELECTION, fid('A'));
    const cls = classifyVisual(state, EMPTY_CONTEXT, {
      activeFeatureVertexIds: vidSet('A-v0', 'A-v1', 'A-v2'),
    });
    expect(cls.vertices.get(vid('A-v0'))).toBe(VERTEX_HIGHLIGHT.Marker);
    expect(cls.vertices.get(vid('A-v1'))).toBe(VERTEX_HIGHLIGHT.Marker);
    expect(cls.vertices.get(vid('A-v2'))).toBe(VERTEX_HIGHLIGHT.Marker);
  });

  it('all four categories can hold simultaneously and stay distinct', () => {
    // Active feature A; context feature is NOT shown (active present), so use a
    // separate scenario: no active feature, context = B, selected + dragging on B.
    // Here we assert co-existence of Active(A) + Selected + Dragging + Marker is
    // not possible for the SAME id, but the categories themselves are distinct.
    const drag = withTransient(
      withVertexSet(withActiveFeature(EMPTY_SELECTION, fid('A')), fid('A'), vidSet('A-v0')),
      {
        phase: POINTER_PHASE.VertexDrag,
        ownerFeatureId: fid('A'),
        pressedVertexId: vid('A-v0'),
        origin: coord(0, 0),
        current: coord(2, 2),
      },
    );
    const cls = classifyVisual(drag, EMPTY_CONTEXT, {
      activeFeatureVertexIds: vidSet('A-v0', 'A-v1'),
    });
    expect(cls.features.get(fid('A'))).toBe(FEATURE_HIGHLIGHT.Active);
    expect(cls.vertices.get(vid('A-v0'))).toBe(VERTEX_HIGHLIGHT.Dragging);
    expect(cls.vertices.get(vid('A-v1'))).toBe(VERTEX_HIGHLIGHT.Marker);
    // The category VALUES are all different from one another (distinct, 基準 6).
    const all = new Set([
      FEATURE_HIGHLIGHT.Active,
      FEATURE_HIGHLIGHT.Context,
      VERTEX_HIGHLIGHT.Selected,
      VERTEX_HIGHLIGHT.Dragging,
      VERTEX_HIGHLIGHT.Marker,
    ]);
    expect(all.size).toBe(5);
  });
});

// FR-82 点線アウトラインの結線アダプタ。描画側 (render/ui) は SelectionState/VertexContext
// ではなく (activeFeature, vertexOwner, vertexIds) の三つ組でしか選択を持っていないので、
// 「その三つ組から地物ハイライトを引く」入口を分類器の側に一つだけ置く。判定そのものは
// classifyVisual に委譲する — 描画側で第二の規則を書かない (教訓 5.29 二重実装禁止)。
describe('classifyFeatureHighlights (描画側アダプタ, FR-82)', () => {
  it('アクティブ地物のみ → Active だけ', () => {
    const m = classifyFeatureHighlights({
      activeFeature: fid('A'),
      vertexOwner: null,
      vertexIds: vidSet(),
    });
    expect(m.get(fid('A'))).toBe(FEATURE_HIGHLIGHT.Active);
    expect(m.size).toBe(1);
  });

  it('アクティブ無し + オーナー B の頂点選択 → B:Context', () => {
    const m = classifyFeatureHighlights({
      activeFeature: null,
      vertexOwner: fid('B'),
      vertexIds: vidSet('B-v0'),
    });
    expect(m.get(fid('B'))).toBe(FEATURE_HIGHLIGHT.Context);
    expect(m.size).toBe(1);
  });

  it('アクティブ A + 別オーナー B → A:Active と B:Context', () => {
    const m = classifyFeatureHighlights({
      activeFeature: fid('A'),
      vertexOwner: fid('B'),
      vertexIds: vidSet('B-v0'),
    });
    expect(m.get(fid('A'))).toBe(FEATURE_HIGHLIGHT.Active);
    expect(m.get(fid('B'))).toBe(FEATURE_HIGHLIGHT.Context);
  });

  it('アクティブ A + 同じ A のオーナー → Active が勝ち Context は立たない (合成規則)', () => {
    const m = classifyFeatureHighlights({
      activeFeature: fid('A'),
      vertexOwner: fid('A'),
      vertexIds: vidSet('A-v0'),
    });
    expect(m.get(fid('A'))).toBe(FEATURE_HIGHLIGHT.Active);
    expect(m.size).toBe(1);
  });

  it('オーナーはあるが選択集合が空 → Context は立たない (教訓 5.18 空は空)', () => {
    const m = classifyFeatureHighlights({
      activeFeature: null,
      vertexOwner: fid('B'),
      vertexIds: vidSet(),
    });
    expect(m.size).toBe(0);
  });
});
