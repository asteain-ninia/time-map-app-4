// U24 受け入れ基準12 — screen-space proximity snap (FR-31): zoom-dependent,
// distance read from settings (not hard-coded), nearest-within-distance wins,
// exclusions honoured.

import { describe, expect, it } from 'vitest';

import { decideSnap, type SnapCandidate, type WorldToScreen } from './snap';
import { coord, vid } from './fixtures';

// A simple linear world→screen at a given pixels-per-degree zoom (mirrors the
// render-layer transform: screen x = lon*zoom, y = -lat*zoom).
const projAtZoom =
  (zoom: number): WorldToScreen =>
  (w) => ({ x: w.lon * zoom, y: -w.lat * zoom });

const cands: SnapCandidate[] = [
  { vertexId: vid('near'), position: coord(1, 0) },
  { vertexId: vid('far'), position: coord(5, 0) },
];

describe('decideSnap (FR-31 受け入れ基準12)', () => {
  it('snaps to a candidate within the snap distance in SCREEN pixels', () => {
    // zoom 60 px/deg: "near" is at 60px from a dragged point at lon 0.
    const d = decideSnap({
      draggedPosition: coord(0, 0),
      candidates: cands,
      snapDistancePx: 70, // from U16 settings (passed in, not hard-coded)
      toScreen: projAtZoom(60),
    });
    expect(d).not.toBeNull();
    expect(d!.vertexId).toBe(vid('near'));
  });

  it('is ZOOM-DEPENDENT: same world gap snaps at high zoom, not at low zoom', () => {
    const draggedPosition = coord(0, 0);
    const snapDistancePx = 50;
    // At zoom 60, "near" (lon 1) is 60px away → beyond 50px → no snap.
    const low = decideSnap({ draggedPosition, candidates: cands, snapDistancePx, toScreen: projAtZoom(60) });
    expect(low).toBeNull();
    // At zoom 40, "near" is 40px away → within 50px → snaps. Same world gap, same
    // 50px distance, DIFFERENT result purely from zoom (FR-31 ズーム依存).
    const high = decideSnap({ draggedPosition, candidates: cands, snapDistancePx, toScreen: projAtZoom(40) });
    expect(high).not.toBeNull();
    expect(high!.vertexId).toBe(vid('near'));
  });

  it('uses the supplied snap distance (not a hard-coded 50) — a tiny distance never snaps', () => {
    const d = decideSnap({
      draggedPosition: coord(0, 0),
      candidates: cands,
      snapDistancePx: 1,
      toScreen: projAtZoom(60),
    });
    expect(d).toBeNull();
  });

  it('nearest candidate within distance wins', () => {
    const close: SnapCandidate[] = [
      { vertexId: vid('a'), position: coord(0.5, 0) },
      { vertexId: vid('b'), position: coord(0.2, 0) },
    ];
    const d = decideSnap({
      draggedPosition: coord(0, 0),
      candidates: close,
      snapDistancePx: 100,
      toScreen: projAtZoom(60),
    });
    expect(d!.vertexId).toBe(vid('b')); // 12px < 30px
  });

  it('empty candidate set → no snap (教訓5.18 length-decided)', () => {
    expect(
      decideSnap({ draggedPosition: coord(0, 0), candidates: [], snapDistancePx: 50, toScreen: projAtZoom(60) }),
    ).toBeNull();
  });

  it('excluded vertices (self / same-container) are never snap targets', () => {
    const d = decideSnap({
      draggedPosition: coord(0, 0),
      candidates: cands,
      snapDistancePx: 100,
      toScreen: projAtZoom(60),
      exclude: new Set([vid('near')]),
    });
    // "near" excluded → falls back to "far" only if within distance (5*60=300px > 100 → null).
    expect(d).toBeNull();
  });
});
