// U08 階層検証の世界シーム整列テスト (audit root cause A の横展開).
//
// checkAggregateShapes は子の派生面積を unionAll で合体し、その「穴」を inter-child gap
// として検出する。子は resolveLeafShape の RAW representative 座標由来なので、シームを
// またいで隣接する 2 子 (+179 付近 と −179 付近) は representative 空間で ~360° 離れて
// 格納され得る。整列せず union/difference に渡すと、隙間なくタイルしている子同士が逆回り
// ~358° で散らばり、(1) 偽の inter-child gap (AggregateShapeMismatch) を報告、または
// (2) areasEqualWithinTolerance が誤って不一致を返す。共有ヘルパ alignMultiPolygon /
// referenceLonForMultiPolygon (単一真実源) で共通 world-turn へ揃えてから演算することを
// 固定する。

import { describe, expect, it } from 'vitest';

import { createBasicAttributes, createColorInfo } from '../attributes';
import { createCoordinate, type WorldCoordinate } from '../coordinate';
import {
  createAggregateFeature,
  createLeafFeature,
  type Feature,
} from '../feature';
import { asFeatureId, asRingId, asVertexId } from '../ids';
import { createShape, createHoleRing, createTerritoryRing } from '../ring';
import { createVertex, createVertexStore, type Vertex } from '../vertex';
import { buildForest } from './forest';
import {
  HIERARCHY_VIOLATION,
  areasEqualWithinTolerance,
  checkAggregateShapes,
} from './validate';
import type { GeoMultiPolygon } from '../geometry/types';

const COLOR = createColorInfo(true, '#102030', '#405060', '#708090');

/** Leaf from an explicit coordinate ring (controls seam placement / vertex order). */
function leafFromRing(
  id: string,
  coords: readonly WorldCoordinate[],
  parentId?: string,
): { feature: Feature; vertices: Vertex[] } {
  const vertices = coords.map((c, i) => createVertex(asVertexId(`v-${id}-${i}`), c));
  const ring = createTerritoryRing(asRingId(`r-${id}`), vertices.map((v) => v.id));
  const fid = asFeatureId(id);
  const feature =
    parentId === undefined
      ? createLeafFeature(fid, createBasicAttributes(id, 0, 1), COLOR, createShape([ring]))
      : createLeafFeature(fid, createBasicAttributes(id, 0, 1), COLOR, createShape([ring]), {
          parentId: asFeatureId(parentId),
        });
  return { feature, vertices };
}

function aggFeature(id: string, childIds: readonly string[]): Feature {
  return createAggregateFeature(
    asFeatureId(id),
    createBasicAttributes(id, 0, 1),
    COLOR,
    childIds.map(asFeatureId),
  );
}

describe('U08 階層検証 — 世界シーム整列 (root cause A 横展開)', () => {
  it('シームをまたいで隙間なくタイルする 2 子は AggregateShapeMismatch を出さない', () => {
    // 子 A: [170,180]×[0,10] (東端), 子 B: [-180,-170]×[0,10] (西端, representative)。
    // 連続フレームでは 180==-180 を共有辺として隙間なく [170,190] をタイルする。
    const a = leafFromRing(
      'a',
      [
        createCoordinate(170, 0),
        createCoordinate(180, 0),
        createCoordinate(180, 10),
        createCoordinate(170, 10),
      ],
      'agg',
    );
    const b = leafFromRing(
      'b',
      [
        createCoordinate(-180, 0),
        createCoordinate(-170, 0),
        createCoordinate(-170, 10),
        createCoordinate(-180, 10),
      ],
      'agg',
    );
    const features = [aggFeature('agg', ['a', 'b']), a.feature, b.feature];
    const store = createVertexStore([...a.vertices, ...b.vertices]);
    const forest = buildForest(features);

    const violations = checkAggregateShapes(forest, store).filter(
      (v) => v.kind === HIERARCHY_VIOLATION.AggregateShapeMismatch,
    );
    expect(violations).toHaveLength(0);
  });

  it('シームをまたぐ子自身の lake hole は inter-child gap として誤検出しない', () => {
    // 子 A: 連続フレーム [170,190]×[0,10] の外環に、自身の lake hole [178,182]×[3,7] を
    // 持つ (どちらも representative で seam をまたいで格納)。子 B: [150,170]×[0,10] が隣接。
    // interChildGap は union の穴から「各子自身の hole」を差し引いて inter-child gap だけを
    // 残す。整列が無いと holeRegions / 残差 difference が 360° 窓ズレを起こし、A 自身の
    // lake を子の hole として相殺できず偽の AggregateShapeMismatch を出し得る。
    const outer = [
      createVertex(asVertexId('A-o0'), createCoordinate(170, 0)),
      createVertex(asVertexId('A-o1'), createCoordinate(-170, 0)), // 連続 190
      createVertex(asVertexId('A-o2'), createCoordinate(-170, 10)),
      createVertex(asVertexId('A-o3'), createCoordinate(170, 10)),
    ];
    const hole = [
      createVertex(asVertexId('A-h0'), createCoordinate(178, 3)),
      createVertex(asVertexId('A-h1'), createCoordinate(178, 7)),
      createVertex(asVertexId('A-h2'), createCoordinate(-178, 7)), // 連続 182
      createVertex(asVertexId('A-h3'), createCoordinate(-178, 3)),
    ];
    const trA = createTerritoryRing(asRingId('A-tr'), outer.map((v) => v.id));
    const hrA = createHoleRing(asRingId('A-hr'), hole.map((v) => v.id), asRingId('A-tr'));
    const a = createLeafFeature(
      asFeatureId('A'),
      createBasicAttributes('A', 0, 1),
      COLOR,
      createShape([trA, hrA]),
      { parentId: asFeatureId('agg') },
    );
    const b = leafFromRing(
      'B',
      [
        createCoordinate(150, 0),
        createCoordinate(170, 0),
        createCoordinate(170, 10),
        createCoordinate(150, 10),
      ],
      'agg',
    );
    const features = [aggFeature('agg', ['A', 'B']), a, b.feature];
    const store = createVertexStore([...outer, ...hole, ...b.vertices]);
    const forest = buildForest(features);

    const violations = checkAggregateShapes(forest, store).filter(
      (v) => v.kind === HIERARCHY_VIOLATION.AggregateShapeMismatch,
    );
    // A's lake is the child's OWN hole, never an inter-child gap.
    expect(violations).toHaveLength(0);
  });

  it('areasEqualWithinTolerance: シームをまたぐ同一領域を等価判定する', () => {
    // 同一の連続矩形を、(1) 単一シーム跨ぎリング、(2) representative 2 片、で表現。
    // 整列が無いと 360° 窓ズレで「不一致」になる。
    const folded: GeoMultiPolygon = [
      [
        [
          createCoordinate(170, 0),
          createCoordinate(-170, 0), // 連続フレームで 190
          createCoordinate(-170, 10),
          createCoordinate(170, 10),
        ],
      ],
    ];
    const same: GeoMultiPolygon = [
      [
        [
          createCoordinate(170, 0),
          createCoordinate(190, 0),
          createCoordinate(190, 10),
          createCoordinate(170, 10),
        ],
      ],
    ];
    expect(areasEqualWithinTolerance(folded, same)).toBe(true);
  });

  it('areasEqualWithinTolerance: シームから離れた通常領域の判定は不変', () => {
    const a: GeoMultiPolygon = [
      [
        [
          createCoordinate(0, 0),
          createCoordinate(10, 0),
          createCoordinate(10, 10),
          createCoordinate(0, 10),
        ],
      ],
    ];
    const b: GeoMultiPolygon = [
      [
        [
          createCoordinate(0, 0),
          createCoordinate(10, 0),
          createCoordinate(10, 10),
          createCoordinate(0, 10),
        ],
      ],
    ];
    const disjoint: GeoMultiPolygon = [
      [
        [
          createCoordinate(40, 0),
          createCoordinate(50, 0),
          createCoordinate(50, 10),
          createCoordinate(40, 10),
        ],
      ],
    ];
    expect(areasEqualWithinTolerance(a, b)).toBe(true);
    expect(areasEqualWithinTolerance(a, disjoint)).toBe(false);
  });
});
