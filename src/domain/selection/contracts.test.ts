// U22 selection — layer-crossing contract factories (教訓 5.33 / 5.34). These pin the
// shape of a {@link HitResult} the hit-test (U24) produces and the selection unit /
// edit-session adapter consume, so the two layers never rely on structural accident.

import { describe, expect, it } from 'vitest';

import { HIT_KIND, edgeHit } from './contracts';
import { asFeatureId, asRingId, asVertexId } from '../ids';

describe('edgeHit factory (FR-87 edge-midpoint hit)', () => {
  it('builds a line edge hit (no ringId key) carrying the two endpoint ids', () => {
    const hit = edgeHit(asFeatureId('L'), asVertexId('v0'), asVertexId('v1'));
    expect(hit.kind).toBe(HIT_KIND.Edge);
    if (hit.kind === HIT_KIND.Edge) {
      expect(hit.featureId).toBe(asFeatureId('L'));
      expect(hit.startVertexId).toBe(asVertexId('v0'));
      expect(hit.endVertexId).toBe(asVertexId('v1'));
      // A line edge has no ring; the branded-optional key is DROPPED (not undefined).
      expect('ringId' in hit).toBe(false);
    }
  });

  it('builds a leaf edge hit carrying its ringId', () => {
    const hit = edgeHit(
      asFeatureId('A'),
      asVertexId('v0'),
      asVertexId('v1'),
      asRingId('r0'),
    );
    expect(hit.kind).toBe(HIT_KIND.Edge);
    if (hit.kind === HIT_KIND.Edge) {
      expect(hit.ringId).toBe(asRingId('r0'));
      expect(hit.startVertexId).toBe(asVertexId('v0'));
      expect(hit.endVertexId).toBe(asVertexId('v1'));
    }
  });
});
