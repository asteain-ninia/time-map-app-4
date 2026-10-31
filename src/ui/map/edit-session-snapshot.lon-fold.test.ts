// B80: 辺に足した頂点は、押した所が ±360° の複製の上でも、保存する座標は経度 [-180, 180) に畳む。
//
// 確定の関門は押した点の巻きのまま（`session.preview`）で見るので、畳むのは頂点の体だけ。
// 畳んでも形は変わらない: 輪は隣り合う頂点の最短の向きでつなぐので（`unwrapRing`）、
// 538° も 178° も同じ輪になる。期待値は手で組んだ座標。

import { describe, expect, it } from 'vitest';

import { createBasicAttributes, createColorInfo } from '../../domain/attributes';
import { createCoordinate, type WorldCoordinate } from '../../domain/coordinate';
import { createLeafFeature, FEATURE_KIND } from '../../domain/feature';
import {
  EDIT_TOOL,
  beginDrag,
  updateDrag,
  type DragTarget,
} from '../../domain/editing/drag-session';
import { unwrapRingClosed } from '../../domain/geo/seam';
import { asFeatureId, asRingId, asVertexId } from '../../domain/ids';
import { DEFAULT_BASEMAP, DEFAULT_SETTINGS, singleAnchorHistory } from '../../domain/persistence/fixtures';
import type { DomainProject } from '../../domain/persistence/index';
import { createShape, createTerritoryRing } from '../../domain/ring';
import { timePointYear } from '../../domain/time/time-point';
import { createVertex, createVertexStore } from '../../domain/vertex';

import { buildEditSnapshot } from './edit-session-snapshot';

const COLOR = createColorInfo(true, '#102030', '#405060', '#708090', 'default', 1, 1);

/** 経度 lons の並びの四角形（緯度は 0, 0, 10, 10）。辺 0→1 が南の辺。 */
function project(lons: readonly [number, number, number, number]): DomainProject {
  const lats = [0, 0, 10, 10];
  const vertices = lons.map((lon, i) => createVertex(asVertexId(`v${String(i)}`), createCoordinate(lon, lats[i]!)));
  const feature = createLeafFeature(
    asFeatureId('A'),
    createBasicAttributes('A', 0, 100),
    COLOR,
    createShape([createTerritoryRing(asRingId('r'), vertices.map((v) => v.id))]),
  );
  return {
    histories: [singleAnchorHistory('A', [feature], createVertexStore(vertices), 0)],
    settings: DEFAULT_SETTINGS,
    baseMap: DEFAULT_BASEMAP,
  };
}

function storedAfterAdd(root: DomainProject, press: WorldCoordinate, at: WorldCoordinate): WorldCoordinate {
  const target: DragTarget = {
    tool: EDIT_TOOL.EdgeAdd,
    featureId: asFeatureId('A'),
    startVertexId: asVertexId('v0'),
    endVertexId: asVertexId('v1'),
    ringId: asRingId('r'),
    newVertexId: asVertexId('new'),
  };
  const session = updateDrag(beginDrag(target, press), { preview: at });
  const snapshot = buildEditSnapshot(
    { getRoot: () => root, getTime: () => timePointYear(10) },
    session,
  );
  expect(snapshot.feature?.kind).toBe(FEATURE_KIND.Leaf);
  expect(snapshot.vertices.map((v) => v.id)).toEqual([asVertexId('new')]);
  return snapshot.vertices[0]!.coordinate;
}

describe('B80: 辺に足した頂点の経度は [-180, 180) で保存する', () => {
  it('東へ 1 周した複製の上（538°）で足すと 178° で保存する', () => {
    const root = project([170, 174, 174, 170]);
    expect(storedAfterAdd(root, { lon: 532, lat: 0 }, { lon: 532, lat: 0 })).toEqual({ lon: 172, lat: 0 });
    expect(storedAfterAdd(root, { lon: 532, lat: 0 }, { lon: 538, lat: -2 })).toEqual({ lon: 178, lat: -2 });
  });

  it('西へ 1 周した複製の上で足しても同じ。経度の小さい側も畳む', () => {
    const root = project([0, 10, 10, 0]);
    expect(storedAfterAdd(root, { lon: -355, lat: 0 }, { lon: -355, lat: -1 })).toEqual({ lon: 5, lat: -1 });
    const west = project([-175, -170, -170, -175]);
    expect(storedAfterAdd(west, { lon: -532, lat: 0 }, { lon: -532, lat: -1 })).toEqual({ lon: -172, lat: -1 });
  });

  it('継ぎ目をまたぐ辺でも畳む（ちょうど 180° は -180°、180.5° は -179.5°）', () => {
    const root = project([179, -179, -179, 179]);
    expect(storedAfterAdd(root, { lon: 180, lat: 0 }, { lon: 180, lat: 0 })).toEqual({ lon: -180, lat: 0 });
    expect(storedAfterAdd(root, { lon: 180, lat: 0 }, { lon: 180.5, lat: -1 })).toEqual({ lon: -179.5, lat: -1 });
  });

  it('本来の巻きの中で足した座標はそのまま（小数の端数も変えない）', () => {
    const root = project([1, 2, 2, 1]);
    expect(storedAfterAdd(root, { lon: 1.5, lat: 0 }, { lon: 1.1234567, lat: -0.5 })).toEqual({
      lon: 1.1234567,
      lat: -0.5,
    });
  });

  it('畳んでも輪の形は変わらない（連続の経度へ戻すと、複製の上で足したつもりの形と同じ）', () => {
    // 四角 170〜174 の南の辺に、複製の上で (538, -2)＝本来の (178, -2) を足す。
    const stored = storedAfterAdd(project([170, 174, 174, 170]), { lon: 532, lat: 0 }, { lon: 538, lat: -2 });
    const ring = unwrapRingClosed([
      createCoordinate(170, 0),
      createCoordinate(stored.lon, stored.lat),
      createCoordinate(174, 0),
      createCoordinate(174, 10),
      createCoordinate(170, 10),
    ]);
    const asPressed = unwrapRingClosed([
      createCoordinate(170, 0),
      createCoordinate(538, -2),
      createCoordinate(174, 0),
      createCoordinate(174, 10),
      createCoordinate(170, 10),
    ]);
    expect(ring.map((p) => p.lon)).toEqual([170, 178, 174, 174, 170]);
    expect(asPressed.map((p) => p.lon)).toEqual(ring.map((p) => p.lon));
  });
});
