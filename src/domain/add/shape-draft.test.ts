import { describe, expect, it } from 'vitest';

import {
  ADD_TOOL_KIND,
  placeVertex,
  startSession,
} from './session';
import {
  CONFIRM_STATUS,
  MAX_EDGE_LON_SPAN_DEG,
  SHAPE_REJECT,
  confirmShape,
  draftCoordinates,
  isClosedTool,
  longEdgeStartIndexes,
} from './shape-draft';

const C = (lon: number, lat: number) => ({ lon, lat });

function withVertices(tool: Parameters<typeof startSession>[0], coords: ReadonlyArray<readonly [number, number]>) {
  let s = startSession(tool);
  for (const [lon, lat] of coords) s = placeVertex(s, C(lon, lat));
  return s;
}

describe('confirmShape (FR-76 minimum vertices)', () => {
  it('point: 1 vertex confirms', () => {
    const r = confirmShape(withVertices(ADD_TOOL_KIND.Point, [[0, 0]]));
    expect(r.status).toBe(CONFIRM_STATUS.Ok);
  });

  it('point: 0 vertices rejected as too few', () => {
    const r = confirmShape(startSession(ADD_TOOL_KIND.Point));
    expect(r.status).toBe(CONFIRM_STATUS.Rejected);
    if (r.status === CONFIRM_STATUS.Rejected) {
      expect(r.rejection.kind).toBe(SHAPE_REJECT.TooFewVertices);
    }
  });

  it('line: <2 rejected, ≥2 ok', () => {
    expect(confirmShape(withVertices(ADD_TOOL_KIND.Line, [[0, 0]])).status).toBe(
      CONFIRM_STATUS.Rejected,
    );
    const ok = confirmShape(withVertices(ADD_TOOL_KIND.Line, [[0, 0], [1, 1]]));
    expect(ok.status).toBe(CONFIRM_STATUS.Ok);
  });

  it('face: <3 rejected, ≥3 ok', () => {
    expect(
      confirmShape(withVertices(ADD_TOOL_KIND.Face, [[0, 0], [1, 0]])).status,
    ).toBe(CONFIRM_STATUS.Rejected);
    const ok = confirmShape(withVertices(ADD_TOOL_KIND.Face, [[0, 0], [2, 0], [1, 2]]));
    expect(ok.status).toBe(CONFIRM_STATUS.Ok);
  });

  it('too-few rejection carries required/actual for the message (FR-115)', () => {
    const r = confirmShape(withVertices(ADD_TOOL_KIND.Face, [[0, 0]]));
    if (r.status === CONFIRM_STATUS.Rejected) {
      expect(r.rejection.required).toBe(3);
      expect(r.rejection.actual).toBe(1);
    }
  });

  it('face: a self-intersecting ring is rejected (FR-25)', () => {
    // Bowtie: (0,0)-(2,2)-(2,0)-(0,2) self-intersects.
    const r = confirmShape(
      withVertices(ADD_TOOL_KIND.Face, [[0, 0], [2, 2], [2, 0], [0, 2]]),
    );
    expect(r.status).toBe(CONFIRM_STATUS.Rejected);
    if (r.status === CONFIRM_STATUS.Rejected) {
      expect(r.rejection.kind).toBe(SHAPE_REJECT.SelfIntersecting);
    }
  });

  it('D7: 一直線に並んだ 3 点は「面積がありません」で断る（自己交差ではない）', () => {
    // バグ狩り #11: 実データで一直線の 3 点を確定すると「面の輪郭が自己交差しています。
    // 交差しない形状にしてください。」と出ていた。何を直せばよいのか分からない案内である。
    const r = confirmShape(withVertices(ADD_TOOL_KIND.Face, [[0, 0], [1, 1], [2, 2]]));
    expect(r.status).toBe(CONFIRM_STATUS.Rejected);
    if (r.status === CONFIRM_STATUS.Rejected) {
      expect(r.rejection.kind).toBe(SHAPE_REJECT.NoArea);
    }
  });

  it('D7: 同じ点を 3 つ打った形も「面積がありません」', () => {
    const r = confirmShape(withVertices(ADD_TOOL_KIND.Face, [[1, 1], [1, 1], [1, 1]]));
    expect(r.status).toBe(CONFIRM_STATUS.Rejected);
    if (r.status === CONFIRM_STATUS.Rejected) {
      expect(r.rejection.kind).toBe(SHAPE_REJECT.NoArea);
    }
  });

  it('D7: ふつうの三角形は通る（一直線の判定が広すぎない）', () => {
    const r = confirmShape(withVertices(ADD_TOOL_KIND.Face, [[0, 0], [2, 0], [1, 2]]));
    expect(r.status).toBe(CONFIRM_STATUS.Ok);
  });

  it('produces a draft whose coordinates match the placed vertices', () => {
    const r = confirmShape(withVertices(ADD_TOOL_KIND.Line, [[0, 0], [3, 4]]));
    if (r.status === CONFIRM_STATUS.Ok) {
      expect(draftCoordinates(r.draft)).toEqual([C(0, 0), C(3, 4)]);
    }
  });
});


// --- N-51: 1 辺で経度 180 度以上を渡る形（技術方針 §6.8）---------------------
//
// 保存形式は「隣り合う頂点は最短方向で繋がっている」と仮定して経度を連続量へ戻すので、
// 1 辺で 180 度以上を渡る形は保存して読み直すと必ず別の形になる。**書く側で止める以外に
// 手が無い**（開発ガイド §5.43 の実例そのもの）。

describe('longEdgeStartIndexes（N-51 / 技術方針 §6.8）', () => {
  it('180 度未満の辺しか無ければ 1 本も返さない', () => {
    expect(longEdgeStartIndexes([C(0, 0), C(170, 0), C(170, 10)], false)).toEqual([]);
  });

  it('ちょうど 180 度の辺も「渡れない」に数える（どちら回りか決まらないため）', () => {
    expect(longEdgeStartIndexes([C(-90, 0), C(90, 0)], false)).toEqual([0]);
    expect(MAX_EDGE_LON_SPAN_DEG).toBe(180);
  });

  it('開いた列では最後の頂点から先頭へ戻る辺を見ない', () => {
    // 0 → 100 → 199 はどの辺も 180 度未満。閉じれば 199 → 0 が 199 度で引っかかる。
    const ring = [C(0, 0), C(100, 1), C(199, 2)];
    expect(longEdgeStartIndexes(ring, false)).toEqual([]);
    expect(longEdgeStartIndexes(ring, true)).toEqual([2]);
  });

  it('閉じるのは面だけ', () => {
    expect(isClosedTool(ADD_TOOL_KIND.Face)).toBe(true);
    expect(isClosedTool(ADD_TOOL_KIND.Line)).toBe(false);
    expect(isClosedTool(ADD_TOOL_KIND.Point)).toBe(false);
  });
});

describe('confirmShape（N-51 の関門）', () => {
  it('線: 1 辺で 180 度以上を渡ると確定を断る', () => {
    const r = confirmShape(withVertices(ADD_TOOL_KIND.Line, [[-100, 0], [100, 0]]));
    expect(r.status).toBe(CONFIRM_STATUS.Rejected);
    if (r.status === CONFIRM_STATUS.Rejected) {
      expect(r.rejection.kind).toBe(SHAPE_REJECT.LongEdge);
      expect(r.rejection.longEdgeCount).toBe(1);
    }
  });

  it('線: 途中に点を打てば同じ形が通る（直し方が実際に効く）', () => {
    const r = confirmShape(
      withVertices(ADD_TOOL_KIND.Line, [[-100, 0], [0, 0], [100, 0]]),
    );
    expect(r.status).toBe(CONFIRM_STATUS.Ok);
  });

  it('面: 幅 199 度の四角は断る（実測 N-51 の形。上下 2 辺が引っかかる）', () => {
    const r = confirmShape(
      withVertices(ADD_TOOL_KIND.Face, [[0, 0], [199, 0], [199, 20], [0, 20]]),
    );
    expect(r.status).toBe(CONFIRM_STATUS.Rejected);
    if (r.status === CONFIRM_STATUS.Rejected) {
      expect(r.rejection.kind).toBe(SHAPE_REJECT.LongEdge);
      expect(r.rejection.longEdgeCount).toBe(2);
    }
  });

  it('面: 閉じる辺だけが 180 度以上でも断る（打った辺はどれも短い）', () => {
    // 0 → 90 → 179 はどれも 180 度未満だが、179 → 0 へ閉じる辺が 179 度…では通るので
    // 閉じる辺だけが引っかかる形を作る: 0 → 90 → 181（90 → 181 は 91 度）で、
    // 閉じる辺 181 → 0 が 181 度になる。
    const r = confirmShape(withVertices(ADD_TOOL_KIND.Face, [[0, 0], [90, 5], [181, 10]]));
    expect(r.status).toBe(CONFIRM_STATUS.Rejected);
    if (r.status === CONFIRM_STATUS.Rejected) {
      expect(r.rejection.kind).toBe(SHAPE_REJECT.LongEdge);
      expect(r.rejection.longEdgeCount).toBe(1);
    }
  });

  it('点は辺を持たないので、この関門を素通りする', () => {
    const r = confirmShape(withVertices(ADD_TOOL_KIND.Point, [[179, 0]]));
    expect(r.status).toBe(CONFIRM_STATUS.Ok);
  });
});
