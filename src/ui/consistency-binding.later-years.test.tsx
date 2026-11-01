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
  entries: ReadonlyArray<{ readonly year: number; readonly features: readonly Feature[]; readonly vertices: readonly Vertex[] }>,
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
    expect(result.conflicts[0]!.time).toEqual({ kind: 'point', at: timePointYear(1500) });
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
    expect(result.conflicts[0]!.time).toEqual({ kind: 'point', at: timePointYear(1500) });
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

  it('押した年と後の年の両方で重なる組は 1 件で、範囲を言う。削った形が続く年に錨を増やさない', () => {
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
    expect(first.conflicts[0]!.time).toEqual({ kind: 'range', from: T, to: timePointYear(1500) });
    const result = resolveKeeping(root, moveFace(root, 'A', 8), asFeatureId('Y'), asFeatureId('A'));
    expect(result.status).toBe(PROCESS_STATUS.Committed);
    if (result.status !== PROCESS_STATUS.Committed) return;
    expect(anchorYears(result.state, 'A')).toEqual([1000]);
    expect(overlapsOnLoad(result.state)).toEqual([]);
  });

  it('関係の無い地物の切れ目では組を調べ直さず、続く重なりとして範囲を伸ばす。解決は押した年の 1 回', () => {
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
    expect(first.conflicts[0]!.time).toEqual({ kind: 'range', from: T, to: timePointYear(1500) });
    expect(first.conflicts[0]!.slices).toEqual([T]);
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
