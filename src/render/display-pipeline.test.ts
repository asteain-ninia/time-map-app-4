// U34 display-pipeline wiring tests (FR-42 / FR-43, 受け入れ基準1 / 3 / 5,
// 教訓5.5 / 5.29). These pin the END-TO-END connection that was missing: the
// display-control inputs (global depth N / individual focus M) actually drive the
// U19 draw batch, and changing them changes which features draw / at what shape.

import { describe, expect, it } from 'vitest';

import { createBasicAttributes, createColorInfo } from '../domain/attributes';
import { createCoordinate } from '../domain/coordinate';
import {
  createAggregateFeature,
  createLeafFeature,
  type Feature,
} from '../domain/feature';
import { asFeatureId, asRingId, asVertexId, type FeatureId } from '../domain/ids';
import { createShape, createTerritoryRing } from '../domain/ring';
import { buildForest, type Forest } from '../domain/hierarchy/forest';
import { createVertex, createVertexStore, type VertexStore } from '../domain/vertex';

import type { FeatureStyle } from './feature-layer';
import {
  type DisplayControlInput,
  buildDisplayAreas,
  resolveDisplayControl,
} from './display-pipeline';
import type { DisplayPresentation } from './display-bridge';

// --- a two-level forest: root(0) -> mid(1) -> { leafA(2), leafB(2) } ----------
//
// Plus a second sibling tree to prove focus restricts to ONE vertical region.

const COLOR = createColorInfo(true, '#102030', '#405060', '#708090');
const attrs = (name: string) => createBasicAttributes(name, 0, 1);
const fid = (s: string): FeatureId => asFeatureId(s);

const VERTICES = [
  createVertex(asVertexId('a0'), createCoordinate(0, 0)),
  createVertex(asVertexId('a1'), createCoordinate(1, 0)),
  createVertex(asVertexId('a2'), createCoordinate(1, 1)),
  createVertex(asVertexId('a3'), createCoordinate(0, 1)),
  createVertex(asVertexId('b0'), createCoordinate(10, 10)),
  createVertex(asVertexId('b1'), createCoordinate(11, 10)),
  createVertex(asVertexId('b2'), createCoordinate(11, 11)),
  createVertex(asVertexId('b3'), createCoordinate(10, 11)),
  createVertex(asVertexId('c0'), createCoordinate(20, 20)),
  createVertex(asVertexId('c1'), createCoordinate(21, 20)),
  createVertex(asVertexId('c2'), createCoordinate(21, 21)),
  createVertex(asVertexId('c3'), createCoordinate(20, 21)),
];

function leaf(id: string, vids: string[], parentId?: string): Feature {
  const ring = createTerritoryRing(asRingId(`r-${id}`), vids.map(asVertexId));
  return createLeafFeature(
    fid(id),
    attrs(id),
    COLOR,
    createShape([ring]),
    parentId !== undefined ? { parentId: fid(parentId) } : {},
  );
}

function forest(): Forest {
  return buildForest([
    // tree 1: root -> mid -> { leafA, leafB }
    createAggregateFeature(fid('root'), attrs('root'), COLOR, [fid('mid')]),
    createAggregateFeature(fid('mid'), attrs('mid'), COLOR, [fid('leafA'), fid('leafB')], {
      parentId: fid('root'),
    }),
    leaf('leafA', ['a0', 'a1', 'a2', 'a3'], 'mid'),
    leaf('leafB', ['b0', 'b1', 'b2', 'b3'], 'mid'),
    // tree 2: a lone TOP-LEVEL leaf (depth 0) far away.
    leaf('lone', ['c0', 'c1', 'c2', 'c3']),
  ]);
}

function store(): VertexStore {
  return createVertexStore(VERTICES);
}

const STYLE: FeatureStyle = { fill: '#3366cc', stroke: '#123456', selectedColor: '#00e5ff' };

const presentationFor = (): DisplayPresentation => ({
  style: STYLE,
  label: '',
  selected: false,
});

function control(over: Partial<DisplayControlInput> = {}): DisplayControlInput {
  return {
    globalDepth: 0,
    focus: { originId: null, depth: 0, emphasize: false },
    ...over,
  };
}

function drawnIds(forest: Forest, vs: VertexStore, ctl: DisplayControlInput): string[] {
  return buildDisplayAreas(forest, vs, ctl, presentationFor).map((a) => a.id);
}

// =============================================================================
// 1. N change → the draw batch follows (受け入れ基準1, 教訓5.5)
// =============================================================================
describe('display pipeline: changing global depth N re-generates the draw batch', () => {
  it('N=0 rolls everything up to the top-level aggregate (root) + lone leaf', () => {
    const f = forest();
    const ids = drawnIds(f, store(), control({ globalDepth: 0 }));
    expect(ids).toContain('root'); // tree 1 rounds to its root aggregate.
    expect(ids).toContain('lone'); // tree 2 is a depth-0 leaf, drawn as itself.
    expect(ids).not.toContain('mid'); // deeper features absorbed (受け入れ基準1).
    expect(ids).not.toContain('leafA');
  });

  it('raising N expands deeper; N at forest max draws every leaf as its own shape', () => {
    const f = forest();
    const vs = store();

    const atN1 = drawnIds(f, vs, control({ globalDepth: 1 }));
    expect(atN1).toContain('mid'); // depth-1 aggregate now terminal.
    expect(atN1).not.toContain('leafA'); // still absorbed at N=1.

    const atN2 = drawnIds(f, vs, control({ globalDepth: 2 }));
    expect(atN2).toContain('leafA'); // depth-2 leaves now draw.
    expect(atN2).toContain('leafB');
    expect(atN2).toContain('lone');
  });

  it('out-of-range N is clamped to the forest depth range (FR-117)', () => {
    const f = forest();
    const vs = store();
    // N=999 clamps to max depth (2) → same batch as N=2; never throws / breaks.
    const clamped = drawnIds(f, vs, control({ globalDepth: 999 }));
    const atMax = drawnIds(f, vs, control({ globalDepth: 2 }));
    expect(clamped).toEqual(atMax);
    expect(clamped).toContain('leafA');
  });
});

// =============================================================================
// 2. focus → only the vertical region deepens to M (受け入れ基準3 / 4)
// =============================================================================
describe('display pipeline: focus deep-dives only the vertical region (FR-43)', () => {
  it('focus on leafA with M=2, global N=0: leafA region expands, lone stays rolled up', () => {
    const f = forest();
    const vs = store();
    const ids = drawnIds(
      f,
      vs,
      control({ globalDepth: 0, focus: { originId: fid('leafA'), depth: 2, emphasize: true } }),
    );
    // Vertical region of leafA = { root, mid, leafA } follows M=2 → leafA draws.
    expect(ids).toContain('leafA');
    // leafB is NOT in leafA's vertical region (sibling) → follows global N=0,
    // absorbed into the rolled-up tree.
    expect(ids).not.toContain('leafB');
    // The other tree's lone leaf is depth-0 → draws under N=0 anyway, unaffected.
    expect(ids).toContain('lone');
  });

  it('emphasis is carried for the region only (FR-43 強調)', () => {
    const f = forest();
    const vs = store();
    const resolved = resolveDisplayControl(
      f,
      vs,
      control({ globalDepth: 2, focus: { originId: fid('leafA'), depth: 2, emphasize: true } }),
    );
    const a = resolved.shapes.find((s) => s.featureId === fid('leafA'));
    const lone = resolved.shapes.find((s) => s.featureId === fid('lone'));
    expect(a?.emphasized).toBe(true); // in the vertical region.
    expect(lone?.emphasized).toBe(false); // outside the region.
  });

  it('a stale focus origin (absent feature) falls back to global N only (受け入れ基準3)', () => {
    const f = forest();
    const vs = store();
    const withStale = drawnIds(
      f,
      vs,
      control({ globalDepth: 0, focus: { originId: fid('ghost'), depth: 2, emphasize: true } }),
    );
    const globalOnly = drawnIds(f, vs, control({ globalDepth: 0 }));
    // The ghost origin yields an empty region → identical to global-N-only.
    expect(withStale).toEqual(globalOnly);
  });
});

// =============================================================================
// 3. purity (受け入れ基準6)
// =============================================================================
describe('display pipeline: purity', () => {
  it('same inputs → equal areas; inputs untouched', () => {
    const f = forest();
    const vs = store();
    const ctl = control({ globalDepth: 1 });
    const first = buildDisplayAreas(f, vs, ctl, presentationFor);
    const second = buildDisplayAreas(f, vs, ctl, presentationFor);
    expect(first).toEqual(second);
    expect(ctl.globalDepth).toBe(1); // input not mutated.
  });
});
