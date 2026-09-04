import { describe, expect, it } from 'vitest';

import {
  ADD_TOOL_KIND,
  placeVertex,
  startSession,
  updatePreview,
} from '../domain/add/index';

import { DEFAULT_ADD_STYLE, buildAddPrimitives } from './add-batch';

const C = (lon: number, lat: number) => ({ lon, lat });

function face3() {
  let s = startSession(ADD_TOOL_KIND.Face);
  s = placeVertex(s, C(0, 0));
  s = placeVertex(s, C(2, 0));
  s = placeVertex(s, C(1, 2));
  return s;
}

describe('buildAddPrimitives (FR-78 / 教訓 5.18)', () => {
  it('a null session yields an empty frame', () => {
    expect(buildAddPrimitives(null)).toEqual([]);
  });

  it('draws a marker per placed vertex', () => {
    let s = startSession(ADD_TOOL_KIND.Line);
    s = placeVertex(s, C(0, 0));
    s = placeVertex(s, C(1, 1));
    const prims = buildAddPrimitives(s);
    const markers = prims.filter((p) => p.kind === 'point');
    expect(markers).toHaveLength(2);
  });

  it('draws the placed-edge polyline for line/face (≥2 vertices)', () => {
    let s = startSession(ADD_TOOL_KIND.Line);
    s = placeVertex(s, C(0, 0));
    s = placeVertex(s, C(1, 1));
    const lines = buildAddPrimitives(s).filter((p) => p.kind === 'line');
    expect(lines.length).toBeGreaterThanOrEqual(1);
  });

  it('a face closing line is TRANSLUCENT and only drawn once closable (≥3)', () => {
    // 2 vertices: not closable yet — no closing line.
    let s = startSession(ADD_TOOL_KIND.Face);
    s = placeVertex(s, C(0, 0));
    s = placeVertex(s, C(2, 0));
    const closingStroke = DEFAULT_ADD_STYLE.closingStroke;
    const before = buildAddPrimitives(s).filter(
      (p) => p.kind === 'line' && p.stroke === closingStroke,
    );
    expect(before).toHaveLength(0);

    // 3 vertices: closing line appears, with the translucent stroke.
    const s3 = face3();
    const closing = buildAddPrimitives(s3).filter(
      (p) => p.kind === 'line' && p.stroke === closingStroke,
    );
    expect(closing).toHaveLength(1);
    expect(closingStroke).toMatch(/rgba\(/);
  });

  it('a point tool never draws an edge or closing line', () => {
    let s = startSession(ADD_TOOL_KIND.Point);
    s = placeVertex(s, C(3, 3));
    s = updatePreview(s, C(4, 4));
    const lines = buildAddPrimitives(s).filter((p) => p.kind === 'line');
    expect(lines).toHaveLength(0);
  });

  it('draws a cursor-follow preview edge for line once a vertex + preview exist', () => {
    let s = startSession(ADD_TOOL_KIND.Line);
    s = placeVertex(s, C(0, 0));
    s = updatePreview(s, C(5, 5));
    const lines = buildAddPrimitives(s).filter((p) => p.kind === 'line');
    // The placed edge needs ≥2 vertices; with 1 vertex + preview the only line is
    // the preview edge.
    expect(lines).toHaveLength(1);
  });

  it('uses screen-fixed sizes (FR-17): marker radius / line width are px constants', () => {
    let s = startSession(ADD_TOOL_KIND.Line);
    s = placeVertex(s, C(0, 0));
    const marker = buildAddPrimitives(s).find((p) => p.kind === 'point');
    expect(marker && marker.kind === 'point' && marker.radiusPx).toBe(
      DEFAULT_ADD_STYLE.markerRadiusPx,
    );
  });
});

// --- 増分 3: 塗り（N-15）・琥珀の輪（吸着の予告）・赤い辺（N-51）--------------

describe('buildAddPrimitives — 描いている最中に見えるもの（増分 3）', () => {
  it('N-15: 面は 3 頂点そろうと半透明の塗りが出る（線だけでは形が読めなかった）', () => {
    const fills = buildAddPrimitives(face3()).filter((p) => p.kind === 'polygon');
    expect(fills).toHaveLength(1);
    expect(fills[0]).toMatchObject({ fill: DEFAULT_ADD_STYLE.draftFill });
  });

  it('N-15: 2 頂点までは塗らない（まだ面ではない）', () => {
    let s = startSession(ADD_TOOL_KIND.Face);
    s = placeVertex(s, C(0, 0));
    s = placeVertex(s, C(2, 0));
    expect(buildAddPrimitives(s).filter((p) => p.kind === 'polygon')).toHaveLength(0);
  });

  it('N-15: カーソルの位置も塗りの輪郭に入る（いま確定したらこの形、が読める）', () => {
    let s = startSession(ADD_TOOL_KIND.Face);
    s = placeVertex(s, C(0, 0));
    s = placeVertex(s, C(2, 0));
    s = updatePreview(s, C(1, 2));
    const fills = buildAddPrimitives(s).filter((p) => p.kind === 'polygon');
    expect(fills).toHaveLength(1);
    if (fills[0]?.kind === 'polygon') expect(fills[0].ring).toHaveLength(3);
  });

  it('閉じる辺は破線で描く（打った辺の実線と見分けが付く）', () => {
    const closing = buildAddPrimitives(face3()).find(
      (p) => p.kind === 'line' && p.stroke === DEFAULT_ADD_STYLE.closingStroke,
    );
    expect(closing).toBeDefined();
    if (closing?.kind === 'line') expect(closing.dashPx).toEqual(DEFAULT_ADD_STYLE.closingDashPx);
  });

  it('吸着の予告: 共有相手が居るときだけ、置かれる場所に琥珀の輪が出る', () => {
    let s = startSession(ADD_TOOL_KIND.Face);
    s = placeVertex(s, C(0, 0));
    // 押した場所は (5, 5) だが、置かれるのは吸着先の (4, 4)。輪は置かれる場所に描く。
    s = updatePreview(s, C(5, 5), {
      coordinate: C(4, 4),
      sharedCandidateId: 'f-1' as never,
    });
    const rings = buildAddPrimitives(s).filter((p) => p.kind === 'handle');
    expect(rings).toHaveLength(1);
    expect(rings[0]).toMatchObject({
      at: { lon: 4, lat: 4 },
      stroke: DEFAULT_ADD_STYLE.snapRingStroke,
      // 塗り透明 ＝ 純粋な輪（新しい primitive 種別を足さずに済ませている）。
      fill: 'rgba(0, 0, 0, 0)',
    });
  });

  it('吸着の予告: 共有相手が居ない（グリッド吸着・素の座標）なら輪は出ない', () => {
    let s = startSession(ADD_TOOL_KIND.Face);
    s = placeVertex(s, C(0, 0));
    s = updatePreview(s, C(5, 5), { coordinate: C(5, 5), sharedCandidateId: null });
    expect(buildAddPrimitives(s).filter((p) => p.kind === 'handle')).toHaveLength(0);
  });

  it('吸着の予告: 頂点を置いた瞬間に消える（教訓 5.2 一時状態は全経路で破棄）', () => {
    let s = startSession(ADD_TOOL_KIND.Face);
    s = updatePreview(s, C(5, 5), { coordinate: C(4, 4), sharedCandidateId: 'f-1' as never });
    s = placeVertex(s, C(4, 4), 'f-1' as never);
    expect(buildAddPrimitives(s).filter((p) => p.kind === 'handle')).toHaveLength(0);
  });

  it('N-51: 1 辺で経度 180 度以上を渡る辺は赤く描き直される', () => {
    let s = startSession(ADD_TOOL_KIND.Line);
    s = placeVertex(s, C(-100, 0));
    s = placeVertex(s, C(100, 0));
    const red = buildAddPrimitives(s).filter(
      (p) => p.kind === 'line' && p.stroke === DEFAULT_ADD_STYLE.longEdgeStroke,
    );
    expect(red).toHaveLength(1);
    if (red[0]?.kind === 'line') {
      expect(red[0].points).toEqual([{ lon: -100, lat: 0 }, { lon: 100, lat: 0 }]);
    }
  });

  it('N-51: 面の閉じる辺が長いときも赤くなる（確定を断る相手と同じ列を見ている）', () => {
    let s = startSession(ADD_TOOL_KIND.Face);
    s = placeVertex(s, C(0, 0));
    s = placeVertex(s, C(90, 5));
    s = placeVertex(s, C(181, 10));
    const red = buildAddPrimitives(s).filter(
      (p) => p.kind === 'line' && p.stroke === DEFAULT_ADD_STYLE.longEdgeStroke,
    );
    expect(red).toHaveLength(1);
    if (red[0]?.kind === 'line') {
      expect(red[0].points).toEqual([{ lon: 181, lat: 10 }, { lon: 0, lat: 0 }]);
    }
  });

  it('N-51: 短い辺だけなら赤い辺は 1 本も出ない', () => {
    const red = buildAddPrimitives(face3()).filter(
      (p) => p.kind === 'line' && p.stroke === DEFAULT_ADD_STYLE.longEdgeStroke,
    );
    expect(red).toHaveLength(0);
  });
});
