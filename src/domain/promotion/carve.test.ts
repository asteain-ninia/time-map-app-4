// B39 の直し — 面の中に子を順に描いたとき、親 →［子1, 子2, 子3, 分け残し］の平らな形になり、
// 次に開いたときの整合の検査が何も出さない（＝修復を聞かれない）ことを、ドメインの経路で固定する。
//
// 画面の確定（`App.tsx` の `composeAddWithParentFollowUp`）と同じ順に呼ぶ:
//   1 人目: 追加 → 所属変更と同じ経路で親を集約化（分け残しが生まれる）
//   2 人目以降: 追加（親＝まとめ役） → 分け残しを削り、子の並びを揃える
//     （`planDirectDomainCarves` → `applyAddUnderAggregate`）

import { describe, expect, it } from 'vitest';

import { createBasicAttributes, createColorInfo } from '../attributes';
import { createCoordinate } from '../coordinate';
import { createAnchor, createAnchorSnapshot } from '../anchor';
import { deriveAnchorId } from '../anchor-id';
import {
  FEATURE_KIND,
  createAggregateFeature,
  createLeafFeature,
  isDirectDomainLeaf,
  type Feature,
  type LeafFeature,
} from '../feature';
import type { GeoMultiPolygon, GeoRing } from '../geometry/types';
import { createShape, createTerritoryRing } from '../ring';
import { createVertex, createVertexStore, type Vertex, type VertexStore } from '../vertex';
import { asFeatureId, asRingId, asVertexId, type FeatureId } from '../ids';
import { createIdGeneratorState } from '../id-generator';
import { buildForest, directChildIds } from '../hierarchy/forest';
import { resolveFeatureArea, resolveLeafShape } from '../hierarchy/resolve-shape';
import { getCalendar } from '../time/calendar';
import { timePointYear, type TimePoint } from '../time/time-point';
import { createAnchorEntry, resolveAt, withEntryEnd } from '../anchor-series';
import { createGeoParams } from '../geo/geo-params';
import type { DomainProject } from '../persistence/serialize';
import { INCONSISTENCY, checkConsistency } from '../persistence/consistency';
import {
  applyAddProposal,
  applyAffiliationProposal,
  toAffiliationEditProposal,
} from '../editing/apply-proposal';
import { ADD_FOLLOW_UP, addFollowUpKind, settleAddUnderAggregate } from '../editing/add-follow-up';
import { editFeatureInterval, endRunAt } from '../affiliation/interval-edit';
import { buildAffiliationProposalForTargets } from '../affiliation/proposal';
import { parentExisting } from '../affiliation/decision';

import { planDirectDomainCarves } from './carve';

const calendar = getCalendar('gregorian');
const COLOR = createColorInfo(true, '#90caf9', '#ffb300', '#0d47a1');
const T0 = timePointYear(0);

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

/** 正方形の末端（[x0,x1]×[y0,y1]）。頂点 id は `tag` から作る。 */
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
  const ring = createTerritoryRing(asRingId(`${id}-r`), vertices.map((v) => v.id));
  const feature = createLeafFeature(
    asFeatureId(id),
    createBasicAttributes(id, 0, 3000),
    COLOR,
    createShape([ring]),
    parentId === undefined ? {} : { parentId },
  );
  return { feature, vertices };
}

function add(root: DomainProject, s: { feature: LeafFeature; vertices: Vertex[] }, at = T0): DomainProject {
  return applyAddProposal(root, {
    featureId: s.feature.id,
    anchorTime: at,
    snapshot: { feature: s.feature, vertices: s.vertices, sharedCandidateIds: new Map() },
  });
}

/** その年の地物と頂点（全系列の束）。 */
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

/** 1 人目: 追加のあと、親（形を持つ末端）を集約化する（画面の確定と同じ経路）。 */
function addFirstChild(root: DomainProject, child: { feature: LeafFeature; vertices: Vertex[] }, at = T0): DomainProject {
  const afterAdd = add(root, child, at);
  const eff = effectiveAt(afterAdd, at);
  const built = buildAffiliationProposalForTargets(
    eff.features,
    [child.feature.id],
    parentExisting(child.feature.parentId!),
    { idState: createIdGeneratorState(), now: tick, vertexStore: eff.store },
  );
  expect(built.status, JSON.stringify(built)).toBe('proposal');
  if (built.status !== 'proposal') throw new Error('unreachable');
  return applyAffiliationProposal(afterAdd, toAffiliationEditProposal(built.proposal, at), calendar);
}

/** 末端どうしの面積を持つ重なり（その年の整合の検査が出すもの）の件数。 */
function overlapCount(root: DomainProject): number {
  return checkConsistency(root, calendar).inconsistencies.filter(
    (i) => i.kind === INCONSISTENCY.TerminalExclusion || i.kind === INCONSISTENCY.AnchorSpatialOverlap,
  ).length;
}

/** 採番の時刻（呼ぶたびに進める ―― 実アプリの `Date.now()` と同じく、確定ごとに違う）。 */
let clock = 100;
const tick = (): number => (clock += 1);

/** 2 人目以降: 追加（親＝まとめ役）のあと、分け残しを削り子の並びを揃える。 */
function addLaterChild(root: DomainProject, child: { feature: LeafFeature; vertices: Vertex[] }, at = T0): DomainProject {
  const afterAdd = add(root, child, at);
  const now = tick();
  const settled = settleAddUnderAggregate(afterAdd, child.feature.id, at, calendar, {
    idState: createIdGeneratorState(),
    now: () => now,
  });
  expect(settled).not.toBeNull();
  return settled!;
}

/**
 * 画面の確定と同じ決め方（`addFollowUpKind`）で後始末を選んで当てる。返り値の `kind` で
 * どの後始末を通ったかも見る。
 */
function addChild(
  root: DomainProject,
  child: { feature: LeafFeature; vertices: Vertex[] },
  at = T0,
): { root: DomainProject; kind: string } {
  const afterAdd = add(root, child, at);
  const kind = addFollowUpKind(afterAdd, child.feature.id, at, calendar);
  if (kind === ADD_FOLLOW_UP.Promote) return { root: addFirstChild(root, child, at), kind };
  if (kind === ADD_FOLLOW_UP.Settle) return { root: addLaterChild(root, child, at), kind };
  return { root: afterAdd, kind };
}

function ringArea(ring: GeoRing): number {
  let sum = 0;
  for (let i = 0; i < ring.length; i += 1) {
    const a = ring[i]!;
    const b = ring[(i + 1) % ring.length]!;
    sum += a.lon * b.lat - b.lon * a.lat;
  }
  return Math.abs(sum) / 2;
}
function area(mp: GeoMultiPolygon): number {
  let total = 0;
  for (const poly of mp) poly.forEach((ring, i) => (total += (i === 0 ? 1 : -1) * ringArea(ring)));
  return total;
}

const P = asFeatureId('P');

describe('B39 — 面の中に子を順に描くと、平らな形になり修復を聞かれない', () => {
  it('子 3 人: 親 →［子1, 子2, 子3, 分け残し］、分け残しは 1 つ、整合の検査は空', () => {
    let root = add(emptyProject(), square('P', 0, 0, 100, 100));
    root = addFirstChild(root, square('C1', 10, 10, 30, 30, P));
    root = addLaterChild(root, square('C2', 50, 10, 70, 30, P));
    root = addLaterChild(root, square('C3', 10, 50, 30, 70, P));

    const eff = effectiveAt(root, T0);
    const forest = buildForest(eff.features);
    const parent = eff.features.find((f) => f.id === P)!;
    expect(parent.kind).toBe(FEATURE_KIND.Aggregate);
    const children = directChildIds(forest, P);
    const dds = eff.features.filter(isDirectDomainLeaf);
    // 分け残しは 1 つだけ（鎖ができない）で、親の直下に居る。
    expect(dds).toHaveLength(1);
    expect(dds[0]!.parentId).toBe(P);
    expect(dds[0]!.attributes.name).toBe('P 直轄領');
    expect([...children].sort()).toEqual(
      [asFeatureId('C1'), asFeatureId('C2'), asFeatureId('C3'), dds[0]!.id].sort(),
    );
    // 子の並び（childIds）も同じ顔ぶれ（揃えてある）。
    if (parent.kind === FEATURE_KIND.Aggregate) {
      expect([...parent.childIds].sort()).toEqual([...children].sort());
    }
    // 分け残し ＝ 元の形 − 子の和（100² − 3 × 20²）。親の土地は 1 片も減らない。
    const ddShape = resolveLeafShape((dds[0] as LeafFeature).shape, eff.store)!;
    expect(area(ddShape)).toBeCloseTo(10000 - 3 * 400, 6);
    const parentArea = resolveFeatureArea(forest, eff.store, P);
    expect(parentArea.status).toBe('ok');
    if (parentArea.status === 'ok') expect(area(parentArea.area)).toBeCloseTo(10000, 6);

    // 次に開いたときの検査（＝修復の板が出るかどうか）が何も出さない。
    const report = checkConsistency(root, calendar);
    expect(report.inconsistencies, JSON.stringify(report.inconsistencies)).toHaveLength(0);
  });

  it('削らなければ兄弟の末端どうしが重なり、子の並びも食い違う（この直しが要る理由）', () => {
    let root = add(emptyProject(), square('P', 0, 0, 100, 100));
    root = addFirstChild(root, square('C1', 10, 10, 30, 30, P));
    root = add(root, square('C2', 50, 10, 70, 30, P)); // 後始末なし
    const kinds = checkConsistency(root, calendar).inconsistencies.map((i) => i.kind);
    expect(kinds).toContain(INCONSISTENCY.TerminalExclusion);
    expect(kinds).toContain(INCONSISTENCY.TreeTopology);
  });

  it('削っても動かない外周は元の頂点のまま（あとから隣が吸着した共有が切れない）', () => {
    let root = add(emptyProject(), square('P', 0, 0, 100, 100));
    root = addFirstChild(root, square('C1', 10, 10, 30, 30, P));
    const ddBefore = effectiveAt(root, T0).features.find(isDirectDomainLeaf) as LeafFeature;
    const outerBefore = ddBefore.shape.rings.find((r) => r.parentRingId === undefined)!;
    root = addLaterChild(root, square('C2', 50, 10, 70, 30, P));
    const ddAfter = effectiveAt(root, T0).features.find(isDirectDomainLeaf) as LeafFeature;
    const outerAfter = ddAfter.shape.rings.find((r) => r.parentRingId === undefined)!;
    expect([...outerAfter.vertexIds].sort()).toEqual([...outerBefore.vertexIds].sort());
    // 削った分の穴が 1 つ増えている（C1 の穴 + C2 の穴）。
    expect(ddAfter.shape.rings.length).toBe(ddBefore.shape.rings.length + 1);
  });

  it('分け残しを覆い尽くす子を足したら、その年から分け残しを消す（空の末端を残さない）', () => {
    let root = add(emptyProject(), square('P', 0, 0, 100, 100));
    root = addFirstChild(root, square('C1', 0, 0, 50, 100, P));
    root = addLaterChild(root, square('C2', 50, 0, 100, 100, P));
    const eff = effectiveAt(root, T0);
    expect(eff.features.filter(isDirectDomainLeaf)).toHaveLength(0);
    const children = directChildIds(buildForest(eff.features), P);
    expect([...children].sort()).toEqual([asFeatureId('C1'), asFeatureId('C2')]);
    const report = checkConsistency(root, calendar);
    expect(report.inconsistencies, JSON.stringify(report.inconsistencies)).toHaveLength(0);
  });

  it('分け残しと重ならない子（親の外に離れて居る子）なら分け残しは触らない', () => {
    let root = add(emptyProject(), square('P', 0, 0, 100, 100));
    root = addFirstChild(root, square('C1', 10, 10, 30, 30, P));
    root = add(root, square('C2', 200, 0, 220, 20, P));
    const eff = effectiveAt(root, T0);
    const carves = planDirectDomainCarves(eff.features, eff.store, asFeatureId('C2'), {
      idState: createIdGeneratorState(),
      now: () => 2,
    });
    expect(carves).toEqual([]);
  });

  it('終わりのある面に子を描くと、分け残しも元の面と一緒に終わる（B77 のうち分け残しの分）', () => {
    let root = add(emptyProject(), square('P', 0, 0, 100, 100));
    // 親の面は 1500 年で終わる。
    root = {
      ...root,
      histories: root.histories.map((h) =>
        h.featureId === P
          ? {
              featureId: h.featureId,
              series: { entries: h.series.entries.map((e) => withEntryEnd(e, timePointYear(1500))) },
            }
          : h,
      ),
    };
    const at = timePointYear(1300);
    root = addFirstChild(root, square('C1', 10, 10, 30, 30, P), at);
    const dd = effectiveAt(root, at).features.find(isDirectDomainLeaf)!;
    const ddHistory = root.histories.find((h) => h.featureId === dd.id)!;
    expect(ddHistory.series.entries.map((e) => e.end)).toEqual([timePointYear(1500)]);
    // 終わった後の年には分け残しは居ない。
    expect(effectiveAt(root, timePointYear(1600)).features.some(isDirectDomainLeaf)).toBe(false);
  });

  it('親が自分の系列を持たない（まとめ役の錨に居候している）面でも、平らに並び整合の検査は空', () => {
    // 実データの州と同じ形: 「国」（まとめ役）の錨の中に、親の面 P が居候している。
    const country = asFeatureId('K');
    const p = square('P', 0, 0, 100, 100, country);
    const agg = createAggregateFeature(country, createBasicAttributes('国', 0, 3000), COLOR, [P]);
    const snapshot = createAnchorSnapshot([agg, p.feature], createVertexStore(p.vertices));
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
    root = addFirstChild(root, square('C1', 10, 10, 30, 30, P));
    root = addLaterChild(root, square('C2', 50, 10, 70, 30, P));
    root = addLaterChild(root, square('C3', 10, 50, 30, 70, P));
    const eff = effectiveAt(root, T0);
    const children = directChildIds(buildForest(eff.features), P);
    const dds = eff.features.filter(isDirectDomainLeaf);
    expect(dds).toHaveLength(1);
    expect([...children].sort()).toEqual(
      [asFeatureId('C1'), asFeatureId('C2'), asFeatureId('C3'), dds[0]!.id].sort(),
    );
    const report = checkConsistency(root, calendar);
    expect(report.inconsistencies, JSON.stringify(report.inconsistencies)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// B39 の手直し 2 回目（検証 docs/ui-redesign/審査/B39-検証Opus.md の 3-2・2-1・2-2・2-3・2-4）
// ---------------------------------------------------------------------------

/** 錨を並べた系列を持つ履歴を作る（錨ごとに地物と頂点）。 */
function historyOf(
  ownerId: FeatureId,
  entries: readonly { at: TimePoint; features: Feature[]; vertices: Vertex[] }[],
): DomainProject['histories'][number] {
  return {
    featureId: ownerId,
    series: {
      entries: entries.map((e) =>
        createAnchorEntry(
          createAnchor(deriveAnchorId(ownerId, e.at), createAnchorSnapshot(e.features, createVertexStore(e.vertices))),
          e.at,
          null,
        ),
      ),
    },
  };
}

const Y = (y: number): TimePoint => timePointYear(y);

describe('B39 の手直し 2 回目 — 年をまたぐ形・隣との共有・終わらせ方', () => {
  it('3-2: 年 T に作る分け残しは親の次の錨の始まりで終わり、親が後で手放した土地は戻らない', () => {
    // P は 0 年に 100×100、500 年に東の帯（80〜100）を Q へ渡して 80×100。
    const p0 = square('P', 0, 0, 100, 100);
    const e1 = createVertex(asVertexId('P5-1'), createCoordinate(80, 0));
    const e2 = createVertex(asVertexId('P5-2'), createCoordinate(80, 100));
    const p500v = [p0.vertices[0]!, e1, e2, p0.vertices[3]!];
    const p500f = createLeafFeature(
      P,
      createBasicAttributes('P', 0, 3000),
      COLOR,
      createShape([createTerritoryRing(asRingId('P-r500'), p500v.map((v) => v.id))]),
    );
    // Q は 500 年から、P と境の 2 頂点を共有する東の帯。
    const q1 = createVertex(asVertexId('Q-1'), createCoordinate(100, 0));
    const q2 = createVertex(asVertexId('Q-2'), createCoordinate(100, 100));
    const qFeature = createLeafFeature(
      asFeatureId('Q'),
      createBasicAttributes('Q', 0, 3000),
      COLOR,
      createShape([createTerritoryRing(asRingId('Q-r'), [e1.id, q1.id, q2.id, e2.id])]),
    );
    let root: DomainProject = {
      ...emptyProject(),
      histories: [
        historyOf(P, [
          { at: Y(0), features: [p0.feature], vertices: p0.vertices },
          { at: Y(500), features: [p500f], vertices: p500v },
        ]),
        historyOf(asFeatureId('Q'), [{ at: Y(500), features: [qFeature], vertices: [e1, q1, q2, e2] }]),
      ],
    };
    expect(overlapCount(root)).toBe(0);
    root = addChild(root, square('C1', 10, 10, 30, 30, P), Y(100)).root;
    const ddAt300 = effectiveAt(root, Y(300)).features.find(isDirectDomainLeaf);
    expect(ddAt300).toBeDefined();
    // 分け残しは 500 年（P の次の錨の始まり）で終わる。
    const ddHistory = root.histories.find((h) => h.featureId === ddAt300!.id)!;
    expect(ddHistory.series.entries.map((e) => e.end)).toEqual([Y(500)]);
    expect(effectiveAt(root, Y(600)).features.some(isDirectDomainLeaf)).toBe(false);
    // 東の帯が分け残しとして戻って Q と重なる、が無い。
    expect(overlapCount(root)).toBe(0);
  });

  it('2-1: 100・300・200 年の順に子を描いても、分け残しの後ろの錨へ削りが入り重なりが無い', () => {
    let root = add(emptyProject(), square('P', 0, 0, 100, 100));
    root = addChild(root, square('C1', 10, 10, 30, 30, P), Y(100)).root;
    root = addChild(root, square('C2', 50, 10, 70, 30, P), Y(300)).root;
    const third = addChild(root, square('C3', 10, 50, 30, 70, P), Y(200));
    expect(third.kind).toBe(ADD_FOLLOW_UP.Settle);
    root = third.root;
    const report = checkConsistency(root, calendar);
    expect(report.inconsistencies, JSON.stringify(report.inconsistencies)).toHaveLength(0);
    const at300 = effectiveAt(root, Y(300));
    const dd300 = at300.features.find(isDirectDomainLeaf) as LeafFeature;
    expect(area(resolveLeafShape(dd300.shape, at300.store)!)).toBeCloseTo(10000 - 3 * 400, 6);
    const at200 = effectiveAt(root, Y(200));
    const dd200 = at200.features.find(isDirectDomainLeaf) as LeafFeature;
    expect(area(resolveLeafShape(dd200.shape, at200.store)!)).toBeCloseTo(10000 - 2 * 400, 6);
  });

  it('2-2: 1 人目より前の年に 2 人目を描いたら、後始末をせず従来の形に落とす（分け残しは 2 つにならない）', () => {
    let root = add(emptyProject(), square('P', 0, 0, 100, 100));
    root = addChild(root, square('C1', 10, 10, 30, 30, P), Y(100)).root;
    const second = addChild(root, square('C2', 50, 10, 70, 30, P), Y(50));
    expect(second.kind).toBe(ADD_FOLLOW_UP.Defer);
    root = second.root;
    const allDd = new Set<string>();
    for (const h of root.histories) {
      for (const e of h.series.entries) {
        for (const f of e.anchor.snapshot.features) if (isDirectDomainLeaf(f)) allDd.add(f.id);
      }
    }
    expect(allDd.size).toBe(1);
  });

  it('2-4: 1 人目で親を集約化しても、親と隣が共有していた頂点の id を分け残しが引き継ぐ（T 字 0）', () => {
    const p = square('P', 0, 0, 100, 100);
    // Q は P の東隣で、境の 2 頂点（100,0）（100,100）を P と共有する。
    const qOwn = [
      createVertex(asVertexId('Q-1'), createCoordinate(200, 0)),
      createVertex(asVertexId('Q-2'), createCoordinate(200, 100)),
    ];
    const qShape = createShape([
      createTerritoryRing(asRingId('Q-r'), [p.vertices[1]!.id, qOwn[0]!.id, qOwn[1]!.id, p.vertices[2]!.id]),
    ]);
    const q = createLeafFeature(asFeatureId('Q'), createBasicAttributes('Q', 0, 3000), COLOR, qShape);
    let root = add(emptyProject(), p);
    root = add(root, { feature: q, vertices: [p.vertices[1]!, qOwn[0]!, p.vertices[2]!, qOwn[1]!] });
    root = addChild(root, square('C1', 10, 10, 30, 30, P)).root;
    const dd = effectiveAt(root, T0).features.find(isDirectDomainLeaf) as LeafFeature;
    const outer = dd.shape.rings.find((r) => r.parentRingId === undefined)!;
    // 外周は元の 4 頂点そのもの（隣と共有していた 2 頂点を含む。境の上に新しい頂点が増えない ＝ T 字 0）。
    expect([...outer.vertexIds].sort()).toEqual(p.vertices.map((v) => v.id).sort());
    const report = checkConsistency(root, calendar);
    expect(report.inconsistencies, JSON.stringify(report.inconsistencies)).toHaveLength(0);
  });

  it('2-3: まとめ役を「この年に終わった」にすると、印のある分け残しも一緒に終わる（最上位に残らない）', () => {
    let root = add(emptyProject(), square('P', 0, 0, 100, 100));
    root = addChild(root, square('C1', 10, 10, 30, 30, P)).root;
    root = addChild(root, square('C2', 50, 10, 70, 30, P)).root;
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
    // 最上位へ移るのは本物の子 2 人だけ（分け残しは昇格させない）。
    expect([...ended.promoted].sort()).toEqual([asFeatureId('C1'), asFeatureId('C2')]);
    root = { ...root, histories: ended.histories };
    expect(effectiveAt(root, Y(400)).features.some(isDirectDomainLeaf)).toBe(true);
    expect(effectiveAt(root, Y(600)).features.some(isDirectDomainLeaf)).toBe(false);
    const report = checkConsistency(root, calendar);
    expect(report.inconsistencies, JSON.stringify(report.inconsistencies)).toHaveLength(0);
  });
});
