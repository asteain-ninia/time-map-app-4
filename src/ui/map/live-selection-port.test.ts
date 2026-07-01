// FR-80 rubber-band wiring — the LIVE {@link SelectionPort} unit lens (教訓 5.7 配線欠落).
//
// Locks the empty-space DRAG → rectangle-select path the composition root now wires:
//   - an empty-space DRAG rubber-band-selects the vertices the injected resolver reports
//     (plain = replace, Shift = add), driving U22's OWN reducer (単一真実源, 教訓 5.29);
//   - a VERTEX / FEATURE-BODY drag NEVER enters the rectangle path (that gesture is the
//     U24 edit-session's — the port must not double-drive it): a non-empty drag selects
//     nothing, and the resolver is never consulted;
//   - a click (no drag) keeps the verbatim body/vertex/empty click semantics.
//
// The port is exercised through a fake store seam + a fake screen→world + a fake
// resolver, so the exact reducer semantics are asserted without a renderer (受け入れ基準 8).

import { describe, expect, it, vi } from 'vitest';

import { createLiveSelectionPort } from './live-selection-port';
import { NO_MODIFIERS } from './ports';
import {
  EMPTY_HIT,
  EMPTY_SELECTION,
  featureBodyHit,
  vertexHit,
  withVertexSet,
  type RectangleHit,
  type RectangleResolver,
  type SelectionState,
} from '../../domain/selection';
import { fid, vid, vidSet } from '../../domain/selection/fixtures';
import type { ScreenPoint } from '../../render';

/** A mutable store seam over one selection value (the U22 truth the port writes back). */
function fakeSeam(initial: SelectionState = EMPTY_SELECTION) {
  let selection = initial;
  return {
    getSelection: () => selection,
    restoreSelection: (s: SelectionState) => {
      selection = s;
    },
    current: () => selection,
  };
}

/** A screen→world that maps screen (x, y) straight to world (lon = x, lat = y). */
const screenToWorld = (p: ScreenPoint) => ({ lon: p.x, lat: p.y });

const SHIFT = { ...NO_MODIFIERS, shift: true };

describe('createLiveSelectionPort — rubber-band rectangle (FR-80)', () => {
  it('an empty-space DRAG selects the vertices the resolver reports (plain = replace)', () => {
    const seam = fakeSeam();
    const inside: RectangleHit = {
      ownerFeatureId: fid('A'),
      vertexIds: vidSet('a0', 'a1'),
    };
    const resolver: RectangleResolver = {
      verticesInRectangle: vi.fn(() => inside),
    };
    const port = createLiveSelectionPort(seam, screenToWorld, resolver);

    // Press on EMPTY space, drag to an opposite corner, release as a DRAG.
    port.start(EMPTY_HIT, { x: 10, y: 10 }, NO_MODIFIERS);
    port.move({ x: 40, y: 40 });
    port.end({ x: 40, y: 40 }, true);

    // The resolver was consulted with the drag's WORLD corners (screen→world).
    expect(resolver.verticesInRectangle).toHaveBeenCalledWith(
      { lon: 10, lat: 10 },
      { lon: 40, lat: 40 },
    );
    // The selection is REPLACED with the reported inside set under its owner.
    expect(seam.current().vertexOwner).toBe(fid('A'));
    expect(seam.current().vertexIds).toEqual(vidSet('a0', 'a1'));
  });

  it('a Shift + empty-space DRAG ADDS the inside vertices to the existing set (same owner)', () => {
    const seam = fakeSeam(withVertexSet(EMPTY_SELECTION, fid('A'), vidSet('a0')));
    const resolver: RectangleResolver = {
      verticesInRectangle: () => ({ ownerFeatureId: fid('A'), vertexIds: vidSet('a1', 'a2') }),
    };
    const port = createLiveSelectionPort(seam, screenToWorld, resolver);

    port.start(EMPTY_HIT, { x: 0, y: 0 }, SHIFT);
    port.move({ x: 5, y: 5 });
    port.end({ x: 5, y: 5 }, true);

    // Shift + rectangle on the SAME owner adds to the existing set (FR-80).
    expect(seam.current().vertexOwner).toBe(fid('A'));
    expect(seam.current().vertexIds).toEqual(vidSet('a0', 'a1', 'a2'));
  });

  it('an empty rubber-band (resolver → null) clears a plain drag but keeps a Shift drag', () => {
    const nullResolver: RectangleResolver = { verticesInRectangle: () => null };

    // Plain drag over nothing → selection cleared.
    const plain = fakeSeam(withVertexSet(EMPTY_SELECTION, fid('A'), vidSet('a0')));
    const p1 = createLiveSelectionPort(plain, screenToWorld, nullResolver);
    p1.start(EMPTY_HIT, { x: 0, y: 0 }, NO_MODIFIERS);
    p1.end({ x: 9, y: 9 }, true);
    expect(plain.current().vertexIds.size).toBe(0);

    // Shift drag over nothing → existing set untouched (教訓 5.18 nothing-inside).
    const shift = fakeSeam(withVertexSet(EMPTY_SELECTION, fid('A'), vidSet('a0')));
    const p2 = createLiveSelectionPort(shift, screenToWorld, nullResolver);
    p2.start(EMPTY_HIT, { x: 0, y: 0 }, SHIFT);
    p2.end({ x: 9, y: 9 }, true);
    expect(shift.current().vertexIds).toEqual(vidSet('a0'));
  });
});

describe('createLiveSelectionPort — non-empty drags never rubber-band (edit-session 非干渉)', () => {
  it('a VERTEX drag selects nothing and never consults the resolver', () => {
    const seam = fakeSeam();
    const resolver: RectangleResolver = { verticesInRectangle: vi.fn(() => null) };
    const port = createLiveSelectionPort(seam, screenToWorld, resolver);

    port.start(vertexHit(fid('A'), vid('a0')), { x: 3, y: 3 }, NO_MODIFIERS);
    port.move({ x: 30, y: 30 });
    port.end({ x: 30, y: 30 }, true); // a DRAG on a vertex handle

    // The vertex drag is the U24 edit-session's; this port leaves selection untouched
    // and never opens a rubber-band.
    expect(seam.current()).toBe(EMPTY_SELECTION);
    expect(resolver.verticesInRectangle).not.toHaveBeenCalled();
  });

  it('a FEATURE-BODY drag selects nothing and never consults the resolver', () => {
    const seam = fakeSeam();
    const resolver: RectangleResolver = { verticesInRectangle: vi.fn(() => null) };
    const port = createLiveSelectionPort(seam, screenToWorld, resolver);

    port.start(featureBodyHit(fid('A')), { x: 3, y: 3 }, NO_MODIFIERS);
    port.end({ x: 30, y: 30 }, true); // a DRAG on a feature body

    expect(seam.current()).toBe(EMPTY_SELECTION);
    expect(resolver.verticesInRectangle).not.toHaveBeenCalled();
  });
});

describe('createLiveSelectionPort — an empty CLICK never opens a rubber-band', () => {
  it('an empty-space CLICK (no drag) clears the selection without consulting the resolver', () => {
    const seam = fakeSeam(withVertexSet(EMPTY_SELECTION, fid('A'), vidSet('a0')));
    const resolver: RectangleResolver = { verticesInRectangle: vi.fn(() => null) };
    const port = createLiveSelectionPort(seam, screenToWorld, resolver);
    port.start(EMPTY_HIT, { x: 3, y: 3 }, NO_MODIFIERS);
    port.end({ x: 3, y: 3 }, false); // NOT a drag → a click
    expect(seam.current().vertexIds.size).toBe(0);
    // A click (origin === at) never reaches the rectangle branch.
    expect(resolver.verticesInRectangle).not.toHaveBeenCalled();
  });
});
