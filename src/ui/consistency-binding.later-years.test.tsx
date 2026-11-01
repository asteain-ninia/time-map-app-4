// 確定の重なりの検出は、その編集が効く後の年も見る（GPT 審査の指摘を再現して直した）。
//
// 確定の検出が押した年だけを見ていたので、1500 年から現れる外の地物と 1000 年の移動で重なる形が確定を
// 通り、読み込みの全部の時刻の検査で修復に当たった。普通の面の移動でも集約地物の移動でも起きる。
//
//   npx vitest run src/ui/consistency-binding.later-years.test.tsx

import { describe, expect, it } from 'vitest';

import { createAnchor } from '../domain/anchor';
import { createAnchorEntry, resolveAt } from '../domain/anchor-series';
import { createBasicAttributes, createColorInfo } from '../domain/attributes';
import {
  PROCESS_STATUS,
  createEditProposal,
  type ConflictTime,
  type ConflictsPendingResult,
  type ProcessResult,
} from '../domain/consistency/index';
import { buildSnapshot } from '../domain/editing/edit-flow';
import { moveVertexSet, planAggregateMove } from '../domain/editing/move';
import { createAggregateFeature, createLeafFeature, referencedVertexIds, type Feature } from '../domain/feature';
import { createGeoParams } from '../domain/geo/geo-params';
import { asAnchorId, asFeatureId, asRingId, asVertexId, type FeatureId } from '../domain/ids';
import { checkConsistency, INCONSISTENCY } from '../domain/persistence/consistency';
import type { FeatureHistory } from '../domain/persistence/serialize';
import { createShape, createTerritoryRing } from '../domain/ring';
import { getCalendar } from '../domain/time/calendar';
import { timePointYear } from '../domain/time/time-point';
import { createVertex, createVertexStore, type Vertex } from '../domain/vertex';
import { createLiveShapeEditBinding, type DomainRoot } from './consistency-binding';
import { formatConflictTime } from './conflict/model';
import { featuresAt, verticesAt } from './live-lookup';

const calendar = getCalendar('gregorian');
const COLOR = createColorInfo(true, '#111111', '#222222', '#333333');
const T = timePointYear(1000);

const body = (id: string, lon: number, lat: number): Vertex => createVertex(asVertexId(id), { lon, lat });
const square = (p: string, lon: number, lat = 0, size = 5): readonly Vertex[] => [
  body(`${p}0`, lon, lat),
  body(`${p}1`, lon + size, lat),
  body(`${p}2`, lon + size, lat + size),
  body(`${p}3`, lon, lat + size),
];
const leaf = (id: string, parent?: string, name = id, p = id.toLowerCase()) =>
  createLeafFeature(
    asFeatureId(id),
    createBasicAttributes(`${name}の名`, 0, 9999),
    COLOR,
    createShape([createTerritoryRing(asRingId(`r-${id}`), [0, 1, 2, 3].map((i) => asVertexId(`${p}${String(i)}`)))]),
    parent === undefined ? {} : { parentId: asFeatureId(parent) },
  );
const history = (
  owner: string,
  entries: ReadonlyArray<{
    readonly year: number;
    readonly end?: number;
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
        e.end === undefined ? null : timePointYear(e.end),
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
function moveFace(root: DomainRoot, id: string, dLon: number) {
  const feature = featuresAt(root, T).find((f) => f.id === asFeatureId(id))!;
  const moved = moveVertexSet(new Set(referencedVertexIds(feature)), verticesAt(root, T), { dLon, dLat: 0 });
  return createEditProposal(feature.id, T, buildSnapshot({ feature, vertices: moved }));
}
function moveAggregate(root: DomainRoot, id: string, dLon: number) {
  const features = featuresAt(root, T);
  const plan = planAggregateMove(asFeatureId(id), features);
  const moved = moveVertexSet(plan.movingVertexIds, verticesAt(root, T), { dLon, dLat: 0 });
  const feature = features.find((f) => f.id === asFeatureId(id))!;
  return createEditProposal(feature.id, T, buildSnapshot({ feature, vertices: moved }));
}
function paused(result: ProcessResult<DomainRoot>): ConflictsPendingResult<DomainRoot> {
  if (result.status !== PROCESS_STATUS.ConflictsPending) {
    throw new Error(`板が出ない: ${result.status}`);
  }
  return result;
}
/** 全部の組に同じ方針を当てて確定する。 */
function resolveKeeping(
  root: DomainRoot,
  proposal: ReturnType<typeof moveFace>,
  priority: FeatureId,
  adjust: FeatureId,
): ProcessResult<DomainRoot> {
  const binding = bindingOf(root);
  const first = paused(binding.startProcess(proposal));
  return binding.applyResolutionsFor(proposal)(
    first.conflicts.map((c) => ({ conflictId: c.id, priorityFeatureId: priority, adjustFeatureId: adjust })),
  );
}
const anchorYears = (root: DomainRoot, owner: string) =>
  root.histories.find((h) => h.featureId === asFeatureId(owner))!.series.entries.map((e) => e.start.year);
/** その年から記録の終わりまで続く重なり。 */
const since = (year: number): ConflictTime => ({
  kind: 'range',
  from: timePointYear(year),
  spans: [{ from: timePointYear(year), until: null }],
});
/** 期間を並べた重なり。`[始まり, この年から重ならない]`（終わらないなら null）。 */
const spansOf = (...list: ReadonlyArray<readonly [number, number | null]>): ConflictTime => ({
  kind: 'range',
  from: timePointYear(list[0]![0]),
  spans: list.map(([from, until]) => ({
    from: timePointYear(from),
    until: until === null ? null : timePointYear(until),
  })),
});
const overlapsOnLoad = (root: DomainRoot) =>
  checkConsistency(root, calendar).inconsistencies.filter((i) => i.kind === INCONSISTENCY.TerminalExclusion);

/** A は 1000 年から、X は 1500 年から、A の東 10 度に居る。全部の年で重ならない。 */
function laterNeighbour(): DomainRoot {
  return project([
    history('A', [{ year: 1000, features: [leaf('A')], vertices: square('a', 0) }]),
    history('X', [{ year: 1500, features: [leaf('X')], vertices: square('x', 10) }]),
  ]);
}

describe('後の年にだけ生じる重なり', () => {
  it('普通の面の移動: 板を出し、重なりの年を言う。読み込みが修復を言う形を確定しない', () => {
    const root = laterNeighbour();
    expect(overlapsOnLoad(root)).toEqual([]);
    const result = paused(bindingOf(root).startProcess(moveFace(root, 'A', 10)));
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0]!.time).toEqual(since(1500));
    expect(result.conflicts[0]!.a.displayName).toBe('Aの名');
    expect(result.conflicts[0]!.b.displayName).toBe('Xの名');
  });

  it('集約地物の移動でも同じ', () => {
    const country = createAggregateFeature(asFeatureId('G'), createBasicAttributes('G', 0, 9999), COLOR, [asFeatureId('A')]);
    const root = project([
      history('G', [{ year: 1000, features: [country, leaf('A', 'G')], vertices: square('a', 0) }]),
      history('X', [{ year: 1500, features: [leaf('X')], vertices: square('x', 10) }]),
    ]);
    const result = paused(bindingOf(root).startProcess(moveAggregate(root, 'G', 10)));
    expect(result.conflicts[0]!.time).toEqual(since(1500));
  });

  it('動かした面を削る解決: 重なる相手が居ない年は動いた形のまま、1500 年から削り、読み込みは重なりを言わない', () => {
    const root = laterNeighbour();
    const result = resolveKeeping(root, moveFace(root, 'A', 8), asFeatureId('X'), asFeatureId('A'));
    expect(result.status).toBe(PROCESS_STATUS.Committed);
    if (result.status !== PROCESS_STATUS.Committed) return;
    expect(anchorYears(result.state, 'A')).toEqual([1000, 1500]);
    const lonsAt = (year: number) =>
      [...verticesAt(result.state, timePointYear(year)).byId.values()].map((v) => v.coordinate.lon);
    expect(Math.max(...lonsAt(1000))).toBe(13);
    expect(overlapsOnLoad(result.state)).toEqual([]);
    expect(checkConsistency(result.state, calendar).inconsistencies).toEqual([]);
  });

  it('外の地物を削る解決: 外の地物の錨を 1500 年で削る。動かした面に錨は増えない', () => {
    const root = laterNeighbour();
    const result = resolveKeeping(root, moveFace(root, 'A', 8), asFeatureId('A'), asFeatureId('X'));
    expect(result.status).toBe(PROCESS_STATUS.Committed);
    if (result.status !== PROCESS_STATUS.Committed) return;
    expect(anchorYears(result.state, 'A')).toEqual([1000]);
    expect(anchorYears(result.state, 'X')).toEqual([1500]);
    expect(checkConsistency(result.state, calendar).inconsistencies).toEqual([]);
  });

  it('引き継ぎが届く後の錨も、同じ解決で全部削る（1 回の適用で収まる）', () => {
    const later = [1600, 1700, 1800, 1900, 2000, 2100, 2200, 2300, 2400, 2500];
    const root = project([
      history('A', [
        { year: 1000, features: [leaf('A')], vertices: square('a', 0) },
        ...later.map((year) => ({ year, features: [leaf('A')], vertices: square('a', 0) })),
      ]),
      history('X', [{ year: 1500, features: [leaf('X')], vertices: square('x', 10) }]),
    ]);
    const result = resolveKeeping(root, moveFace(root, 'A', 8), asFeatureId('X'), asFeatureId('A'));
    expect(result.status).toBe(PROCESS_STATUS.Committed);
    if (result.status !== PROCESS_STATUS.Committed) return;
    expect(overlapsOnLoad(result.state)).toEqual([]);
    expect(checkConsistency(result.state, calendar).inconsistencies).toEqual([]);
  });

  it('押した年と後の年の両方で重なる組は 1 件で、終わりを言わない。削った形が続く年に錨を増やさない', () => {
    const root = project([
      history('A', [{ year: 1000, features: [leaf('A')], vertices: square('a', 0) }]),
      // Y は 1500 年に改名しただけ（形は同じ）。
      history('Y', [
        { year: 1000, features: [leaf('Y')], vertices: square('y', 10) },
        { year: 1500, features: [leaf('Y', undefined, 'Y2', 'y')], vertices: square('y', 10) },
      ]),
    ]);
    const first = paused(bindingOf(root).startProcess(moveFace(root, 'A', 8)));
    expect(first.conflicts).toHaveLength(1);
    expect(first.conflicts[0]!.time).toEqual(since(1000));
    const result = resolveKeeping(root, moveFace(root, 'A', 8), asFeatureId('Y'), asFeatureId('A'));
    expect(result.status).toBe(PROCESS_STATUS.Committed);
    if (result.status !== PROCESS_STATUS.Committed) return;
    expect(anchorYears(result.state, 'A')).toEqual([1000]);
    expect(overlapsOnLoad(result.state)).toEqual([]);
  });

  it('関係の無い地物の切れ目では組を調べ直さず、重なりは続いていると言う。解決は押した年の 1 回', () => {
    const root = project([
      history('A', [{ year: 1000, features: [leaf('A')], vertices: square('a', 0) }]),
      history('Y', [{ year: 1000, features: [leaf('Y')], vertices: square('y', 10) }]),
      // 遠くの Z が 1500 年に改名しただけ。
      history('Z', [
        { year: 1000, features: [leaf('Z')], vertices: square('z', 100) },
        { year: 1500, features: [leaf('Z', undefined, 'Z2', 'z')], vertices: square('z', 100) },
      ]),
    ]);
    const first = paused(bindingOf(root).startProcess(moveFace(root, 'A', 8)));
    expect(first.conflicts).toHaveLength(1);
    expect(first.conflicts[0]!.time).toEqual(since(1000));
    expect(first.conflicts[0]!.slices).toEqual([T]);
  });

  it('遠くの面の切れ目を飛ばしても、その後に近くへ現れる面を見逃さない。遠くの切れ目を重なりの終わりと言わない', () => {
    const root = project([
      history('A', [{ year: 1000, features: [leaf('A')], vertices: square('a', 0) }]),
      history('Z', [{ year: 1200, features: [leaf('Z')], vertices: square('z', 100) }]),
      history('X', [{ year: 1500, features: [leaf('X')], vertices: square('x', 10) }]),
      history('W', [{ year: 1800, features: [leaf('W')], vertices: square('w', -100) }]),
    ]);
    const first = paused(bindingOf(root).startProcess(moveFace(root, 'A', 8)));
    expect(first.conflicts).toHaveLength(1);
    expect(first.conflicts[0]!.time).toEqual(since(1500));
    expect(first.conflicts[0]!.slices).toEqual([timePointYear(1500)]);
  });

  it('世界の継ぎ目の向こうに後の年に現れる面も見逃さない', () => {
    const root = project([
      history('A', [{ year: 1000, features: [leaf('A')], vertices: square('a', -170) }]),
      history('X', [{ year: 1500, features: [leaf('X')], vertices: square('x', 174) }]),
    ]);
    const result = paused(bindingOf(root).startProcess(moveFace(root, 'A', -13)));
    expect(result.conflicts[0]!.time).toEqual(since(1500));
  });

  it('形の変わった面の子が後の年に現れたら、遠くても切れ目を飛ばさない', () => {
    const root = project([
      history('A', [{ year: 1000, features: [leaf('A')], vertices: square('a', 0) }]),
      history('C', [{ year: 1500, features: [leaf('C', 'A')], vertices: square('c', 100) }]),
      history('X', [{ year: 1000, features: [leaf('X')], vertices: square('x', 10) }]),
    ]);
    // 1500 年から A は親になり末端でなくなるので、A と X の重なりは 1500 年になるまで。
    const first = paused(bindingOf(root).startProcess(moveFace(root, 'A', 8)));
    expect(first.conflicts[0]!.time).toEqual(spansOf([1000, 1500]));
  });

  it('前の切れ目で形の変わった面から遠くても、引き継ぎで書き換えた面の重なりは見逃さない', () => {
    // A と K は頂点 u を、A と N は頂点 s を引く。A は 1300 年に遠くへ移り、s も u も引かなくなる。N は 1500 年から
    // 現れる。s と u を動かすと、1300 年からの形の変わった面は K だけで、1500 年の N は K から遠いが X に重なる。
    const named = (id: string, ids: readonly string[]) =>
      createLeafFeature(
        asFeatureId(id),
        createBasicAttributes(`${id}の名`, 0, 9999),
        COLOR,
        createShape([createTerritoryRing(asRingId(`r-${id}`), ids.map((v) => asVertexId(v)))]),
      );
    const a = named('A', ['a0', 's', 'u']);
    const root = project([
      history('A', [
        { year: 1000, features: [a], vertices: [body('a0', 0, 0), body('s', 5, 0), body('u', 0, 5)] },
        {
          year: 1300,
          features: [named('A', ['f0', 'f1', 'f2'])],
          vertices: [body('f0', 100, 0), body('f1', 105, 0), body('f2', 100, 5)],
        },
      ]),
      history('K', [
        {
          year: 1000,
          features: [named('K', ['u', 'k1', 'k2'])],
          vertices: [body('u', 0, 5), body('k1', -5, 5), body('k2', -5, 10)],
        },
      ]),
      history('N', [
        {
          year: 1500,
          features: [named('N', ['s', 'n1', 'n2'])],
          vertices: [body('s', 5, 0), body('n1', 5, -5), body('n2', 0, -5)],
        },
      ]),
      history('X', [{ year: 1500, features: [leaf('X')], vertices: square('x', 8, -5) }]),
    ]);
    const proposal = createEditProposal(
      a.id,
      T,
      buildSnapshot({
        feature: a,
        vertices: [createVertex(asVertexId('s'), { lon: 12, lat: 0 }), createVertex(asVertexId('u'), { lon: 0, lat: 5.5 })],
      }),
    );
    const result = paused(bindingOf(root).startProcess(proposal));
    expect(result.conflicts.map((c) => [c.a.displayName, c.b.displayName])).toEqual([['Nの名', 'Xの名']]);
    expect(result.conflicts[0]!.time).toEqual(since(1500));
  });

  it('引き継ぎが止まった年から先（その年に本当に動いた記録）は重なりと言わない', () => {
    const root = project([
      history('A', [
        { year: 1000, features: [leaf('A')], vertices: square('a', 0) },
        // 1400 年に別の場所へ動かしてある。全部の頂点がここで止まる。
        { year: 1400, features: [leaf('A')], vertices: square('a', -30) },
      ]),
      history('X', [{ year: 1500, features: [leaf('X')], vertices: square('x', 10) }]),
    ]);
    const result = bindingOf(root).startProcess(moveFace(root, 'A', 10));
    expect(result.status).toBe(PROCESS_STATUS.Committed);
  });

  it('前からある後の年の重なりで止めない。同じ相手へ増えたら止める', () => {
    const root = project([
      history('A', [{ year: 1000, features: [leaf('A')], vertices: square('a', 0) }]),
      history('X', [{ year: 1500, features: [leaf('X')], vertices: square('x', 4) }]),
    ]);
    expect(overlapsOnLoad(root)).not.toEqual([]);
    expect(bindingOf(root).startProcess(moveFace(root, 'A', -1)).status).toBe(PROCESS_STATUS.Committed);
    expect(bindingOf(root).startProcess(moveFace(root, 'A', 1)).status).toBe(PROCESS_STATUS.ConflictsPending);
  });

  it('相手が居ない年へ動かすだけなら板を出さない（相手が後の年に居なくなる）', () => {
    const root = project([
      history('A', [{ year: 1000, features: [leaf('A')], vertices: square('a', 0) }]),
      // X は 900 年から 950 年まで（A の動く先に居るが、押した年より前に終わっている）。
      {
        featureId: asFeatureId('X'),
        series: {
          entries: [
            createAnchorEntry(
              createAnchor(asAnchorId('a-X-900'), { features: [leaf('X')], vertices: createVertexStore(square('x', 10)) }),
              timePointYear(900),
              timePointYear(950),
            ),
          ],
        },
      },
    ]);
    expect(bindingOf(root).startProcess(moveFace(root, 'A', 10)).status).toBe(PROCESS_STATUS.Committed);
    expect(resolveAt(root.histories[0]!.series, T, calendar).kind).toBe('present');
  });
});

describe('重なりの期間（記録は切れ目ごとに正しく、板の文が実態を言う）', () => {
  const movedA = () => history('A', [{ year: 1000, features: [leaf('A')], vertices: square('a', 0) }]);
  const conflictOf = (root: DomainRoot) => paused(bindingOf(root).startProcess(moveFace(root, 'A', 8))).conflicts;

  it('相手が居ない期間を挟むと、期間を分けて言う。解決は両方の期間に効く', () => {
    const root = project([
      movedA(),
      history('X', [
        { year: 1000, end: 1200, features: [leaf('X')], vertices: square('x', 10) },
        { year: 1500, features: [leaf('X')], vertices: square('x', 10) },
      ]),
    ]);
    const [conflict] = conflictOf(root);
    expect(conflict!.time).toEqual(spansOf([1000, 1200], [1500, null]));
    expect(formatConflictTime(conflict!.time)).toBe('1000年から1200年になるまで、1500年から');
    expect(conflict!.slices).toEqual([T, timePointYear(1500)]);
    const result = resolveKeeping(root, moveFace(root, 'A', 8), asFeatureId('X'), asFeatureId('A'));
    expect(result.status).toBe(PROCESS_STATUS.Committed);
    if (result.status === PROCESS_STATUS.Committed) expect(overlapsOnLoad(result.state)).toEqual([]);
  });

  it('相手に遠くの子が来て末端でなくなると、その年に重なりは終わる', () => {
    const root = project([
      movedA(),
      history('X', [{ year: 1000, features: [leaf('X')], vertices: square('x', 10) }]),
      history('K', [{ year: 1500, features: [leaf('K', 'X')], vertices: square('k', 120) }]),
    ]);
    const [conflict] = conflictOf(root);
    expect(conflict!.time).toEqual(spansOf([1000, 1500]));
    expect(formatConflictTime(conflict!.time)).toBe('1000年から1500年になるまで');
    expect(conflict!.slices).toEqual([T]);
  });

  it('相手の遠くの子が去って末端に戻ると、その年からの重なりを見逃さない', () => {
    const root = project([
      movedA(),
      history('X', [{ year: 1000, features: [leaf('X')], vertices: square('x', 10) }]),
      history('K', [{ year: 1000, end: 1500, features: [leaf('K', 'X')], vertices: square('k', 120) }]),
    ]);
    const [conflict] = conflictOf(root);
    expect(conflict!.id).toBe('A__X');
    expect(conflict!.time).toEqual(since(1500));
    expect(conflict!.slices).toEqual([timePointYear(1500)]);
  });

  it('相手が同じ形の錨を後の年に持つだけなら、重なりは続いている。その年を終わりと言わない', () => {
    const root = project([
      movedA(),
      history('X', [
        { year: 1000, features: [leaf('X')], vertices: square('x', 10) },
        { year: 1800, features: [leaf('X')], vertices: square('x', 10) },
      ]),
    ]);
    const [conflict] = conflictOf(root);
    expect(conflict!.time).toEqual(since(1000));
    expect(formatConflictTime(conflict!.time)).toBe('1000年から');
  });

  it('相手が後の年に自分の錨で遠くへ移ると、重なりは移るまで。前の切れ目の組を持ち越さない', () => {
    const root = project([
      movedA(),
      history('X', [
        { year: 1000, features: [leaf('X')], vertices: square('x', 10) },
        { year: 1500, features: [leaf('X')], vertices: square('x', 100) },
      ]),
    ]);
    const [conflict] = conflictOf(root);
    expect(conflict!.time).toEqual(spansOf([1000, 1500]));
    expect(conflict!.slices).toEqual([T]);
  });

  it('動かした面が後の年に自分の錨で別の場所へ動いているなら、重なりはその年まで', () => {
    const root = project([
      history('A', [
        { year: 1000, features: [leaf('A')], vertices: square('a', 0) },
        { year: 1500, features: [leaf('A')], vertices: square('a', -60) },
      ]),
      history('X', [{ year: 1000, features: [leaf('X')], vertices: square('x', 10) }]),
    ]);
    const [conflict] = conflictOf(root);
    expect(conflict!.time).toEqual(spansOf([1000, 1500]));
  });

  it('編集の効かない期間を飛び越えた先でも、その間の変化を見落とさない', () => {
    // A の 1000 年と 1600 年の錨は同じ頂点で書き換わる。1400 年の錨だけ別の場所へ動いていて、効かない。
    const root = project([
      history('A', [
        { year: 1000, features: [leaf('A')], vertices: square('a', 0) },
        { year: 1400, features: [leaf('A', undefined, 'A', 'c')], vertices: square('c', -60) },
        { year: 1600, features: [leaf('A')], vertices: square('a', 0) },
      ]),
      history('X', [
        { year: 1000, features: [leaf('X')], vertices: square('x', 100) },
        // X は効かない期間のあいだに、動かした先へ来る。
        { year: 1500, features: [leaf('X')], vertices: square('x', 10) },
      ]),
    ]);
    const conflicts = conflictOf(root);
    expect(conflicts.map((c) => c.time)).toEqual([since(1600)]);
  });

  it('組ごとに年が違えば、それぞれの期間を言う', () => {
    const root = project([
      movedA(),
      history('Y', [{ year: 1000, features: [leaf('Y')], vertices: square('y', 10) }]),
      history('X', [{ year: 1500, features: [leaf('X')], vertices: square('x', 10, 3) }]),
    ]);
    const conflicts = conflictOf(root);
    expect(conflicts.map((c) => [c.id, c.time])).toEqual([
      ['A__Y', since(1000)],
      ['A__X', since(1500)],
    ]);
  });
});
