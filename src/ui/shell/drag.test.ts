// U20 pure-logic tests: the drag state machine on ALL paths (教訓 5.8,
// 受け入れ基準 5).

import { describe, expect, it } from 'vitest';

import {
  IDLE_DRAG,
  dragReducer,
  wasClick,
  type DragState,
} from './drag';

const at = (x: number, y: number) => ({ x, y });

describe('dragReducer (教訓 5.8: 全パスで開始・更新・終了)', () => {
  it('press enters dragging with origin recorded', () => {
    const s = dragReducer(IDLE_DRAG, {
      type: 'press',
      pointer: at(10, 10),
      panelPosition: at(100, 100),
    });
    expect(s.status).toBe('dragging');
    if (s.status === 'dragging') {
      expect(s.position).toEqual(at(100, 100));
      expect(s.moved).toBe(false);
    }
  });

  it('move past threshold flips moved and tracks position', () => {
    let s: DragState = dragReducer(IDLE_DRAG, {
      type: 'press',
      pointer: at(0, 0),
      panelPosition: at(50, 50),
    });
    s = dragReducer(s, { type: 'move', pointer: at(20, 5) });
    expect(s.status).toBe('dragging');
    if (s.status === 'dragging') {
      expect(s.moved).toBe(true);
      expect(s.position).toEqual(at(70, 55));
    }
  });

  it('a tiny move under threshold does NOT count as a drag', () => {
    let s: DragState = dragReducer(IDLE_DRAG, {
      type: 'press',
      pointer: at(0, 0),
      panelPosition: at(0, 0),
    });
    s = dragReducer(s, { type: 'move', pointer: at(1, 1) });
    expect(s.status === 'dragging' && s.moved).toBe(false);
  });

  it('release ALWAYS clears to idle — drag path', () => {
    let s: DragState = dragReducer(IDLE_DRAG, {
      type: 'press',
      pointer: at(0, 0),
      panelPosition: at(0, 0),
    });
    s = dragReducer(s, { type: 'move', pointer: at(40, 40) });
    s = dragReducer(s, { type: 'release' });
    expect(s).toEqual(IDLE_DRAG);
  });

  it('release ALWAYS clears to idle — click-only path (no move, 教訓 5.8)', () => {
    let s: DragState = dragReducer(IDLE_DRAG, {
      type: 'press',
      pointer: at(5, 5),
      panelPosition: at(0, 0),
    });
    // The click path: detect it BEFORE release clears the state.
    expect(wasClick(s)).toBe(true);
    s = dragReducer(s, { type: 'release' });
    expect(s).toEqual(IDLE_DRAG);
  });

  it('move/release while idle are no-ops (lost pointer-up never sticks)', () => {
    expect(dragReducer(IDLE_DRAG, { type: 'move', pointer: at(1, 1) })).toEqual(IDLE_DRAG);
    expect(dragReducer(IDLE_DRAG, { type: 'release' })).toEqual(IDLE_DRAG);
  });

  it('wasClick is false once a real drag occurred', () => {
    let s: DragState = dragReducer(IDLE_DRAG, {
      type: 'press',
      pointer: at(0, 0),
      panelPosition: at(0, 0),
    });
    s = dragReducer(s, { type: 'move', pointer: at(50, 0) });
    expect(wasClick(s)).toBe(false);
  });
});
