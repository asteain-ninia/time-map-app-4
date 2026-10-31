// B80: 辺に足した頂点は、押した所が ±360° の複製の上でも、保存する座標は経度 [-180, 180) に畳む。
//
// 確定の関門は押した点の巻きのまま（`session.preview`）で見るので、畳むのは頂点の体だけ。
// 畳んでも形は変わらない: 輪は隣り合う頂点の最短の向きでつなぐので（`unwrapRing`）、
// 538° も 178° も同じ輪になる。期待値は手で組んだ座標。

import { describe, expect, it } from 'vitest';

import { createBasicAttributes, createColorInfo } from '../../domain/attributes';
import { createCoordinate, type WorldCoordinate } from '../../domain/coordinate';
import {
  createLeafFeature,
  createLineFeature,
  createPointFeature,
  FEATURE_KIND,
  type Feature,
} from '../../domain/feature';
import {
  EDIT_TOOL,
  beginDrag,
  updateDrag,
  type DragSession,
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

/** 地物 1 つだけのプロジェクト。 */
function single(feature: Feature, points: readonly (readonly [string, number, number])[]): DomainProject {
  const vertices = points.map((p) => createVertex(asVertexId(p[0]), createCoordinate(p[1], p[2])));
  return {
    histories: [singleAnchorHistory(String(feature.id), [feature], createVertexStore(vertices), 0)],
    settings: DEFAULT_SETTINGS,
    baseMap: DEFAULT_BASEMAP,
  };
}

/** 確定で保存される頂点の体（id → [経度, 緯度]）。 */
function stored(root: DomainProject, session: DragSession): ReadonlyMap<string, readonly [number, number]> {
  const snapshot = buildEditSnapshot({ getRoot: () => root, getTime: () => timePointYear(10) }, session);
  return new Map(snapshot.vertices.map((v) => [String(v.id), [v.coordinate.lon, v.coordinate.lat] as const]));
}

function vertexDrag(
  vertexId: string,
  press: WorldCoordinate,
  at: WorldCoordinate,
  companions?: readonly string[],
): DragSession {
  const target: DragTarget = {
    tool: EDIT_TOOL.VertexMove,
    featureId: asFeatureId('A'),
    vertexId: asVertexId(vertexId),
    ringId: asRingId('r'),
    ...(companions === undefined
      ? {}
      : { companionVertexIds: new Set(companions.map((id) => asVertexId(id))) }),
  };
  return updateDrag(beginDrag(target, press), { preview: at });
}

function featureDrag(press: WorldCoordinate, at: WorldCoordinate): DragSession {
  const target: DragTarget = { tool: EDIT_TOOL.FeatureMove, featureId: asFeatureId('A') };
  return updateDrag(beginDrag(target, press), { preview: at });
}

describe('B113: 頂点のドラッグと面の移動の経度も [-180, 180) で保存する', () => {
  it('頂点を 179° から 181° へ引くと -179° で保存する。動かしていない頂点は入らない', () => {
    const root = project([170, 179, 179, 170]);
    const out = stored(root, vertexDrag('v1', { lon: 179, lat: 0 }, { lon: 181, lat: -1 }));
    expect([...out.entries()]).toEqual([['v1', [-179, -1]]]);
  });

  it('西へ越えても畳む。-179° から -181° は 179°', () => {
    const root = project([-179, -170, -170, -179]);
    const out = stored(root, vertexDrag('v0', { lon: -179, lat: 0 }, { lon: -181, lat: 2 }));
    expect([...out.entries()]).toEqual([['v0', [179, 2]]]);
  });

  it('複製の上で掴んで継ぎ目を越えても同じ（541° は最短の向きで 181° の巻き ＝ -179°）', () => {
    const root = project([170, 179, 179, 170]);
    const out = stored(root, vertexDrag('v1', { lon: 539, lat: 0 }, { lon: 541, lat: -1 }));
    expect([...out.entries()]).toEqual([['v1', [-179, -1]]]);
  });

  it('一緒に動く頂点も畳む（4 度動かすと 178→182 ＝ -178、179→183 ＝ -177）', () => {
    const root = project([170, 179, 178, 170]);
    const out = stored(
      root,
      vertexDrag('v1', { lon: 179, lat: 0 }, { lon: 183, lat: 0 }, ['v2']),
    );
    expect(out.get('v1')).toEqual([-177, 0]);
    expect(out.get('v2')).toEqual([-178, 10]);
  });

  it('面を東へ 5 度動かすと 175→180 は -180、179→184 は -176', () => {
    const root = project([175, 179, 179, 175]);
    const out = stored(root, featureDrag({ lon: 177, lat: 5 }, { lon: 182, lat: 5 }));
    expect(out.get('v0')).toEqual([-180, 0]);
    expect(out.get('v1')).toEqual([-176, 0]);
    expect(out.get('v2')).toEqual([-176, 10]);
    expect(out.get('v3')).toEqual([-180, 10]);
  });

  it('線と点も同じ', () => {
    const line = createLineFeature(
      asFeatureId('A'),
      createBasicAttributes('A', 0, 100),
      COLOR,
      [asVertexId('a'), asVertexId('b')],
    );
    const lineOut = stored(
      single(line, [['a', 175, 0], ['b', 179, 0]]),
      featureDrag({ lon: 177, lat: 0 }, { lon: 180, lat: 0 }),
    );
    expect(lineOut.get('a')).toEqual([178, 0]);
    expect(lineOut.get('b')).toEqual([-178, 0]);

    const point = createPointFeature(
      asFeatureId('A'),
      createBasicAttributes('A', 0, 100),
      COLOR,
      asVertexId('p'),
    );
    const pointOut = stored(
      single(point, [['p', 179, 3]]),
      featureDrag({ lon: 179, lat: 3 }, { lon: 182, lat: 3 }),
    );
    expect(pointOut.get('p')).toEqual([-178, 3]);
  });

  it('範囲の中は畳む計算を通さない（吸着先の座標がビットまで同じ。ちょうど -180° もそのまま）', () => {
    const root = project([170, 174, 174, 170]);
    // 0.1 + 0.2 は足して引くと端数が変わる値。
    const snapped = { lon: 0.1 + 0.2, lat: 0.7 + 0.1 };
    const out = stored(root, vertexDrag('v1', { lon: 174, lat: 0 }, snapped));
    expect(out.get('v1')).toEqual([snapped.lon, snapped.lat]);
    const west = stored(root, vertexDrag('v1', { lon: 174, lat: 0 }, { lon: -180, lat: 1 }));
    expect(west.get('v1')).toEqual([-180, 1]);
  });

  it('畳んでも輪の形は変わらない（連続の経度へ戻すと、動かしたつもりの形と同じ）', () => {
    const root = project([175, 179, 179, 175]);
    const out = stored(root, featureDrag({ lon: 177, lat: 5 }, { lon: 182, lat: 5 }));
    const ring = ['v0', 'v1', 'v2', 'v3'].map((id) => {
      const [lon, lat] = out.get(id)!;
      return createCoordinate(lon, lat);
    });
    const lons = unwrapRingClosed(ring).map((p) => p.lon);
    expect(lons.map((lon) => lon - lons[0]!)).toEqual([0, 4, 4, 0]);
  });
});
