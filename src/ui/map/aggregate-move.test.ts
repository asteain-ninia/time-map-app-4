// ［動かす］で集約地物を引くときの確定の材料と下書き（所有者の裁定 2026-11-01）。分類そのものの検査は
// `domain/editing/move.aggregate.test.ts`、記録の置き場は `domain/editing/apply-proposal.aggregate-move.test.ts`。
//
//   npx vitest run src/ui/map/aggregate-move.test.ts

import { describe, expect, it } from 'vitest';

import { createAnchor } from '../../domain/anchor';
import { createAnchorEntry } from '../../domain/anchor-series';
import { createBasicAttributes, createColorInfo } from '../../domain/attributes';
import { beginDrag, EDIT_TOOL, updateDrag } from '../../domain/editing/drag-session';
import { confirmRelease, EDIT_REFUSAL, RELEASE_OUTCOME } from '../../domain/editing/edit-flow';
import { coord, fid, territory, vid } from '../../domain/editing/fixtures';
import { createAggregateFeature, createLeafFeature, type Feature } from '../../domain/feature';
import { createGeoParams } from '../../domain/geo/geo-params';
import { asAnchorId } from '../../domain/ids';
import type { DomainProject } from '../../domain/persistence/serialize';
import { createShape } from '../../domain/ring';
import { timePointYear } from '../../domain/time/time-point';
import { createVertex, createVertexStore, type Vertex } from '../../domain/vertex';
import {
  AGGREGATE_MOVE_FIXED_MARK,
  buildFeatureMovePreviewPrimitives,
} from './active-feature-handles';
import { AGGREGATE_MOVE_BLOCK, aggregateMoveAt, aggregateMoveBlock } from './aggregate-move';
import { buildEditSnapshot, buildMovingRings } from './edit-session-snapshot';

const DEFAULT_DISPLAY_CONTROL = {
  globalDepth: 0,
  focus: { originId: null, depth: 0, emphasize: false },
};
const T = timePointYear(1000);
const ATTRS = createBasicAttributes('test', 0, 9999);
const COLOR = createColorInfo(true, '#111', '#222', '#333');

function body(id: string, lon: number, lat: number): Vertex {
  return createVertex(vid(id), coord(lon, lat));
}

/** 国（集約）の下に州 2 つ。州 B は隣の国と頂点 s を共有する。 */
function project(): DomainProject {
  const country = createAggregateFeature(fid('国'), ATTRS, COLOR, [fid('州A'), fid('州B')]);
  const a = createLeafFeature(fid('州A'), ATTRS, COLOR, createShape([territory('ra', ['a0', 'a1', 'ab'])]), {
    parentId: fid('国'),
  });
  const b = createLeafFeature(fid('州B'), ATTRS, COLOR, createShape([territory('rb', ['ab', 'b1', 's'])]), {
    parentId: fid('国'),
  });
  const n = createLeafFeature(fid('隣'), ATTRS, COLOR, createShape([territory('rn', ['s', 'n1', 'n2'])]));
  const inside: readonly Feature[] = [country, a, b];
  return {
    histories: [
      {
        featureId: country.id,
        series: {
          entries: [
            createAnchorEntry(
              createAnchor(asAnchorId('a-国'), {
                features: inside,
                vertices: createVertexStore([
                  body('a0', 0, 0),
                  body('a1', 1, 0),
                  body('ab', 1, 1),
                  body('b1', 2, 0),
                  body('s', 2, 1),
                ]),
              }),
              T,
            ),
          ],
        },
      },
      {
        featureId: n.id,
        series: {
          entries: [
            createAnchorEntry(
              createAnchor(asAnchorId('a-隣'), {
                features: [n],
                vertices: createVertexStore([body('s', 2, 1), body('n1', 3, 0), body('n2', 3, 1)]),
              }),
              T,
            ),
          ],
        },
      },
    ],
    settings: {
      calendarId: 'gregorian',
      geo: createGeoParams(40000, 0.0034),
      gridSpacingDeg: 10,
      snapDistancePx: 50,
      autoColorDefault: true,
    },
    baseMap: { source: 's', meta: { lonWest: -180, lonEast: 180, latNorth: 90, latSouth: -90 } },
  };
}

function session(dLon: number, dLat: number) {
  const begun = beginDrag({ tool: EDIT_TOOL.FeatureMove, featureId: fid('国') }, coord(0, 0));
  return updateDrag(begun, { preview: coord(dLon, dLat) });
}

describe('aggregateMoveAt', () => {
  it('集約地物でないなら無く、同じ根・同じ年なら同じ計画を返す', () => {
    const root = project();
    expect(aggregateMoveAt(root, T, fid('州A'))).toBeUndefined();
    expect(aggregateMoveAt(root, T, fid('無'))).toBeUndefined();
    const first = aggregateMoveAt(root, T, fid('国'));
    expect(first?.plan.leaves).toHaveLength(2);
    expect(aggregateMoveAt(root, timePointYear(1000), fid('国'))).toBe(first);
  });

  it('根が替われば計画を作り直す', () => {
    const first = aggregateMoveAt(project(), T, fid('国'));
    expect(aggregateMoveAt(project(), T, fid('国'))).not.toBe(first);
  });
});

describe('aggregateMoveBlock', () => {
  const plan = aggregateMoveAt(project(), T, fid('国'))!.plan;

  it('動かせるなら null、下位領域が無ければ・全部不動なら理由を返す', () => {
    expect(aggregateMoveBlock(plan)).toBeNull();
    expect(aggregateMoveBlock({ ...plan, leaves: [] })).toBe(AGGREGATE_MOVE_BLOCK.NoLeaves);
    expect(aggregateMoveBlock({ ...plan, movingVertexIds: [] })).toBe(AGGREGATE_MOVE_BLOCK.AllFixed);
  });
});

describe('確定の材料', () => {
  const ctx = { getRoot: project, getTime: () => T };

  it('写しは集約地物の記録と、動く頂点の新しい体だけを運ぶ', () => {
    const root = project();
    const snapshot = buildEditSnapshot({ getRoot: () => root, getTime: () => T }, session(2, 1));
    expect(snapshot.feature?.id).toBe(fid('国'));
    const moved = new Map(snapshot.vertices.map((v) => [v.id, v.coordinate]));
    expect([...moved.keys()].sort()).toEqual([vid('a0'), vid('a1'), vid('ab'), vid('b1')].sort());
    expect(moved.get(vid('ab'))).toEqual(coord(3, 2));
  });

  it('形の変わる輪だけを測り、全部動く輪は測らない', () => {
    const rings = buildMovingRings(ctx, session(2, 1));
    expect(rings).toHaveLength(1);
    // 州 B の輪 [ab, b1, s] のうち、s（添字 2）は動かない。
    expect(rings[0]?.movingIndexes).toEqual([0, 1]);
    expect(rings[0]?.closed).toBe(true);
  });

  it('不動の頂点から伸びる辺が半周以上になる引きは断る', () => {
    const root = project();
    const moving = session(200, 0);
    const outcome = confirmRelease({
      session: moving,
      anchorTime: T,
      snapshot: buildEditSnapshot({ getRoot: () => root, getTime: () => T }, moving),
      current: root,
      movingRings: buildMovingRings({ getRoot: () => root, getTime: () => T }, moving),
      runProcess: () => {
        throw new Error('断るので手続きへ進まない');
      },
    });
    expect(outcome).toEqual({ kind: RELEASE_OUTCOME.Refused, reason: EDIT_REFUSAL.LongDrag });
  });
});

describe('引いている間の下書き', () => {
  it('下位の末端地物の輪郭と、動かない頂点の印を描く', () => {
    const root = project();
    const prims = buildFeatureMovePreviewPrimitives(
      root,
      T,
      fid('国'),
      DEFAULT_DISPLAY_CONTROL,
      session(2, 1),
    );
    expect(prims.filter((p) => p.kind === 'line')).toHaveLength(2);
    const marks = prims.filter((p) => p.kind === 'point');
    expect(marks).toEqual([
      { kind: 'point', at: { lon: 2, lat: 1 }, ...AGGREGATE_MOVE_FIXED_MARK },
    ]);
  });

  it('輪郭は不動の頂点を元の場所に置いたまま、動く頂点を動いた先に描く', () => {
    const root = project();
    const prims = buildFeatureMovePreviewPrimitives(
      root,
      T,
      fid('国'),
      DEFAULT_DISPLAY_CONTROL,
      session(2, 1),
    );
    const lines = prims.filter((p) => p.kind === 'line');
    const stateB = JSON.stringify(lines[1]);
    expect(stateB).toContain('"lon":2,"lat":1');
    expect(stateB).toContain('"lon":3,"lat":2');
  });

  it('印が上限を超えるなら印を省き、輪郭は描く', () => {
    const root = project();
    const prims = buildFeatureMovePreviewPrimitives(
      root,
      T,
      fid('国'),
      DEFAULT_DISPLAY_CONTROL,
      session(2, 1),
      undefined,
      undefined,
      0,
    );
    expect(prims.some((p) => p.kind === 'point')).toBe(false);
    expect(prims.filter((p) => p.kind === 'line')).toHaveLength(2);
  });
});
