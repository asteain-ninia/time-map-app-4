import { describe, expect, it } from 'vitest';

import { asFeatureId } from '../ids';

import {
  ADD_TOOL_KIND,
  parentSelectableFor,
  PARENT_SELECTION_KIND,
  PARENT_TOP_LEVEL,
  PARENT_UNSET,
  UNDO_RESULT,
  canConfirm,
  isNestingInside,
  minVerticesFor,
  parentSelection,
  placeVertex,
  resetSession,
  revalidateParent,
  setGridSnap,
  setParentSelection,
  startSession,
  undoVertex,
  updatePreview,
} from './session';

const C = (lon: number, lat: number) => ({ lon, lat });

describe('startSession (教訓 5.2 開始時クリア)', () => {
  it('creates an empty session for the tool, no vertices/preview, parent unset', () => {
    const s = startSession(ADD_TOOL_KIND.Line);
    expect(s.tool).toBe(ADD_TOOL_KIND.Line);
    expect(s.vertices).toEqual([]);
    expect(s.preview).toBeNull();
    expect(s.gridSnap).toBe(false);
    expect(s.parent).toEqual(PARENT_UNSET);
  });

  it('carries the grid-snap preference forward', () => {
    expect(startSession(ADD_TOOL_KIND.Face, true).gridSnap).toBe(true);
  });
});

describe('minVerticesFor (FR-76)', () => {
  it('point=1 line=2 face=3', () => {
    expect(minVerticesFor(ADD_TOOL_KIND.Point)).toBe(1);
    expect(minVerticesFor(ADD_TOOL_KIND.Line)).toBe(2);
    expect(minVerticesFor(ADD_TOOL_KIND.Face)).toBe(3);
  });
});

describe('placeVertex', () => {
  it('appends in click order for line/face', () => {
    let s = startSession(ADD_TOOL_KIND.Face);
    s = placeVertex(s, C(0, 0));
    s = placeVertex(s, C(1, 0));
    s = placeVertex(s, C(1, 1));
    expect(s.vertices.map((v) => v.coordinate)).toEqual([C(0, 0), C(1, 0), C(1, 1)]);
  });

  it('a point holds at most one vertex (re-click relocates)', () => {
    let s = startSession(ADD_TOOL_KIND.Point);
    s = placeVertex(s, C(0, 0));
    s = placeVertex(s, C(5, 5));
    expect(s.vertices).toHaveLength(1);
    expect(s.vertices[0]?.coordinate).toEqual(C(5, 5));
  });

  it('records a shared-vertex candidate when provided (FR-30〜33)', () => {
    const fid = asFeatureId('f1');
    let s = startSession(ADD_TOOL_KIND.Line);
    s = placeVertex(s, C(0, 0), fid);
    expect(s.vertices[0]?.sharedCandidateId).toBe(fid);
  });
});

describe('updatePreview', () => {
  it('sets the cursor-follow preview point', () => {
    const s = updatePreview(startSession(ADD_TOOL_KIND.Line), C(2, 3));
    expect(s.preview).toEqual(C(2, 3));
  });
});

describe('undoVertex (FR-78 / 注意点: 0頂点での取消)', () => {
  it('removes the last vertex one at a time', () => {
    let s = startSession(ADD_TOOL_KIND.Face);
    s = placeVertex(s, C(0, 0));
    s = placeVertex(s, C(1, 0));
    const r = undoVertex(s);
    expect(r.kind).toBe(UNDO_RESULT.Removed);
    if (r.kind === UNDO_RESULT.Removed) {
      expect(r.session.vertices).toHaveLength(1);
    }
  });

  it('cancels the add when undoing at 0 vertices (defined behavior)', () => {
    const s = startSession(ADD_TOOL_KIND.Line);
    expect(undoVertex(s).kind).toBe(UNDO_RESULT.Cancelled);
  });
});

describe('resetSession (教訓 5.2 全経路で破棄)', () => {
  it('discards the session entirely (returns null)', () => {
    expect(resetSession()).toBeNull();
  });
});

describe('grid snap toggle (FR-78)', () => {
  it('toggles the draft flag', () => {
    const s = setGridSnap(startSession(ADD_TOOL_KIND.Point), true);
    expect(s.gridSnap).toBe(true);
  });
});

describe('parent selection (FR-77 / FR-39, 教訓 5.18)', () => {
  it('unset / top-level / chosen-parent are three distinct states', () => {
    const fid = asFeatureId('p1');
    expect(PARENT_UNSET.kind).toBe(PARENT_SELECTION_KIND.Unset);
    expect(PARENT_TOP_LEVEL.kind).toBe(PARENT_SELECTION_KIND.TopLevel);
    expect(parentSelection(fid)).toEqual({
      kind: PARENT_SELECTION_KIND.Parent,
      parentId: fid,
    });
  });

  it('setParentSelection stores the choice', () => {
    const fid = asFeatureId('p1');
    const s = setParentSelection(startSession(ADD_TOOL_KIND.Face), parentSelection(fid));
    expect(s.parent).toEqual(parentSelection(fid));
  });

  it('revalidateParent clears an ineligible chosen parent (教訓 5.5)', () => {
    const fid = asFeatureId('p1');
    const s = setParentSelection(startSession(ADD_TOOL_KIND.Face), parentSelection(fid));
    const cleared = revalidateParent(s, new Set([asFeatureId('other')]));
    expect(cleared.parent).toEqual(PARENT_UNSET);
  });

  it('revalidateParent keeps an eligible chosen parent', () => {
    const fid = asFeatureId('p1');
    const s = setParentSelection(startSession(ADD_TOOL_KIND.Face), parentSelection(fid));
    const kept = revalidateParent(s, new Set([fid]));
    expect(kept.parent).toEqual(parentSelection(fid));
  });

  it('revalidateParent leaves unset / top-level untouched', () => {
    const u = startSession(ADD_TOOL_KIND.Face);
    expect(revalidateParent(u, new Set()).parent).toEqual(PARENT_UNSET);
    const t = setParentSelection(u, PARENT_TOP_LEVEL);
    expect(revalidateParent(t, new Set()).parent).toEqual(PARENT_TOP_LEVEL);
  });
});

describe('canConfirm (FR-76 完了可否)', () => {
  it('point needs 1, line 2, face 3', () => {
    let p = startSession(ADD_TOOL_KIND.Point);
    expect(canConfirm(p)).toBe(false);
    p = placeVertex(p, C(0, 0));
    expect(canConfirm(p)).toBe(true);

    let l = startSession(ADD_TOOL_KIND.Line);
    l = placeVertex(l, C(0, 0));
    expect(canConfirm(l)).toBe(false);
    l = placeVertex(l, C(1, 0));
    expect(canConfirm(l)).toBe(true);

    let f = startSession(ADD_TOOL_KIND.Face);
    f = placeVertex(f, C(0, 0));
    f = placeVertex(f, C(1, 0));
    expect(canConfirm(f)).toBe(false);
    f = placeVertex(f, C(1, 1));
    expect(canConfirm(f)).toBe(true);
  });
});

// --- 入れ子の見分け（増分 3 の手直し B1 / FR-29 の但し書き）--------------------
//
// 規則（司令塔の決定。所有者が覆せる）: 打った頂点が全部、**同じ末端の内側または境界の上**
// なら入れ子とみなす。境界を数えるのが手直しで塞いだ穴で、これが無いと
// 「親の角へ吸着した頂点」が入るたびに入れ子と認められず、**打つ順で結果が変わった**。

describe('isNestingInside（入れ子の見分け。FR-29 の但し書き）', () => {
  const PARENT = asFeatureId('f-parent');
  const OTHER = asFeatureId('f-other');
  const inside = (s: ReturnType<typeof startSession>, lon: number, lat: number, id = PARENT) =>
    placeVertex(s, C(lon, lat), null, null, id, null, null);
  const onBoundary = (s: ReturnType<typeof startSession>, lon: number, lat: number, id = PARENT) =>
    placeVertex(s, C(lon, lat), null, null, null, null, id);
  const outside = (s: ReturnType<typeof startSession>, lon: number, lat: number) =>
    placeVertex(s, C(lon, lat));

  it('頂点が 1 つも無ければ真（これから内側に描き始めるところ）', () => {
    expect(isNestingInside(startSession(ADD_TOOL_KIND.Face), PARENT)).toBe(true);
  });

  it('全部その面の内側なら入れ子', () => {
    let s = startSession(ADD_TOOL_KIND.Face);
    s = inside(s, 1, 1);
    s = inside(s, 2, 1);
    expect(isNestingInside(s, PARENT)).toBe(true);
  });

  it('境界（線）の上に載った頂点も「その面の側」に数える', () => {
    let s = startSession(ADD_TOOL_KIND.Face);
    s = onBoundary(s, 0, 0); // 親の角へ吸着した点
    s = inside(s, 1, 1);
    expect(isNestingInside(s, PARENT)).toBe(true);
  });

  it('打つ順が変わっても結果が変わらない（境界の点が先でも後でも入れ子）', () => {
    let a = startSession(ADD_TOOL_KIND.Face);
    a = onBoundary(a, 0, 0);
    a = inside(a, 1, 1);
    a = inside(a, 2, 2);

    let b = startSession(ADD_TOOL_KIND.Face);
    b = inside(b, 1, 1);
    b = inside(b, 2, 2);
    b = onBoundary(b, 0, 0);

    expect(isNestingInside(a, PARENT)).toBe(isNestingInside(b, PARENT));
    expect(isNestingInside(a, PARENT)).toBe(true);
  });

  it('1 つでも外に打っていたら入れ子ではない（＝隣を描いていて誤って重ねた事故）', () => {
    let s = startSession(ADD_TOOL_KIND.Face);
    s = outside(s, 50, 50); // どの面にも触れていない海の上
    s = inside(s, 1, 1);
    expect(isNestingInside(s, PARENT)).toBe(false);
  });

  it('別の面の内側／境界は数えない（親をまたぐ形は入れ子ではない）', () => {
    let s = startSession(ADD_TOOL_KIND.Face);
    s = inside(s, 1, 1, OTHER);
    s = inside(s, 2, 2, PARENT);
    expect(isNestingInside(s, PARENT)).toBe(false);

    let t = startSession(ADD_TOOL_KIND.Face);
    t = onBoundary(t, 0, 0, OTHER);
    t = inside(t, 2, 2, PARENT);
    expect(isNestingInside(t, PARENT)).toBe(false);
  });

  it('穴の中（＝その面の外）に打った点は数えない', () => {
    // 穴の内側は `pointInPolygon` が「面の外」と答えるので、供給元は内側の記録を付けない。
    // ここではその結果（記録が付かない）を受けて偽になることを固定する。
    let s = startSession(ADD_TOOL_KIND.Face);
    s = inside(s, 1, 1);
    s = outside(s, 3, 3); // 親の穴の中を押した
    expect(isNestingInside(s, PARENT)).toBe(false);
  });
});

describe('parentSelectableFor（2026-09-06、2 回目の手直しの調査 8）', () => {
  // 上位領域を聞くのは面だけ。この述語が無かったころ、素性欄は面のときしか上位領域の
  // 欄を出さないのに **既定の上位領域を決める側は全部の道具で走って**いて、点を 1 つ
  // 打つだけで「その点が落ちた面」が黙って親になり、開き直すと親の面が
  // 「末端なのに子を持つ」で修復ダイアログを出した。
  it('面だけが上位領域を選ぶ（点・線は選ばない）', () => {
    expect(parentSelectableFor(ADD_TOOL_KIND.Face)).toBe(true);
    expect(parentSelectableFor(ADD_TOOL_KIND.Point)).toBe(false);
    expect(parentSelectableFor(ADD_TOOL_KIND.Line)).toBe(false);
  });
});
