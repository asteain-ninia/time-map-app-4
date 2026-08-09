// U34 display-control decision tests (FR-42 / FR-43).
//
// These exercise the PURE display decisions: depth-threshold aggregation/omission
// (shared by global N and focus M), vertical-region computation via U08 cycle-safe
// walks, the integrated decision (縦方向領域内は M、外は N), non-interference of the
// state slice (covered in the store test), and purity (受け入れ基準 6).

import { describe, expect, it } from 'vitest';

import { createBasicAttributes, createColorInfo } from '../attributes';
import { createCoordinate } from '../coordinate';
import {
  createAggregateFeature,
  createLeafFeature,
  type Feature,
} from '../feature';
import { asFeatureId, asRingId, asVertexId, type FeatureId } from '../ids';
import { createShape, createTerritoryRing } from '../ring';
import { buildForest, type Forest } from '../hierarchy/forest';
import { derivedDepths } from '../hierarchy/depth';
import {
  DISPLAY_VERDICT,
  buildDisplayDecisions,
  classifyAtThreshold,
  clampThreshold,
  depthRange,
  drawableIds,
  NO_FOCUS,
  verticalRegion,
} from './depth-focus';

const COLOR = createColorInfo(true, '#102030', '#405060', '#708090');
const attrs = (name: string) => createBasicAttributes(name, 0, 1);
const fid = (s: string): FeatureId => asFeatureId(s);

function leaf(id: string, parentId?: string): Feature {
  const corners = [
    createCoordinate(0, 0),
    createCoordinate(1, 0),
    createCoordinate(1, 1),
    createCoordinate(0, 1),
  ];
  const vs = corners.map((c, i) => createVertexId(id, i, c));
  const ring = createTerritoryRing(
    asRingId(`r-${id}`),
    vs.map((v) => v.id),
  );
  return parentId === undefined
    ? createLeafFeature(fid(id), attrs(id), COLOR, createShape([ring]))
    : createLeafFeature(fid(id), attrs(id), COLOR, createShape([ring]), {
        parentId: fid(parentId),
      });
}
function createVertexId(id: string, i: number, c: ReturnType<typeof createCoordinate>) {
  return { id: asVertexId(`v-${id}-${i}`), coordinate: c };
}

function agg(id: string, childIds: string[], parentId?: string): Feature {
  return parentId === undefined
    ? createAggregateFeature(fid(id), attrs(id), COLOR, childIds.map(fid))
    : createAggregateFeature(fid(id), attrs(id), COLOR, childIds.map(fid), {
        parentId: fid(parentId),
      });
}

// A small forest:  root(0) -> mid(1) -> leafA(2), leafB(2)
//                  root2(0) -> leafC(1)
function sampleForest(): Forest {
  return buildForest([
    agg('root', ['mid']),
    agg('mid', ['leafA', 'leafB'], 'root'),
    leaf('leafA', 'mid'),
    leaf('leafB', 'mid'),
    agg('root2', ['leafC']),
    leaf('leafC', 'root2'),
  ]);
}

// =============================================================================
// 1. Shared depth-threshold judgement (教訓 5.30 過少共有の戒め)
// =============================================================================
describe('classifyAtThreshold (shared by N and M)', () => {
  it('d < T => Real (expanded; children carry the area)', () => {
    expect(classifyAtThreshold(0, 2, true)).toBe(DISPLAY_VERDICT.Real);
    expect(classifyAtThreshold(1, 2, true)).toBe(DISPLAY_VERDICT.Real);
  });
  it('d === T with children => Aggregate (terminal: draw 集約形状)', () => {
    expect(classifyAtThreshold(1, 1, true)).toBe(DISPLAY_VERDICT.Aggregate);
  });
  it('d === T without children => Real (a leaf draws its own shape)', () => {
    expect(classifyAtThreshold(1, 1, false)).toBe(DISPLAY_VERDICT.Real);
  });
  it('d > T => Omitted (absorbed into ancestor aggregate)', () => {
    expect(classifyAtThreshold(2, 1, true)).toBe(DISPLAY_VERDICT.Omitted);
    expect(classifyAtThreshold(2, 1, false)).toBe(DISPLAY_VERDICT.Omitted);
  });
  it('undefined depth (cyclic, -1) => Omitted', () => {
    expect(classifyAtThreshold(-1, 0, true)).toBe(DISPLAY_VERDICT.Omitted);
  });
});

// =============================================================================
// 2. Threshold range & clamping (FR-42 / FR-117)
// =============================================================================
describe('depthRange / clampThreshold', () => {
  it('range upper bound is the forest max derivable depth', () => {
    const r = depthRange(2);
    expect(r).toEqual({ min: 0, max: 2 });
  });
  it('empty / all-roots forest has range [0,0]', () => {
    expect(depthRange(0)).toEqual({ min: 0, max: 0 });
  });
  it('clamps below min and above max, floors fractions', () => {
    const r = depthRange(3);
    expect(clampThreshold(-5, r)).toBe(0);
    expect(clampThreshold(99, r)).toBe(3);
    expect(clampThreshold(2.9, r)).toBe(2);
    expect(clampThreshold(NaN, r)).toBe(0);
  });
});

// =============================================================================
// 3. Global depth decisions (FR-42, 受け入れ基準 1)
// =============================================================================
describe('buildDisplayDecisions — global depth only (FR-42)', () => {
  it('N=0: only the roots draw, as their own aggregate (集約形状)', () => {
    const forest = sampleForest();
    const d = buildDisplayDecisions({ forest, globalThreshold: 0 });
    expect(d.get(fid('root'))?.verdict).toBe(DISPLAY_VERDICT.Aggregate);
    expect(d.get(fid('root'))?.rollUpTargetId).toBe(fid('root'));
    expect(d.get(fid('root2'))?.verdict).toBe(DISPLAY_VERDICT.Aggregate);
    // Everything below depth 0 is omitted (absorbed into the root aggregate).
    expect(d.get(fid('mid'))?.verdict).toBe(DISPLAY_VERDICT.Omitted);
    expect(d.get(fid('leafA'))?.verdict).toBe(DISPLAY_VERDICT.Omitted);
    expect(d.get(fid('leafC'))?.verdict).toBe(DISPLAY_VERDICT.Omitted);
    expect(drawableIds(d)).toEqual([fid('root'), fid('root2')]);
  });

  it('N=1: depth-1 features are terminal; root2->leafC (a leaf) draws its own shape', () => {
    const forest = sampleForest();
    const d = buildDisplayDecisions({ forest, globalThreshold: 1 });
    // root は展開されるので自身は描かれない (仕様 U34 §31「より深い階層の描画へ降りる」/
    // 集約地物は自前の形状を持たず、その領域は子が担う — 親を描くと子を覆い、
    // 描画集合を共有するヒットテストが子のクリックを奪う)。
    expect(d.get(fid('root'))?.verdict).toBe(DISPLAY_VERDICT.Omitted);
    expect(d.get(fid('mid'))?.verdict).toBe(DISPLAY_VERDICT.Aggregate);
    expect(d.get(fid('mid'))?.rollUpTargetId).toBe(fid('mid'));
    // mid's children are below the terminal: omitted.
    expect(d.get(fid('leafA'))?.verdict).toBe(DISPLAY_VERDICT.Omitted);
    expect(d.get(fid('leafB'))?.verdict).toBe(DISPLAY_VERDICT.Omitted);
    // leafC is depth 1 with NO children -> Real (own shape), not aggregate.
    expect(d.get(fid('leafC'))?.verdict).toBe(DISPLAY_VERDICT.Real);
    // root2 も展開済みの集約なので描かれない (leafC がその領域を担う)。
    expect(d.get(fid('root2'))?.verdict).toBe(DISPLAY_VERDICT.Omitted);
  });

  it('N at forest max: 末端が実形状で描かれ、展開済みの集約は描かれない', () => {
    const forest = sampleForest();
    const d = buildDisplayDecisions({ forest, globalThreshold: 2 });
    expect(d.get(fid('leafA'))?.verdict).toBe(DISPLAY_VERDICT.Real);
    expect(d.get(fid('leafB'))?.verdict).toBe(DISPLAY_VERDICT.Real);
    expect(d.get(fid('leafC'))?.verdict).toBe(DISPLAY_VERDICT.Real);
    // 展開された集約 (root/mid/root2) は自身を描かない — 領域は子が担う。
    expect(d.get(fid('root'))?.verdict).toBe(DISPLAY_VERDICT.Omitted);
    expect(d.get(fid('mid'))?.verdict).toBe(DISPLAY_VERDICT.Omitted);
    expect(d.get(fid('root2'))?.verdict).toBe(DISPLAY_VERDICT.Omitted);
    // 描かれるのは末端だけで、面は重複しない (クリックは必ず末端に当たる)。
    expect(drawableIds(d)).toEqual([fid('leafA'), fid('leafB'), fid('leafC')]);
  });

  it('子を持つ末端地物 (FR-35 中間状態) は展開されても自身の実形状を描く', () => {
    // 集約と違い、末端地物は子が担わない自前のリングを持つので描き続ける。
    const forest = buildForest([leaf('host'), leaf('kid', 'host')]);
    const d = buildDisplayDecisions({ forest, globalThreshold: 1 });
    expect(d.get(fid('host'))?.verdict).toBe(DISPLAY_VERDICT.Real);
    expect(d.get(fid('kid'))?.verdict).toBe(DISPLAY_VERDICT.Real);
  });

  it('accepts a precomputed depth map (U08 derivedDepths) and agrees with self-compute', () => {
    const forest = sampleForest();
    const depths = derivedDepths(forest);
    const withMap = buildDisplayDecisions({ forest, depths, globalThreshold: 1 });
    const without = buildDisplayDecisions({ forest, globalThreshold: 1 });
    for (const id of forest.orderedIds) {
      expect(withMap.get(id)?.verdict).toBe(without.get(id)?.verdict);
    }
  });
});

// =============================================================================
// 4. Vertical region via U08 cycle-safe walks (教訓 5.28)
// =============================================================================
describe('verticalRegion (上位＋自身＋下位, 教訓 5.28)', () => {
  it('includes ancestors, self and descendants', () => {
    const forest = sampleForest();
    const region = verticalRegion(forest, fid('mid'));
    expect([...region].sort()).toEqual(
      [fid('root'), fid('mid'), fid('leafA'), fid('leafB')].sort(),
    );
  });
  it('a leaf origin includes only its ancestor chain + itself', () => {
    const forest = sampleForest();
    const region = verticalRegion(forest, fid('leafA'));
    expect([...region].sort()).toEqual(
      [fid('root'), fid('mid'), fid('leafA')].sort(),
    );
  });
  it('an absent origin yields an empty region (stale focus fallback)', () => {
    const forest = sampleForest();
    expect(verticalRegion(forest, fid('ghost')).size).toBe(0);
  });
  it('does not loop forever on a cycle (returns a finite set)', () => {
    // a -> b -> a  (broken parent links form a cycle).
    const forest = buildForest([agg('a', ['b'], 'b'), agg('b', ['a'], 'a')]);
    const region = verticalRegion(forest, fid('a'));
    expect(region.has(fid('a'))).toBe(true);
    expect(region.size).toBeGreaterThan(0);
  });
});

// =============================================================================
// 5. Individual focus + coexistence with global (FR-43, 受け入れ基準 3/4)
// =============================================================================
describe('buildDisplayDecisions — focus coexists with global (FR-43)', () => {
  it('focus M deeper than N expands only the vertical region', () => {
    const forest = sampleForest();
    // Global N=0 (everything rolled to roots); focus on mid with M=2.
    const d = buildDisplayDecisions({
      forest,
      globalThreshold: 0,
      focus: { originId: fid('mid'), depth: 2, emphasize: true },
    });
    // Vertical region of mid = {root, mid, leafA, leafB} -> follow M=2.
    // root / mid は展開済みの集約なので自身は描かれず、領域は leafA/leafB が担う。
    expect(d.get(fid('root'))?.verdict).toBe(DISPLAY_VERDICT.Omitted); // 0 < 2 (展開)
    expect(d.get(fid('mid'))?.verdict).toBe(DISPLAY_VERDICT.Omitted); // 1 < 2 (展開)
    expect(d.get(fid('leafA'))?.verdict).toBe(DISPLAY_VERDICT.Real); // 2 == 2 leaf
    expect(d.get(fid('leafB'))?.verdict).toBe(DISPLAY_VERDICT.Real);
    // Outside the region follows N=0: root2 aggregate, leafC omitted.
    expect(d.get(fid('root2'))?.verdict).toBe(DISPLAY_VERDICT.Aggregate);
    expect(d.get(fid('leafC'))?.verdict).toBe(DISPLAY_VERDICT.Omitted);
  });

  it('region features are emphasized; outside are not', () => {
    const forest = sampleForest();
    const d = buildDisplayDecisions({
      forest,
      globalThreshold: 2,
      focus: { originId: fid('leafA'), depth: 2, emphasize: true },
    });
    expect(d.get(fid('leafA'))?.emphasized).toBe(true);
    expect(d.get(fid('mid'))?.emphasized).toBe(true); // ancestor in region
    expect(d.get(fid('root'))?.emphasized).toBe(true);
    expect(d.get(fid('leafB'))?.emphasized).toBe(false); // sibling, NOT in region
    expect(d.get(fid('root2'))?.emphasized).toBe(false);
  });

  it('focus M shallower than N: region follows M, outside follows N', () => {
    const forest = sampleForest();
    // N=2 (full detail); focus mid with M=0 -> region rolls up to its top.
    const d = buildDisplayDecisions({
      forest,
      globalThreshold: 2,
      focus: { originId: fid('mid'), depth: 0, emphasize: false },
    });
    // Region {root, mid, leafA, leafB} at M=0: root is terminal aggregate,
    // everything deeper in the region is omitted.
    expect(d.get(fid('root'))?.verdict).toBe(DISPLAY_VERDICT.Aggregate);
    expect(d.get(fid('mid'))?.verdict).toBe(DISPLAY_VERDICT.Omitted);
    expect(d.get(fid('leafA'))?.verdict).toBe(DISPLAY_VERDICT.Omitted);
    // Outside the region at N=2: leafC draws its real shape.
    expect(d.get(fid('leafC'))?.verdict).toBe(DISPLAY_VERDICT.Real);
  });

  it('a stale/absent focus origin falls back to global N only (教訓 5.5/5.2)', () => {
    const forest = sampleForest();
    const withGhost = buildDisplayDecisions({
      forest,
      globalThreshold: 1,
      focus: { originId: fid('ghost'), depth: 2, emphasize: true },
    });
    const globalOnly = buildDisplayDecisions({ forest, globalThreshold: 1 });
    for (const id of forest.orderedIds) {
      expect(withGhost.get(id)?.verdict).toBe(globalOnly.get(id)?.verdict);
      expect(withGhost.get(id)?.emphasized).toBe(false);
    }
  });

  it('NO_FOCUS behaves identically to omitting focus', () => {
    const forest = sampleForest();
    const a = buildDisplayDecisions({ forest, globalThreshold: 1, focus: NO_FOCUS });
    const b = buildDisplayDecisions({ forest, globalThreshold: 1 });
    for (const id of forest.orderedIds) {
      expect(a.get(id)?.verdict).toBe(b.get(id)?.verdict);
    }
  });
});

// =============================================================================
// 6. Roll-up target = U08 single resolution source (教訓 5.29, 受け入れ基準 5)
// =============================================================================
describe('aggregate roll-up target (教訓 5.29)', () => {
  it('Aggregate verdict names the feature itself as the roll-up target', () => {
    const forest = sampleForest();
    const d = buildDisplayDecisions({ forest, globalThreshold: 0 });
    const root = d.get(fid('root'));
    expect(root?.verdict).toBe(DISPLAY_VERDICT.Aggregate);
    // The target is THIS feature; U19 resolves its geometry via U08 (we never
    // carry geometry here — only the selection of which feature to round to).
    expect(root?.rollUpTargetId).toBe(fid('root'));
  });
  it('non-Aggregate verdicts carry no roll-up target', () => {
    const forest = sampleForest();
    const d = buildDisplayDecisions({ forest, globalThreshold: 2 });
    expect(d.get(fid('leafA'))?.rollUpTargetId).toBeUndefined();
  });
});

// =============================================================================
// 7. Purity (受け入れ基準 6)
// =============================================================================
describe('purity', () => {
  it('does not mutate the forest or depth map; same input -> same output', () => {
    const forest = sampleForest();
    const depths = derivedDepths(forest);
    const depthsSnapshot = new Map(depths);
    const input = {
      forest,
      depths,
      globalThreshold: 1,
      focus: { originId: fid('mid'), depth: 2, emphasize: true },
    } as const;
    const first = buildDisplayDecisions(input);
    const second = buildDisplayDecisions(input);
    // Depth map untouched.
    expect([...depths.entries()]).toEqual([...depthsSnapshot.entries()]);
    // Deterministic.
    for (const id of forest.orderedIds) {
      expect(first.get(id)).toEqual(second.get(id));
    }
  });
});
