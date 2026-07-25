// N725-9 集合デルタ拘束 — 随伴頂点にも FR-28 排他 / FR-89 親領域包含を効かせる.
//
// WHAT THIS FIXES (edit-session-adapter.applyMove の KNOWN GAP, FR-80 fix-forward review
// HIGH): 近傍クエリと `constrainSlide` は掴んだ主頂点 1 点しか見ないので、N 頂点ドラッグの
// 残り N−1 頂点は FR-28 衝突判定も FR-89 親領域判定も一切通らずコミットされていた。実 UI で
// 「2 頂点選択 → v0 を掴んで東へドラッグ → v1 が隣の末端の内部に入る」が再現する。FR-28 /
// FR-89 は must 要件であり、live edit binding の `detectSpatial` は `() => []` なので後段でも
// 拾われない。
//
// 裁定 (N725-9 / N725-10, 2026-07-25): 「方向は主頂点、量は集合の交叉」。主頂点は今日どおり
// constrainSlide + decideSnap して実変位 d を決め、随伴は d の**スカラー縮小**のみを要求できる
// (別ベクトルにはできない = FR-80「同一ベクトル」を literal に保つ)。s* = min over 全移動頂点 of
// max{s∈[0,1] : p_i + s·d が許容集合 A_i に入る}。A_i は原点星型なので光線への制限は区間 [0,t_i]
// になり、交叉は min で閉じる。
//
// このファイルは ADR の再現手順をそのまま RED にする: 障害物を**随伴頂点の側にだけ**置き、
// 主頂点のクエリ矩形の外に出す。したがって主頂点の近傍集合は空のまま = 今日の実装では素通り。

import { describe, expect, it, vi } from 'vitest';

import {
  EDIT_TOOL,
  RELEASE_OUTCOME,
  beginDrag,
  constrainSetSlide,
  type DragSession,
} from '../../domain/editing';
import { PROCESS_STATUS } from '../../domain/consistency';
import {
  EMPTY_SELECTION,
  replaceVertices,
  vertexHit,
  type HitResult,
  type SelectionState,
} from '../../domain/selection';
import { asFeatureId, asRingId, asVertexId } from '../../domain/ids';
import { createCoordinate, type WorldCoordinate } from '../../domain/coordinate';
import { createVertex, createVertexStore, getVertex } from '../../domain/vertex';
import { createLeafFeature, createPointFeature } from '../../domain/feature';
import { createBasicAttributes, createColorInfo } from '../../domain/attributes';
import { createHoleRing, createShape, createTerritoryRing } from '../../domain/ring';
import { POINT_LOCATION, pointInPolygon } from '../../domain/geometry/predicates';
import type { GeoPolygon } from '../../domain/geometry/types';
import { SpatialIndex } from '../../domain/spatial/rtree';
import {
  DEFAULT_BASEMAP,
  DEFAULT_SETTINGS,
  singleAnchorHistory,
} from '../../domain/persistence/fixtures';
import type { DomainProject } from '../../domain/persistence/index';
import { timePointYear } from '../../domain/time/time-point';
import type { ScreenPoint } from '../../render';
import { verticesAt } from '../live-lookup';
import { createLiveEditBinding } from '../consistency-binding';
import { createEditSessionPort } from './edit-session-adapter';
import { NO_MODIFIERS } from './ports';
import { buildEditSnapshot, ringIdForLeafVertex } from './edit-session-snapshot';
import { createNeighboursQuery } from './slide-snap-neighbours';

const TIME = timePointYear(0);
const COLOR = createColorInfo(true, '#102030', '#405060', '#708090');

const LEAF_A = asFeatureId('leaf-a');
const RING_A = asRingId('leaf-a-r');
const OBS = asFeatureId('leaf-obs');
const RING_OBS = asRingId('leaf-obs-r');

const A_BL = asVertexId('a-bl'); // (0,0)
const A_BR = asVertexId('a-br'); // (10,0)   ← 主頂点 (掴む)
const A_TR = asVertexId('a-tr'); // (10,10)  ← 随伴頂点 (障害物へ突っ込む)
const A_TL = asVertexId('a-tl'); // (0,10)

/**
 * 主頂点 A_BR(10,0) と随伴 A_TR(10,10) を持つ正方形 leaf-a と、**随伴頂点の東側にだけ**ある
 * 静止末端 leaf-obs (11,9)-(13,11)。
 *
 *                       +----+  leaf-obs (11,9)-(13,11)
 *   (0,10) A_TL   A_TR(10,10)|    |
 *      +------------+     +----+
 *      |   leaf-a   |
 *      +------------+
 *   (0,0) A_BL    A_BR(10,0)
 *
 * 主頂点を東へ +2 動かすと随伴が (12,10) = leaf-obs の内部へ入る。主頂点の到達点 (12,0) を
 * 中心にした近傍クエリ矩形 (margin 8 ⇒ lat −8..8) は leaf-obs の bbox (lat 9..11) に届かない
 * ので、今日の実装は障害物の存在すら知らない。
 */
function companionObstacleProject(): DomainProject {
  const vs = [
    createVertex(A_BL, createCoordinate(0, 0)),
    createVertex(A_BR, createCoordinate(10, 0)),
    createVertex(A_TR, createCoordinate(10, 10)),
    createVertex(A_TL, createCoordinate(0, 10)),
    createVertex(asVertexId('o-bl'), createCoordinate(11, 9)),
    createVertex(asVertexId('o-br'), createCoordinate(13, 9)),
    createVertex(asVertexId('o-tr'), createCoordinate(13, 11)),
    createVertex(asVertexId('o-tl'), createCoordinate(11, 11)),
  ];
  const a = createLeafFeature(
    LEAF_A,
    createBasicAttributes('A国', 0, 100),
    COLOR,
    createShape([createTerritoryRing(RING_A, [A_BL, A_BR, A_TR, A_TL])]),
  );
  const obs = createLeafFeature(
    OBS,
    createBasicAttributes('障害国', 0, 100),
    COLOR,
    createShape([
      createTerritoryRing(RING_OBS, [
        asVertexId('o-bl'),
        asVertexId('o-br'),
        asVertexId('o-tr'),
        asVertexId('o-tl'),
      ]),
    ]),
  );
  return {
    histories: [singleAnchorHistory('leaf-a', [a, obs], createVertexStore(vs), 0)],
    settings: DEFAULT_SETTINGS,
    baseMap: DEFAULT_BASEMAP,
  };
}

const OBSTACLE_POLYGON: GeoPolygon = [
  [
    createCoordinate(11, 9),
    createCoordinate(13, 9),
    createCoordinate(13, 11),
    createCoordinate(11, 11),
  ],
];

// --- FR-89 fixture: 穴リング頂点の随伴が親領域から出る配置 -------------------

const HOLED = asFeatureId('holed');
const OUTER_RING = asRingId('holed-outer');
const HOLE_RING = asRingId('holed-hole');
const O_BL = asVertexId('o2-bl'); // (0,0)
const O_BR = asVertexId('o2-br'); // (30,0)
const O_TR = asVertexId('o2-tr'); // (30,30)
const O_TL = asVertexId('o2-tl'); // (0,30)
const H_BL = asVertexId('h-bl'); // (10,10)  ← 主頂点
const H_BR = asVertexId('h-br'); // (28,10)  ← 随伴 (東へ動くと外周 lon=30 を越える)
const H_TR = asVertexId('h-tr'); // (28,20)
const H_TL = asVertexId('h-tl'); // (10,20)

const OUTER_POLYGON: GeoPolygon = [
  [
    createCoordinate(0, 0),
    createCoordinate(30, 0),
    createCoordinate(30, 30),
    createCoordinate(0, 30),
  ],
];

function holedNearEdgeProject(): DomainProject {
  const vs = [
    createVertex(O_BL, createCoordinate(0, 0)),
    createVertex(O_BR, createCoordinate(30, 0)),
    createVertex(O_TR, createCoordinate(30, 30)),
    createVertex(O_TL, createCoordinate(0, 30)),
    createVertex(H_BL, createCoordinate(10, 10)),
    createVertex(H_BR, createCoordinate(28, 10)),
    createVertex(H_TR, createCoordinate(28, 20)),
    createVertex(H_TL, createCoordinate(10, 20)),
  ];
  const feature = createLeafFeature(
    HOLED,
    createBasicAttributes('穴あき国', 0, 100),
    COLOR,
    createShape([
      createTerritoryRing(OUTER_RING, [O_BL, O_BR, O_TR, O_TL]),
      createHoleRing(HOLE_RING, [H_BL, H_BR, H_TR, H_TL], OUTER_RING),
    ]),
  );
  return {
    histories: [singleAnchorHistory('holed', [feature], createVertexStore(vs), 0)],
    settings: DEFAULT_SETTINGS,
    baseMap: DEFAULT_BASEMAP,
  };
}

// --- LIVE harness: 実 createNeighboursQuery を注入 (スタブではない) ----------

interface LiveHarness {
  readonly port: ReturnType<typeof createEditSessionPort<DomainProject>>;
  readonly previews: (DragSession | null)[];
  readonly committed: () => DomainProject;
  readonly commandCount: () => number;
}

function liveHarness(
  initial: DomainProject,
  selection: SelectionState,
  margin = 8,
  snapDistancePx = 5,
): LiveHarness {
  let root = initial;
  let commands = 0;
  const previews: (DragSession | null)[] = [];
  const binding = createLiveEditBinding({ getRoot: () => root });
  const ctx = { getRoot: () => root, getTime: () => TIME };
  const query = createNeighboursQuery({
    getRoot: () => root,
    getTime: () => TIME,
    snapWorldMargin: () => margin,
  });
  const port = createEditSessionPort<DomainProject>({
    screenToWorld: (p: ScreenPoint) => createCoordinate(p.x, p.y),
    ringIdForVertex: (hit) => ringIdForLeafVertex(ctx, hit.featureId, hit.vertexId),
    vertexSelection: () => selection,
    anchorTime: () => TIME,
    currentState: () => root,
    ports: binding.ports,
    buildSnapshot: (session) => buildEditSnapshot(ctx, session),
    onReleased: (outcome) => {
      if (outcome.kind !== RELEASE_OUTCOME.Processed) return;
      if (outcome.result.status !== PROCESS_STATUS.Committed) return;
      commands += 1;
      root = outcome.result.state;
    },
    onPreview: (session) => previews.push(session),
    worldToScreen: (world) => ({ x: world.lon, y: world.lat }),
    snapDistancePx: () => snapDistancePx,
    neighboursAt: (preview, session) => query(preview, session),
  });
  return { port, previews, committed: () => root, commandCount: () => commands };
}

function coordOf(root: DomainProject, id: ReturnType<typeof asVertexId>): WorldCoordinate {
  const v = getVertex(verticesAt(root, TIME), id);
  expect(v).toBeDefined();
  return v!.coordinate;
}

function grab(featureId: ReturnType<typeof asFeatureId>, id: ReturnType<typeof asVertexId>): HitResult {
  return vertexHit(featureId, id);
}

function selectionOf(
  featureId: ReturnType<typeof asFeatureId>,
  ...ids: readonly ReturnType<typeof asVertexId>[]
): SelectionState {
  return replaceVertices(EMPTY_SELECTION, featureId, new Set(ids));
}

// ---------------------------------------------------------------------------
// 1. ADR 再現 — 近傍クエリ層 (RED-1)
// ---------------------------------------------------------------------------

describe('近傍クエリは随伴頂点まわりの障害物も返す (N725-9)', () => {
  it('随伴頂点の掃過範囲にある静止末端の辺・候補が movingSet に載る', () => {
    const root = companionObstacleProject();
    const query = createNeighboursQuery({
      getRoot: () => root,
      getTime: () => TIME,
      snapWorldMargin: () => 8,
    });
    const session = beginDrag(
      {
        tool: EDIT_TOOL.VertexMove,
        featureId: LEAF_A,
        vertexId: A_BR,
        ringId: RING_A,
        companionVertexIds: new Set([A_TR]),
      },
      { lon: 10, lat: 0 },
    );
    const neighbours = query(createCoordinate(12, 0), session);

    // 主頂点側は今日どおり何も見えない (障害物はクエリ矩形の外) — これが GAP の前提。
    expect(neighbours.edges).toEqual([]);
    expect(neighbours.candidates).toEqual([]);

    // 随伴側は障害物を見る。
    const companions = neighbours.movingSet?.companions ?? [];
    expect(companions).toHaveLength(1);
    const companion = companions[0]!;
    expect(companion.vertexId).toBe(A_TR as unknown as string);
    expect(companion.from).toEqual(createCoordinate(10, 10));
    expect(companion.candidates.map((c) => c.featureId)).toContain(OBS as unknown as string);
    expect(companion.edges.length).toBeGreaterThan(0);
    expect(neighbours.movingSet?.primaryFrom).toEqual(createCoordinate(10, 0));
  });

  it('随伴なしのドラッグでは movingSet を組まない (単一頂点経路は無改変)', () => {
    const root = companionObstacleProject();
    const query = createNeighboursQuery({
      getRoot: () => root,
      getTime: () => TIME,
      snapWorldMargin: () => 8,
    });
    const single = beginDrag(
      { tool: EDIT_TOOL.VertexMove, featureId: LEAF_A, vertexId: A_BR, ringId: RING_A },
      { lon: 10, lat: 0 },
    );
    expect(query(createCoordinate(12, 0), single).movingSet).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 1b. 必須2 [MED-3] — ±360 シーム whole-turn で随伴の掃過箱が潰れない
// ---------------------------------------------------------------------------

describe('必須2 whole-turn ドラッグでも随伴の掃過箱が実掃過距離で組まれる (reachBox)', () => {
  // 主頂点 (179.9,0) を掴んで (−179.9,0) へ = 最短 +0.2° だが生 Δlon = −359.8°。
  // `constrainSlide` は経度ラップを持たないので実際の掃過は生距離。随伴の掃過箱を最短デルタ
  // (0.2°) で組むと、随伴が実際に掃きうる範囲の障害物を取りこぼす。生距離 (359.8°) で組めば拾う。
  function wholeTurnProject(): DomainProject {
    const vs = [
      createVertex(asVertexId('wp0'), createCoordinate(179.9, 0)), // 主頂点
      createVertex(asVertexId('wp1'), createCoordinate(179.9, 5)), // 随伴
      createVertex(asVertexId('wp2'), createCoordinate(178, 2)),
      // 随伴の西 4.9° にだけ障害物 (最短デルタ箱 0.2° の外・生距離箱 359.8° の内)。
      createVertex(asVertexId('wo-0'), createCoordinate(175, 4)),
      createVertex(asVertexId('wo-1'), createCoordinate(177, 4)),
      createVertex(asVertexId('wo-2'), createCoordinate(177, 6)),
      createVertex(asVertexId('wo-3'), createCoordinate(175, 6)),
    ];
    const wt = createLeafFeature(
      asFeatureId('wt'),
      createBasicAttributes('WT', 0, 100),
      COLOR,
      createShape([
        createTerritoryRing(asRingId('wt-r'), [
          asVertexId('wp0'),
          asVertexId('wp1'),
          asVertexId('wp2'),
        ]),
      ]),
    );
    const wobs = createLeafFeature(
      asFeatureId('wobs'),
      createBasicAttributes('WOBS', 0, 100),
      COLOR,
      createShape([
        createTerritoryRing(asRingId('wobs-r'), [
          asVertexId('wo-0'),
          asVertexId('wo-1'),
          asVertexId('wo-2'),
          asVertexId('wo-3'),
        ]),
      ]),
    );
    return {
      histories: [singleAnchorHistory('wt', [wt, wobs], createVertexStore(vs), 0)],
      settings: DEFAULT_SETTINGS,
      baseMap: DEFAULT_BASEMAP,
    };
  }

  it('随伴の掃過箱が生の掃過距離で組まれ、最短デルタの外にある障害物も拾う', () => {
    const root = wholeTurnProject();
    const query = createNeighboursQuery({
      getRoot: () => root,
      getTime: () => TIME,
      snapWorldMargin: () => 1,
    });
    const session = beginDrag(
      {
        tool: EDIT_TOOL.VertexMove,
        featureId: asFeatureId('wt'),
        vertexId: asVertexId('wp0'),
        ringId: asRingId('wt-r'),
        companionVertexIds: new Set([asVertexId('wp1')]),
      },
      { lon: 179.9, lat: 0 },
    );
    // preview = −179.9 (生 Δlon = −359.8, 最短 +0.2)。
    const neighbours = query(createCoordinate(-179.9, 0), session);
    const companion = neighbours.movingSet!.companions.find((c) => c.vertexId === 'wp1')!;
    // 旧: 最短デルタ 0.2° の箱では障害物 (西 4.9°) を取りこぼす (RED)。
    // 新: 生距離 359.8° の箱なら拾う。
    expect(companion.candidates.map((c) => c.featureId)).toContain('wobs');
  });
});

// ---------------------------------------------------------------------------
// 2. ADR 再現 — ライブ経路 end-to-end (RED-2)
// ---------------------------------------------------------------------------

describe('FR-28: 随伴頂点が隣接末端の内部にコミットされない (N725-9 ADR 再現)', () => {
  it('2 頂点選択で主頂点を東へドラッグしても随伴が障害物の内部に入らない', () => {
    const h = liveHarness(companionObstacleProject(), selectionOf(LEAF_A, A_BR, A_TR));
    h.port.begin(grab(LEAF_A, A_BR), { x: 10, y: 0 }, NO_MODIFIERS);
    h.port.update({ x: 12, y: 0 });
    h.port.release({ x: 12, y: 0 }, true);

    const after = h.committed();
    expect(pointInPolygon(coordOf(after, A_TR), OBSTACLE_POLYGON)).not.toBe(
      POINT_LOCATION.Inside,
    );
  });

  it('集合デルタは障害物に接するところまで — 主頂点も同じスカラーで縮む (同一ベクトル維持)', () => {
    const h = liveHarness(companionObstacleProject(), selectionOf(LEAF_A, A_BR, A_TR));
    h.port.begin(grab(LEAF_A, A_BR), { x: 10, y: 0 }, NO_MODIFIERS);
    h.port.update({ x: 12, y: 0 });
    h.port.release({ x: 12, y: 0 }, true);

    const after = h.committed();
    const primary = coordOf(after, A_BR);
    const companion = coordOf(after, A_TR);
    // 障害物左辺 lon=11 で止まる ⇒ デルタ (+2,0) が (+1,0) に縮む。
    expect(primary.lon).toBeCloseTo(11, 7);
    expect(primary.lat).toBeCloseTo(0, 7);
    expect(companion.lon).toBeCloseTo(11, 7);
    expect(companion.lat).toBeCloseTo(10, 7);
    // 剛体性: 両者の変位は同一ベクトル。
    expect(primary.lon - 10).toBeCloseTo(companion.lon - 10, 12);
    expect(primary.lat - 0).toBeCloseTo(companion.lat - 10, 12);
    // 1 ドラッグ = 1 コマンド (FR-80「単一の編集操作」) は維持。
    expect(h.commandCount()).toBe(1);
  });

  it('非退行: 障害物に届かないドラッグは今日どおり目標位置ぴったりで確定する', () => {
    const h = liveHarness(companionObstacleProject(), selectionOf(LEAF_A, A_BR, A_TR));
    h.port.begin(grab(LEAF_A, A_BR), { x: 10, y: 0 }, NO_MODIFIERS);
    h.port.update({ x: 10.5, y: 0 });
    h.port.release({ x: 10.5, y: 0 }, true);

    const after = h.committed();
    expect(coordOf(after, A_BR)).toEqual(createCoordinate(10.5, 0));
    expect(coordOf(after, A_TR)).toEqual(createCoordinate(10.5, 10));
  });

  it('非退行: 選択に入っていない頂点を掴めば単一頂点移動のまま (随伴拘束は発動しない)', () => {
    const h = liveHarness(companionObstacleProject(), selectionOf(LEAF_A, A_TL));
    h.port.begin(grab(LEAF_A, A_BR), { x: 10, y: 0 }, NO_MODIFIERS);
    h.port.update({ x: 12, y: 0 });
    h.port.release({ x: 12, y: 0 }, true);

    const after = h.committed();
    expect(coordOf(after, A_BR)).toEqual(createCoordinate(12, 0));
    expect(coordOf(after, A_TR)).toEqual(createCoordinate(10, 10)); // 静止
  });
});

// ---------------------------------------------------------------------------
// 3. FR-89 — 随伴頂点も親領域から出られない (RED-3)
// ---------------------------------------------------------------------------

describe('FR-89: 随伴する穴リング頂点が親領域の外へ出ない (N725-9)', () => {
  it('外周に近い随伴頂点が外周を越えるドラッグは集合ごと外周で止まる', () => {
    const h = liveHarness(holedNearEdgeProject(), selectionOf(HOLED, H_BL, H_BR));
    h.port.begin(grab(HOLED, H_BL), { x: 10, y: 10 }, NO_MODIFIERS);
    h.port.update({ x: 15, y: 10 });
    h.port.release({ x: 15, y: 10 }, true);

    const after = h.committed();
    const companion = coordOf(after, H_BR);
    expect(pointInPolygon(companion, OUTER_POLYGON)).not.toBe(POINT_LOCATION.Outside);
    // 外周 lon=30 で止まる ⇒ デルタ (+5,0) が (+2,0) に縮む。
    expect(companion.lon).toBeCloseTo(30, 7);
    expect(coordOf(after, H_BL).lon).toBeCloseTo(12, 7);
  });

  it('非退行: 親領域内に収まるドラッグはそのまま通る', () => {
    const h = liveHarness(holedNearEdgeProject(), selectionOf(HOLED, H_BL, H_BR));
    h.port.begin(grab(HOLED, H_BL), { x: 10, y: 10 }, NO_MODIFIERS);
    h.port.update({ x: 11, y: 10 });
    h.port.release({ x: 11, y: 10 }, true);

    const after = h.committed();
    expect(coordOf(after, H_BL)).toEqual(createCoordinate(11, 10));
    expect(coordOf(after, H_BR)).toEqual(createCoordinate(29, 10));
  });
});

// ---------------------------------------------------------------------------
// 4. スナップとの合成 (裁定 追加条件 i)
// ---------------------------------------------------------------------------

describe('引き戻しが起きたフレームでは主頂点のスナップが残らない (N725-9 条件 i)', () => {
  it('生の到達点でしか届かない候補は共有ペアにならない (縮んだ位置で判定するから)', () => {
    // (12,0) にスナップ候補 (別地物の点) を置く。主頂点の生の到達点は (12,0) なので
    // 距離 0 = 必ず届くが、随伴の壁で (11,0) まで縮むと距離 1 > 閾値 0.5 で外れる。
    const root = companionObstacleProject();
    const withSnapTarget: DomainProject = {
      ...root,
      histories: [
        ...root.histories,
        singleAnchorHistory(
          'pin',
          [
            createPointFeature(
              asFeatureId('pin'),
              createBasicAttributes('目印', 0, 100),
              COLOR,
              asVertexId('pin-v'),
            ),
          ],
          createVertexStore([createVertex(asVertexId('pin-v'), createCoordinate(12, 0))]),
          0,
        ),
      ],
    };
    const h = liveHarness(withSnapTarget, selectionOf(LEAF_A, A_BR, A_TR), 8, 0.5);
    h.port.begin(grab(LEAF_A, A_BR), { x: 10, y: 0 }, NO_MODIFIERS);
    h.port.update({ x: 12, y: 0 });
    const live = h.previews.at(-1)!;
    expect(live.preview.lon).toBeCloseTo(11, 7);
    expect(live.snap).toBeNull();

    // 非退行の対: 随伴のいない単一頂点ドラッグなら縮まないので、同じ候補にスナップする。
    const single = liveHarness(withSnapTarget, selectionOf(LEAF_A, A_TL), 8, 0.5);
    single.port.begin(grab(LEAF_A, A_BR), { x: 10, y: 0 }, NO_MODIFIERS);
    single.port.update({ x: 12, y: 0 });
    expect(single.previews.at(-1)!.snap?.vertexId).toBe(asVertexId('pin-v'));
  });

  // --- 必須3 [MED-2] スナップが剛体性を破らない (両分岐) ---------------------

  function withPinAt(lon: number, lat: number): DomainProject {
    const root = companionObstacleProject();
    return {
      ...root,
      histories: [
        ...root.histories,
        singleAnchorHistory(
          'pin',
          [
            createPointFeature(
              asFeatureId('pin'),
              createBasicAttributes('目印', 0, 100),
              COLOR,
              asVertexId('pin-v'),
            ),
          ],
          createVertexStore([createVertex(asVertexId('pin-v'), createCoordinate(lon, lat))]),
          0,
        ),
      ],
    };
  }

  it('必須3 分岐A: d_snap が随伴を障害物へ押し込むなら snap を捨てる (拘束>スナップ)', () => {
    // 引き戻し主頂点 (11,0) が pin(11.4,0.3) に snap (距離0.5≤0.6)。しかし
    // d_snap=(1.4,0.3) は随伴 A_TR(10,10)→(11.4,10.3) を障害物 [11,13]×[9,11] の内部へ
    // 押し込む ⇒ snap は捨てられ、preview は引き戻し位置のまま (剛体性を保つ)。
    const h = liveHarness(withPinAt(11.4, 0.3), selectionOf(LEAF_A, A_BR, A_TR), 8, 0.6);
    h.port.begin(grab(LEAF_A, A_BR), { x: 10, y: 0 }, NO_MODIFIERS);
    h.port.update({ x: 12, y: 0 });
    const live = h.previews.at(-1)!;
    expect(live.preview.lon).toBeCloseTo(11, 7);
    expect(live.preview.lat).toBeCloseTo(0, 7);
    expect(live.snap).toBeNull();
  });

  it('必須3 分岐B: d_snap が全随伴合法なら preview=snapPos にして集合ごと剛体スナップ', () => {
    // pin(10.9,0.2) に snap (距離0.224≤0.3)。d_snap=(0.9,0.2) は随伴 A_TR(10,10)→(10.9,10.2)
    // で障害物の外 ⇒ snap は生き残り、preview は snapPos に一致 (随伴も同じ d_snap で動く)。
    const h = liveHarness(withPinAt(10.9, 0.2), selectionOf(LEAF_A, A_BR, A_TR), 8, 0.3);
    h.port.begin(grab(LEAF_A, A_BR), { x: 10, y: 0 }, NO_MODIFIERS);
    h.port.update({ x: 12, y: 0 });
    const live = h.previews.at(-1)!;
    expect(live.snap?.vertexId).toBe(asVertexId('pin-v'));
    expect(live.preview.lon).toBeCloseTo(10.9, 7);
    expect(live.preview.lat).toBeCloseTo(0.2, 7);
  });

  it('縮んだ位置で decideSnap し直すので、届かなくなった候補は共有ペアにならない', () => {
    // 障害物の頂点 (11,9) は生の到達点 (12,0) から 9px 離れているが、スナップ距離を
    // 大きくすると「縮む前の位置なら届く」状況が作れる。縮んだ後 (11,0) からの距離は
    // 9.0 (= (11,9) まで) なので、閾値 9.05 なら縮む前後で候補の有無が変わる。
    const h = liveHarness(companionObstacleProject(), selectionOf(LEAF_A, A_BR, A_TR), 20, 9.02);
    h.port.begin(grab(LEAF_A, A_BR), { x: 10, y: 0 }, NO_MODIFIERS);
    h.port.update({ x: 12, y: 0 });
    const live = h.previews.at(-1)!;
    // 縮んだ主頂点位置 (11,0) から (11,9) までは 9.0 ≤ 9.02 なので候補は残る。
    // 重要なのは「判定が縮んだ後の位置で行われる」こと: 生の (12,0) からは 9.055 > 9.02。
    expect(live.preview.lon).toBeCloseTo(11, 7);
    expect(live.snap?.screenDistance).toBeCloseTo(9, 6);
  });
});

// ---------------------------------------------------------------------------
// 5. perf ガード (既存流儀: multi-vertex-drag.fr80.test.ts:716-760)
// ---------------------------------------------------------------------------

describe('集合デルタのフレーム毎コスト', () => {
  /**
   * 大量の静止末端 + 大量の随伴頂点を持つプロジェクト。`ringSize` で各障害物リングの頂点数を
   * 上げると「海岸線型」(細長い末端が随伴列に沿って何万辺も走る) を再現できる。既定 4 は
   * 従来の 4 頂点矩形と完全一致 (union / 検索回数テストの前提を壊さない)。
   */
  function bulkProject(companionCount: number, obstacleCount: number, ringSize = 4): {
    root: DomainProject;
    companions: Set<ReturnType<typeof asVertexId>>;
  } {
    const vertices = [];
    const companions = new Set<ReturnType<typeof asVertexId>>();
    // ドラッグ地物: 縦一列に並ぶ頂点 (リングは先頭 3 点)。
    for (let i = 0; i < companionCount + 1; i += 1) {
      const id = asVertexId(`bulk-${i}`);
      vertices.push(createVertex(id, createCoordinate(0, i * 0.5)));
      if (i > 0) companions.add(id);
    }
    const dragged = createLeafFeature(
      asFeatureId('bulk'),
      createBasicAttributes('bulk', 0, 100),
      COLOR,
      createShape([
        createTerritoryRing(asRingId('bulk-r'), [
          asVertexId('bulk-0'),
          asVertexId('bulk-1'),
          asVertexId('bulk-2'),
        ]),
      ]),
    );
    const features = [dragged];
    for (let k = 0; k < obstacleCount; k += 1) {
      const base = `obs-${k}`;
      const y = k * 0.6;
      const ids: ReturnType<typeof asVertexId>[] = [];
      if (ringSize <= 4) {
        // 従来と完全一致の 4 頂点矩形 (随伴列 lon 0 のすぐ東)。
        ids.push(
          asVertexId(`${base}-0`),
          asVertexId(`${base}-1`),
          asVertexId(`${base}-2`),
          asVertexId(`${base}-3`),
        );
        vertices.push(createVertex(ids[0]!, createCoordinate(0.15, y)));
        vertices.push(createVertex(ids[1]!, createCoordinate(0.55, y)));
        vertices.push(createVertex(ids[2]!, createCoordinate(0.55, y + 0.4)));
        vertices.push(createVertex(ids[3]!, createCoordinate(0.15, y + 0.4)));
      } else {
        // 海岸線型: 東西の長辺を分割し、ringSize 頂点の細長いリングにする。
        const half = Math.max(2, Math.floor(ringSize / 2));
        for (let s = 0; s < half; s += 1) {
          const id = asVertexId(`${base}-w${s}`);
          ids.push(id);
          vertices.push(createVertex(id, createCoordinate(0.15, y + (0.4 * s) / (half - 1))));
        }
        for (let s = 0; s < half; s += 1) {
          const id = asVertexId(`${base}-e${s}`);
          ids.push(id);
          vertices.push(
            createVertex(id, createCoordinate(0.55, y + (0.4 * (half - 1 - s)) / (half - 1))),
          );
        }
      }
      features.push(
        createLeafFeature(
          asFeatureId(base),
          createBasicAttributes(base, 0, 100),
          COLOR,
          createShape([createTerritoryRing(asRingId(`${base}-r`), ids)]),
        ),
      );
    }
    return {
      root: {
        histories: [singleAnchorHistory('bulk', features, createVertexStore(vertices), 0)],
        settings: DEFAULT_SETTINGS,
        baseMap: DEFAULT_BASEMAP,
      },
      companions,
    };
  }

  it('海岸線型 (随伴 400 × 静止末端 400 × 160 辺/末端 ≒ 64k 辺) の 1 フレームが桁退化しない', () => {
    // 必須5 (MED-1): 従来の 300ms ガードは出荷フィクスチャの実測 17.6ms の 17 倍で、しかも
    // 最悪配置ですらなかった (空クエリに近い)。ここでは細長い末端が随伴列に沿って走る「海岸線型」
    // = 実際に「頂点 × 近傍片」割り当てを踏む配置に置き換え、閾値は「実測中央値の 3-4 倍」に
    // 締める (桁退化を検出できる誠実な値)。壁時計 60FPS は CI でアサートしない (マシン依存)。
    const { root, companions } = bulkProject(400, 400, 160);
    const query = createNeighboursQuery({
      getRoot: () => root,
      getTime: () => TIME,
      snapWorldMargin: () => 1,
    });
    const session = beginDrag(
      {
        tool: EDIT_TOOL.VertexMove,
        featureId: asFeatureId('bulk'),
        vertexId: asVertexId('bulk-0'),
        ringId: asRingId('bulk-r'),
        companionVertexIds: companions,
      },
      { lon: 0, lat: 0 },
    );
    query(createCoordinate(0.1, 0), session); // 索引構築 (ドラッグ全体で 1 回) を除外

    const runFrame = (lon: number): { edgesSeen: boolean; finite: boolean } => {
      const neighbours = query(createCoordinate(lon, 0), session);
      const movingSet = neighbours.movingSet!;
      const slid = constrainSetSlide({
        start: createCoordinate(0, 0),
        target: createCoordinate(lon, 0),
        edges: neighbours.edges,
        candidates: neighbours.candidates,
        primaryFrom: movingSet.primaryFrom,
        companions: movingSet.companions,
      });
      return {
        edgesSeen: movingSet.companions.length === 400 && movingSet.companions.some((c) => c.edges.length > 0),
        finite: Number.isFinite(slid.position.lon),
      };
    };

    // 中央値をとる (単発の GC スパイクに閾値が振られないように)。
    const samples: number[] = [];
    let sane = true;
    for (let i = 0; i < 5; i += 1) {
      const started = performance.now();
      const out = runFrame(0.2 + i * 1e-4);
      samples.push(performance.now() - started);
      sane = sane && out.edgesSeen && out.finite;
    }
    samples.sort((a, b) => a - b);
    const median = samples[Math.floor(samples.length / 2)]!;

    // 掃過箱が実際に障害物を掴み、拘束が有限値を返していること (空クエリを測って安心しない)。
    expect(sane).toBe(true);
    // 開発機 実測: 海岸線型 (≒64k 辺) 1 フレームの中央値 ≒ 22ms (近傍クエリ + 集合拘束)。
    // 閾値はその ~4 倍 = 90ms。「頂点 × 近傍片」割り当てが線形→二次に退化すれば桁で超える一方、
    // 通常の機差 (CI が 2-3 倍遅い程度) では割れない誠実な値。深い最適化 (16.6ms/frame 予算内へ
    // 収める) は本 fix のスコープ外 = 既知の性能上限として記録 (ADR / 報告)。
    expect(median).toBeLessThan(90);
  });

  it('広域に散った選択 (union 箱が退化) でも各随伴が自分の障害物を受け取る', () => {
    // 随伴 2 点を lat 0 と lat 500 に離して置く。union 箱の面積は個別箱の総和の
    // 16 倍をはるかに超えるので頂点別プローブへ落ちる — そこでも拘束は落ちない
    // (「N が大きいから諦める」degrade は禁止, 教訓 5.7)。
    const vertices = [
      createVertex(asVertexId('s-0'), createCoordinate(0, 0)), // 主頂点
      createVertex(asVertexId('s-1'), createCoordinate(0, 1)),
      createVertex(asVertexId('s-2'), createCoordinate(0, 500)), // 遠い随伴
    ];
    const features = [
      createLeafFeature(
        asFeatureId('spread'),
        createBasicAttributes('spread', 0, 100),
        COLOR,
        createShape([
          createTerritoryRing(asRingId('spread-r'), [
            asVertexId('s-0'),
            asVertexId('s-1'),
            asVertexId('s-2'),
          ]),
        ]),
      ),
    ];
    // 遠い随伴のすぐ東にだけ障害物を置く (主頂点の到達範囲の外)。
    const obsIds = [
      asVertexId('far-0'),
      asVertexId('far-1'),
      asVertexId('far-2'),
      asVertexId('far-3'),
    ];
    vertices.push(createVertex(obsIds[0]!, createCoordinate(1, 499)));
    vertices.push(createVertex(obsIds[1]!, createCoordinate(3, 499)));
    vertices.push(createVertex(obsIds[2]!, createCoordinate(3, 501)));
    vertices.push(createVertex(obsIds[3]!, createCoordinate(1, 501)));
    features.push(
      createLeafFeature(
        asFeatureId('far-obs'),
        createBasicAttributes('far', 0, 100),
        COLOR,
        createShape([createTerritoryRing(asRingId('far-obs-r'), obsIds)]),
      ),
    );
    const root: DomainProject = {
      histories: [singleAnchorHistory('spread', features, createVertexStore(vertices), 0)],
      settings: DEFAULT_SETTINGS,
      baseMap: DEFAULT_BASEMAP,
    };
    const query = createNeighboursQuery({
      getRoot: () => root,
      getTime: () => TIME,
      snapWorldMargin: () => 0.1,
    });
    const session = beginDrag(
      {
        tool: EDIT_TOOL.VertexMove,
        featureId: asFeatureId('spread'),
        vertexId: asVertexId('s-0'),
        ringId: asRingId('spread-r'),
        companionVertexIds: new Set([asVertexId('s-1'), asVertexId('s-2')]),
      },
      { lon: 0, lat: 0 },
    );
    const neighbours = query(createCoordinate(2, 0), session);
    const far = neighbours.movingSet!.companions.find((c) => c.vertexId === 's-2')!;
    expect(far.candidates.map((c) => c.featureId)).toContain('far-obs');
    // 主頂点側は今日どおり何も見えない (遠い障害物はそのクエリ矩形の外)。
    expect(neighbours.candidates).toEqual([]);

    const slid = constrainSetSlide({
      start: createCoordinate(0, 0),
      target: createCoordinate(2, 0),
      edges: neighbours.edges,
      candidates: neighbours.candidates,
      primaryFrom: neighbours.movingSet!.primaryFrom,
      companions: neighbours.movingSet!.companions,
    });
    expect(slid.retracted).toBe(true);
    expect(slid.position.lon).toBeCloseTo(1, 7); // 障害物の左辺 lon=1 で止まる
  });

  it('索引 search の呼び出し回数が随伴数 N に比例しない (union 掃過箱)', () => {
    const spy = vi.spyOn(SpatialIndex.prototype, 'search');
    try {
      const small = bulkProject(4, 50);
      const large = bulkProject(200, 50);
      const run = (fixture: ReturnType<typeof bulkProject>): number => {
        const query = createNeighboursQuery({
          getRoot: () => fixture.root,
          getTime: () => TIME,
          snapWorldMargin: () => 1,
        });
        const session = beginDrag(
          {
            tool: EDIT_TOOL.VertexMove,
            featureId: asFeatureId('bulk'),
            vertexId: asVertexId('bulk-0'),
            ringId: asRingId('bulk-r'),
            companionVertexIds: fixture.companions,
          },
          { lon: 0, lat: 0 },
        );
        query(createCoordinate(0.1, 0), session);
        spy.mockClear();
        query(createCoordinate(0.2, 0), session);
        return spy.mock.calls.length;
      };
      const few = run(small);
      const many = run(large);
      expect(few).toBeGreaterThan(0);
      expect(many).toBe(few); // 定数回 (主頂点 3 プローブ + union 3 プローブ)
    } finally {
      spy.mockRestore();
    }
  });
});
