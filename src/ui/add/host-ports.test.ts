// P0-A — the host's frame composition (CONVERGE-2): COMMITTED features must reach
// the draw batch, UNDER the tool overlay and ABOVE the grid, and a changed
// committed set (e.g. after a time change) must change the batch. `composeFrame`
// is the pure core the live host delegates to on every paint, so this fixes the
// behavior without a DOM / Canvas (host-ports itself is DOM-only by design).

import { describe, expect, it } from 'vitest';

import { DEFAULT_CAMERA } from '../state/session';
import type { Camera, Viewport } from '../../render/camera';
import type { DrawPrimitive } from '../../render/map-renderer';
import type { EvaluatedFeature, FeatureStyle } from '../../render/feature-layer';

import { composeFrame } from './host-ports';

const VIEWPORT: Viewport = { widthCss: 800, heightCss: 600, devicePixelRatio: 1 };
const CAMERA: Camera = DEFAULT_CAMERA;

const STYLE: FeatureStyle = { fill: '#123456', stroke: '#000', selectedColor: '#0ff' };

function point(id: string, lon: number, lat: number): EvaluatedFeature {
  return { kind: 'point', id, at: { lon, lat }, style: STYLE, label: '', selected: false };
}

function kinds(prims: readonly DrawPrimitive[]): string[] {
  return prims.map((p) => p.kind);
}

describe('composeFrame', () => {
  it('includes committed features ABOVE the grid and UNDER the tool overlay', () => {
    const overlay: DrawPrimitive[] = [
      { kind: 'point', at: { lon: 0, lat: 0 }, radiusPx: 4, fill: '#f00' },
    ];
    const prims = composeFrame({
      baseImage: null,
      committed: [point('pt-1', 10, 20)],
      overlay,
      camera: CAMERA,
      viewport: VIEWPORT,
    });

    // The committed point produced a point primitive.
    const committedPoint = prims.find(
      (p): p is Extract<DrawPrimitive, { kind: 'point' }> =>
        p.kind === 'point' && p.fill === STYLE.fill,
    );
    expect(committedPoint).toBeDefined();

    // Order: at least one gridline precedes the committed point, which precedes
    // the overlay point (the last primitive).
    const ks = kinds(prims);
    const firstGrid = ks.indexOf('gridline');
    const committedIdx = prims.indexOf(committedPoint!);
    const overlayIdx = prims.length - 1;
    expect(firstGrid).toBeGreaterThanOrEqual(0);
    expect(firstGrid).toBeLessThan(committedIdx);
    expect(committedIdx).toBeLessThan(overlayIdx);
    expect(prims[overlayIdx]).toBe(overlay[0]);
  });

  it('draws no committed primitives when there are none (grid still drawn)', () => {
    const prims = composeFrame({
      baseImage: null,
      committed: [],
      overlay: [],
      camera: CAMERA,
      viewport: VIEWPORT,
    });
    expect(kinds(prims)).toContain('gridline');
    expect(prims.every((p) => p.kind !== 'point')).toBe(true);
  });

  it('reflects a CHANGED committed set in the batch (time-change reflection)', () => {
    const before = composeFrame({
      baseImage: null,
      committed: [point('pt-1', 10, 20)],
      overlay: [],
      camera: CAMERA,
      viewport: VIEWPORT,
    });
    const after = composeFrame({
      baseImage: null,
      committed: [point('pt-1', 10, 20), point('pt-2', 30, 40)],
      overlay: [],
      camera: CAMERA,
      viewport: VIEWPORT,
    });

    const committedPointCount = (prims: readonly DrawPrimitive[]): number =>
      prims.filter((p) => p.kind === 'point' && p.fill === STYLE.fill).length;

    expect(committedPointCount(before)).toBe(1);
    expect(committedPointCount(after)).toBe(2);
  });
});
