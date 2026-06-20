// U22 selection reducer tests — input state → event → expected state (NFR 5.8).
// Covers 受け入れ基準 1 (active feature 0/1 + Escape), 2 (replace/toggle/range),
// 3 (simultaneous move = one op + no-op guard), 8 (transient discard on all paths).

import { describe, expect, it } from 'vitest';

import {
  EMPTY_HIT,
  featureBodyHit,
  vertexHit,
  type HitResult,
} from './contracts';
import {
  EMPTY_RECTANGLE_RESOLVER,
  SELECTION_EVENT,
  reduceSelection,
  type RectangleResolver,
  type SelectionEvent,
} from './reducer';
import {
  EMPTY_SELECTION,
  POINTER_PHASE,
  isInteracting,
  withActiveFeature,
  withVertexSet,
  type SelectionState,
} from './state';
import { coord, fid, vid, vidSet } from './fixtures';

function down(
  at: ReturnType<typeof coord>,
  hit: HitResult,
  shiftHeld = false,
): SelectionEvent {
  return { kind: SELECTION_EVENT.PointerDown, at, hit, shiftHeld };
}

function move(at: ReturnType<typeof coord>): SelectionEvent {
  return { kind: SELECTION_EVENT.PointerMove, at };
}

function up(at: ReturnType<typeof coord>): SelectionEvent {
  return { kind: SELECTION_EVENT.PointerUp, at };
}

const reduce = (s: SelectionState, e: SelectionEvent, opts = {}) =>
  reduceSelection(s, e, opts).state;

// --- 受け入れ基準 1: active feature 0/1 + Escape -----------------------------

describe('active feature (FR-79)', () => {
  it('a feature-body press makes it the sole active feature', () => {
    const next = reduce(EMPTY_SELECTION, down(coord(1, 1), featureBodyHit(fid('A'))));
    expect(next.activeFeature).toBe(fid('A'));
  });

  it('pressing a different feature replaces the active feature (still 0/1)', () => {
    const a = reduce(EMPTY_SELECTION, down(coord(1, 1), featureBodyHit(fid('A'))));
    const b = reduce(a, down(coord(2, 2), featureBodyHit(fid('B'))));
    expect(b.activeFeature).toBe(fid('B'));
  });

  it('selecting a feature body clears any prior vertex selection', () => {
    const withVerts = withVertexSet(EMPTY_SELECTION, fid('A'), vidSet('A-v0'));
    const next = reduce(withVerts, down(coord(1, 1), featureBodyHit(fid('A'))));
    expect(next.vertexIds.size).toBe(0);
    expect(next.vertexOwner).toBeNull();
    expect(next.activeFeature).toBe(fid('A'));
  });

  it('Escape clears active feature, vertex set, and transient (FR-79)', () => {
    const dirty = withVertexSet(
      withActiveFeature(EMPTY_SELECTION, fid('A')),
      fid('A'),
      vidSet('A-v0', 'A-v1'),
    );
    const next = reduce(dirty, { kind: SELECTION_EVENT.Escape });
    expect(next).toEqual(EMPTY_SELECTION);
  });

  it('a click on empty space clears the active feature', () => {
    const active = withActiveFeature(EMPTY_SELECTION, fid('A'));
    const pressed = reduce(active, down(coord(5, 5), EMPTY_HIT));
    // not moved: release on the same point clears (FR-79).
    const released = reduce(pressed, up(coord(5, 5)));
    expect(released.activeFeature).toBeNull();
  });
});

// --- 受け入れ基準 2: vertex set replace / toggle / range ---------------------

describe('vertex selection set (FR-80)', () => {
  it('plain click REPLACES the set with one vertex', () => {
    const start = withVertexSet(EMPTY_SELECTION, fid('A'), vidSet('A-v0', 'A-v1'));
    const next = reduce(start, down(coord(0, 0), vertexHit(fid('A'), vid('A-v2'))));
    expect(next.vertexIds).toEqual(vidSet('A-v2'));
    expect(next.vertexOwner).toBe(fid('A'));
  });

  it('shift+click ADDS an unselected vertex (toggle on)', () => {
    const start = withVertexSet(EMPTY_SELECTION, fid('A'), vidSet('A-v0'));
    const next = reduce(
      start,
      down(coord(0, 0), vertexHit(fid('A'), vid('A-v1')), true),
    );
    expect(next.vertexIds).toEqual(vidSet('A-v0', 'A-v1'));
  });

  it('shift+click REMOVES a selected vertex (toggle off)', () => {
    const start = withVertexSet(EMPTY_SELECTION, fid('A'), vidSet('A-v0', 'A-v1'));
    const next = reduce(
      start,
      down(coord(0, 0), vertexHit(fid('A'), vid('A-v1')), true),
    );
    expect(next.vertexIds).toEqual(vidSet('A-v0'));
  });

  it('toggling the last vertex off clears the owner (教訓 5.18)', () => {
    const start = withVertexSet(EMPTY_SELECTION, fid('A'), vidSet('A-v0'));
    const next = reduce(
      start,
      down(coord(0, 0), vertexHit(fid('A'), vid('A-v0')), true),
    );
    expect(next.vertexIds.size).toBe(0);
    expect(next.vertexOwner).toBeNull();
  });

  it('drag rectangle from empty space RANGE-selects the contained vertices', () => {
    const resolver: RectangleResolver = {
      verticesInRectangle: () => ({
        ownerFeatureId: fid('A'),
        vertexIds: vidSet('A-v0', 'A-v1', 'A-v2'),
      }),
    };
    let r = reduceSelection(EMPTY_SELECTION, down(coord(0, 0), EMPTY_HIT));
    r = reduceSelection(r.state, move(coord(10, 10)), { rectangle: resolver });
    r = reduceSelection(r.state, up(coord(10, 10)), { rectangle: resolver });
    expect(r.state.vertexIds).toEqual(vidSet('A-v0', 'A-v1', 'A-v2'));
    expect(r.state.vertexOwner).toBe(fid('A'));
  });

  it('shift + drag rectangle on the same owner ADDS to the existing set', () => {
    const resolver: RectangleResolver = {
      verticesInRectangle: () => ({
        ownerFeatureId: fid('A'),
        vertexIds: vidSet('A-v2'),
      }),
    };
    const start = withVertexSet(EMPTY_SELECTION, fid('A'), vidSet('A-v0'));
    let r = reduceSelection(start, down(coord(0, 0), EMPTY_HIT, true));
    r = reduceSelection(r.state, move(coord(10, 10)), { rectangle: resolver });
    r = reduceSelection(r.state, up(coord(10, 10)), { rectangle: resolver });
    expect(r.state.vertexIds).toEqual(vidSet('A-v0', 'A-v2'));
  });

  it('an empty rectangle (plain) clears the selection', () => {
    let r = reduceSelection(
      withVertexSet(EMPTY_SELECTION, fid('A'), vidSet('A-v0')),
      down(coord(0, 0), EMPTY_HIT),
    );
    r = reduceSelection(r.state, move(coord(10, 10)), {
      rectangle: EMPTY_RECTANGLE_RESOLVER,
    });
    r = reduceSelection(r.state, up(coord(10, 10)), {
      rectangle: EMPTY_RECTANGLE_RESOLVER,
    });
    expect(r.state.vertexIds.size).toBe(0);
  });

  it('an empty shift-rectangle leaves the existing set untouched', () => {
    const start = withVertexSet(EMPTY_SELECTION, fid('A'), vidSet('A-v0'));
    let r = reduceSelection(start, down(coord(0, 0), EMPTY_HIT, true));
    r = reduceSelection(r.state, move(coord(10, 10)), {
      rectangle: EMPTY_RECTANGLE_RESOLVER,
    });
    r = reduceSelection(r.state, up(coord(10, 10)), {
      rectangle: EMPTY_RECTANGLE_RESOLVER,
    });
    expect(r.state.vertexIds).toEqual(vidSet('A-v0'));
  });
});

// --- 受け入れ基準 3: simultaneous move = one op + no-op guard ----------------

describe('simultaneous move (FR-80 / FR-94)', () => {
  const multi = withVertexSet(EMPTY_SELECTION, fid('A'), vidSet('A-v0', 'A-v1', 'A-v2'));

  it('dragging a selected vertex emits ONE move over the whole set', () => {
    let r = reduceSelection(multi, down(coord(0, 0), vertexHit(fid('A'), vid('A-v0'))));
    r = reduceSelection(r.state, move(coord(3, 4)));
    expect(r.emittedMove).toBeNull(); // mid-drag frame is NOT a command (FR-94).
    r = reduceSelection(r.state, up(coord(3, 4)));
    expect(r.emittedMove).not.toBeNull();
    expect(r.emittedMove?.vertexIds).toEqual(vidSet('A-v0', 'A-v1', 'A-v2'));
    expect(r.emittedMove?.delta).toEqual({ dLon: 3, dLat: 4 });
  });

  it('a zero-vector confirm emits NO move (no-op guard, 教訓 5.24)', () => {
    let r = reduceSelection(multi, down(coord(2, 2), vertexHit(fid('A'), vid('A-v0'))));
    r = reduceSelection(r.state, up(coord(2, 2))); // released without moving.
    expect(r.emittedMove).toBeNull();
  });

  it('clicking (no move) an already-selected vertex REPLACES the set with it (受け入れ基準 2 / FR-80)', () => {
    // {v0,v1,v2} selected; plain press on the already-selected v0 then release
    // WITHOUT moving must collapse the set to {v0} — the click=replace path that
    // press-time arming alone would have dropped (教訓 5.8: replace on no-move).
    let r = reduceSelection(multi, down(coord(2, 2), vertexHit(fid('A'), vid('A-v0'))));
    r = reduceSelection(r.state, up(coord(2, 2))); // released on the same point.
    expect(r.state.vertexIds).toEqual(vidSet('A-v0'));
    expect(r.state.vertexOwner).toBe(fid('A'));
    expect(r.emittedMove).toBeNull(); // a click never emits a move.
    expect(isInteracting(r.state)).toBe(false); // transient discarded (教訓 5.2).
  });

  it('clicking (no move) a DIFFERENT already-selected vertex replaces with THAT one', () => {
    // Press on v2 (also selected) and release without moving → set becomes {v2}.
    let r = reduceSelection(multi, down(coord(2, 2), vertexHit(fid('A'), vid('A-v2'))));
    r = reduceSelection(r.state, up(coord(2, 2)));
    expect(r.state.vertexIds).toEqual(vidSet('A-v2'));
  });

  it('mid-drag frames never emit a command (only release does)', () => {
    let r = reduceSelection(multi, down(coord(0, 0), vertexHit(fid('A'), vid('A-v0'))));
    r = reduceSelection(r.state, move(coord(1, 1)));
    r = reduceSelection(r.state, move(coord(2, 2)));
    r = reduceSelection(r.state, move(coord(3, 3)));
    expect(r.emittedMove).toBeNull();
    r = reduceSelection(r.state, up(coord(3, 3)));
    expect(r.emittedMove?.delta).toEqual({ dLon: 3, dLat: 3 });
  });
});

// --- 受け入れ基準 8: transient discard on every path (教訓 5.2) --------------

describe('transient discard on all paths (教訓 5.2)', () => {
  it('select → cancel (Escape) → re-operate leaves no residual transient', () => {
    // Start a rectangle draft.
    let r = reduceSelection(EMPTY_SELECTION, down(coord(0, 0), EMPTY_HIT));
    r = reduceSelection(r.state, move(coord(5, 5)));
    expect(isInteracting(r.state)).toBe(true);
    // Cancel.
    r = reduceSelection(r.state, { kind: SELECTION_EVENT.Escape });
    expect(isInteracting(r.state)).toBe(false);
    // Re-operate: a fresh feature click works cleanly.
    r = reduceSelection(r.state, down(coord(1, 1), featureBodyHit(fid('A'))));
    expect(r.state.activeFeature).toBe(fid('A'));
    expect(isInteracting(r.state)).toBe(false);
  });

  it('select → confirm (release) → re-operate leaves no residual transient', () => {
    const multi = withVertexSet(EMPTY_SELECTION, fid('A'), vidSet('A-v0', 'A-v1'));
    let r = reduceSelection(multi, down(coord(0, 0), vertexHit(fid('A'), vid('A-v0'))));
    r = reduceSelection(r.state, move(coord(2, 2)));
    r = reduceSelection(r.state, up(coord(2, 2)));
    expect(isInteracting(r.state)).toBe(false);
    // Re-operate immediately: a new drag starts from a clean baseline.
    r = reduceSelection(r.state, down(coord(2, 2), vertexHit(fid('A'), vid('A-v0'))));
    r = reduceSelection(r.state, up(coord(2, 2)));
    expect(r.emittedMove).toBeNull(); // zero vector from the new baseline.
    expect(isInteracting(r.state)).toBe(false);
  });

  it('Reset (tool/mode switch) discards transient AND selection', () => {
    let r = reduceSelection(
      withActiveFeature(EMPTY_SELECTION, fid('A')),
      down(coord(0, 0), EMPTY_HIT),
    );
    r = reduceSelection(r.state, move(coord(5, 5)));
    r = reduceSelection(r.state, { kind: SELECTION_EVENT.Reset });
    expect(r.state).toEqual(EMPTY_SELECTION);
  });

  it('a fresh press always starts from a clean transient (教訓 5.8)', () => {
    // Begin a rectangle but never release; then a new press elsewhere.
    let r = reduceSelection(EMPTY_SELECTION, down(coord(0, 0), EMPTY_HIT));
    r = reduceSelection(r.state, move(coord(5, 5)));
    // New press on a vertex resets the draft.
    r = reduceSelection(
      withVertexSet(r.state, fid('A'), vidSet('A-v0')),
      down(coord(1, 1), vertexHit(fid('A'), vid('A-v0'))),
    );
    expect(r.state.transient.phase).toBe(POINTER_PHASE.VertexDrag);
  });
});

// --- press → move → release full coverage (教訓 5.8) ------------------------

describe('press → move → release sequence (教訓 5.8)', () => {
  it('a freshly-clicked vertex can be dragged immediately (all paths)', () => {
    let r = reduceSelection(EMPTY_SELECTION, down(coord(0, 0), vertexHit(fid('A'), vid('A-v0'))));
    expect(r.state.vertexIds).toEqual(vidSet('A-v0')); // click committed on press.
    expect(r.state.transient.phase).toBe(POINTER_PHASE.VertexDrag); // armed.
    r = reduceSelection(r.state, move(coord(5, 0)));
    r = reduceSelection(r.state, up(coord(5, 0)));
    expect(r.emittedMove?.vertexIds).toEqual(vidSet('A-v0'));
    expect(r.emittedMove?.delta).toEqual({ dLon: 5, dLat: 0 });
  });

  it('a move with no transient in progress is a no-op (hover ≠ selection)', () => {
    const r = reduceSelection(EMPTY_SELECTION, move(coord(9, 9)));
    expect(r.state).toEqual(EMPTY_SELECTION);
  });
});
