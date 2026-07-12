// Tests for the extracted shared-vertex derivation (FR-30 / FR-33 単一真実源).
//
// This is the ONE derivation the FR-30 visual marker, the FR-96 右クリック「共有解除」
// 出し分け and the FR-33 共有解除本体 all read: a vertex is SHARED iff ≥2 distinct shape
// references cite it. The tests build REAL domain features (教訓 5.39) sharing a vertex
// and assert the derivation reports exactly that vertex — and that it is RAW /
// depth-independent (built from the full per-time feature set, never a grabbable subset).

import { describe, expect, it } from 'vitest';

import { createBasicAttributes, createColorInfo } from '../../domain/attributes';
import { createCoordinate } from '../../domain/coordinate';
import { createLeafFeature, createLineFeature, type Feature } from '../../domain/feature';
import { asFeatureId, asRingId, asVertexId } from '../../domain/ids';
import { createShape, createTerritoryRing } from '../../domain/ring';
import { createVertex, createVertexStore } from '../../domain/vertex';

import type { DisplayResolution } from './display-resolution-cache';
import {
  containersOf,
  sharedVertexIdsFor,
  sharedVertexIdsOf,
} from './shared-vertex-derivation';

const COLOR = createColorInfo(true, '#111111', '#222222', '#333333', 'default', 1, 1);
const vid = (s: string): ReturnType<typeof asVertexId> => asVertexId(s);

/** Two square leaves that SHARE the vertex `vs` on their touching edge. */
function twoLeavesSharingVertex(): { features: Feature[]; vertices: ReturnType<typeof createVertexStore> } {
  const vs = createVertex(vid('vs'), createCoordinate(10, 0));
  const a0 = createVertex(vid('a0'), createCoordinate(0, 0));
  const a1 = createVertex(vid('a1'), createCoordinate(10, 0));
  const a2 = createVertex(vid('a2'), createCoordinate(0, 10));
  const b0 = createVertex(vid('b0'), createCoordinate(20, 0));
  const b1 = createVertex(vid('b1'), createCoordinate(20, 10));

  const leafA = createLeafFeature(
    asFeatureId('A'),
    createBasicAttributes('A', 0, 100),
    COLOR,
    createShape([createTerritoryRing(asRingId('A-r'), [a0.id, a1.id, vs.id, a2.id])]),
  );
  const leafB = createLeafFeature(
    asFeatureId('B'),
    createBasicAttributes('B', 0, 100),
    COLOR,
    createShape([createTerritoryRing(asRingId('B-r'), [vs.id, a1.id, b0.id, b1.id])]),
  );
  return {
    features: [leafA, leafB],
    vertices: createVertexStore([vs, a0, a1, a2, b0, b1]),
  };
}

describe('sharedVertexIdsOf — ≥2 shape references ⇒ shared', () => {
  it('two leaves citing one vertex → that vertex is shared', () => {
    const { features, vertices } = twoLeavesSharingVertex();
    const shared = sharedVertexIdsOf(vertices, features);
    // vs is cited by A-r and B-r; a1 is ALSO cited by both rings here (share too).
    expect(shared.has(vid('vs'))).toBe(true);
    expect(shared.has(vid('a1'))).toBe(true);
    // a vertex cited by ONE ring only is not shared.
    expect(shared.has(vid('a0'))).toBe(false);
    expect(shared.has(vid('b0'))).toBe(false);
  });

  it('a lone line vertex is never shared (only ≥2 citations count)', () => {
    const a = createVertex(vid('la'), createCoordinate(0, 0));
    const b = createVertex(vid('lb'), createCoordinate(5, 5));
    const line = createLineFeature(
      asFeatureId('L'),
      createBasicAttributes('L', 0, 100),
      COLOR,
      [a.id, b.id],
    );
    const shared = sharedVertexIdsOf(createVertexStore([a, b]), [line]);
    expect(shared.size).toBe(0);
  });
});

describe('containersOf — only rings + line paths are containers', () => {
  it('leaf rings and line paths contribute; the count matches', () => {
    const { features } = twoLeavesSharingVertex();
    const entries = containersOf(features);
    expect(entries.length).toBe(2); // two leaf rings
    for (const e of entries) expect(e.container.kind).toBe('ring');
  });
});

describe('sharedVertexIdsFor — memoized over a DisplayResolution', () => {
  it('reads resolution.features + resolution.vertices (RAW, depth-independent)', () => {
    const { features, vertices } = twoLeavesSharingVertex();
    // Only `.features` and `.vertices` are consulted; the rest is irrelevant here.
    const resolution = { features, vertices } as unknown as DisplayResolution;
    const shared = sharedVertexIdsFor(resolution);
    expect(shared.has(vid('vs'))).toBe(true);
    // Identity-memoized: a second call on the SAME bundle returns the SAME set.
    expect(sharedVertexIdsFor(resolution)).toBe(shared);
  });
});
