// U25 — the hole/enclave add-draft state machine (FR-22 / FR-78, 受け入れ基準
// 1 / 7).

import { describe, expect, it } from 'vitest';
import { RING_ADD_MODE } from './auto-mode';
import {
  MIN_RING_VERTICES,
  UNDO_RESULT,
  canConfirm,
  placeFirstVertex,
  placeVertex,
  resetDraft,
  setGridSnap,
  startDraft,
  undoVertex,
  updatePreview,
} from './draft';
import { coord, fid } from './fixtures';

const TARGET = fid('F');

describe('ring-add draft (FR-22 / FR-78)', () => {
  it('starts with no mode, no vertices (mode decided on first click)', () => {
    const d = startDraft(TARGET);
    expect(d.mode).toBeNull();
    expect(d.vertices).toHaveLength(0);
    expect(canConfirm(d)).toBe(false);
  });

  it('first click freezes the mode; ≥3 vertices makes it confirmable', () => {
    let d = startDraft(TARGET);
    d = placeFirstVertex(d, coord(10, 10), RING_ADD_MODE.Hole);
    expect(d.mode).toBe(RING_ADD_MODE.Hole);
    d = placeVertex(d, coord(20, 10));
    expect(canConfirm(d)).toBe(false); // 2 < MIN_RING_VERTICES
    d = placeVertex(d, coord(20, 20));
    expect(d.vertices).toHaveLength(MIN_RING_VERTICES);
    expect(canConfirm(d)).toBe(true);
  });

  it('undo removes the last vertex; undoing the last one clears the mode', () => {
    let d = startDraft(TARGET);
    d = placeFirstVertex(d, coord(10, 10), RING_ADD_MODE.Enclave);
    d = placeVertex(d, coord(20, 10));
    const r1 = undoVertex(d);
    expect(r1.kind).toBe(UNDO_RESULT.Removed);
    if (r1.kind !== UNDO_RESULT.Removed) throw new Error('unreachable');
    expect(r1.draft.vertices).toHaveLength(1);
    expect(r1.draft.mode).toBe(RING_ADD_MODE.Enclave);

    const r2 = undoVertex(r1.draft);
    expect(r2.kind).toBe(UNDO_RESULT.Removed);
    if (r2.kind !== UNDO_RESULT.Removed) throw new Error('unreachable');
    expect(r2.draft.vertices).toHaveLength(0);
    expect(r2.draft.mode).toBeNull(); // mode never lingers past an empty list (教訓 5.2)
  });

  it('undo at zero vertices cancels the add (caller runs resetDraft)', () => {
    const d = startDraft(TARGET);
    expect(undoVertex(d).kind).toBe(UNDO_RESULT.Cancelled);
  });

  it('resetDraft discards everything (all transient state — 教訓 5.2)', () => {
    expect(resetDraft()).toBeNull();
  });

  it('grid-snap toggle + preview are independent transient fields', () => {
    let d = startDraft(TARGET, false);
    d = setGridSnap(d, true);
    expect(d.gridSnap).toBe(true);
    d = updatePreview(d, coord(5, 5));
    expect(d.preview).toEqual(coord(5, 5));
    // toggling preview / grid never adds a vertex.
    expect(d.vertices).toHaveLength(0);
  });

  it('placeVertex on an empty draft defaults the first click to enclave (教訓 5.7)', () => {
    let d = startDraft(TARGET);
    d = placeVertex(d, coord(1, 1));
    expect(d.mode).toBe(RING_ADD_MODE.Enclave);
    expect(d.vertices).toHaveLength(1);
  });
});
