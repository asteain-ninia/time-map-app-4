// U41 — the SHARED FR-113 filter resolution memo (filtered-display.ts) unit tests.
//
// Proves the single verdict the draw path + hit-test share: inert short-circuit (the
// perf 鉄則), per-axis culling (種別 / 深度 / 個別非表示), opacity + emphasis dim
// pass-through, the FR-42 → FR-113 sequential composition, and memo identity. Built from
// the REAL domain factories via the persistence fixtures (教訓 5.39).

import { afterEach, describe, expect, it } from 'vitest';

import { createAnchor, createAnchorSnapshot } from '../../domain/anchor';
import { createAnchorEntry, normalizeSeries } from '../../domain/anchor-series';
import { createBasicAttributes, createColorInfo } from '../../domain/attributes';
import { createCoordinate } from '../../domain/coordinate';
import {
  createAggregateFeature,
  createLineFeature,
  type Feature,
} from '../../domain/feature';
import { asAnchorId, asFeatureId, asVertexId } from '../../domain/ids';
import type { DomainProject } from '../../domain/persistence/index';
import {
  CAL,
  DEFAULT_BASEMAP,
  DEFAULT_SETTINGS,
  pointFeature,
  singleAnchorHistory,
  squareLeaf,
} from '../../domain/persistence/fixtures';
import { timePointYear } from '../../domain/time/time-point';
import { createVertex, createVertexStore } from '../../domain/vertex';
import {
  DEFAULT_FILTER_STATE,
  DIM_OPACITY_FACTOR,
  FEATURE_KIND_AXIS,
  isFilterInert,
  setDepthThreshold,
  setEmphasizedKinds,
  setIndividualHidden,
  setKindVisible,
  setOpacity,
} from '../discovery/index';

import type { DisplayControlInput } from '../../render/display-pipeline';
import {
  clearDisplayResolutionCache,
  computeDisplayResolution,
  type DisplayResolution,
} from './display-resolution-cache';
import {
  clearFilteredDisplayCache,
  computeFilteredDisplay,
  resolveFilteredDisplay,
} from './filtered-display';

const COLOR = createColorInfo(true, '#102030', '#405060', '#708090');
const AGG = asFeatureId('agg-1');
const LEAF_A = asFeatureId('leaf-a');
const LEAF_B = asFeatureId('leaf-b');
const PT = asFeatureId('pt-1');
const LN = asFeatureId('ln-1');

const N0: DisplayControlInput = { globalDepth: 0, focus: { originId: null, depth: 0, emphasize: false } };
const N1: DisplayControlInput = { globalDepth: 1, focus: { originId: null, depth: 0, emphasize: false } };

/**
 * An aggregate (agg-1, depth 0) over two leaves (leaf-a / leaf-b, depth 1), plus a point
 * and a line (no hierarchy). Everything effective at year 10.
 */
function hierProject(): DomainProject {
  const a = squareLeaf('leaf-a', 'A国', 0, 0, 10);
  const b = squareLeaf('leaf-b', 'B国', 30, 0, 10);
  const agg = createAggregateFeature(AGG, createBasicAttributes('連邦', 0, 100), COLOR, [LEAF_A, LEAF_B]);
  const aChild = { ...a.feature, parentId: AGG } as Feature;
  const bChild = { ...b.feature, parentId: AGG } as Feature;
  const aggVerts = createVertexStore([...a.vertices, ...b.vertices]);
  const aggHistory = {
    featureId: AGG,
    series: normalizeSeries(
      [createAnchorEntry(createAnchor(asAnchorId('agg-anc'), createAnchorSnapshot([aChild, bChild, agg], aggVerts)), timePointYear(0), null)],
      CAL,
    ),
  };
  const pt = pointFeature('pt-1', '首都', 50, 30); // effective 0..50
  const va = createVertex(asVertexId('ln-a'), createCoordinate(-30, -30));
  const vb = createVertex(asVertexId('ln-b'), createCoordinate(-25, -25));
  const ln = createLineFeature(LN, createBasicAttributes('街道', 0, 1000), COLOR, [va.id, vb.id]);
  return {
    histories: [
      aggHistory,
      singleAnchorHistory('pt-1', [pt.feature], createVertexStore([pt.vertex]), 0),
      singleAnchorHistory('ln-1', [ln], createVertexStore([va, vb]), 0),
    ],
    settings: DEFAULT_SETTINGS,
    baseMap: DEFAULT_BASEMAP,
  };
}

function resolutionAt(control: DisplayControlInput): DisplayResolution {
  return computeDisplayResolution(hierProject(), timePointYear(10), control);
}

afterEach(() => {
  clearFilteredDisplayCache();
  clearDisplayResolutionCache();
});

describe('resolveFilteredDisplay — inert short-circuit (perf 鉄則)', () => {
  it('DEFAULT_FILTER_STATE is inert and resolves to null (no per-feature verdict)', () => {
    expect(isFilterInert(DEFAULT_FILTER_STATE)).toBe(true);
    // null return is the STRUCTURAL proof that resolveFeatureDisplay is never called
    // (the function returns before its loop) — the zero-overhead default path.
    expect(computeFilteredDisplay(resolutionAt(N0), DEFAULT_FILTER_STATE)).toBeNull();
  });

  it('a filter equal-to-default by value is still inert (all kinds on, opacity 1)', () => {
    const equal = setKindVisible(DEFAULT_FILTER_STATE, FEATURE_KIND_AXIS.Point, true);
    expect(isFilterInert(equal)).toBe(true);
    expect(computeFilteredDisplay(resolutionAt(N0), equal)).toBeNull();
  });

  it('any active axis makes it NON-inert (opacity 0.99 alone)', () => {
    const dim = setOpacity(DEFAULT_FILTER_STATE, 0.99);
    expect(isFilterInert(dim)).toBe(false);
    expect(computeFilteredDisplay(resolutionAt(N0), dim)).not.toBeNull();
  });
});

describe('resolveFilteredDisplay — 種別軸 (kind)', () => {
  it('面オフ: area shapes leave the visible母集合, point/line stay', () => {
    // N=1 so leaf-a / leaf-b draw as Real areas.
    const filter = setKindVisible(DEFAULT_FILTER_STATE, FEATURE_KIND_AXIS.Area, false);
    const fd = computeFilteredDisplay(resolutionAt(N1), filter)!;
    expect(fd.visibleIds.has(LEAF_A)).toBe(false);
    expect(fd.visibleIds.has(LEAF_B)).toBe(false);
    expect(fd.visibleIds.has(PT)).toBe(true);
    expect(fd.visibleIds.has(LN)).toBe(true);
  });

  it('点オフ: the point leaves, areas + line stay', () => {
    const filter = setKindVisible(DEFAULT_FILTER_STATE, FEATURE_KIND_AXIS.Point, false);
    const fd = computeFilteredDisplay(resolutionAt(N1), filter)!;
    expect(fd.visibleIds.has(PT)).toBe(false);
    expect(fd.visibleIds.has(LEAF_A)).toBe(true);
    expect(fd.visibleIds.has(LN)).toBe(true);
  });
});

describe('resolveFilteredDisplay — 個別非表示 (individual)', () => {
  it('個別非表示 hides exactly that feature; others unaffected', () => {
    const filter = setIndividualHidden(DEFAULT_FILTER_STATE, PT, true);
    const fd = computeFilteredDisplay(resolutionAt(N1), filter)!;
    expect(fd.visibleIds.has(PT)).toBe(false);
    expect(fd.displayById.get(PT)?.visible).toBe(false);
    expect(fd.visibleIds.has(LEAF_A)).toBe(true);
    expect(fd.visibleIds.has(LN)).toBe(true);
  });
});

describe('resolveFilteredDisplay — 不透明度 (opacity)', () => {
  it('folds a uniform opacity into every visible verdict', () => {
    const filter = setOpacity(DEFAULT_FILTER_STATE, 0.4);
    const fd = computeFilteredDisplay(resolutionAt(N1), filter)!;
    for (const id of [LEAF_A, LEAF_B, PT, LN]) {
      const v = fd.displayById.get(id)!;
      expect(v.visible).toBe(true);
      expect(v.opacity).toBeCloseTo(0.4);
    }
  });
});

describe('resolveFilteredDisplay — 強調 pass-through (dim others)', () => {
  it('emphasized kind keeps full opacity; others dim by DIM_OPACITY_FACTOR', () => {
    const filter = setEmphasizedKinds(DEFAULT_FILTER_STATE, [FEATURE_KIND_AXIS.Point]);
    const fd = computeFilteredDisplay(resolutionAt(N1), filter)!;
    const pt = fd.displayById.get(PT)!;
    expect(pt.emphasized).toBe(true);
    expect(pt.opacity).toBeCloseTo(1);
    const leaf = fd.displayById.get(LEAF_A)!;
    expect(leaf.emphasized).toBe(false);
    expect(leaf.opacity).toBeCloseTo(DIM_OPACITY_FACTOR);
  });
});

describe('resolveFilteredDisplay — FR-42 N と FR-113 M の順次合成 (ユーザー裁定)', () => {
  it('N=1 で展開した子 leaf を M=0 が隠す (定義済みの空白挙動)', () => {
    // FR-42 globalDepth=1 draws leaf-a / leaf-b (depth 1) as Real; FR-113 depthThreshold=0
    // then hides them (depth 1 > 0). Points/lines have no area depth → unaffected. This is
    // the "展開済みの子が深度フィルタで隠れる" defined blank, NOT a bug.
    const filter = setDepthThreshold(DEFAULT_FILTER_STATE, 0);
    const fd = computeFilteredDisplay(resolutionAt(N1), filter)!;
    expect(fd.visibleIds.has(LEAF_A)).toBe(false);
    expect(fd.visibleIds.has(LEAF_B)).toBe(false);
    expect(fd.visibleIds.has(PT)).toBe(true);
    expect(fd.visibleIds.has(LN)).toBe(true);
  });

  it('M≥ 子の深度なら子は残る (M=1 で depth-1 leaf は表示)', () => {
    const filter = setDepthThreshold(DEFAULT_FILTER_STATE, 1);
    const fd = computeFilteredDisplay(resolutionAt(N1), filter)!;
    expect(fd.visibleIds.has(LEAF_A)).toBe(true);
    expect(fd.visibleIds.has(LEAF_B)).toBe(true);
  });

  it('N=0 集約 (depth 0) は M=0 でも残る (集約自体は深度0)', () => {
    // FR-42 rolls up to the aggregate (depth 0); FR-113 M=0 keeps depth-0 features.
    const filter = setDepthThreshold(DEFAULT_FILTER_STATE, 0);
    const fd = computeFilteredDisplay(resolutionAt(N0), filter)!;
    expect(fd.visibleIds.has(AGG)).toBe(true);
  });
});

describe('resolveFilteredDisplay — memo identity (単一 COMPUTATION)', () => {
  it('same (resolution, filter) returns the SAME reference (draw + hit share it)', () => {
    const resolution = resolutionAt(N1);
    const filter = setOpacity(DEFAULT_FILTER_STATE, 0.5);
    const first = resolveFilteredDisplay(resolution, filter);
    const second = resolveFilteredDisplay(resolution, filter);
    expect(second).toBe(first);
  });

  it('inert filter memoizes null too (no recompute)', () => {
    const resolution = resolutionAt(N0);
    expect(resolveFilteredDisplay(resolution, DEFAULT_FILTER_STATE)).toBeNull();
    expect(resolveFilteredDisplay(resolution, DEFAULT_FILTER_STATE)).toBeNull();
  });
});
