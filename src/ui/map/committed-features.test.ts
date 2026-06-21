// P0-A — the committed-feature → U19 render-input bridge (CONVERGE-2).
//
// Proves the render接続 that was missing: a COMMITTED feature resolved at the
// current time becomes a U19 `EvaluatedFeature`, and moving the current time
// changes which features appear. Built from the REAL domain factories via the
// persistence fixtures (教訓 5.39: instantiate, never hand-write literals).

import { afterEach, describe, expect, it, vi } from 'vitest';

import { timePointYear } from '../../domain/time/time-point';
import type { FeatureId } from '../../domain/ids';
import { createVertexStore } from '../../domain/vertex';
import type { DomainProject } from '../../domain/persistence/index';
import {
  CAL,
  DEFAULT_BASEMAP,
  DEFAULT_SETTINGS,
  pointFeature,
  squareLeaf,
  singleAnchorHistory,
} from '../../domain/persistence/fixtures';
import { createAnchor, createAnchorSnapshot } from '../../domain/anchor';
import { createAnchorEntry, normalizeSeries } from '../../domain/anchor-series';
import { createAggregateFeature, createLineFeature } from '../../domain/feature';
import { createCoordinate } from '../../domain/coordinate';
import { createVertex } from '../../domain/vertex';
import { asVertexId } from '../../domain/ids';
import { createBasicAttributes, createColorInfo } from '../../domain/attributes';
import { asAnchorId, asFeatureId } from '../../domain/ids';
import type { Feature } from '../../domain/feature';
import type { FeatureHistory } from '../../domain/persistence/serialize';

import type { DisplayControlInput } from '../../render/display-pipeline';
import * as displayBridge from '../../render/display-bridge';
import {
  buildCommittedFeatures,
  clearCommittedFeaturesCache,
} from './committed-features';
import { clearDisplayResolutionCache } from './display-resolution-cache';

// Default display control: global depth 0 (top-level rollup), no focus. A root
// leaf with no children draws directly at N=0 (it IS its own top-level区).
const DISPLAY: DisplayControlInput = {
  globalDepth: 0,
  focus: { originId: null, depth: 0, emphasize: false },
};

/**
 * A project with a point existing from year 0 and a leaf existing from year 100.
 * At year 0 only the point is effective; at year 100 BOTH are — so the resolved
 * set MUST change with the current time (the property the wiring must preserve).
 */
function project(): DomainProject {
  const pt = pointFeature('pt-1', '首都', 50, 30);
  const leaf = squareLeaf('leaf-1', 'A国', 0, 0, 10);
  return {
    histories: [
      singleAnchorHistory('pt-1', [pt.feature], createVertexStore([pt.vertex]), 0),
      singleAnchorHistory('leaf-1', [leaf.feature], createVertexStore(leaf.vertices), 100),
    ],
    settings: DEFAULT_SETTINGS,
    baseMap: DEFAULT_BASEMAP,
  };
}

afterEach(() => {
  clearCommittedFeaturesCache();
  clearDisplayResolutionCache();
  vi.restoreAllMocks();
});

describe('buildCommittedFeatures', () => {
  it('emits the committed point effective at the current time', () => {
    const features = buildCommittedFeatures(project(), timePointYear(0), null, DISPLAY);
    expect(features.map((f) => f.id)).toEqual(['pt-1']);
    const point = features[0];
    expect(point?.kind).toBe('point');
    if (point?.kind === 'point') {
      expect(point.at).toEqual({ lon: 50, lat: 30 });
    }
  });

  it('changes the resolved set when the current time changes', () => {
    const root = project();
    const atYear0 = buildCommittedFeatures(root, timePointYear(0), null, DISPLAY);
    const atYear100 = buildCommittedFeatures(root, timePointYear(100), null, DISPLAY);

    // At year 0 only the point exists; at year 100 the leaf has come into being.
    expect(new Set(atYear0.map((f) => f.id))).toEqual(new Set(['pt-1']));
    expect(new Set(atYear100.map((f) => f.id))).toEqual(new Set(['pt-1', 'leaf-1']));

    const leaf = atYear100.find((f) => f.id === 'leaf-1');
    expect(leaf?.kind).toBe('area');
    if (leaf && leaf.kind === 'area') {
      // The leaf resolves to a non-empty multipolygon (one territory piece).
      expect(leaf.shape.length).toBeGreaterThan(0);
      expect(leaf.shape[0]?.[0]?.length).toBe(4); // square outer ring
    }
  });

  it('rolls aggregate children up via U34 at global depth 0 (FR-42 集約形状)', () => {
    // An aggregate parent over two disjoint leaves, all in ONE anchor snapshot.
    const a = squareLeaf('leaf-a', 'A国', 0, 0, 10);
    const b = squareLeaf('leaf-b', 'B国', 20, 0, 10);
    const aggColor = createColorInfo(true, '#abcdef', '#fedcba', '#012345');
    const agg = createAggregateFeature(
      asFeatureId('agg-1'),
      createBasicAttributes('連邦', 0, 100),
      aggColor,
      [asFeatureId('leaf-a'), asFeatureId('leaf-b')],
    );
    const aChild = { ...a.feature, parentId: asFeatureId('agg-1') } as Feature;
    const bChild = { ...b.feature, parentId: asFeatureId('agg-1') } as Feature;
    const verts = createVertexStore([...a.vertices, ...b.vertices]);
    const anchor = createAnchor(
      asAnchorId('agg-1-anc'),
      createAnchorSnapshot([aChild, bChild, agg], verts),
    );
    const history: FeatureHistory = {
      featureId: asFeatureId('agg-1'),
      series: normalizeSeries([createAnchorEntry(anchor, timePointYear(0), null)], CAL),
    };
    const root = {
      histories: [history],
      settings: DEFAULT_SETTINGS,
      baseMap: DEFAULT_BASEMAP,
    };

    const features = buildCommittedFeatures(root, timePointYear(0), null, DISPLAY);

    // At depth 0 the children roll up to the aggregate: ONE area drawn, for the
    // aggregate, NOT one per leaf (FR-42 非干渉 / 集約形状).
    const areaIds = features.filter((f) => f.kind === 'area').map((f) => f.id);
    expect(areaIds).toEqual(['agg-1']);
    const aggArea = features.find((f) => f.id === 'agg-1');
    if (aggArea && aggArea.kind === 'area') {
      expect(aggArea.label).toBe('連邦');
      expect(aggArea.style.fill).toBe('#abcdef'); // the aggregate's own color
      // The union carries BOTH leaves' pieces (教訓 5.1 全片保持).
      expect(aggArea.shape.length).toBe(2);
    }
  });

  it('HB-14/FR-07: unwraps a seam-crossing line into a continuous run [179,181]', () => {
    // A line whose two vertices are stored as representatives either side of the
    // antimeridian (lon 179 and lon -179, a 2° hop across +180). The render layer's
    // EvaluatedLine.points contract requires CONTINUOUS longitudes; buildCommittedFeatures
    // must unwrap them so the polyline is one short segment, not a 358° span drawn the
    // long way round (which made it vanish / misdraw on near-seam zoom-in).
    const va = createVertex(asVertexId('seam-a'), createCoordinate(179, 0));
    const vb = createVertex(asVertexId('seam-b'), createCoordinate(-179, 0));
    const lf = createLineFeature(
      asFeatureId('seam-line'),
      createBasicAttributes('日付変更線', 0, 50),
      createColorInfo(true, '#abcdef', '#fedcba', '#012345'),
      [va.id, vb.id],
    );
    const root: DomainProject = {
      histories: [
        singleAnchorHistory('seam-line', [lf], createVertexStore([va, vb]), 0),
      ],
      settings: DEFAULT_SETTINGS,
      baseMap: DEFAULT_BASEMAP,
    };
    const features = buildCommittedFeatures(root, timePointYear(10), null, DISPLAY);
    const line = features.find((f) => f.id === 'seam-line');
    expect(line?.kind).toBe('line');
    if (line && line.kind === 'line') {
      // First vertex kept as-is; second unwrapped to +181 (the short way), not -179.
      expect(line.points.map((p) => p.lon)).toEqual([179, 181]);
      expect(line.points.map((p) => p.lat)).toEqual([0, 0]);
    }
  });

  it('does NOT emit a 1-vertex line (描画されない＝EvaluatedLine にもしない, clip⊇draw⊇hit)', () => {
    // bughunt: a degenerate single-vertex line (corrupt load / mid-edit transient) is
    // structurally valid but renders to NOTHING — feature-layer.buildLinePrimitives
    // needs ≥2 points. The bridge previously dropped a line only when raw.length===0,
    // so a 1-vertex line became an EvaluatedLine that the renderer never drew yet the
    // hit-test offered its (invisible) vertex for selection. The bridge must mirror the
    // renderer's minimum-vertex rule and emit NO line for a sub-2-vertex line.
    const v = createVertex(asVertexId('solo-v'), createCoordinate(10, 10));
    const lf = createLineFeature(
      asFeatureId('solo-line'),
      createBasicAttributes('一頂点線', 0, 50),
      createColorInfo(true, '#abcdef', '#fedcba', '#012345'),
      [v.id],
    );
    const root: DomainProject = {
      histories: [
        singleAnchorHistory('solo-line', [lf], createVertexStore([v]), 0),
      ],
      settings: DEFAULT_SETTINGS,
      baseMap: DEFAULT_BASEMAP,
    };
    const features = buildCommittedFeatures(root, timePointYear(10), null, DISPLAY);
    // The 1-vertex line contributes NO drawable: not as a line, and not as anything.
    expect(features.find((f) => f.id === 'solo-line')).toBeUndefined();
    expect(features.filter((f) => f.kind === 'line')).toHaveLength(0);
  });

  it('emits a 2-vertex line (the minimum drawable line is still drawn)', () => {
    // Boundary parity with the predicate: exactly MIN_LINE_VERTICES (2) IS drawable.
    const va = createVertex(asVertexId('two-a'), createCoordinate(10, 10));
    const vb = createVertex(asVertexId('two-b'), createCoordinate(12, 10));
    const lf = createLineFeature(
      asFeatureId('two-line'),
      createBasicAttributes('二頂点線', 0, 50),
      createColorInfo(true, '#abcdef', '#fedcba', '#012345'),
      [va.id, vb.id],
    );
    const root: DomainProject = {
      histories: [
        singleAnchorHistory('two-line', [lf], createVertexStore([va, vb]), 0),
      ],
      settings: DEFAULT_SETTINGS,
      baseMap: DEFAULT_BASEMAP,
    };
    const features = buildCommittedFeatures(root, timePointYear(10), null, DISPLAY);
    const line = features.find((f) => f.id === 'two-line');
    expect(line?.kind).toBe('line');
    if (line && line.kind === 'line') expect(line.points).toHaveLength(2);
  });

  it('marks the active feature selected (FR-82) without changing structure', () => {
    const root = project();
    const selected = 'pt-1' as unknown as FeatureId;
    const features = buildCommittedFeatures(root, timePointYear(0), selected, DISPLAY);
    const point = features.find((f) => f.id === 'pt-1');
    expect(point?.selected).toBe(true);

    const none = buildCommittedFeatures(root, timePointYear(0), null, DISPLAY);
    expect(none.find((f) => f.id === 'pt-1')?.selected).toBe(false);
  });
});

// bughunt2 回帰: a camera-only frame must NOT rebuild the EvaluatedFeature[] batch.
// `ports.redraw()` re-reads the committed-features getter once per drawn frame; during a
// sustained pan/zoom (FR-110 caps the rate, not the cost) the four inputs (root / time /
// selectedId / displayControl) are all unchanged immutable store references, so the built
// batch — including the per-line `unwrapLonSequence` allocations and the presentation
// mapping (`toEvaluatedAreas`) — must be served from the memo, not re-derived. We spy on
// the presentation-mapping step that should run only on a real rebuild and assert it runs
// ONCE across many same-input calls, then re-runs only on an input identity change.
describe('buildCommittedFeatures output memo (bughunt2: camera-only frames reuse the batch)', () => {
  it('reuses the SAME batch across repeated same-input frames (no rebuild)', () => {
    const root = project();
    const time = timePointYear(100); // both the point AND the leaf area are effective
    const spy = vi.spyOn(displayBridge, 'toEvaluatedAreas');

    const first = buildCommittedFeatures(root, time, null, DISPLAY);
    // Three more camera-only frames at the SAME generation (a pan/zoom redraw burst).
    const second = buildCommittedFeatures(root, time, null, DISPLAY);
    const third = buildCommittedFeatures(root, time, null, DISPLAY);

    // The area presentation mapping built the batch exactly ONCE — the later frames hit
    // the memo and returned the SAME array object (identity reuse, not a copy).
    expect(spy).toHaveBeenCalledTimes(1);
    expect(second).toBe(first);
    expect(third).toBe(first);
  });

  it('rebuilds when the selection IDENTITY changes (FR-82, no stale batch)', () => {
    const root = project();
    const time = timePointYear(100);
    const selected = 'leaf-1' as unknown as FeatureId;
    const spy = vi.spyOn(displayBridge, 'toEvaluatedAreas');

    const unselected = buildCommittedFeatures(root, time, null, DISPLAY);
    const withSelection = buildCommittedFeatures(root, time, selected, DISPLAY);

    // A selection change is a miss → a fresh rebuild, and the new batch reflects it.
    expect(spy).toHaveBeenCalledTimes(2);
    expect(withSelection).not.toBe(unselected);
    expect(unselected.find((f) => f.id === 'leaf-1')?.selected).toBe(false);
    expect(withSelection.find((f) => f.id === 'leaf-1')?.selected).toBe(true);

    // Re-querying the FIRST (unselected) generation is a hit again (LRU capacity ≥ 2).
    const unselectedAgain = buildCommittedFeatures(root, time, null, DISPLAY);
    expect(spy).toHaveBeenCalledTimes(2);
    expect(unselectedAgain).toBe(unselected);
  });

  it('rebuilds when the time IDENTITY changes (the resolved set changes)', () => {
    const root = project();
    const spy = vi.spyOn(displayBridge, 'toEvaluatedAreas');

    const atYear0 = buildCommittedFeatures(root, timePointYear(0), null, DISPLAY);
    const atYear100 = buildCommittedFeatures(root, timePointYear(100), null, DISPLAY);

    expect(spy).toHaveBeenCalledTimes(2);
    // The batches differ — year 0 has only the point, year 100 adds the leaf area.
    expect(new Set(atYear0.map((f) => f.id))).toEqual(new Set(['pt-1']));
    expect(new Set(atYear100.map((f) => f.id))).toEqual(new Set(['pt-1', 'leaf-1']));
  });
});
