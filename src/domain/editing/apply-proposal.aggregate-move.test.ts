// 集約地物を［動かす］で引いた確定の、記録の置き場と後の年の引き継ぎ（所有者の裁定 2026-11-01）。
//
//   npx vitest run src/domain/editing/apply-proposal.aggregate-move.test.ts

import { describe, expect, it } from 'vitest';

import { createAnchor } from '../anchor';
import { createAnchorEntry, resolveAt } from '../anchor-series';
import { createBasicAttributes, createColorInfo } from '../attributes';
import { createEditProposal } from '../consistency/types';
import { createAggregateFeature, createLeafFeature, referencedVertexIds, type Feature } from '../feature';
import { createGeoParams } from '../geo/geo-params';
import { asAnchorId, type VertexId } from '../ids';
import { checkConsistency, INCONSISTENCY } from '../persistence/consistency';
import type { DomainProject, FeatureHistory } from '../persistence/serialize';
import { createShape } from '../ring';
import { getCalendar } from '../time/calendar';
import { timePointYear } from '../time/time-point';
import { createVertex, createVertexStore, getVertex, type Vertex } from '../vertex';
import { applyEditProposal, reportVertexCarryForward } from './apply-proposal';
import { buildSnapshot } from './edit-flow';
import { coord, fid, territory, vid } from './fixtures';
import { moveVertexSet, planAggregateMove } from './move';

const calendar = getCalendar('gregorian');
const ATTRS = createBasicAttributes('test', 0, 9999);
const COLOR = createColorInfo(true, '#111', '#222', '#333');
const T = timePointYear(1000);

function body(id: string, lon: number, lat: number): Vertex {
  return createVertex(vid(id), coord(lon, lat));
}

function leaf(id: string, parent: string | undefined, vertexIds: readonly string[]): Feature {
  return createLeafFeature(
    fid(id),
    ATTRS,
    COLOR,
    createShape([territory(`r-${id}`, vertexIds)]),
    parent === undefined ? {} : { parentId: fid(parent) },
  );
}

function history(
  owner: string,
  entries: ReadonlyArray<{
    readonly year: number;
    readonly features: readonly Feature[];
    readonly vertices: readonly Vertex[];
  }>,
): FeatureHistory {
  return {
    featureId: fid(owner),
    series: {
      entries: entries.map((e) =>
        createAnchorEntry(
          createAnchor(asAnchorId(`a-${owner}-${String(e.year)}`), {
            features: e.features,
            vertices: createVertexStore(e.vertices),
          }),
          timePointYear(e.year),
        ),
      ),
    },
  };
}

function project(histories: readonly FeatureHistory[]): DomainProject {
  return {
    histories,
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

function featuresAtT(root: DomainProject): Feature[] {
  const out: Feature[] = [];
  for (const h of root.histories) {
    const r = resolveAt(h.series, T, calendar);
    if (r.kind === 'present') out.push(...r.entry.anchor.snapshot.features);
  }
  return out;
}

/** 計画を立てて確定する（画面の経路と同じ順）。 */
function moveAggregate(
  root: DomainProject,
  aggregateId: string,
  dLon: number,
  dLat: number,
): { readonly after: DomainProject; readonly proposal: ReturnType<typeof proposalOf> } {
  const proposal = proposalOf(root, aggregateId, dLon, dLat);
  return { after: applyEditProposal(root, proposal, calendar), proposal };
}

function proposalOf(root: DomainProject, aggregateId: string, dLon: number, dLat: number) {
  const features = featuresAtT(root);
  const all: Vertex[] = [];
  for (const h of root.histories) {
    const r = resolveAt(h.series, T, calendar);
    if (r.kind === 'present') all.push(...r.entry.anchor.snapshot.vertices.byId.values());
  }
  const plan = planAggregateMove(fid(aggregateId), features);
  const moved = moveVertexSet(plan.movingVertexIds, createVertexStore(all), { dLon, dLat });
  const aggregate = features.find((f) => f.id === fid(aggregateId))!;
  return createEditProposal(aggregate.id, T, buildSnapshot({ feature: aggregate, vertices: moved }));
}

function coordinateIn(root: DomainProject, owner: string, year: number, vertex: string) {
  const h = root.histories.find((x) => x.featureId === fid(owner))!;
  const r = resolveAt(h.series, timePointYear(year), calendar);
  if (r.kind !== 'present') throw new Error('居ない');
  return getVertex(r.entry.anchor.snapshot.vertices, vid(vertex))?.coordinate;
}

function anchorYears(root: DomainProject, owner: string): number[] {
  return root.histories
    .find((x) => x.featureId === fid(owner))!
    .series.entries.map((e) => e.start.year);
}

/** 国（集約）の錨に州 A が居候し、州 B は自分の系列、隣は州 B と頂点 s を共有する。 */
function nestedProject(): DomainProject {
  const country = createAggregateFeature(fid('国'), ATTRS, COLOR, [fid('州A'), fid('州B')]);
  const a = leaf('州A', '国', ['a0', 'a1', 'ab']);
  const b = leaf('州B', '国', ['ab', 'b1', 's']);
  const neighbour = leaf('隣', undefined, ['s', 'n1', 'n2']);
  const aBodies = [body('a0', 0, 0), body('a1', 1, 0), body('ab', 1, 1)];
  const bBodies = [body('ab', 1, 1), body('b1', 2, 0), body('s', 2, 1)];
  const nBodies = [body('s', 2, 1), body('n1', 3, 0), body('n2', 3, 1)];
  return project([
    history('国', [
      { year: 1000, features: [country, a], vertices: aBodies },
      { year: 1500, features: [country, a], vertices: aBodies },
    ]),
    history('州B', [
      { year: 1000, features: [b], vertices: bBodies },
      { year: 1500, features: [b], vertices: bBodies },
    ]),
    history('隣', [{ year: 1000, features: [neighbour], vertices: nBodies }]),
  ]);
}

describe('集約地物を動かす確定', () => {
  it('親の錨の下位領域も自分の系列の下位領域も動き、外と共有する頂点は動かない', () => {
    const { after } = moveAggregate(nestedProject(), '国', 10, 5);
    expect(coordinateIn(after, '国', 1000, 'a0')).toEqual(coord(10, 5));
    // 下位領域どうしの共有頂点は、引いている 2 つの系列の両方で動く。
    expect(coordinateIn(after, '国', 1000, 'ab')).toEqual(coord(11, 6));
    expect(coordinateIn(after, '州B', 1000, 'ab')).toEqual(coord(11, 6));
    expect(coordinateIn(after, '州B', 1000, 'b1')).toEqual(coord(12, 5));
    // 外の面と共有している頂点は動かず、隣の系列は同じ値のまま。
    expect(coordinateIn(after, '州B', 1000, 's')).toEqual(coord(2, 1));
    expect(coordinateIn(after, '隣', 1000, 's')).toEqual(coord(2, 1));
  });

  it('T に引いていない系列へ錨を増やさない: 押した年に錨があれば増えない', () => {
    const before = nestedProject();
    const { after } = moveAggregate(before, '国', 10, 5);
    expect(anchorYears(after, '国')).toEqual(anchorYears(before, '国'));
    expect(anchorYears(after, '州B')).toEqual(anchorYears(before, '州B'));
    expect(after.histories.find((h) => h.featureId === fid('隣'))).toBe(
      before.histories.find((h) => h.featureId === fid('隣')),
    );
  });

  it('下位領域が全部自分の系列を持つなら、集約地物の系列は 1 本も増えない', () => {
    const country = createAggregateFeature(fid('国'), ATTRS, COLOR, [fid('州')]);
    const before = project([
      history('国', [{ year: 900, features: [country], vertices: [] }]),
      history('州', [
        {
          year: 900,
          features: [leaf('州', '国', ['a', 'b', 'c'])],
          vertices: [body('a', 0, 0), body('b', 1, 0), body('c', 1, 1)],
        },
      ]),
    ]);
    const { after } = moveAggregate(before, '国', 1, 1);
    expect(after.histories.find((h) => h.featureId === fid('国'))).toBe(
      before.histories.find((h) => h.featureId === fid('国')),
    );
    expect(anchorYears(after, '州')).toEqual([900, 1000]);
    // 押した年より前の記録は動かない。
    expect(coordinateIn(after, '州', 950, 'a')).toEqual(coord(0, 0));
    expect(coordinateIn(after, '州', 1000, 'a')).toEqual(coord(1, 1));
  });

  it('後の年の錨へ、自分の系列の下位領域のぶんも引き継ぎ、その数を数える', () => {
    const before = nestedProject();
    const { after, proposal } = moveAggregate(before, '国', 10, 5);
    expect(coordinateIn(after, '国', 1500, 'a0')).toEqual(coord(10, 5));
    expect(coordinateIn(after, '州B', 1500, 'b1')).toEqual(coord(12, 5));
    expect(coordinateIn(after, '州B', 1500, 's')).toEqual(coord(2, 1));
    expect(reportVertexCarryForward(before, proposal, calendar)).toEqual({
      anchorCount: 2,
      firstYear: 1500,
    });
  });

  it('後の年に本当に動いた頂点は、その年の記録を壊さない', () => {
    const country = createAggregateFeature(fid('国'), ATTRS, COLOR, [fid('州A')]);
    const a = leaf('州A', '国', ['a', 'b', 'c']);
    const before = project([
      history('国', [
        {
          year: 1000,
          features: [country, a],
          vertices: [body('a', 0, 0), body('b', 1, 0), body('c', 1, 1)],
        },
        {
          year: 1500,
          features: [country, a],
          vertices: [body('a', 0, -3), body('b', 1, 0), body('c', 1, 1)],
        },
      ]),
    ]);
    const { after } = moveAggregate(before, '国', 10, 5);
    expect(coordinateIn(after, '国', 1500, 'a')).toEqual(coord(0, -3));
    expect(coordinateIn(after, '国', 1500, 'b')).toEqual(coord(11, 5));
  });

  it('集約地物の錨にも隣の錨にも、引いていない頂点の体を置いていかない', () => {
    const { after } = moveAggregate(nestedProject(), '国', 10, 5);
    for (const h of after.histories) {
      for (const entry of h.series.entries) {
        const cited = new Set<VertexId>(entry.anchor.snapshot.features.flatMap(referencedVertexIds));
        for (const id of entry.anchor.snapshot.vertices.byId.keys()) {
          expect(cited.has(id), `${String(h.featureId)} の ${String(id)}`).toBe(true);
        }
      }
    }
  });

  it('確定のあとも読み込みの検査が同じ頂点の座標の食い違いを言わない', () => {
    const { after } = moveAggregate(nestedProject(), '国', 10, 5);
    const issues = checkConsistency(after, calendar).inconsistencies.filter(
      (i) => i.kind === INCONSISTENCY.VertexCoordinateDivergence,
    );
    expect(issues).toEqual([]);
  });
});

describe('隣への頂点の体の配り方', () => {
  it('地物 1 つの移動で、頂点を 1 つ共有するだけの隣へ、引いていない体を置いていかない', () => {
    const a = leaf('A', undefined, ['s', 'a1', 'a2']);
    const n = leaf('隣', undefined, ['s', 'n1', 'n2']);
    const before = project([
      history('A', [
        { year: 1000, features: [a], vertices: [body('s', 0, 0), body('a1', 1, 0), body('a2', 1, 1)] },
      ]),
      history('隣', [
        { year: 1000, features: [n], vertices: [body('s', 0, 0), body('n1', -1, 0), body('n2', -1, 1)] },
      ]),
    ]);
    const moved = [body('s', 5, 5), body('a1', 6, 5), body('a2', 6, 6)];
    const after = applyEditProposal(
      before,
      createEditProposal(fid('A'), T, buildSnapshot({ feature: a, vertices: moved })),
      calendar,
    );
    expect(coordinateIn(after, '隣', 1000, 's')).toEqual(coord(5, 5));
    expect(coordinateIn(after, '隣', 1000, 'a1')).toBeUndefined();
    expect(coordinateIn(after, '隣', 1000, 'a2')).toBeUndefined();
  });
});
