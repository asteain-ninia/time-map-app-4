// B72: 頂点を揃える修復は、**その年に食い違っている頂点だけ**を、**その年の間だけ**揃える。
//
// 同じ頂点 id が年によって別の場所を指すのは正常な形（`editing/vertex-carry-forward.ts`）。
// 検査（`detectVertexDivergence`）が問題にするのは「同じ年に効いている記録どうしで座標が違う」
// ことだけなので、修復もそこだけを書き換える。期待値はどれも手で組んだ座標。

import { describe, expect, it } from 'vitest';

import { createAnchor, createAnchorSnapshot } from '../anchor';
import { createAnchorEntry, resolveAt, type AnchorEntry } from '../anchor-series';
import { createBasicAttributes, createColorInfo } from '../attributes';
import { createCoordinate } from '../coordinate';
import { createLeafFeature, createPointFeature } from '../feature';
import { asAnchorId, asFeatureId, asRingId, asVertexId } from '../ids';
import { createShape, createTerritoryRing } from '../ring';
import { timePointYear } from '../time/time-point';
import { createVertex, createVertexStore, type Vertex } from '../vertex';
import { checkConsistency, INCONSISTENCY } from './consistency';
import { CAL, DEFAULT_BASEMAP, DEFAULT_SETTINGS } from './fixtures';
import { applyRepairChecked, REPAIR_OPTION } from './repair';
import type { DomainProject, FeatureHistory } from './serialize';

const COLOR = createColorInfo(true, '#102030', '#405060', '#708090', 'default', 1, 1);

type Pt = readonly [string, number, number];

let anchorNo = 0;
function entry(
  featureId: string,
  points: readonly Pt[],
  start: number,
  end: number | null = null,
  stray: readonly Pt[] = [],
): AnchorEntry {
  const body = (p: Pt): Vertex => createVertex(asVertexId(p[0]), createCoordinate(p[1], p[2]));
  const feature = createLeafFeature(
    asFeatureId(featureId),
    createBasicAttributes(featureId, 0, 0),
    COLOR,
    createShape([
      createTerritoryRing(
        asRingId(`${featureId}-r`),
        points.map((p) => asVertexId(p[0])),
      ),
    ]),
  );
  anchorNo += 1;
  return createAnchorEntry(
    createAnchor(
      asAnchorId(`a${String(anchorNo)}`),
      createAnchorSnapshot([feature], createVertexStore([...points, ...stray].map(body))),
    ),
    timePointYear(start),
    end === null ? null : timePointYear(end),
  );
}

/** 点の地物の錨。`cited` だけを引き、`stray` は頂点の表に残るだけ（どの地物も引かない写し）。 */
function pointEntry(
  featureId: string,
  cited: Pt,
  start: number,
  end: number | null = null,
  stray: readonly Pt[] = [],
): AnchorEntry {
  const body = (p: Pt): Vertex => createVertex(asVertexId(p[0]), createCoordinate(p[1], p[2]));
  anchorNo += 1;
  return createAnchorEntry(
    createAnchor(
      asAnchorId(`a${String(anchorNo)}`),
      createAnchorSnapshot(
        [
          createPointFeature(
            asFeatureId(featureId),
            createBasicAttributes(featureId, 0, 0),
            COLOR,
            asVertexId(cited[0]),
          ),
        ],
        createVertexStore([cited, ...stray].map(body)),
      ),
    ),
    timePointYear(start),
    end === null ? null : timePointYear(end),
  );
}

const history = (featureId: string, entries: readonly AnchorEntry[]): FeatureHistory => ({
  featureId: asFeatureId(featureId),
  series: { entries },
});

const projectOf = (histories: readonly FeatureHistory[]): DomainProject => ({
  histories,
  settings: DEFAULT_SETTINGS,
  baseMap: DEFAULT_BASEMAP,
});

function repaired(project: DomainProject): DomainProject {
  const inc = checkConsistency(project, CAL).inconsistencies.find(
    (i) => i.kind === INCONSISTENCY.VertexCoordinateDivergence,
  );
  if (inc === undefined) throw new Error('食い違いが検出されない（試験の組み方の誤り）');
  const applied = applyRepairChecked(project, inc, REPAIR_OPTION.ReconcileVertexCoordinate, CAL);
  expect(applied.resolved).toBe(true);
  expect(
    applied.remaining.inconsistencies.filter(
      (i) => i.kind === INCONSISTENCY.VertexCoordinateDivergence,
    ),
  ).toEqual([]);
  return applied.project;
}

/** その地物の系列の、その年に効いている頂点の座標（[経度, 緯度]）。 */
function coordAt(project: DomainProject, featureId: string, year: number, vertexId: string): readonly [number, number] {
  const h = project.histories.find((x) => x.featureId === asFeatureId(featureId))!;
  const r = resolveAt(h.series, timePointYear(year), CAL);
  if (r.kind !== 'present') throw new Error(`${featureId} は ${String(year)} 年に居ない`);
  const v = r.entry.anchor.snapshot.vertices.byId.get(asVertexId(vertexId))!;
  return [v.coordinate.lon, v.coordinate.lat];
}

const startsOf = (project: DomainProject, featureId: string): readonly (readonly [number, number | null])[] =>
  project.histories
    .find((x) => x.featureId === asFeatureId(featureId))!
    .series.entries.map((e) => [e.start.year, e.end === null ? null : e.end.year] as const);

/** F: 正方形。角 a2 だけが年で動く。a1 は G と共有する。 */
const F = (a2: readonly [number, number]): Pt[] => [
  ['a0', 0, 0],
  ['a1', 10, 0],
  ['a2', a2[0], a2[1]],
  ['a3', 0, 10],
];
/** G: F の右下で a1 だけで接する正方形。a1 の座標を指定できる。 */
const G = (a1: readonly [number, number]): Pt[] => [
  ['a1', a1[0], a1[1]],
  ['g1', 20, 0],
  ['g2', 20, -10],
  ['g3', 10, -10],
];

describe('B72: 頂点を揃える修復は、食い違っていない年と頂点を書き換えない', () => {
  it('1500 年の別の頂点 a1 が食い違っていても、正しく動かした a2 の座標は全部の年でそのまま', () => {
    const project = projectOf([
      history('F', [entry('F', F([10, 10]), 1000, 1500), entry('F', F([12, 12]), 1500)]),
      history('G', [entry('G', G([10, -1]), 1500)]),
    ]);
    const out = repaired(project);
    // 動かした記録は残る。
    expect(coordAt(out, 'F', 1000, 'a2')).toEqual([10, 10]);
    expect(coordAt(out, 'F', 1500, 'a2')).toEqual([12, 12]);
    // 食い違っていた a1 は 1500 年に揃う（どちらも動かしていないので、先からある F の座標）。
    expect(coordAt(out, 'F', 1500, 'a1')).toEqual([10, 0]);
    expect(coordAt(out, 'G', 1500, 'a1')).toEqual([10, 0]);
    // 錨は増えない。
    expect(startsOf(out, 'F')).toEqual([[1000, 1500], [1500, null]]);
    expect(startsOf(out, 'G')).toEqual([[1500, null]]);
  });

  it.each([
    ['F が先', true],
    ['G が先', false],
  ])('片方の系列が 1500 年に動かした記録は巻き戻らない。もう片方は 1500 年から揃う（%s）', (_n, fFirst) => {
    const f = history('F', [entry('F', F([10, 10]), 1000)]);
    const g = history('G', [
      entry('G', G([10, 0]), 1000, 1500),
      entry('G', G([11, 0]), 1500),
    ]);
    const out = repaired(projectOf(fFirst ? [f, g] : [g, f]));
    // G の動かした記録が正。
    expect(coordAt(out, 'G', 1000, 'a1')).toEqual([10, 0]);
    expect(coordAt(out, 'G', 1500, 'a1')).toEqual([11, 0]);
    // F の 1 本の錨は、1500 年の境目で割って後ろだけを揃える。1000 年は元の座標のまま。
    expect(coordAt(out, 'F', 1000, 'a1')).toEqual([10, 0]);
    expect(coordAt(out, 'F', 1500, 'a1')).toEqual([11, 0]);
    expect(startsOf(out, 'F')).toEqual([[1000, 1500], [1500, null]]);
  });

  it('動かした記録がどちらにも無ければ、先に居た系列の座標が正（後から現れた写しが古い）', () => {
    // 隣が 1500 年から現れ、移動前の座標の写しを持っている形（vertex-carry-forward.ts の注記の形）。
    const f = history('F', [entry('F', F([10, 10]), 0)]);
    const g = history('G', [entry('G', G([10, -1]), 1500)]);
    for (const order of [[f, g], [g, f]]) {
      const out = repaired(projectOf(order));
      expect(coordAt(out, 'F', 0, 'a1')).toEqual([10, 0]);
      expect(coordAt(out, 'F', 1500, 'a1')).toEqual([10, 0]);
      expect(coordAt(out, 'G', 1500, 'a1')).toEqual([10, 0]);
      expect(startsOf(out, 'F')).toEqual([[0, null]]);
    }
  });

  it('終わりのある錨を割っても終わりの年は変わらず、後ろの年の記録にも触らない', () => {
    const f = history('F', [
      entry('F', F([10, 10]), 1000, 2000),
      entry('F', F([10, 10]).map((p): Pt => (p[0] === 'a1' ? ['a1', 9, 0] : p)), 2500),
    ]);
    const g = history('G', [
      entry('G', G([10, 0]), 1000, 1500),
      entry('G', G([11, 0]), 1500, 1800),
    ]);
    const out = repaired(projectOf([f, g]));
    expect(startsOf(out, 'F')).toEqual([[1000, 1500], [1500, 1800], [1800, 2000], [2500, null]]);
    expect(coordAt(out, 'F', 1000, 'a1')).toEqual([10, 0]);
    expect(coordAt(out, 'F', 1500, 'a1')).toEqual([11, 0]);
    // G が終わった年からは食い違っていないので、F の元の座標のまま。
    expect(coordAt(out, 'F', 1800, 'a1')).toEqual([10, 0]);
    expect(coordAt(out, 'F', 2500, 'a1')).toEqual([9, 0]);
  });

  it('両方の系列が別の年に動かしていれば、年ごとにいちばん新しい記録へ揃う', () => {
    const f = history('F', [
      entry('F', F([10, 10]), 0, 1500),
      entry('F', F([10, 10]).map((p): Pt => (p[0] === 'a1' ? ['a1', 12, 0] : p)), 1500),
    ]);
    const g = history('G', [
      entry('G', G([10, 0]), 0, 1200),
      entry('G', G([11, 0]), 1200),
    ]);
    const out = repaired(projectOf([f, g]));
    const years: readonly [number, number][] = [
      [0, 10],
      [1200, 11],
      [1500, 12],
    ];
    for (const [year, lon] of years) {
      expect(coordAt(out, 'F', year, 'a1')).toEqual([lon, 0]);
      expect(coordAt(out, 'G', year, 'a1')).toEqual([lon, 0]);
    }
  });

  it('どの地物も引いていない版は、動かした記録があっても正にしない', () => {
    // G の 1500 年の錨に a2 の紛れ込みの版がある。F が引いている座標が正。
    const f = history('F', [entry('F', F([12, 12]), 1000)]);
    const g = history('G', [
      entry('G', G([10, 0]), 1000, 1500, [['a2', 50, 50]]),
      entry('G', G([10, 0]), 1500, null, [['a2', 60, 60]]),
    ]);
    const out = repaired(projectOf([g, f]));
    expect(coordAt(out, 'F', 1000, 'a2')).toEqual([12, 12]);
    expect(coordAt(out, 'F', 1500, 'a2')).toEqual([12, 12]);
    expect(coordAt(out, 'G', 1500, 'a2')).toEqual([12, 12]);
  });

  it('入力のプロジェクトを書き換えない', () => {
    const f = history('F', [entry('F', F([10, 10]), 1000)]);
    const g = history('G', [entry('G', G([10, 0]), 1000, 1500), entry('G', G([11, 0]), 1500)]);
    const project = projectOf([f, g]);
    repaired(project);
    expect(project.histories[0]!.series.entries).toHaveLength(1);
    expect(coordAt(project, 'F', 1500, 'a1')).toEqual([10, 0]);
  });

  // 表に残っているだけの写しは、その錨でその頂点が居たことの記録ではない。
  it('初めて頂点を引いた錨を「動かした版」と読まず、動かした記録を巻き戻さない', () => {
    const project = projectOf([
      // A は 100 年に v を (0,0) から (1,0) へ動かした。
      history('A', [pointEntry('A', ['v', 0, 0], 0, 100), pointEntry('A', ['v', 1, 0], 100)]),
      // B は 200 年まで w を引く。表に引かれていない v=(50,0) が残り、200 年に初めて v=(0,0) を引く。
      history('B', [
        pointEntry('B', ['w', 30, 0], 0, 200, [['v', 50, 0]]),
        pointEntry('B', ['v', 0, 0], 200),
      ]),
    ]);
    const out = repaired(project);
    expect(coordAt(out, 'A', 0, 'v')).toEqual([0, 0]);
    expect(coordAt(out, 'A', 100, 'v')).toEqual([1, 0]);
    expect(coordAt(out, 'A', 200, 'v')).toEqual([1, 0]);
    expect(coordAt(out, 'A', 300, 'v')).toEqual([1, 0]);
    expect(startsOf(out, 'A')).toEqual([[0, 100], [100, null]]);
    // 揃えられるのは、動かしていない B の側。
    expect(coordAt(out, 'B', 200, 'v')).toEqual([1, 0]);
  });

  it('動かした記録がどちらにも無いとき、表に残っていた写しを「先に居た」根拠にしない', () => {
    const project = projectOf([
      // C は 200 年に初めて v を引く。それより前の表の v=(5,5) は引かれていない写し。
      history('C', [
        pointEntry('C', ['w', 30, 0], 0, 200, [['v', 5, 5]]),
        pointEntry('C', ['v', 5, 5], 200),
      ]),
      // D は 100 年から v=(6,6) を引いている。実際に先に居たのは D。
      history('D', [pointEntry('D', ['v', 6, 6], 100)]),
    ]);
    const out = repaired(project);
    expect(coordAt(out, 'D', 100, 'v')).toEqual([6, 6]);
    expect(coordAt(out, 'D', 200, 'v')).toEqual([6, 6]);
    expect(coordAt(out, 'C', 200, 'v')).toEqual([6, 6]);
    expect(startsOf(out, 'D')).toEqual([[100, null]]);
  });

  it('過去の錨で実際に引いていれば、動かした記録は今までどおり勝つ', () => {
    const project = projectOf([
      // E は 0 年から v を引き、200 年に (2,0) へ動かした。
      history('E', [pointEntry('E', ['v', 0, 0], 0, 200), pointEntry('E', ['v', 2, 0], 200)]),
      // G は 100 年から動かしていない。
      history('G', [pointEntry('G', ['v', 0, 0], 100)]),
    ]);
    const out = repaired(project);
    expect(coordAt(out, 'E', 200, 'v')).toEqual([2, 0]);
    expect(coordAt(out, 'G', 150, 'v')).toEqual([0, 0]);
    expect(coordAt(out, 'G', 200, 'v')).toEqual([2, 0]);
  });

  it('引いていない錨を挟むと、その先へ遡って「動かした」と読まない', () => {
    const project = projectOf([
      // J は 100 年まで v=(0,0) を引き、200 年までは引かず、200 年に (9,9) で引き直す。
      history('J', [
        pointEntry('J', ['v', 0, 0], 0, 100),
        pointEntry('J', ['w', 30, 0], 100, 200, [['v', 0, 0]]),
        pointEntry('J', ['v', 9, 9], 200),
      ]),
      // K は 50 年から動かしていない。連続して引いている K が先に居た版。
      history('K', [pointEntry('K', ['v', 0, 0], 50)]),
    ]);
    const out = repaired(project);
    expect(coordAt(out, 'K', 200, 'v')).toEqual([0, 0]);
    expect(coordAt(out, 'J', 200, 'v')).toEqual([0, 0]);
  });
});
