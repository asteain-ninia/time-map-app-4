// B105 — 打ち直しが効かなかったときの断り（守り）が、分け残しを作る 3 つの入口で実際に効くこと。
//
// 打ち直しは長い辺を必ず消すので、いまの実装で断りに届く形は作れない。だから打ち直しの関数を
// 差し替えて「打ち直しが効かなかった」場面を作る（§5.41）。守りは 2 段ある。
//   (a) 打ち直したあとに長い辺が残っている。
//   (b) 長い辺は無いことになっているが、組み立てた形を読み直すと面積が合わない。

import { afterEach, describe, expect, it, vi } from 'vitest';

import { parentExisting } from '../affiliation/decision';
import { MSG_AFFILIATION_LONG_EDGE } from '../affiliation/messages';
import { buildAffiliationProposal } from '../affiliation/proposal';
import { createBasicAttributes, createColorInfo } from '../attributes';
import { createAnchor, createAnchorSnapshot } from '../anchor';
import { createAnchorEntry } from '../anchor-series';
import { deriveAnchorId } from '../anchor-id';
import { createCoordinate, type WorldCoordinate } from '../coordinate';
import { createLeafFeature, type LeafFeature } from '../feature';
import { createGeoParams } from '../geo/geo-params';
import { wrapLonDeg } from '../geo/index';
import type { GeoRing } from '../geometry/index';
import { createIdGeneratorState } from '../id-generator';
import { asFeatureId, asRingId, asVertexId, type FeatureId } from '../ids';
import { checkConsistency } from '../persistence/consistency';
import { applyRepair, REPAIR_OPTION } from '../persistence/repair';
import type { DomainProject } from '../persistence/serialize';
import { createShape, createTerritoryRing } from '../ring';
import { getCalendar } from '../time/calendar';
import { timePointYear } from '../time/time-point';
import { createVertex, createVertexStore, type Vertex } from '../vertex';

import { PROMOTION_REJECT, PROMOTION_STATUS, promoteLeafToAggregate } from './promote';

const fakes = vi.hoisted(() => ({ reportNoLongEdges: false }));

vi.mock('../geo/long-edge', async (importOriginal) => {
  const real = await importOriginal<typeof import('../geo/long-edge')>();
  return {
    ...real,
    // 打ち直しが何もしない。
    restoreDroppedPoints: (mp: unknown) => mp,
    subdivideLongEdges: (mp: unknown) => mp,
    // (b) の段へ届かせるとき、長い辺の検出を素通りさせる。
    countLongEdgesInMultiPolygon: (mp: Parameters<typeof real.countLongEdgesInMultiPolygon>[0]) =>
      fakes.reportNoLongEdges ? 0 : real.countLongEdgesInMultiPolygon(mp),
  };
});

const CAL = getCalendar('gregorian');
const COLOR = createColorInfo(true, '#90caf9', '#ffb300', '#0d47a1');
const Y0 = timePointYear(0);
const P = asFeatureId('P');
const C = asFeatureId('C');
const c = (lon: number, lat: number): WorldCoordinate => createCoordinate(lon, lat);

function leafOf(
  id: string,
  ring: GeoRing,
  parentId?: FeatureId,
): { feature: LeafFeature; vertices: Vertex[] } {
  const vertices = ring.map((p, i) =>
    createVertex(asVertexId(`${id}-${i}`), c(wrapLonDeg(p.lon), p.lat)),
  );
  return {
    vertices,
    feature: createLeafFeature(
      asFeatureId(id),
      createBasicAttributes(id, 0, 0),
      COLOR,
      createShape([createTerritoryRing(asRingId(`${id}-r`), vertices.map((v) => v.id))]),
      parentId === undefined ? {} : { parentId },
    ),
  };
}

const band = (): GeoRing => {
  const ring: WorldCoordinate[] = [];
  for (let lon = -180; lon < 179; lon += 30) ring.push(c(lon, -90));
  ring.push(c(179.99, -90), c(179.99, -59));
  for (let lon = 150; lon > -180; lon -= 30) ring.push(c(lon, -59));
  ring.push(c(-180, -59));
  return ring;
};
const childRing: GeoRing = [c(40, -86), c(42, -86), c(42, -84), c(40, -84)];

function project(...items: { feature: LeafFeature; vertices: Vertex[] }[]): DomainProject {
  return {
    histories: items.map((s) => ({
      featureId: s.feature.id,
      series: {
        entries: [
          createAnchorEntry(
            createAnchor(
              deriveAnchorId(s.feature.id, Y0),
              createAnchorSnapshot([s.feature], createVertexStore(s.vertices)),
            ),
            Y0,
            null,
          ),
        ],
      },
    })),
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

describe.each([
  ['(a) 長い辺が残る', false],
  ['(b) 読み直した面積が合わない', true],
] as const)('打ち直しが効かないとき %s', (_name, reportNoLongEdges) => {
  afterEach(() => {
    fakes.reportNoLongEdges = false;
  });

  it('所属変更: 理由が読める文で断る', () => {
    fakes.reportNoLongEdges = reportNoLongEdges;
    const parent = leafOf('P', band());
    const child = leafOf('C', childRing);
    const r = buildAffiliationProposal([parent.feature, child.feature], C, parentExisting(P), {
      idState: createIdGeneratorState(),
      now: () => 1000,
      vertexStore: createVertexStore([...parent.vertices, ...child.vertices]),
    });
    if (r.status === 'proposal') throw new Error('確定してしまった');
    expect(r.kind).toBe('long-edge');
    expect(r.message).toBe(MSG_AFFILIATION_LONG_EDGE);
  });

  it('細分: 確定せず、形の解決の断りで返す', () => {
    fakes.reportNoLongEdges = reportNoLongEdges;
    const parent = leafOf('P', band());
    const child = leafOf('C', childRing, P);
    const r = promoteLeafToAggregate({
      features: [parent.feature, child.feature],
      vertices: createVertexStore([...parent.vertices, ...child.vertices]),
      targetId: P,
      acquiredChildIds: [C],
      idState: createIdGeneratorState(),
      now: () => 1000,
    });
    if (r.status !== PROMOTION_STATUS.Rejected) throw new Error(r.status);
    expect(r.kind).toBe(PROMOTION_REJECT.GeometryUnresolved);
  });

  it('読み込みの修復: 記録を変えない（行は残る）', () => {
    fakes.reportNoLongEdges = reportNoLongEdges;
    const parent = leafOf('P', band());
    const child = leafOf('C', childRing, P);
    const root = project(parent, child);
    const target = checkConsistency(root, CAL).inconsistencies[0]!;
    expect(applyRepair(root, target, REPAIR_OPTION.MaterializeDirectDomain, CAL)).toBe(root);
  });
});
