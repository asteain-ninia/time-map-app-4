// 作図中の吸着と FR-29 の **供給元**（`snap-ports.ts`）の単体テスト。
//
// ここが守るのは 3 つ。
//  1. **吸着は「押した位置と同じ周回」の座標を返し、保存する体は元の値を別に運ぶ。**
//     日付変更線をまたいで描いているとき、この 2 つは 360 度ちょうど食い違う。片方に
//     揃えると、①下書きの中に 360 度の飛びが生まれて N-51 が誤爆する（利用者から見れば
//     小さな形なのに「世界を半周以上します」と断られる）か、②同じ id を指す 2 つの地物の
//     体が食い違って読み込みの整合チェックに引っかかる、のどちらかが起きる。
//  2. **吸着の ON/OFF はここ 1 か所で見る**（呼び出し側で二重に判定しない）。
//  3. **FR-29 の「末端地物」は子を持たない leaf**（排他検証と同じ定義。`spatial/terminals.ts`）。
//     子を持つ面は排他検証の対象外なので、その内側でも頂点を置ける。

import { describe, expect, it } from 'vitest';

import { createBasicAttributes, createColorInfo } from '../../domain/attributes';
import { createEditProposal } from '../../domain/consistency/index';
import { applyAddProposal } from '../../domain/editing/apply-proposal';
import {
  createLeafFeature,
  withParentId,
  type Feature,
} from '../../domain/feature';
import { createGeoParams } from '../../domain/geo/geo-params';
import { asFeatureId, asRingId, asVertexId } from '../../domain/ids';
import { createShape, createTerritoryRing } from '../../domain/ring';
import { timePointYear } from '../../domain/time/time-point';
import { createVertex, type Vertex } from '../../domain/vertex';
import type { AddSnapshot } from '../../domain/add/index';
import type { Camera, Viewport } from '../../render';
import { DEFAULT_FILTER_STATE } from '../discovery/index';
import type { DomainRoot } from '../consistency-binding';
import { DEFAULT_DISPLAY_CONTROL } from '../state/session';

import { createAddSnapPorts, type AddSnapContext } from './snap-ports';

const color = createColorInfo(true, '#90caf9', '#ffb300', '#0d47a1');
const time = timePointYear(0);

function emptyProject(): DomainRoot {
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

/** `size` 度四方の正方形の面。左下が (ox, oy)。 */
function squareLeaf(
  idRaw: string,
  vPrefix: string,
  ox: number,
  oy: number,
  size: number,
): { feature: Feature; vertices: Vertex[] } {
  const corners = [
    [0, 0],
    [size, 0],
    [size, size],
    [0, size],
  ];
  const vertices = corners.map((c, i) =>
    createVertex(asVertexId(`${vPrefix}-${i}`), { lon: c[0]! + ox, lat: c[1]! + oy }),
  );
  const ring = createTerritoryRing(
    asRingId(`r-${idRaw}`),
    vertices.map((v) => v.id),
  );
  const feature = createLeafFeature(
    asFeatureId(idRaw),
    createBasicAttributes(idRaw, 0, 0),
    color,
    createShape([ring]),
  );
  return { feature, vertices };
}

function commit(root: DomainRoot, f: { feature: Feature; vertices: Vertex[] }): DomainRoot {
  const snapshot: AddSnapshot = {
    feature: f.feature,
    vertices: f.vertices,
    sharedCandidateIds: new Map(),
  };
  return applyAddProposal(root, createEditProposal(f.feature.id, time, snapshot));
}

function portsFor(
  root: DomainRoot,
  camera: Camera,
  snap = { enabled: true, vertex: true, tolerancePx: 12 },
) {
  const viewport: Viewport = { widthCss: 200, heightCss: 200, devicePixelRatio: 1 };
  const ctx: AddSnapContext = {
    root,
    time,
    displayControl: DEFAULT_DISPLAY_CONTROL,
    filter: DEFAULT_FILTER_STATE,
    snap,
  };
  return createAddSnapPorts({
    readContext: () => ctx,
    readCamera: () => ({ camera, viewport }),
  });
}

describe('createAddSnapPorts — 吸着（FR-31）', () => {
  it('許容内の既存の頂点に当たると、その頂点と持ち主を返す', () => {
    const leaf = squareLeaf('f-a', 'v-a', 0, 0, 4);
    const root = commit(emptyProject(), leaf);
    // 10 px/度・中心 (2,2) の 200×200。(4,4) は画面の (120, 80)。
    const ports = portsFor(root, { centerLon: 2, centerLat: 2, zoom: 10 });
    // 頂点 (4,4) の 0.5 度 ＝ 5px 外を押す。
    const hit = ports.resolveProximity({ lon: 4.5, lat: 4 });
    expect(hit).not.toBeNull();
    expect(hit?.coordinate).toEqual({ lon: 4, lat: 4 });
    expect(hit?.featureId).toBe(asFeatureId('f-a'));
    expect(hit?.vertexId).toBe(asVertexId('v-a-2'));
  });

  it('許容の外なら null（吸着しない）', () => {
    const root = commit(emptyProject(), squareLeaf('f-a', 'v-a', 0, 0, 4));
    const ports = portsFor(root, { centerLon: 2, centerLat: 2, zoom: 10 });
    // 3 度 ＝ 30px 離れている（許容 12px の外）。
    expect(ports.resolveProximity({ lon: 7, lat: 4 })).toBeNull();
  });

  it('吸着を切ってあれば、当たる場所でも null（判定はここ 1 か所）', () => {
    const root = commit(emptyProject(), squareLeaf('f-a', 'v-a', 0, 0, 4));
    const off = portsFor(root, { centerLon: 2, centerLat: 2, zoom: 10 }, {
      enabled: false,
      vertex: true,
      tolerancePx: 12,
    });
    expect(off.resolveProximity({ lon: 4.5, lat: 4 })).toBeNull();
    const noVertex = portsFor(root, { centerLon: 2, centerLat: 2, zoom: 10 }, {
      enabled: true,
      vertex: false,
      tolerancePx: 12,
    });
    expect(noVertex.resolveProximity({ lon: 4.5, lat: 4 })).toBeNull();
  });

  it('許容 px を狭めると、同じクリックで吸着しなくなる', () => {
    const root = commit(emptyProject(), squareLeaf('f-a', 'v-a', 0, 0, 4));
    const wide = portsFor(root, { centerLon: 2, centerLat: 2, zoom: 10 });
    const narrow = portsFor(root, { centerLon: 2, centerLat: 2, zoom: 10 }, {
      enabled: true,
      vertex: true,
      tolerancePx: 2,
    });
    expect(wide.resolveProximity({ lon: 4.5, lat: 4 })).not.toBeNull();
    expect(narrow.resolveProximity({ lon: 4.5, lat: 4 })).toBeNull();
  });

  it('**日付変更線の向こうで描いているときは、押した位置と同じ周回へ寄せて返す**', () => {
    // 保存されている頂点の 1 つは lon = -173。地図は **1 周回東**の 187 度あたりを
    // 見ている（＝ 日付変更線の向こうへパンして描いている状態）。
    const leaf = squareLeaf('f-a', 'v-a', -177, 0, 4);
    const root = commit(emptyProject(), leaf);
    const ports = portsFor(root, { centerLon: 187, centerLat: 2, zoom: 10 });
    // -173 の複製は 187 に描かれている。その 0.5 度（5px）外を押す。
    const hit = ports.resolveProximity({ lon: 186.5, lat: 4 });
    expect(hit).not.toBeNull();
    // 下書きへ入れる座標は **押した位置と同じ周回**（187）。ここを元の値のままにすると、
    // 隣の頂点との経度差が 360 度近くになり、N-51 が誤爆する。
    expect(hit?.coordinate.lon).toBeCloseTo(187, 6);
    // 保存する体は **元の値**（-173）。共有頂点は同じ id を 2 つの地物が指すので、
    // 体が食い違ってはいけない。
    expect(hit?.bodyCoordinate.lon).toBeCloseTo(-173, 6);
    // 2 つはちょうど 1 周回ぶん違う。
    expect(hit!.coordinate.lon - hit!.bodyCoordinate.lon).toBeCloseTo(360, 6);
  });

  it('同じ周回で描いているときは、2 つの座標が一致する（普通の場合は何も変わらない）', () => {
    const root = commit(emptyProject(), squareLeaf('f-a', 'v-a', 0, 0, 4));
    const ports = portsFor(root, { centerLon: 2, centerLat: 2, zoom: 10 });
    const hit = ports.resolveProximity({ lon: 4.5, lat: 4 });
    expect(hit?.coordinate).toEqual(hit?.bodyCoordinate);
  });

  it('地図がまだ載っていなければ null（画面上の距離が定義できない）', () => {
    const root = commit(emptyProject(), squareLeaf('f-a', 'v-a', 0, 0, 4));
    const ports = createAddSnapPorts({
      readContext: () => ({
        root,
        time,
        displayControl: DEFAULT_DISPLAY_CONTROL,
        filter: DEFAULT_FILTER_STATE,
        snap: { enabled: true, vertex: true, tolerancePx: 12 },
      }),
      readCamera: () => null,
    });
    expect(ports.resolveProximity({ lon: 4, lat: 4 })).toBeNull();
  });
});

describe('createAddSnapPorts — FR-29 の末端判定', () => {
  it('子を持たない面の内側は「末端の内側」', () => {
    const root = commit(emptyProject(), squareLeaf('f-a', 'v-a', 0, 0, 4));
    const ports = portsFor(root, { centerLon: 2, centerLat: 2, zoom: 10 });
    const hit = ports.terminalAt({ lon: 2, lat: 2 });
    expect(hit?.featureId).toBe(asFeatureId('f-a'));
    expect(hit?.name).toBe('f-a');
    expect(hit?.onBoundary).toBe(false);
  });

  it('境界の上は「内側」ではなく「線の上」として返る（増分 3 の手直し B1）', () => {
    // 初版はここで null を返していた。断らない点は同じだが、**入れ子の見分けに使えない**
    // ので、親の角へ吸着した瞬間に入れ子と認められなくなっていた（打つ順で結果が変わる）。
    const root = commit(emptyProject(), squareLeaf('f-a', 'v-a', 0, 0, 4));
    const ports = portsFor(root, { centerLon: 2, centerLat: 2, zoom: 10 });
    const hit = ports.terminalAt({ lon: 0, lat: 0 });
    expect(hit?.featureId).toBe(asFeatureId('f-a'));
    expect(hit?.onBoundary).toBe(true);
  });

  it('どの面にも触れていない場所は null', () => {
    const root = commit(emptyProject(), squareLeaf('f-a', 'v-a', 0, 0, 4));
    const ports = portsFor(root, { centerLon: 2, centerLat: 2, zoom: 10 });
    expect(ports.terminalAt({ lon: 50, lat: 50 })).toBeNull();
  });

  it('**子を持つ面の内側は塞がない**（排他検証と同じ定義＝子を持たない leaf）', () => {
    const parent = squareLeaf('f-parent', 'v-p', 0, 0, 10);
    let root = commit(emptyProject(), parent);
    const childBase = squareLeaf('f-child', 'v-c', 2, 2, 2);
    const child = {
      feature: withParentId(childBase.feature, asFeatureId('f-parent')),
      vertices: childBase.vertices,
    };
    root = commit(root, child);
    const ports = portsFor(root, { centerLon: 5, centerLat: 5, zoom: 10 });
    // 親の内側だが子の外側の点。親は子を持つので末端ではない ⇒ 塞がない。
    expect(ports.terminalAt({ lon: 8, lat: 8 })).toBeNull();
    // 子そのものの内側は末端なので塞ぐ。
    expect(ports.terminalAt({ lon: 3, lat: 3 })?.featureId).toBe(asFeatureId('f-child'));
  });

  it('どの面の内側でもなければ null', () => {
    const root = commit(emptyProject(), squareLeaf('f-a', 'v-a', 0, 0, 4));
    const ports = portsFor(root, { centerLon: 2, centerLat: 2, zoom: 10 });
    expect(ports.terminalAt({ lon: 50, lat: 50 })).toBeNull();
  });
});
