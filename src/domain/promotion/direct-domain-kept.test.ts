// B39 の手直しのうち、追加の後始末を戻したあとも **残したもの** を固定する（2026-10-04）。
//
//   1. 集約地物の下に面を足したとき、集約地物の下位領域の並び（`childIds`）を揃える
//      （`syncAggregateChildrenAfterAdd`。居候の集約地物は先に自分の系列へ起こす）。形も所属も変えない。
//      後始末（集約化・分け残しの削り）とは切り離せる ―― 分け残しの無い集約地物で確かめる。
//   2. 分け残しを作るとき、元の面の頂点 id を座標の一致で引き継ぐ（隣との共有を切らない。T 字 0）。
//      所属変更（＝分け残しを作る経路）で確かめる。
//   3. 集約地物が居なくなる区間では、印のある分け残しも一緒に居なくなる（最上位に残らない）。

import { describe, expect, it } from 'vitest';

import { createBasicAttributes, createColorInfo } from '../attributes';
import { createCoordinate } from '../coordinate';
import { createAnchor, createAnchorSnapshot } from '../anchor';
import { deriveAnchorId } from '../anchor-id';
import { createAnchorEntry, resolveAt } from '../anchor-series';
import {
  createAggregateFeature,
  createLeafFeature,
  isDirectDomainLeaf,
  type Feature,
  type LeafFeature,
} from '../feature';
import { createShape, createTerritoryRing } from '../ring';
import { createVertex, createVertexStore, type Vertex, type VertexStore } from '../vertex';
import { asFeatureId, asRingId, asVertexId, type FeatureId } from '../ids';
import { createIdGeneratorState } from '../id-generator';
import { getCalendar } from '../time/calendar';
import { timePointYear, type TimePoint } from '../time/time-point';
import { createGeoParams } from '../geo/geo-params';
import type { DomainProject } from '../persistence/serialize';
import { INCONSISTENCY, checkConsistency } from '../persistence/consistency';
import {
  applyAddProposal,
  applyAffiliationProposal,
  syncAggregateChildrenAfterAdd,
  toAffiliationEditProposal,
} from '../editing/apply-proposal';
import { editFeatureInterval, endRunAt } from '../affiliation/interval-edit';
import { buildAffiliationProposal } from '../affiliation/proposal';
import { parentExisting } from '../affiliation/decision';

const calendar = getCalendar('gregorian');
const COLOR = createColorInfo(true, '#90caf9', '#ffb300', '#0d47a1');
const T0 = timePointYear(0);
const Y = (y: number): TimePoint => timePointYear(y);
const P = asFeatureId('P');

function emptyProject(): DomainProject {
  return {
    histories: [],
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

function square(
  id: string,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  parentId?: FeatureId,
): { feature: LeafFeature; vertices: Vertex[] } {
  const vertices = [
    createVertex(asVertexId(`${id}-0`), createCoordinate(x0, y0)),
    createVertex(asVertexId(`${id}-1`), createCoordinate(x1, y0)),
    createVertex(asVertexId(`${id}-2`), createCoordinate(x1, y1)),
    createVertex(asVertexId(`${id}-3`), createCoordinate(x0, y1)),
  ];
  const feature = createLeafFeature(
    asFeatureId(id),
    createBasicAttributes(id, 0, 3000),
    COLOR,
    createShape([createTerritoryRing(asRingId(`${id}-r`), vertices.map((v) => v.id))]),
    parentId === undefined ? {} : { parentId },
  );
  return { feature, vertices };
}

function add(root: DomainProject, s: { feature: Feature; vertices: readonly Vertex[] }, at = T0): DomainProject {
  return applyAddProposal(root, {
    featureId: s.feature.id,
    anchorTime: at,
    snapshot: { feature: s.feature, vertices: [...s.vertices], sharedCandidateIds: new Map() },
  });
}

function effectiveAt(root: DomainProject, at: TimePoint): { features: Feature[]; store: VertexStore } {
  const features: Feature[] = [];
  const verts: Vertex[] = [];
  const seen = new Set<string>();
  for (const h of root.histories) {
    const r = resolveAt(h.series, at, calendar);
    if (r.kind !== 'present') continue;
    for (const f of r.entry.anchor.snapshot.features) {
      if (seen.has(f.id as string)) continue;
      seen.add(f.id as string);
      features.push(f);
    }
    for (const v of r.entry.anchor.snapshot.vertices.byId.values()) verts.push(v);
  }
  return { features, store: createVertexStore(verts) };
}

/** 所属変更で `childId` を形を持つ末端 `parentId` の下へ移す（分け残しが生まれる経路）。 */
function reparentUnderLeaf(root: DomainProject, childId: FeatureId, parentId: FeatureId, at = T0): DomainProject {
  const eff = effectiveAt(root, at);
  const built = buildAffiliationProposal(eff.features, childId, parentExisting(parentId), {
    idState: createIdGeneratorState(),
    now: () => 1,
    vertexStore: eff.store,
  });
  expect(built.status, JSON.stringify(built)).toBe('proposal');
  if (built.status !== 'proposal') throw new Error('unreachable');
  return applyAffiliationProposal(root, toAffiliationEditProposal(built.proposal, at), calendar);
}

describe('B39 の手直しのうち残したもの', () => {
  it('居候の集約地物の下に面を足すと、子の並びを揃える（自分の系列へ起こしてから）。形も所属も変えない', () => {
    // 「国」K の錨に、集約地物 P と その子 A が居候している（実データの州の形）。
    const country = asFeatureId('K');
    const a = square('A', 0, 0, 40, 40, P);
    const pAgg = createAggregateFeature(P, createBasicAttributes('P', 0, 3000), COLOR, [a.feature.id], {
      parentId: country,
    });
    const k = createAggregateFeature(country, createBasicAttributes('国', 0, 3000), COLOR, [P]);
    const snapshot = createAnchorSnapshot([k, pAgg, a.feature], createVertexStore(a.vertices));
    let root: DomainProject = {
      ...emptyProject(),
      histories: [
        {
          featureId: country,
          series: { entries: [createAnchorEntry(createAnchor(deriveAnchorId(country, T0), snapshot), T0, null)] },
        },
      ],
    };
    expect(checkConsistency(root, calendar).inconsistencies).toHaveLength(0);
    const b = square('B', 50, 0, 90, 40, P);
    root = add(root, b);
    // 揃えなければ「子の並びの食い違い」が出る。
    const kinds = checkConsistency(root, calendar).inconsistencies.map((i) => i.kind);
    expect(kinds).toContain(INCONSISTENCY.TreeTopology);
    const synced = syncAggregateChildrenAfterAdd(root, P, calendar);
    const report = checkConsistency(synced, calendar);
    expect(report.inconsistencies, JSON.stringify(report.inconsistencies)).toHaveLength(0);
    // P は自分の系列を持つようになり、子の並びは A と B。形と所属は変わらない。
    expect(synced.histories.some((h) => h.featureId === P)).toBe(true);
    const pAt0 = effectiveAt(synced, T0).features.find((f) => f.id === P);
    expect(pAt0?.kind).toBe('aggregate');
    if (pAt0?.kind === 'aggregate') expect([...pAt0.childIds].sort()).toEqual([a.feature.id, b.feature.id].sort());
    expect(effectiveAt(synced, T0).features.find((f) => f.id === b.feature.id)).toEqual(b.feature);
  });

  it('分け残しを作るとき、元の面の頂点 id を引き継ぎ、隣との共有が切れない（T 字 0）', () => {
    const p = square('P', 0, 0, 100, 100);
    // Q は P の東隣で、境の 2 頂点（100,0）（100,100）を P と共有する。
    const qOwn = [
      createVertex(asVertexId('Q-1'), createCoordinate(200, 0)),
      createVertex(asVertexId('Q-2'), createCoordinate(200, 100)),
    ];
    const q = createLeafFeature(
      asFeatureId('Q'),
      createBasicAttributes('Q', 0, 3000),
      COLOR,
      createShape([
        createTerritoryRing(asRingId('Q-r'), [p.vertices[1]!.id, qOwn[0]!.id, qOwn[1]!.id, p.vertices[2]!.id]),
      ]),
    );
    let root = add(emptyProject(), p);
    root = add(root, { feature: q, vertices: [p.vertices[1]!, qOwn[0]!, p.vertices[2]!, qOwn[1]!] });
    root = add(root, square('C1', 10, 10, 30, 30));
    root = reparentUnderLeaf(root, asFeatureId('C1'), P);
    const dd = effectiveAt(root, T0).features.find(isDirectDomainLeaf) as LeafFeature;
    const outer = dd.shape.rings.find((r) => r.parentRingId === undefined)!;
    expect([...outer.vertexIds].sort()).toEqual(p.vertices.map((v) => v.id).sort());
    const report = checkConsistency(root, calendar);
    expect(report.inconsistencies, JSON.stringify(report.inconsistencies)).toHaveLength(0);
  });

  it('集約地物を「この年に終わった」にすると、印のある分け残しも一緒に終わる（昇格するのは本物の子だけ）', () => {
    let root = add(emptyProject(), square('P', 0, 0, 100, 100));
    root = add(root, square('C1', 10, 10, 30, 30));
    root = add(root, square('C2', 50, 10, 70, 30));
    root = reparentUnderLeaf(root, asFeatureId('C1'), P);
    // 2 人目は集約地物 P の下へ（分け残しと重ならないよう、分け残しを使わない所属変更で）。
    const eff = effectiveAt(root, T0);
    const built = buildAffiliationProposal(eff.features, asFeatureId('C2'), parentExisting(P), {
      idState: createIdGeneratorState(),
      now: () => 2,
      vertexStore: eff.store,
    });
    if (built.status !== 'proposal') throw new Error(JSON.stringify(built));
    root = applyAffiliationProposal(root, toAffiliationEditProposal(built.proposal, T0), calendar);
    const own = root.histories.find((h) => h.featureId === P)!;
    const r = resolveAt(own.series, Y(500), calendar);
    if (r.kind !== 'present') throw new Error('P が 500 年に居ない');
    const anchorId = r.entry.anchor.id;
    const ended = editFeatureInterval(
      root.histories,
      P,
      (series) => endRunAt(series, P, anchorId, Y(500), calendar),
      calendar,
    );
    expect(ended.ok).toBe(true);
    if (!ended.ok) return;
    expect([...ended.promoted].sort()).toEqual([asFeatureId('C1'), asFeatureId('C2')]);
    root = { ...root, histories: ended.histories };
    expect(effectiveAt(root, Y(400)).features.some(isDirectDomainLeaf)).toBe(true);
    expect(effectiveAt(root, Y(600)).features.some(isDirectDomainLeaf)).toBe(false);
  });
});
