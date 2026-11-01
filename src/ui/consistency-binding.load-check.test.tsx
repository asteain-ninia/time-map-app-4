// 確定を通った形を、読み込みと同じ検査（`checkConsistency`）に掛ける。
//
// 確定の検査は速さのために手順を省くので、省いたぶんが読み込みの検査と食い違うと、確定は通るのに保存して
// 開き直すと修復を聞かれる。ここでは編集の前は整っていた形を確定し、新しい食い違いが出ないことを見る。
// 普通の面の移動と集約地物の移動の両方で確かめる。
//
//   npx vitest run src/ui/consistency-binding.load-check.test.tsx

import { describe, expect, it } from 'vitest';

import { createAnchor } from '../domain/anchor';
import { createAnchorEntry, resolveAt } from '../domain/anchor-series';
import { createBasicAttributes, createColorInfo } from '../domain/attributes';
import {
  PROCESS_STATUS,
  createEditProposal,
  type ConflictsPendingResult,
  type ProcessResult,
} from '../domain/consistency/index';
import { createCoordinate } from '../domain/coordinate';
import { drillRegion, DRILL_STATUS, toEditProposal as drillToEdit } from '../domain/drill/index';
import { freshIdPorts as drillIds } from '../domain/drill/fixtures';
import { buildSnapshot, type FeatureSnapshot } from '../domain/editing/edit-flow';
import { freshIdPorts as knifeIds } from '../domain/knife/fixtures';
import { createOpenKnifeLine } from '../domain/knife/knife-line';
import {
  assembleSplitProposal,
  createInheritanceChoice,
  INHERITANCE_SIDE,
  toEditProposal as splitToEdit,
} from '../domain/knife/proposal';
import { executeSplit } from '../domain/knife/split-geometry';
import { makeIdPorts } from '../domain/merge/fixtures';
import {
  buildMergeProposal,
  MERGE_STATUS,
  parentNone,
  propertyNew,
  toMergeEditProposal,
} from '../domain/merge/index';
import { applyEditProposal } from '../domain/editing/apply-proposal';
import { moveVertexSet, planAggregateMove } from '../domain/editing/move';
import {
  createAggregateFeature,
  createLeafFeature,
  referencedVertexIds,
  type Feature,
  type LeafFeature,
} from '../domain/feature';
import { createGeoParams } from '../domain/geo/geo-params';
import { storedCoordinate } from '../domain/geo/seam';
import { asAnchorId, asFeatureId, asRingId, asVertexId, type FeatureId } from '../domain/ids';
import { checkConsistency, INCONSISTENCY } from '../domain/persistence/consistency';
import type { FeatureHistory } from '../domain/persistence/serialize';
import { createShape, createTerritoryRing } from '../domain/ring';
import { getCalendar } from '../domain/time/calendar';
import { timePointYear } from '../domain/time/time-point';
import { createVertex, createVertexStore, getVertex, withVertexCoordinate, type Vertex } from '../domain/vertex';
import {
  createLiveAddBinding,
  createLiveDrillBinding,
  createLiveKnifeBinding,
  createLiveMergeBinding,
  createLiveShapeEditBinding,
  type DomainRoot,
} from './consistency-binding';
import { featuresAt, verticesAt } from './live-lookup';

const calendar = getCalendar('gregorian');
const COLOR = createColorInfo(true, '#111111', '#222222', '#333333');
const T = timePointYear(1000);

type Corner = readonly [lon: number, lat: number];
const bodies = (p: string, corners: readonly Corner[]): readonly Vertex[] =>
  corners.map(([lon, lat], i) => createVertex(asVertexId(`${p}${String(i)}`), { lon, lat }));
const box = (west: number, east: number, south: number, north: number): readonly Corner[] => [
  [west, south],
  [east, south],
  [east, north],
  [west, north],
];
const leaf = (id: string, count = 4, parent?: string, p = id.toLowerCase()): LeafFeature =>
  createLeafFeature(
    asFeatureId(id),
    createBasicAttributes(`${id}の名`, 0, 9999),
    COLOR,
    createShape([
      createTerritoryRing(
        asRingId(`r-${id}`),
        Array.from({ length: count }, (_, i) => asVertexId(`${p}${String(i)}`)),
      ),
    ]),
    parent === undefined ? {} : { parentId: asFeatureId(parent) },
  );
const history = (
  owner: string,
  entries: ReadonlyArray<{
    readonly year: number;
    readonly features: readonly Feature[];
    readonly vertices: readonly Vertex[];
  }>,
): FeatureHistory => ({
  featureId: asFeatureId(owner),
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
});
const project = (histories: readonly FeatureHistory[]): DomainRoot => ({
  histories,
  settings: {
    calendarId: 'gregorian',
    geo: createGeoParams(40000, 0.0034),
    gridSpacingDeg: 10,
    snapDistancePx: 50,
    autoColorDefault: true,
  },
  baseMap: { source: 's', meta: { lonWest: -180, lonEast: 180, latNorth: 90, latSouth: -90 } },
});

function bindingOf(root: DomainRoot) {
  let n = 0;
  return createLiveShapeEditBinding({
    getRoot: () => root,
    nextVertexId: () => asVertexId(`new-v-${String((n += 1))}`),
    nextRingId: () => asRingId(`new-r-${String((n += 1))}`),
  });
}
const stored = (v: Vertex): Vertex => {
  const c = storedCoordinate(v.coordinate);
  return c === v.coordinate ? v : withVertexCoordinate(v, c);
};
function moveFace(root: DomainRoot, id: string, dLon: number) {
  const feature = featuresAt(root, T).find((f) => f.id === asFeatureId(id))!;
  const moved = moveVertexSet(new Set(referencedVertexIds(feature)), verticesAt(root, T), { dLon, dLat: 0 }).map(stored);
  return createEditProposal(feature.id, T, buildSnapshot({ feature, vertices: moved }));
}
function moveAggregate(root: DomainRoot, id: string, dLon: number) {
  const features = featuresAt(root, T);
  const plan = planAggregateMove(asFeatureId(id), features);
  const moved = moveVertexSet(plan.movingVertexIds, verticesAt(root, T), { dLon, dLat: 0 }).map(stored);
  const feature = features.find((f) => f.id === asFeatureId(id))!;
  return createEditProposal(feature.id, T, buildSnapshot({ feature, vertices: moved }));
}
type Proposal = ReturnType<typeof moveFace>;

function paused(result: ProcessResult<DomainRoot>): ConflictsPendingResult<DomainRoot> {
  if (result.status !== PROCESS_STATUS.ConflictsPending) throw new Error(`板が出ない: ${result.status}`);
  return result;
}
function resolveKeeping(root: DomainRoot, proposal: Proposal, priority: FeatureId, adjust: FeatureId): DomainRoot {
  const binding = bindingOf(root);
  const first = paused(binding.startProcess(proposal));
  const result = binding.applyResolutionsFor(proposal)(
    first.conflicts.map((c) => ({ conflictId: c.id, priorityFeatureId: priority, adjustFeatureId: adjust })),
  );
  if (result.status !== PROCESS_STATUS.Committed) throw new Error(`確定しない: ${result.status}`);
  return result.state;
}
const loadIssues = (root: DomainRoot): readonly string[] =>
  checkConsistency(root, calendar).inconsistencies.map((i) => i.kind);
/** その年のその地物の、頂点の id と座標の並び。 */
function citedAt(root: DomainRoot, owner: string, name: string, year: number): readonly string[] {
  const h = root.histories.find((x) => x.featureId === asFeatureId(owner))!;
  const r = resolveAt(h.series, timePointYear(year), calendar);
  if (r.kind !== 'present') return [];
  const f = r.entry.anchor.snapshot.features.find((x) => x.id === asFeatureId(name))!;
  return referencedVertexIds(f).map((id) => {
    const c = getVertex(r.entry.anchor.snapshot.vertices, id)?.coordinate;
    return `${String(id)}@${String(c?.lon)},${String(c?.lat)}`;
  });
}
const aggregate = (id: string, children: readonly string[]) =>
  createAggregateFeature(asFeatureId(id), createBasicAttributes(id, 0, 9999), COLOR, children.map(asFeatureId));

describe('継ぎ目をまたぐ面を遠いと読まない', () => {
  /** 1500 年から現れる、継ぎ目をまたぐ面。保存の座標では経度の幅が [-170, 170] に見える。 */
  const seamFace = bodies('b', [[170, 0], [-170, 0], [-170, 5], [170, 5]]);

  it('普通の面の移動: 継ぎ目をまたぐ相手に重なる後の年を飛ばさない', () => {
    const root = project([
      history('A', [{ year: 1000, features: [leaf('A')], vertices: bodies('a', box(140, 142, 1, 3)) }]),
      history('B', [{ year: 1500, features: [leaf('B')], vertices: seamFace }]),
    ]);
    expect(loadIssues(root)).toEqual([]);
    const proposal = moveFace(root, 'A', 35);
    const first = paused(bindingOf(root).startProcess(proposal));
    expect(first.conflicts.map((c) => c.id)).toEqual(['A__B']);
    expect(first.conflicts[0]!.slices).toEqual([timePointYear(1500)]);
  });

  it('集約地物の移動でも同じ', () => {
    const root = project([
      history('G', [
        { year: 1000, features: [aggregate('G', ['A']), leaf('A', 4, 'G')], vertices: bodies('a', box(140, 142, 1, 3)) },
      ]),
      history('B', [{ year: 1500, features: [leaf('B')], vertices: seamFace }]),
    ]);
    expect(loadIssues(root)).toEqual([]);
    const first = paused(bindingOf(root).startProcess(moveAggregate(root, 'G', 35)));
    expect(first.conflicts.map((c) => c.id)).toEqual(['A__B']);
  });

  it('動かした面そのものが継ぎ目をまたぐ形でも、その内側に現れる面を飛ばさない', () => {
    const root = project([
      history('A', [{ year: 1000, features: [leaf('A')], vertices: bodies('a', box(170, 174, 1, 3)) }]),
      // 動かしたあとの A は経度 178〜182（保存の座標では 178 と -178）。その中に 1500 年から B が現れる。
      history('B', [{ year: 1500, features: [leaf('B')], vertices: bodies('b', box(179, 179.5, 1.5, 2.5)) }]),
    ]);
    expect(loadIssues(root)).toEqual([]);
    const first = paused(bindingOf(root).startProcess(moveFace(root, 'A', 8)));
    expect(first.conflicts.map((c) => c.id)).toEqual(['A__B']);
  });

  it('本当に遠い切れ目は今までどおり飛ばす（継ぎ目の面でも、反対側の面は遠い）', () => {
    const root = project([
      history('A', [{ year: 1000, features: [leaf('A')], vertices: bodies('a', box(0, 2, 1, 3)) }]),
      history('B', [{ year: 1500, features: [leaf('B')], vertices: seamFace }]),
    ]);
    const proposal = moveFace(root, 'A', 5);
    const result = bindingOf(root).startProcess(proposal);
    expect(result.status).toBe(PROCESS_STATUS.Committed);
  });
});

describe('解決で共有した頂点の相手が、後の年で動く', () => {
  const a = () => bodies('a', box(0, 5, 0, 5));
  const b = () => bodies('b', box(10, 15, 0, 5));
  const b2000 = () => bodies('b', box(30, 35, 0, 5));

  it('普通の面の移動: 相手の頂点の id を持ち込まず、後の年に座標が食い違わない。後の年の削った面も伸びない', () => {
    const root = project([
      history('A', [{ year: 1000, features: [leaf('A')], vertices: a() }]),
      history('B', [
        { year: 1500, features: [leaf('B')], vertices: b() },
        { year: 2000, features: [leaf('B')], vertices: b2000() },
      ]),
    ]);
    expect(loadIssues(root)).toEqual([]);
    const after = resolveKeeping(root, moveFace(root, 'A', 8), asFeatureId('B'), asFeatureId('A'));
    expect(loadIssues(after)).toEqual([]);
    // A は 2000 年も、1500 年に削った形のまま（B の 2000 年の座標へ引きずられない）。
    const lons = (year: number) =>
      featuresAt(after, timePointYear(year))
        .filter((f) => f.id === asFeatureId('A'))
        .flatMap((f) => referencedVertexIds(f))
        .map((id) => getVertex(verticesAt(after, timePointYear(year)), id)!.coordinate.lon);
    expect(Math.max(...lons(1500))).toBe(10);
    expect(Math.max(...lons(2000))).toBe(10);
  });

  it('系列の並びが B、A でも同じ', () => {
    const root = project([
      history('B', [
        { year: 1500, features: [leaf('B')], vertices: b() },
        { year: 2000, features: [leaf('B')], vertices: b2000() },
      ]),
      history('A', [{ year: 1000, features: [leaf('A')], vertices: a() }]),
    ]);
    const after = resolveKeeping(root, moveFace(root, 'A', 8), asFeatureId('B'), asFeatureId('A'));
    expect(loadIssues(after)).toEqual([]);
  });

  it('集約地物の移動でも同じ', () => {
    const root = project([
      history('G', [{ year: 1000, features: [aggregate('G', ['A']), leaf('A', 4, 'G')], vertices: a() }]),
      history('B', [
        { year: 1500, features: [leaf('B')], vertices: b() },
        { year: 2000, features: [leaf('B')], vertices: b2000() },
      ]),
    ]);
    expect(loadIssues(root)).toEqual([]);
    const after = resolveKeeping(root, moveAggregate(root, 'G', 8), asFeatureId('B'), asFeatureId('A'));
    expect(loadIssues(after)).toEqual([]);
  });

  it('相手が後の年で動かないなら、今までどおり共有する（溶接を黙って止めない）', () => {
    const root = project([
      history('A', [{ year: 1000, features: [leaf('A')], vertices: a() }]),
      history('B', [{ year: 1500, features: [leaf('B')], vertices: b() }]),
    ]);
    const after = resolveKeeping(root, moveFace(root, 'A', 8), asFeatureId('B'), asFeatureId('A'));
    expect(loadIssues(after)).toEqual([]);
    const cited = citedAt(after, 'A', 'A', 1500);
    expect(cited).toContain('b0@10,0');
    expect(cited).toContain('b3@10,5');
  });
});

describe('凹みを埋める頂点の削除が、後の年の面を覆う', () => {
  const concave: readonly Corner[] = [[0, 0], [10, 0], [10, 10], [5, 5], [0, 10]];
  const inside = () => bodies('b', box(4.5, 5.5, 8, 9));
  function deleteDent(root: DomainRoot, owner: string) {
    const feature = featuresAt(root, T).find((f) => f.id === asFeatureId(owner)) as LeafFeature;
    const shape = createShape([
      createTerritoryRing(asRingId(`r-${owner}`), ['a0', 'a1', 'a2', 'a4'].map(asVertexId)),
    ]);
    const without: Feature = { ...feature, shape };
    const snapshot: FeatureSnapshot = buildSnapshot({ feature: without, vertices: [] });
    return createEditProposal(feature.id, T, snapshot);
  }

  it('形を変える編集の束ねは板を出す', () => {
    const root = project([
      history('A', [{ year: 1000, features: [leaf('A', 5)], vertices: bodies('a', concave) }]),
      history('B', [{ year: 1500, features: [leaf('B')], vertices: inside() }]),
    ]);
    expect(loadIssues(root)).toEqual([]);
    const first = paused(bindingOf(root).startProcess(deleteDent(root, 'A')));
    expect(first.conflicts.map((c) => c.id)).toEqual(['A__B']);
    expect(first.conflicts[0]!.slices).toEqual([timePointYear(1500)]);
  });
});

describe('吸着の付け替えは、頂点を引かない錨の先へも届く', () => {
  const corners = (name: string, list: ReadonlyArray<readonly [string, number, number]>) => ({
    feature: createLeafFeature(
      asFeatureId(name),
      createBasicAttributes(name, 0, 9999),
      COLOR,
      createShape([createTerritoryRing(asRingId(`r-${name}`), list.map(([id]) => asVertexId(id)))]),
    ),
    vertices: list.map(([id, lon, lat]) => createVertex(asVertexId(id), { lon, lat })),
  });
  const A = corners('A', [['a0', 0, 10], ['s', 10, 10], ['t', 10, 0], ['a3', 0, 0]]);
  // 1500 年の A は s を引かず、別の頂点 q を引く。2000 年にまた s を引く。
  const A1500 = corners('A', [['a0', 0, 10], ['q', 9, 12], ['t', 10, 0], ['a3', 0, 0]]);
  const B = corners('B', [['s', 10, 10], ['b1', 20, 10], ['b2', 20, 0], ['t', 10, 0]]);
  const D = corners('D', [['d', 13, 22], ['d1', 15, 22], ['d2', 15, 20], ['d3', 13, 20]]);
  const released = { lon: 10, lat: 24 };

  function snapped(root: DomainRoot): DomainRoot {
    const snapshot: FeatureSnapshot = {
      feature: A.feature,
      vertices: [createVertex(asVertexId('s'), released)],
      sharePair: { dragged: asVertexId('s'), target: asVertexId('d') },
    };
    return applyEditProposal(root, createEditProposal(A.feature.id, T, snapshot), calendar);
  }

  it('中の錨で参照を外した面も、後の錨で吸着先の id を引く。見かけだけ同じ座標の別 id にならない', () => {
    const root = project([
      history('A', [
        { year: 1000, features: [A.feature], vertices: A.vertices },
        { year: 1500, features: [A1500.feature], vertices: A1500.vertices },
        { year: 2000, features: [A.feature], vertices: A.vertices },
      ]),
      history('B', [{ year: 1000, features: [B.feature], vertices: B.vertices }]),
      history('D', [{ year: 1000, features: [D.feature], vertices: D.vertices }]),
    ]);
    expect(loadIssues(root)).toEqual([]);
    const after = snapped(root);
    expect(citedAt(after, 'A', 'A', 1000)).toContain('d@13,22');
    expect(citedAt(after, 'A', 'A', 1500)).toContain('q@9,12');
    expect(citedAt(after, 'A', 'A', 2000)).toContain('d@13,22');
    expect(citedAt(after, 'A', 'A', 2000).some((c) => c.startsWith('s@'))).toBe(false);
    expect(citedAt(after, 'B', 'B', 2000)).toContain('d@13,22');
    expect(loadIssues(after).filter((k) => k === INCONSISTENCY.VertexCoordinateDivergence)).toEqual([]);
  });

  it('後の錨で本当に動いた頂点からは持ち込まない（記録された歴史を壊さない）', () => {
    const moved = corners('A', [['a0', 0, 10], ['s', 11, 11], ['t', 10, 0], ['a3', 0, 0]]);
    const root = project([
      history('A', [
        { year: 1000, features: [A.feature], vertices: A.vertices },
        { year: 1500, features: [A1500.feature], vertices: A1500.vertices },
        { year: 2000, features: [moved.feature], vertices: moved.vertices },
      ]),
      history('D', [{ year: 1000, features: [D.feature], vertices: D.vertices }]),
    ]);
    const after = snapped(root);
    expect(citedAt(after, 'A', 'A', 2000)).toContain('s@11,11');
    expect(loadIssues(after).filter((k) => k === INCONSISTENCY.VertexCoordinateDivergence)).toEqual([]);
  });
});

describe('移動のほかの確定も、後の年の重なりを板で止める', () => {
  const access = (root: DomainRoot) => {
    let n = 0;
    return {
      getRoot: () => root,
      nextVertexId: () => asVertexId(`new-v-${String((n += 1))}`),
      nextRingId: () => asRingId(`new-r-${String((n += 1))}`),
    };
  };
  const attrs = createBasicAttributes('新しい面', 0, 9999);

  it('追加: 1500 年から現れる面に重なる 1000 年の面（B129）', () => {
    const root = project([history('X', [{ year: 1500, features: [leaf('X')], vertices: bodies('x', box(10, 20, 0, 10)) }])]);
    expect(loadIssues(root)).toEqual([]);
    const a = leaf('A');
    const proposal = createEditProposal(a.id, T, {
      feature: a,
      vertices: bodies('a', box(5, 15, 0, 10)),
      sharedCandidateIds: new Map<never, never>(),
    });
    const binding = createLiveAddBinding(access(root));
    const first = paused(binding.startProcess(proposal));
    expect(first.conflicts[0]!.slices).toEqual([timePointYear(1500)]);
    const result = binding.applyResolutionsFor(proposal)(
      first.conflicts.map((c) => ({ conflictId: c.id, priorityFeatureId: asFeatureId('X'), adjustFeatureId: a.id })),
    );
    if (result.status !== PROCESS_STATUS.Committed) throw new Error(result.status);
    expect(loadIssues(result.state)).toEqual([]);
  });

  /** A は 1000 年と 1500 年の錨を持つ（どちらも同じ形）。 */
  const twoAnchors = () =>
    project([
      history('A', [
        { year: 1000, features: [leaf('A')], vertices: bodies('a', box(0, 10, 0, 10)) },
        { year: 1500, features: [leaf('A')], vertices: bodies('a', box(0, 10, 0, 10)) },
      ]),
    ]);

  it('分ける: 後の錨の分けていない形に、分けた片が重なる', () => {
    const root = twoAnchors();
    expect(loadIssues(root)).toEqual([]);
    const a = leaf('A');
    const store = createVertexStore(bodies('a', box(0, 10, 0, 10)));
    const line = createOpenKnifeLine([createCoordinate(4, -5), createCoordinate(4, 15)]);
    const split = assembleSplitProposal({
      target: a,
      store: store.byId,
      result: executeSplit(a, store, line)!,
      choice: createInheritanceChoice(INHERITANCE_SIDE.A),
      nonInherited: { attributes: attrs, color: COLOR },
      ids: knifeIds(),
    });
    const proposal = splitToEdit(split, T);
    const binding = createLiveKnifeBinding(access(root));
    const first = paused(binding.startProcess(proposal));
    expect(first.conflicts[0]!.slices).toEqual([timePointYear(1500)]);
    const result = binding.applyResolutionsFor(proposal)(
      first.conflicts.map((c) => ({
        conflictId: c.id,
        priorityFeatureId: split.newFeature.id,
        adjustFeatureId: a.id,
      })),
    );
    if (result.status !== PROCESS_STATUS.Committed) throw new Error(result.status);
    expect(loadIssues(result.state)).toEqual([]);
  });

  it('穴あけ: 後の錨の穴の無い形に、新しい面が重なる', () => {
    const root = twoAnchors();
    const a = leaf('A');
    const res = drillRegion({
      target: a,
      store: createVertexStore(bodies('a', box(0, 10, 0, 10))),
      region: box(2, 4, 2, 4).map(([lon, lat]) => createCoordinate(lon, lat)),
      editBaseTime: T,
      newProperties: { attributes: attrs, color: COLOR },
      ids: drillIds(),
    });
    if (res.status !== DRILL_STATUS.Drilled) throw new Error(res.status);
    const proposal = drillToEdit(res.proposal, T);
    const binding = createLiveDrillBinding(access(root));
    const first = paused(binding.startProcess(proposal));
    expect(first.conflicts[0]!.slices).toEqual([timePointYear(1500)]);
    const result = binding.applyResolutionsFor(proposal)(
      first.conflicts.map((c) => ({
        conflictId: c.id,
        priorityFeatureId: res.proposal.newFeature.id,
        adjustFeatureId: a.id,
      })),
    );
    if (result.status !== PROCESS_STATUS.Committed) throw new Error(result.status);
    expect(loadIssues(result.state)).toEqual([]);
  });

  it('結合: 相手が後の錨を持つと、結果の面がその錨に重なる', () => {
    const a = leaf('A');
    const b = leaf('B');
    const root = project([
      history('A', [{ year: 1000, features: [a], vertices: bodies('a', box(0, 10, 0, 10)) }]),
      history('B', [
        { year: 1000, features: [b], vertices: bodies('b', box(10, 20, 0, 10)) },
        { year: 1500, features: [b], vertices: bodies('b', box(10, 20, 0, 10)) },
      ]),
    ]);
    expect(loadIssues(root)).toEqual([]);
    const built = buildMergeProposal({
      features: [a, b],
      vertices: createVertexStore([...bodies('a', box(0, 10, 0, 10)), ...bodies('b', box(10, 20, 0, 10))]),
      targetIds: [a.id, b.id],
      atTime: 1000,
      parentDecision: parentNone,
      propertyDecision: propertyNew({ attributes: attrs, color: COLOR }),
      ids: makeIdPorts(),
    });
    if (built.status !== MERGE_STATUS.Proposal) throw new Error(built.status);
    const proposal = toMergeEditProposal(built.proposal, T);
    const binding = createLiveMergeBinding(access(root));
    const first = paused(binding.startProcess(proposal));
    expect(first.conflicts[0]!.slices).toEqual([timePointYear(1500)]);
    const merged = first.conflicts[0]!.a.featureId === b.id ? first.conflicts[0]!.b.featureId : first.conflicts[0]!.a.featureId;
    const result = binding.applyResolutionsFor(proposal)(
      first.conflicts.map((c) => ({ conflictId: c.id, priorityFeatureId: b.id, adjustFeatureId: merged })),
    );
    if (result.status !== PROCESS_STATUS.Committed) throw new Error(result.status);
    expect(loadIssues(result.state)).toEqual([]);
  });
});
