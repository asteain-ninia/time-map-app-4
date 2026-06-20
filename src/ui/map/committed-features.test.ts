// P0-A — the committed-feature → U19 render-input bridge (CONVERGE-2).
//
// Proves the render接続 that was missing: a COMMITTED feature resolved at the
// current time becomes a U19 `EvaluatedFeature`, and moving the current time
// changes which features appear. Built from the REAL domain factories via the
// persistence fixtures (教訓 5.39: instantiate, never hand-write literals).

import { describe, expect, it } from 'vitest';

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
import { buildCommittedFeatures } from './committed-features';

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
