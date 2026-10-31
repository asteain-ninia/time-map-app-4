// leafReport の単体テスト（教訓 5.41: E2E からしか触れない観測は純関数にして単体で守る）。

import { describe, expect, it } from 'vitest';

import { createBasicAttributes, createColorInfo } from '../../domain/attributes';
import { applyAddProposal } from '../../domain/editing/apply-proposal';
import { createLeafFeature } from '../../domain/feature';
import { createGeoParams } from '../../domain/geo/geo-params';
import { asFeatureId, asRingId, asVertexId } from '../../domain/ids';
import type { DomainProject } from '../../domain/persistence/serialize';
import { createShape, createTerritoryRing } from '../../domain/ring';
import { timePointYear } from '../../domain/time/time-point';
import { createVertex } from '../../domain/vertex';

import { leafReport } from './leaf-report';

const color = createColorInfo(true, '#112233', '#ffb300', '#0d47a1');

function project(): DomainProject {
  return {
    histories: [],
    settings: {
      calendarId: 'gregorian',
      geo: createGeoParams(40075, 0),
      gridSpacingDeg: 10,
      snapDistancePx: 8,
      autoColorDefault: true,
    },
    baseMap: { source: 's', meta: { lonWest: -180, lonEast: 180, latNorth: 90, latSouth: -90 } },
  };
}

function addSquare(
  root: DomainProject,
  id: string,
  name: string,
  x0: number,
  x1: number,
): DomainProject {
  const vs = [
    createVertex(asVertexId(`${id}-0`), { lon: x0, lat: 0 }),
    createVertex(asVertexId(`${id}-1`), { lon: x1, lat: 0 }),
    createVertex(asVertexId(`${id}-2`), { lon: x1, lat: 1 }),
    createVertex(asVertexId(`${id}-3`), { lon: x0, lat: 1 }),
  ];
  const feature = createLeafFeature(
    asFeatureId(id),
    createBasicAttributes(name, 0, 0),
    color,
    createShape([createTerritoryRing(asRingId(`r-${id}`), vs.map((v) => v.id))]),
    { kindLabel: '国' },
  );
  return applyAddProposal(root, {
    featureId: asFeatureId(id),
    anchorTime: timePointYear(1000),
    snapshot: { feature, vertices: vs, sharedCandidateIds: new Map() },
  });
}

describe('leafReport — E2E が表示と独立に地物を読む口', () => {
  it('id と名前で地物を選び、素性・錨列・面積・重なり・点の持ち主を返す', () => {
    let root = addSquare(project(), 'a', '西', 0, 1);
    root = addSquare(root, 'b', '東', 1, 2);
    root = addSquare(root, 'c', '重なる', 1.5, 2.5);
    const at = timePointYear(1000);

    const apart = leafReport(root, at, {
      ids: ['a'],
      names: ['東'],
      probes: [
        { lon: 0.5, lat: 0.5 },
        { lon: 1.5, lat: 0.5 },
        { lon: 5, lat: 5 },
      ],
    });
    expect(apart.entries.map((e) => e.id).sort()).toEqual(['a', 'b']);
    const a = apart.entries.find((e) => e.id === 'a')!;
    expect(a.name).toBe('西');
    expect(a.kindLabel).toBe('国');
    expect(a.color).toEqual(color);
    expect(a.anchorStartYears).toEqual([1000]);
    expect(a.polygonCount).toBe(1);
    expect(a.areaKm2).toBeGreaterThan(0);
    // 隣り合うだけ（辺を接する）なら重なりは 0。
    expect(apart.maxPairOverlapKm2).toBe(0);
    expect(apart.totalAreaKm2).toBeCloseTo(a.areaKm2! * 2, 3);
    expect(apart.probeOwners).toEqual(['a', 'b', null]);

    // 重なる地物を混ぜると、重なりの面積が出る（東と半分重なる）。
    const overlapping = leafReport(root, at, { names: ['東', '重なる'] });
    expect(overlapping.maxPairOverlapKm2).toBeGreaterThan(a.areaKm2! * 0.4);
  });

  it('当たらない問い合わせは空を返す（何も変えない）', () => {
    const root = addSquare(project(), 'a', '西', 0, 1);
    const report = leafReport(root, timePointYear(1000), {});
    expect(report.entries).toEqual([]);
    expect(report.totalAreaKm2).toBe(0);
    expect(report.probeOwners).toEqual([]);
  });

  it('継ぎ目をまたぐ面の内側を、保存された座標のまま読み違えない（B90）', () => {
    const root = addSquare(project(), 'a', 'またぐ', 170, -170);
    const r = leafReport(root, timePointYear(1000), {
      ids: ['a'],
      probes: [
        { lon: 175, lat: 0.5 },
        { lon: -175, lat: 0.5 },
        { lon: 0, lat: 0.5 },
      ],
    });
    expect(r.probeOwners).toEqual(['a', 'a', null]);
  });

  it('継ぎ目をまたいで重なる 2 つの面の重なりを測る（B90）', () => {
    let root = addSquare(project(), 'a', 'A', 170, -170);
    root = addSquare(root, 'b', 'B', 175, -175);
    const r = leafReport(root, timePointYear(1000), { ids: ['a', 'b'] });
    expect(r.entries.map((e) => e.id).sort()).toEqual(['a', 'b']);
    const inner = r.entries.find((e) => e.id === 'b');
    expect(r.maxPairOverlapKm2).toBeCloseTo(inner?.areaKm2 ?? -1, 3);
  });
});
