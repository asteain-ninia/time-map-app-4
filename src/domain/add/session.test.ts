import { describe, expect, it } from 'vitest';

import { asFeatureId } from '../ids';

import {
  ADD_TOOL_KIND,
  PARENT_SELECTION_KIND,
  PARENT_TOP_LEVEL,
  PARENT_UNSET,
  UNDO_RESULT,
  canConfirm,
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
