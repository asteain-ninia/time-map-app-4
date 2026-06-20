// U24 受け入れ基準8 / 9 — press→move→release state machine, click vs drag,
// transient discard on every path (教訓5.8 / 5.7 / 5.2 / 5.22).

import { describe, expect, it } from 'vitest';

import {
  beginDrag,
  updateDrag,
  isNoOp,
  dragDelta,
  discardDrag,
  EDIT_TOOL,
  NO_SLIDE,
  type DragTarget,
} from './drag-session';
import { coord, fid, vid, rid } from './fixtures';

const vertexTarget: DragTarget = {
  tool: EDIT_TOOL.VertexMove,
  featureId: fid('F'),
  vertexId: vid('v0'),
  ringId: rid('r0'),
};

describe('beginDrag (教訓5.8 押下で開始状態)', () => {
  it('opens a session with preview === start (a press that has not moved)', () => {
    const s = beginDrag(vertexTarget, coord(1, 2));
    expect(s.start).toEqual({ lon: 1, lat: 2 });
    expect(s.preview).toEqual(s.start);
    expect(s.slide).toEqual(NO_SLIDE);
    expect(s.snap).toBeNull();
    expect(s.draggedVertexId).toBe(vid('v0')); // vertex-move carries the dragged id
  });

  it('feature-move has no single dragged vertex id', () => {
    const s = beginDrag({ tool: EDIT_TOOL.FeatureMove, featureId: fid('F') }, coord(0, 0));
    expect(s.draggedVertexId).toBeUndefined();
  });
});

describe('isNoOp — click vs drag (受け入れ基準9 / 教訓5.24)', () => {
  it('a press+release at the same position is a no-op (click)', () => {
    const s = beginDrag(vertexTarget, coord(1, 2));
    expect(isNoOp(s)).toBe(true);
  });

  it('a drag back to the start position is also a no-op (zero net move)', () => {
    let s = beginDrag(vertexTarget, coord(1, 2));
    s = updateDrag(s, { preview: coord(3, 4) });
    s = updateDrag(s, { preview: coord(1, 2) });
    expect(isNoOp(s)).toBe(true);
  });

  it('a real move is not a no-op', () => {
    let s = beginDrag(vertexTarget, coord(1, 2));
    s = updateDrag(s, { preview: coord(3, 4) });
    expect(isNoOp(s)).toBe(false);
    expect(dragDelta(s)).toEqual({ dLon: 2, dLat: 2 });
  });
});

describe('updateDrag — transient only (教訓5.22 破壊更新しない)', () => {
  it('returns a NEW session leaving the previous one unchanged (immutable)', () => {
    const s0 = beginDrag(vertexTarget, coord(0, 0));
    const s1 = updateDrag(s0, { preview: coord(5, 5) });
    expect(s0.preview).toEqual({ lon: 0, lat: 0 }); // unchanged
    expect(s1.preview).toEqual({ lon: 5, lat: 5 });
    expect(s1).not.toBe(s0);
  });

  it('keeps prior slide/snap when not provided, and clears snap when null is passed', () => {
    let s = beginDrag(vertexTarget, coord(0, 0));
    s = updateDrag(s, { preview: coord(1, 0), snap: { vertexId: vid('t'), screenDistance: 5 } });
    expect(s.snap).not.toBeNull();
    s = updateDrag(s, { preview: coord(2, 0) }); // snap omitted → preserved
    expect(s.snap).not.toBeNull();
    s = updateDrag(s, { preview: coord(3, 0), snap: null }); // snap dropped (lapsed)
    expect(s.snap).toBeNull();
  });
});

describe('discardDrag — single discard funnel for all termination paths (教訓5.2)', () => {
  it('returns the idle sentinel (null) so cancel / tool-change / mode-change share it', () => {
    expect(discardDrag()).toBeNull();
  });
});
