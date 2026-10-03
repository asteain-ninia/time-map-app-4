// 過去の年の編集が、終わりのある錨の途中に新しい錨を挿しても、地物を終わりの先へ
// 生き返らせないことの検査（増分 7 の手直し 2 回目 / `docs/現状.md` B76）。
//
// 共通の入口 `applyPastEdit` は、挿す錨にその時点で効いている錨の **終わりを引き継ぐ**。
// 以前は終わりを引き継がず、[0, 1000) の地物を 500 年で直すと [500, ∞) になって、1500 年にも
// 居ることになっていた。`apply-proposal.ts` で `applyPastEdit` を呼ぶ 9 か所を、それぞれ実際に
// 通る公開の入口から 1 回ずつ通して確かめる（表で回す）。どの行も
//   - 編集した年（500 年）に新しい錨ができる（入口が本当にその場所を通った）、
//   - 終わりの手前（700 年）には居る、
//   - 終わりの後（1500 年）にはその系列のどの地物も居ない（生き返らない）、
// を見る。carry-forward（増分 2 の「次に本当に変わる錨まで前へ引き継ぐ」）との両立も 1 本見る。

import { describe, expect, it } from 'vitest';

import { createAnchor, createAnchorSnapshot } from '../anchor';
import { applyPastEdit, createAnchorEntry, normalizeSeries, resolveAt } from '../anchor-series';
import { createBasicAttributes, createColorInfo } from '../attributes';
import { parentExisting, parentNone } from '../affiliation/decision';
import { buildAffiliationProposalForTargets } from '../affiliation/proposal';
import type { SplitSnapshot } from '../knife/proposal';
import type { DrillSnapshot } from '../drill/proposal';
import { MERGE_STATUS, buildMergeProposal, toMergeEditProposal } from '../merge/proposal';
import { propertyNew } from '../merge/decision';
import { makeIdPorts } from '../merge/fixtures';
import { createEditProposal } from '../consistency/types';
import {
  createAggregateFeature,
  createLeafFeature,
  withParentId,
  type Feature,
  type LeafFeature,
} from '../feature';
import { createIdGeneratorState } from '../id-generator';
import { asAnchorId, asFeatureId, asRingId, asVertexId } from '../ids';
import { checkConsistency } from '../persistence/consistency';
import type { DomainProject, FeatureHistory } from '../persistence/serialize';
import { createGeoParams } from '../geo/geo-params';
import { createShape, createTerritoryRing } from '../ring';
import { getCalendar } from '../time/calendar';
import { timePointYear } from '../time/time-point';
import { createVertex, createVertexStore, type Vertex } from '../vertex';

import {
  applyAffiliationProposal,
  applyDrillProposal,
  applyEditProposal,
  applyMergeProposal,
  applySplitProposal,
  deriveAnchorId,
  rewriteFeatureColorAtTime,
  toAffiliationEditProposal,
} from './apply-proposal';
import type { FeatureSnapshot } from './edit-flow';

const calendar = getCalendar('gregorian');
const color = createColorInfo(true, '#90caf9', '#ffb300', '#0d47a1');
const EDIT = 500;
const END = 1000;

function projectOf(histories: readonly FeatureHistory[]): DomainProject {
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

/** 4 隅の正方形の末端。頂点 id は渡したもの（共有させるときは同じ id を渡す）。 */
function square(id: string, ids: readonly [string, string, string, string], x: number, y: number, size = 10): {
  feature: LeafFeature;
  vertices: Vertex[];
} {
  const coords = [
    [x, y],
    [x + size, y],
    [x + size, y + size],
    [x, y + size],
  ] as const;
  const vertices = ids.map((v, i) => createVertex(asVertexId(v), { lon: coords[i]![0], lat: coords[i]![1] }));
  const feature = createLeafFeature(
    asFeatureId(id),
    // 飾りの存続年（結合の可否が読む）は編集の年を含むようにしておく。
    createBasicAttributes(id, 0, 2000),
    color,
    createShape([createTerritoryRing(asRingId(`r-${id}`), vertices.map((v) => v.id))]),
  );
  return { feature, vertices };
}

/** `[0, END)` だけ居る系列（持ち主は `owner`、錨は 1 本）。 */
function boundedHistory(owner: string, features: readonly Feature[], vertices: readonly Vertex[]): FeatureHistory {
  const anchor = createAnchor(
    deriveAnchorId(asFeatureId(owner), timePointYear(0)),
    createAnchorSnapshot(features, createVertexStore(vertices)),
  );
  return {
    featureId: asFeatureId(owner),
    series: normalizeSeries([createAnchorEntry(anchor, timePointYear(0), timePointYear(END))], calendar),
  };
}

function historyOf(p: DomainProject, owner: string): FeatureHistory {
  const h = p.histories.find((x) => x.featureId === asFeatureId(owner));
  if (h === undefined) throw new Error(`系列が無い: ${owner}`);
  return h;
}

/** 表の 1 行: 入口の名前、通る `applyPastEdit` の場所、組み立てと実行、見る系列の持ち主。 */
interface Row {
  readonly site: string;
  readonly run: () => { readonly after: DomainProject; readonly owner: string };
}

const rows: readonly Row[] = [
  {
    site: 'applyEditProposal（素性の保存＝過去の年で改名）',
    run: () => {
      const a = square('a', ['a0', 'a1', 'a2', 'a3'], 0, 0);
      const root = projectOf([boundedHistory('a', [a.feature], a.vertices)]);
      const renamed = { ...a.feature, attributes: createBasicAttributes('新名', 0, 0) };
      const snapshot: FeatureSnapshot = { feature: renamed, vertices: [] };
      return { after: applyEditProposal(root, createEditProposal(a.feature.id, timePointYear(EDIT), snapshot), calendar), owner: 'a' };
    },
  },
  {
    site: 'applyEditProposal（この年に錨を作る＝値を変えない錨）',
    run: () => {
      const a = square('a', ['a0', 'a1', 'a2', 'a3'], 0, 0);
      const root = projectOf([boundedHistory('a', [a.feature], a.vertices)]);
      const snapshot: FeatureSnapshot = { feature: a.feature, vertices: [] };
      return { after: applyEditProposal(root, createEditProposal(a.feature.id, timePointYear(EDIT), snapshot), calendar), owner: 'a' };
    },
  },
  {
    site: 'applyMovedVerticesToHistories（共有頂点を動かすと隣の系列にも錨が立つ）',
    run: () => {
      const a = square('a', ['s0', 'a1', 'a2', 's3'], 0, 0);
      const n = square('n', ['n0', 's0', 's3', 'n3'], -10, 0);
      const root = projectOf([
        { featureId: a.feature.id, series: { entries: [createAnchorEntry(createAnchor(deriveAnchorId(a.feature.id, timePointYear(0)), createAnchorSnapshot([a.feature], createVertexStore(a.vertices))), timePointYear(0), null)] } },
        boundedHistory('n', [n.feature], n.vertices),
      ]);
      const moved = createVertex(asVertexId('s0'), { lon: 1, lat: -1 });
      const snapshot: FeatureSnapshot = { feature: a.feature, vertices: [moved] };
      return { after: applyEditProposal(root, createEditProposal(a.feature.id, timePointYear(EDIT), snapshot), calendar), owner: 'n' };
    },
  },
  {
    site: 'rewriteFeatureColorAtTime（自動配色で色を書き替える）',
    run: () => {
      const a = square('a', ['a0', 'a1', 'a2', 'a3'], 0, 0);
      const root = projectOf([boundedHistory('a', [a.feature], a.vertices)]);
      const recolored = createColorInfo(true, '#ff0000', '#ffb300', '#0d47a1');
      const histories = rewriteFeatureColorAtTime(root.histories, a.feature.id, recolored, timePointYear(EDIT), calendar);
      return { after: { ...root, histories }, owner: 'a' };
    },
  },
  {
    site: 'applySplitProposal（分ける: 継ぐ側の形）',
    run: () => {
      const a = square('a', ['a0', 'a1', 'a2', 'a3'], 0, 0);
      const root = projectOf([boundedHistory('a', [a.feature], a.vertices)]);
      const piece = square('p', ['p0', 'p1', 'p2', 'p3'], 20, 0);
      const snapshot: SplitSnapshot = {
        inheritorFeatureId: a.feature.id,
        inheritorShape: createShape([createTerritoryRing(asRingId('r-a-2'), ['a0', 'a1', 'a2'].map(asVertexId))]),
        newFeature: piece.feature,
        vertices: [...a.vertices, ...piece.vertices],
        vertexRemap: new Map(),
        sharedEdgeCuts: [],
        touchedFeatureIds: [a.feature.id, piece.feature.id],
      };
      return { after: applySplitProposal(root, createEditProposal(a.feature.id, timePointYear(EDIT), snapshot), calendar), owner: 'a' };
    },
  },
  {
    site: 'applyVertexRemapToHistories（分ける: 隣の共有頂点を付け替える）',
    run: () => {
      const a = square('a', ['sv', 'a1', 'a2', 'a3'], 0, 0);
      const n = square('n', ['n0', 'sv', 'n2', 'n3'], -10, 0);
      const root = projectOf([
        { featureId: a.feature.id, series: { entries: [createAnchorEntry(createAnchor(deriveAnchorId(a.feature.id, timePointYear(0)), createAnchorSnapshot([a.feature], createVertexStore(a.vertices))), timePointYear(0), null)] } },
        boundedHistory('n', [n.feature], n.vertices),
      ]);
      const svNew = createVertex(asVertexId('sv-new'), { lon: 0, lat: 0 });
      const piece = square('p', ['p0', 'p1', 'p2', 'p3'], 20, 0);
      const snapshot: SplitSnapshot = {
        inheritorFeatureId: a.feature.id,
        inheritorShape: createShape([createTerritoryRing(asRingId('r-a-2'), ['sv-new', 'a1', 'a2'].map(asVertexId))]),
        newFeature: piece.feature,
        vertices: [svNew, ...piece.vertices],
        vertexRemap: new Map([[asVertexId('sv'), asVertexId('sv-new')]]),
        sharedEdgeCuts: [],
        touchedFeatureIds: [a.feature.id, piece.feature.id],
      };
      return { after: applySplitProposal(root, createEditProposal(a.feature.id, timePointYear(EDIT), snapshot), calendar), owner: 'n' };
    },
  },
  {
    site: 'insertSeamsIntoNeighbour（分ける: 隣と共有する辺の途中に継ぎ目を入れる）',
    run: () => {
      const a = square('a', ['e0', 'e1', 'a2', 'a3'], 0, 0);
      const n = square('n', ['e1', 'e0', 'n2', 'n3'], 0, -10);
      const nFeature = createLeafFeature(
        asFeatureId('n'),
        createBasicAttributes('n', 0, 0),
        color,
        createShape([createTerritoryRing(asRingId('r-n'), ['e0', 'e1', 'n2', 'n3'].map(asVertexId))]),
      );
      const root = projectOf([
        { featureId: a.feature.id, series: { entries: [createAnchorEntry(createAnchor(deriveAnchorId(a.feature.id, timePointYear(0)), createAnchorSnapshot([a.feature], createVertexStore(a.vertices))), timePointYear(0), null)] } },
        boundedHistory('n', [nFeature], n.vertices),
      ]);
      const seam = { lon: 5, lat: 0 };
      const cut0 = createVertex(asVertexId('cut0'), seam);
      const piece = square('p', ['p0', 'p1', 'p2', 'p3'], 30, 0);
      const snapshot: SplitSnapshot = {
        inheritorFeatureId: a.feature.id,
        inheritorShape: createShape([createTerritoryRing(asRingId('r-a-2'), ['e0', 'cut0', 'e1', 'a2'].map(asVertexId))]),
        newFeature: piece.feature,
        vertices: [cut0, ...piece.vertices],
        vertexRemap: new Map(),
        sharedEdgeCuts: [
          {
            featureId: a.feature.id,
            ringId: asRingId('r-a'),
            edgeStartIndex: 0,
            edgeStartVertexId: asVertexId('e0'),
            edgeEndVertexId: asVertexId('e1'),
            cutCoordinate: seam,
          },
        ],
        touchedFeatureIds: [a.feature.id, piece.feature.id],
      };
      return { after: applySplitProposal(root, createEditProposal(a.feature.id, timePointYear(EDIT), snapshot), calendar), owner: 'n' };
    },
  },
  {
    site: 'applyDrillProposal（穴あけ: 元の末端の形）',
    run: () => {
      const a = square('a', ['a0', 'a1', 'a2', 'a3'], 0, 0, 30);
      const root = projectOf([boundedHistory('a', [a.feature], a.vertices)]);
      const piece = square('h', ['h0', 'h1', 'h2', 'h3'], 10, 10);
      const snapshot: DrillSnapshot = {
        originalFeatureId: a.feature.id,
        holedShape: a.feature.shape,
        newFeature: piece.feature,
        inheritedParentId: undefined,
        vertices: [...a.vertices, ...piece.vertices],
        touchedFeatureIds: [a.feature.id, piece.feature.id],
      };
      return { after: applyDrillProposal(root, createEditProposal(a.feature.id, timePointYear(EDIT), snapshot), calendar), owner: 'a' };
    },
  },
  {
    site: 'removeFeatureAtTime と rewriteFeatureSnapshotAtTime（結ぶ: まとめ役の錨の中の子を結ぶ）',
    run: () => {
      // まとめ役 P（[0, END)）の錨に a・b・d が居候している。a と b を P の下のまま結ぶ。
      const a = square('a', ['a0', 'sc1', 'sc2', 'a3'], 0, 0);
      const b = square('b', ['sc1', 'b1', 'b2', 'sc2'], 10, 0);
      const d = square('d', ['d0', 'd1', 'd2', 'd3'], 50, 0);
      const children = [a, b, d].map((x) => withParentId(x.feature, asFeatureId('P')));
      const agg = createAggregateFeature(asFeatureId('P'), createBasicAttributes('P', 0, 0), color, children.map((c) => c.id));
      const all: Feature[] = [agg, ...children];
      const vertices = [...a.vertices, ...b.vertices, ...d.vertices];
      const root = projectOf([boundedHistory('P', all, vertices)]);
      const built = buildMergeProposal({
        features: all,
        vertices: createVertexStore(vertices),
        targetIds: [asFeatureId('a'), asFeatureId('b')],
        atTime: EDIT,
        parentDecision: parentExisting(asFeatureId('P')),
        propertyDecision: propertyNew({ attributes: createBasicAttributes('結んだ', 0, 0), color }),
        ids: makeIdPorts(),
      });
      if (built.status !== MERGE_STATUS.Proposal) throw new Error(JSON.stringify(built).slice(0, 300));
      return { after: applyMergeProposal(root, toMergeEditProposal(built.proposal, timePointYear(EDIT)), calendar), owner: 'P' };
    },
  },
  {
    site: 'rewriteFeatureSnapshotAtTime（所属変更: 自分の系列を持つ子の親を外す）',
    run: () => {
      const a = square('a', ['a0', 'a1', 'a2', 'a3'], 0, 0);
      const child = withParentId(a.feature, asFeatureId('P'));
      const agg = createAggregateFeature(asFeatureId('P'), createBasicAttributes('P', 0, 0), color, [child.id, asFeatureId('b')]);
      const b = square('b', ['b0', 'b1', 'b2', 'b3'], 20, 0);
      const bChild = withParentId(b.feature, asFeatureId('P'));
      const root = projectOf([
        boundedHistory('P', [agg], []),
        boundedHistory('a', [child], a.vertices),
        boundedHistory('b', [bChild], b.vertices),
      ]);
      const features: Feature[] = [agg, child, bChild];
      const prop = buildAffiliationProposalForTargets(features, [child.id], parentNone, {
        idState: createIdGeneratorState(),
        now: () => 1,
        vertexStore: createVertexStore([...a.vertices, ...b.vertices]),
      });
      if (prop.status !== 'proposal') throw new Error(JSON.stringify(prop).slice(0, 300));
      return { after: applyAffiliationProposal(root, toAffiliationEditProposal(prop.proposal, timePointYear(EDIT)), calendar), owner: 'a' };
    },
  },
];

describe('過去の年の編集は、終わりのある錨の途中に挿しても終わりを越えて生き返らせない（B76）', () => {
  it.each(rows.map((r) => [r.site, r] as const))('%s', (_site, row) => {
    const { after, owner } = row.run();
    const history = historyOf(after, owner);
    // 入口が本当に編集の年に錨を挿した（または書き替えた）。
    expect(history.series.entries.some((e) => e.start.year === EDIT)).toBe(true);
    // 終わりの手前には居る。
    expect(resolveAt(history.series, timePointYear(700), calendar).kind).toBe('present');
    // 終わりの後には居ない（以前は 500 年の錨が終わりを持たず、ずっと居ることになっていた）。
    expect(resolveAt(history.series, timePointYear(1500), calendar).kind).toBe('absent');
    expect(resolveAt(history.series, timePointYear(END), calendar).kind).toBe('absent');
  });

  it('applyPastEdit そのもの: 挿した錨は、効いていた錨の終わりを引き継ぐ。終わりの無い錨なら開いたまま', () => {
    const a = square('a', ['a0', 'a1', 'a2', 'a3'], 0, 0);
    const bounded = boundedHistory('a', [a.feature], a.vertices).series;
    const make = (eff: Parameters<Parameters<typeof applyPastEdit>[2]>[0]) =>
      createAnchor(asAnchorId('x'), eff.kind === 'present' ? eff.entry.anchor.snapshot : createAnchorSnapshot([], createVertexStore([])));
    const out = applyPastEdit(bounded, timePointYear(EDIT), make, calendar);
    expect(out.entries.map((e) => [e.start.year, e.end?.year ?? null])).toEqual([
      [0, EDIT],
      [EDIT, END],
    ]);
    const open = normalizeSeries([{ ...bounded.entries[0]!, end: null }], calendar);
    const out2 = applyPastEdit(open, timePointYear(EDIT), make, calendar);
    // 終わりの無い錨は、次の錨の始まりで区切られる（終わりの欄は空のまま）。
    expect(out2.entries.map((e) => [e.start.year, e.end?.year ?? null])).toEqual([
      [0, null],
      [EDIT, null],
    ]);
  });

  it('carry-forward と両立する: 終わりのある区間の途中で改名すると、終わりまでは新名で、終わりの後にも次の区間にも漏れない', () => {
    // [0, 1000) と [1200, ∞) の 2 区間。500 年で改名。
    const a = square('a', ['a0', 'a1', 'a2', 'a3'], 0, 0);
    const first = createAnchor(deriveAnchorId(a.feature.id, timePointYear(0)), createAnchorSnapshot([a.feature], createVertexStore(a.vertices)));
    const later = createAnchor(deriveAnchorId(a.feature.id, timePointYear(1200)), createAnchorSnapshot([a.feature], createVertexStore(a.vertices)));
    const root = projectOf([
      {
        featureId: a.feature.id,
        series: normalizeSeries(
          [createAnchorEntry(first, timePointYear(0), timePointYear(END)), createAnchorEntry(later, timePointYear(1200), null)],
          calendar,
        ),
      },
    ]);
    const renamed = { ...a.feature, attributes: createBasicAttributes('新名', 0, 0) };
    const after = applyEditProposal(
      root,
      createEditProposal(a.feature.id, timePointYear(EDIT), { feature: renamed, vertices: [] } satisfies FeatureSnapshot),
      calendar,
    );
    const nameAt = (year: number): string | undefined => {
      const r = resolveAt(historyOf(after, 'a').series, timePointYear(year), calendar);
      return r.kind === 'present' ? r.entry.anchor.snapshot.features[0]?.attributes.name : undefined;
    };
    expect(nameAt(400)).toBe('a');
    expect(nameAt(700)).toBe('新名');
    expect(nameAt(1100)).toBeUndefined();
    // 次の区間の錨は「旧名の写し」なので、増分 2 の決定どおり新名へ引き継がれる（終わりの
    // 引き継ぎとは独立に、次に本当に変わる錨まで前へ送る）。
    expect(nameAt(1500)).toBe('新名');
    expect(checkConsistency(after, calendar).inconsistencies).toEqual([]);
  });
});



