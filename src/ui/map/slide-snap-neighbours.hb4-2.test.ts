// HB4-2 (D56 ユーザー実機報告) — 頂点滑り(エッジ滑り FR-89 / FR-28)の誤作動:
// 「ドラッグ中の頂点が動くことで一緒に動く線(= その頂点に接続する辺)に対して滑りが
// 発生してしまう」。
//
// 期待仕様(D56):
//   - 衝突候補から「ドラッグ頂点に接続する辺」を除外する。
//   - 共有頂点連動(FR-30)時は、連動して動く辺(共有頂点を引用する他地物の隣接辺)も
//     同様に除外する。連動して動く地物の輪郭は「静止した障害物」ではないので、
//     内外判定(candidate polygon)の対象にもしてはならない。
//
// このファイルは現行 HEAD の誤挙動を赤で固定する repro。src 本体は変更しない。

import { describe, expect, it } from 'vitest';

import { createBasicAttributes, createColorInfo } from '../../domain/attributes';
import { createCoordinate } from '../../domain/coordinate';
import { createLeafFeature } from '../../domain/feature';
import { asFeatureId, asRingId, asVertexId } from '../../domain/ids';
import { createHoleRing, createShape, createTerritoryRing } from '../../domain/ring';
import { createVertex, createVertexStore } from '../../domain/vertex';
import { timePointYear } from '../../domain/time/time-point';
import type { DomainProject } from '../../domain/persistence/index';
import {
  DEFAULT_BASEMAP,
  DEFAULT_SETTINGS,
  singleAnchorHistory,
  squareLeaf,
} from '../../domain/persistence/fixtures';
import {
  beginDrag,
  constrainSlide,
  EDIT_TOOL,
  type DragSession,
} from '../../domain/editing';

import { pointInPolygon, POINT_LOCATION } from '../../domain/geometry/predicates';

import { createNeighboursQuery } from './slide-snap-neighbours';

const COLOR = createColorInfo(true, '#102030', '#405060', '#708090');

/**
 * 二つの正方形の末端地物 A / B が「縦の共有辺」を持つプロジェクト。
 *
 *   (0,10)      sv-top(10,10)      (20,10)
 *      +-------------+---------------+
 *      |      A      |       B       |
 *      +-------------+---------------+
 *   (0,0)       sv-bot(10,0)       (20,0)
 *
 * `sv-top` / `sv-bot` は **同一 VertexId** を A と B の両リングが引用する共有頂点
 * (FR-30)。したがって `sv-top` をドラッグすると B の隣接2辺 (b-tr→sv-top /
 * sv-top→sv-bot) も連動して動く。
 */
function sharedEdgeProject(): DomainProject {
  const aBl = createVertex(asVertexId('a-bl'), createCoordinate(0, 0));
  const aTl = createVertex(asVertexId('a-tl'), createCoordinate(0, 10));
  const svBot = createVertex(asVertexId('sv-bot'), createCoordinate(10, 0));
  const svTop = createVertex(asVertexId('sv-top'), createCoordinate(10, 10));
  const bBr = createVertex(asVertexId('b-br'), createCoordinate(20, 0));
  const bTr = createVertex(asVertexId('b-tr'), createCoordinate(20, 10));

  const a = createLeafFeature(
    asFeatureId('leaf-a'),
    createBasicAttributes('A国', 0, 100),
    COLOR,
    createShape([
      createTerritoryRing(asRingId('leaf-a-r'), [aBl.id, svBot.id, svTop.id, aTl.id]),
    ]),
  );
  const b = createLeafFeature(
    asFeatureId('leaf-b'),
    createBasicAttributes('B国', 0, 100),
    COLOR,
    createShape([
      createTerritoryRing(asRingId('leaf-b-r'), [svBot.id, bBr.id, bTr.id, svTop.id]),
    ]),
  );

  return {
    histories: [
      singleAnchorHistory(
        'leaf-a',
        [a, b],
        createVertexStore([aBl, aTl, svBot, svTop, bBr, bTr]),
        0,
      ),
    ],
    settings: DEFAULT_SETTINGS,
    baseMap: DEFAULT_BASEMAP,
  };
}

/** `sv-top`(A の右上、B と共有)を掴んだ vertex-move セッション。 */
function sharedVertexDrag(): DragSession {
  return beginDrag(
    {
      tool: EDIT_TOOL.VertexMove,
      featureId: asFeatureId('leaf-a'),
      vertexId: asVertexId('sv-top'),
      ringId: asRingId('leaf-a-r'),
    },
    { lon: 10, lat: 10 },
  );
}

/** edit-session-adapter.applyMove と同じ順序で 1 フレーム分の滑りを計算する。 */
function slideOneFrame(root: DomainProject, session: DragSession, target: { lon: number; lat: number }) {
  const query = createNeighboursQuery({
    getRoot: () => root,
    getTime: () => timePointYear(0),
    snapWorldMargin: () => 5,
  });
  const neighbours = query(target, session);
  const slid = constrainSlide({
    start: session.start,
    target,
    edges: neighbours.edges,
    candidates: neighbours.candidates,
    ...(neighbours.containment !== undefined ? { containment: neighbours.containment } : {}),
  });
  return { neighbours, slid };
}

describe('HB4-2: 頂点滑りは「ドラッグ頂点に接続して連動する辺」に対して発生してはならない', () => {
  it('制御群(緑): 共有していない単独地物の頂点ドラッグでは自地物の辺に滑らない', () => {
    const a = squareLeaf('leaf-a', 'A国', 0, 0, 10);
    const root: DomainProject = {
      histories: [
        singleAnchorHistory('leaf-a', [a.feature], createVertexStore(a.vertices), 0),
      ],
      settings: DEFAULT_SETTINGS,
      baseMap: DEFAULT_BASEMAP,
    };
    const session = beginDrag(
      {
        tool: EDIT_TOOL.VertexMove,
        featureId: asFeatureId('leaf-a'),
        vertexId: asVertexId('leaf-a-2'),
        ringId: asRingId('leaf-a-r'),
      },
      { lon: 10, lat: 10 },
    );
    // 自地物の内側 (5,5) 方向へ引き込む: 自辺に滑ってはならない。
    const { slid } = slideOneFrame(root, session, { lon: 5, lat: 5 });
    expect(slid.collided).toBe(false);
    expect(slid.position).toEqual({ lon: 5, lat: 5 });
  });

  it('CORE(赤): 共有頂点を隣接地物側へドラッグしても、連動する辺で滑ってはならない', () => {
    const root = sharedEdgeProject();
    const session = sharedVertexDrag();
    // (10,10) → (13,7): B の「現在コミット済み」四角の内部だが、B の該当頂点は
    // 共有頂点なので B も一緒に変形する。よって衝突ではなく素通りが正。
    const { slid } = slideOneFrame(root, session, { lon: 13, lat: 7 });

    expect(slid.position).toEqual({ lon: 13, lat: 7 });
    expect(slid.collided).toBe(false);
    expect(slid.boundaries).toEqual([]);
  });

  it('赤: 近傍クエリは「ドラッグ頂点に接続する辺」を衝突候補に含めてはならない', () => {
    const root = sharedEdgeProject();
    const session = sharedVertexDrag();
    const { neighbours } = slideOneFrame(root, session, { lon: 13, lat: 7 });

    const dragged = { lon: 10, lat: 10 };
    const touchesDragged = (p: { lon: number; lat: number }): boolean =>
      Math.abs(p.lon - dragged.lon) < 1e-9 && Math.abs(p.lat - dragged.lat) < 1e-9;
    const incident = neighbours.edges.filter((e) => touchesDragged(e.a) || touchesDragged(e.b));

    expect(incident).toEqual([]);
  });

  it('赤: 連動して動く地物の「古い」輪郭を静止した内外判定候補にしてはならない', () => {
    const root = sharedEdgeProject();
    const session = sharedVertexDrag();
    const { neighbours } = slideOneFrame(root, session, { lon: 13, lat: 7 });

    // leaf-b は共有頂点 sv-top を引用しており、ドラッグに連動して変形する。
    // 修正の形は問わない(候補から落とす / preview 位置で組み直す のどちらでも可)が、
    // 「sv-top が (10,10) のまま」の古い輪郭が障害物として残っていてはならない。
    const stale = neighbours.candidates.filter((c) =>
      c.polygon.some((ring) =>
        ring.some((p) => Math.abs(p.lon - 10) < 1e-9 && Math.abs(p.lat - 10) < 1e-9),
      ),
    );
    expect(stale).toEqual([]);
  });

  it('連動地物を丸ごと無害化してはならない — 動かない側の辺は依然として壁', () => {
    const root = sharedEdgeProject();
    const session = sharedVertexDrag();
    // sv-top を B の向こう側 (25,5) まで引く。B は連動して変形するが、B の右辺
    // b-br(20,0)→b-tr(20,10) は共有頂点を含まないので動かない = 本物の壁のまま。
    // 連動地物を **edges からも** 丸ごと落とす実装だとここを素通りしてしまう(FR-28 の穴)。
    // (fix-forward 後は candidate ポリゴンこそ提供しないが、動かない辺は edges に残る:
    //  内外判定を捨てても壁は残る、が本テストが固定する契約。)
    const { slid } = slideOneFrame(root, session, { lon: 25, lat: 5 });

    expect(slid.collided).toBe(true);
    expect(slid.position.lon).toBeLessThanOrEqual(20 + 1e-9);
    expect(slid.boundaries.map((b) => b.featureId)).toContain('leaf-b');
  });
});

/**
 * A と B が同じ座標に **別 id の** 頂点を持つ(共有していない)プロジェクト。
 * B は A のドラッグに連動しないので、静止した障害物のまま = 従来どおり滑る。
 */
function coincidentButUnsharedProject(): DomainProject {
  const aBl = createVertex(asVertexId('a-bl'), createCoordinate(0, 0));
  const aTl = createVertex(asVertexId('a-tl'), createCoordinate(0, 10));
  const aBr = createVertex(asVertexId('a-br'), createCoordinate(10, 0));
  const aTr = createVertex(asVertexId('a-tr'), createCoordinate(10, 10));
  // 座標は a-br / a-tr と一致するが **別 id**(FR-31 のスナップ共有化がまだ走っていない状態)。
  const bBl = createVertex(asVertexId('b-bl'), createCoordinate(10, 0));
  const bTl = createVertex(asVertexId('b-tl'), createCoordinate(10, 10));
  const bBr = createVertex(asVertexId('b-br'), createCoordinate(20, 0));
  const bTr = createVertex(asVertexId('b-tr'), createCoordinate(20, 10));

  const a = createLeafFeature(
    asFeatureId('leaf-a'),
    createBasicAttributes('A国', 0, 100),
    COLOR,
    createShape([createTerritoryRing(asRingId('leaf-a-r'), [aBl.id, aBr.id, aTr.id, aTl.id])]),
  );
  const b = createLeafFeature(
    asFeatureId('leaf-b'),
    createBasicAttributes('B国', 0, 100),
    COLOR,
    createShape([createTerritoryRing(asRingId('leaf-b-r'), [bBl.id, bBr.id, bTr.id, bTl.id])]),
  );

  return {
    histories: [
      singleAnchorHistory(
        'leaf-a',
        [a, b],
        createVertexStore([aBl, aTl, aBr, aTr, bBl, bTl, bBr, bTr]),
        0,
      ),
    ],
    settings: DEFAULT_SETTINGS,
    baseMap: DEFAULT_BASEMAP,
  };
}

describe('HB4-2 回帰: id を共有しない隣接地物では従来どおり滑る (FR-28 / 診断 H5)', () => {
  it('座標が一致するだけの別 id の隣接地物は連動しない = 静止した障害物として滑りが起きる', () => {
    const root = coincidentButUnsharedProject();
    // A の右上 a-tr(10,10) を掴む。B の b-tl は同じ座標だが別 id なので B は動かない。
    const session = beginDrag(
      {
        tool: EDIT_TOOL.VertexMove,
        featureId: asFeatureId('leaf-a'),
        vertexId: asVertexId('a-tr'),
        ringId: asRingId('leaf-a-r'),
      },
      { lon: 10, lat: 10 },
    );
    const { neighbours, slid } = slideOneFrame(root, session, { lon: 13, lat: 7 });

    // 除外は **頂点 id** ベース: 別 id の b-tl(10,10) に接続する B の辺は残っていること。
    const incident = neighbours.edges.filter(
      (e) =>
        (Math.abs(e.a.lon - 10) < 1e-9 && Math.abs(e.a.lat - 10) < 1e-9) ||
        (Math.abs(e.b.lon - 10) < 1e-9 && Math.abs(e.b.lat - 10) < 1e-9),
    );
    expect(incident.length).toBeGreaterThan(0);

    // 候補ポリゴンも「古い輪郭」ではなく本来の輪郭のまま(B は動かない)。
    expect(neighbours.candidates).toHaveLength(1);
    expect(neighbours.candidates[0]!.featureId).toBe('leaf-b');

    // よって B の内部 (13,7) へは入れず、滑って止まる = FR-28 の従来挙動。
    expect(slid.collided).toBe(true);
    expect(slid.position).not.toEqual({ lon: 13, lat: 7 });
  });
});

/**
 * 単一地物の内部に、**外周リングと頂点を共有する** 穴リングを持つ構成(診断 H3)。
 * 穴頂点をドラッグするとき、共有された外周頂点も連動して動くので、その頂点に接続する
 * 親(外周)の辺を containment の壁にしてはならない。
 */
function holeTouchingTerritoryProject(): DomainProject {
  const tBl = createVertex(asVertexId('t-bl'), createCoordinate(0, 0));
  const tBr = createVertex(asVertexId('t-br'), createCoordinate(20, 0));
  const tTr = createVertex(asVertexId('t-tr'), createCoordinate(20, 20));
  // 外周の左上 = 穴リングの一頂点(同一 id を両リングが引用する)。
  const shared = createVertex(asVertexId('shared-corner'), createCoordinate(0, 20));
  const hA = createVertex(asVertexId('h-a'), createCoordinate(6, 14));
  const hB = createVertex(asVertexId('h-b'), createCoordinate(14, 6));

  const territoryRingId = asRingId('t-r');
  const f = createLeafFeature(
    asFeatureId('leaf-t'),
    createBasicAttributes('T国', 0, 100),
    COLOR,
    createShape([
      createTerritoryRing(territoryRingId, [tBl.id, tBr.id, tTr.id, shared.id]),
      createHoleRing(asRingId('h-r'), [shared.id, hA.id, hB.id], territoryRingId),
    ]),
  );

  return {
    histories: [
      singleAnchorHistory(
        'leaf-t',
        [f],
        createVertexStore([tBl, tBr, tTr, shared, hA, hB]),
        0,
      ),
    ],
    settings: DEFAULT_SETTINGS,
    baseMap: DEFAULT_BASEMAP,
  };
}

/**
 * `sharedEdgeProject` と同じ A / B に加え、B が **共有頂点を含まない離島片** を
 * もう一つ持つ多角形地物であるプロジェクト。B は sv-top を引用するので「連動する
 * 地物」だが、離島片そのものは一切動かない = 静止した障害物のまま。
 */
function multiPieceNeighbourProject(): DomainProject {
  const aBl = createVertex(asVertexId('a-bl'), createCoordinate(0, 0));
  const aTl = createVertex(asVertexId('a-tl'), createCoordinate(0, 10));
  const svBot = createVertex(asVertexId('sv-bot'), createCoordinate(10, 0));
  const svTop = createVertex(asVertexId('sv-top'), createCoordinate(10, 10));
  const bBr = createVertex(asVertexId('b-br'), createCoordinate(20, 0));
  const bTr = createVertex(asVertexId('b-tr'), createCoordinate(20, 10));
  const iBl = createVertex(asVertexId('i-bl'), createCoordinate(12, 12));
  const iBr = createVertex(asVertexId('i-br'), createCoordinate(16, 12));
  const iTr = createVertex(asVertexId('i-tr'), createCoordinate(16, 16));
  const iTl = createVertex(asVertexId('i-tl'), createCoordinate(12, 16));

  const a = createLeafFeature(
    asFeatureId('leaf-a'),
    createBasicAttributes('A国', 0, 100),
    COLOR,
    createShape([createTerritoryRing(asRingId('leaf-a-r'), [aBl.id, svBot.id, svTop.id, aTl.id])]),
  );
  const b = createLeafFeature(
    asFeatureId('leaf-b'),
    createBasicAttributes('B国', 0, 100),
    COLOR,
    createShape([
      createTerritoryRing(asRingId('leaf-b-r'), [svBot.id, bBr.id, bTr.id, svTop.id]),
      createTerritoryRing(asRingId('leaf-b-isle'), [iBl.id, iBr.id, iTr.id, iTl.id]),
    ]),
  );

  return {
    histories: [
      singleAnchorHistory(
        'leaf-a',
        [a, b],
        createVertexStore([aBl, aTl, svBot, svTop, bBr, bTr, iBl, iBr, iTr, iTl]),
        0,
      ),
    ],
    settings: DEFAULT_SETTINGS,
    baseMap: DEFAULT_BASEMAP,
  };
}

describe('HB4-2 fix-forward (敵対レビュー #1/#2/#3): 連動地物は内外判定の候補にしてはならない', () => {
  // #1 — `neighboursAt` は screen→world の **生の double** を受け取るが、`constrainSlide` は
  // `quantizeCoordinate(target)` で 1e-7 グリッドへ丸める。連動地物の輪郭を「生の preview」で
  // 組み直すと、候補ポリゴンの頂点(生)と内外判定される点(量子化後)が最大 5e-8 ずれ、
  // pointInPolygon が Boundary ではなく Inside を返して偽の滑りが起きる。CORE テストの
  // (13,7) がちょうどグリッド上に乗っているだけで、実機の座標はまず乗らない。
  it('サブグリッド摂動を掛けた target でも連動地物へは素通りする(グリッド上か否かに依存しない)', () => {
    const root = sharedEdgeProject();
    const deltas = [-4.9e-8, -3e-8, -1e-8, 0, 1e-8, 3e-8, 4.9e-8];
    const failures: string[] = [];
    for (const dLon of deltas) {
      for (const dLat of deltas) {
        const target = { lon: 13 + dLon, lat: 7 + dLat };
        const { slid } = slideOneFrame(root, sharedVertexDrag(), target);
        if (slid.collided || slid.boundaries.length > 0) {
          failures.push(`(${dLon}, ${dLat}) => ${JSON.stringify(slid)}`);
        }
      }
    }
    expect(failures).toEqual([]);
  });

  // #2 — 共有頂点を「隣接地物の外側」へ引くと、preview 位置で組み直した近傍輪郭が
  // **前フレーム開始点(session.start)** を strictly inside に含みうる。constrainSlide の
  // 先頭 EXISTING CONTACT (t=0) 分岐がこれを既存接触と誤認し、残った静止辺(B の底辺)を
  // 滑走境界に選んで接線成分だけを許す = 空きスペースへ引いたのにクランプされる。
  it('共有頂点を空きスペース(隣接地物の外側)へ引いてもクランプされない', () => {
    const root = sharedEdgeProject();
    const { slid } = slideOneFrame(root, sharedVertexDrag(), { lon: 7, lat: 14 });

    expect(slid.position).toEqual({ lon: 7, lat: 14 });
    expect(slid.collided).toBe(false);
    expect(slid.boundaries).toEqual([]);
  });

  // #3 — constrainSlide は「start は候補の外側」を前提に最終フォールバック `pos = start` を
  // 置いている(slide.ts:585-591 / 626-630)。呼び出し側が渡す candidates がその前提を破ると
  // ドラッグ全体が押下点で凍結する。`session.start` は updateDrag で更新されない(押下点に固定)
  // ので、1フレームのグリッチではなくジェスチャ終了までの固着になる。
  // ⇒ 近傍クエリの不変条件として「どの候補ポリゴンも start を strictly inside に含まない」を固定する。
  it('候補ポリゴンは decidedly 静止幾何のみ — ドラッグ開始点を内部に含む候補を返さない', () => {
    const root = sharedEdgeProject();
    const session = sharedVertexDrag();
    const targets = [
      { lon: 7, lat: 14 },
      { lon: 13, lat: 7 },
      { lon: 13.000000037, lat: 6.999999963 },
      { lon: 4, lat: 12 },
      { lon: 12, lat: 13 },
      { lon: 25, lat: 5 },
    ];
    for (const target of targets) {
      const { neighbours } = slideOneFrame(root, session, target);
      const containsStart = neighbours.candidates.filter(
        (c) => pointInPolygon(session.start, c.polygon) === POINT_LOCATION.Inside,
      );
      expect({ target, containsStart }).toEqual({ target, containsStart: [] });
    }
  });

  // 「連動するから候補を出さない」の粒度は **地物** ではなく **ポリゴン片(piece)**。
  // 多角形地物の一片だけが共有頂点を持つとき、共有していない片は静止した障害物のままで
  // なければならない(地物単位で落とすと FR-28 の穴になる)。
  it('多角形の近傍は片単位で判定する — 共有していない片は内外判定候補として残る', () => {
    const root = multiPieceNeighbourProject();
    const session = sharedVertexDrag();
    const { neighbours, slid } = slideOneFrame(root, session, { lon: 14, lat: 13 });

    // 共有頂点を持たない離島片(12,12)-(16,16) だけが候補として残る。
    expect(neighbours.candidates).toHaveLength(1);
    expect(
      neighbours.candidates[0]!.polygon[0]!.map((p) => [p.lon, p.lat]),
    ).toEqual([
      [12, 12],
      [16, 12],
      [16, 16],
      [12, 16],
    ]);
    // その片へは侵入できない(従来どおり滑って止まる)。
    expect(slid.collided).toBe(true);
    expect(slid.position.lat).toBeLessThanOrEqual(12 + 1e-9);
  });

  // #3 の帰結: 一度クランプ経路に入ると `pos = start` が返り続け、頂点がカーソルに
  // 追従しなくなる。start を押下点に固定したまま複数フレーム進めて固着しないことを固定する。
  it('複数フレーム(start は押下点に固定)を通して頂点はカーソルに追従し続ける', () => {
    const root = sharedEdgeProject();
    const session = sharedVertexDrag();
    const frames = [
      { lon: 9.5, lat: 11.0 },
      { lon: 8.7, lat: 12.3 },
      { lon: 7.000000021, lat: 14.000000047 },
      { lon: 5.4, lat: 15.9 },
    ];
    for (const target of frames) {
      const { slid } = slideOneFrame(root, session, target);
      expect({ target, position: slid.position, collided: slid.collided }).toEqual({
        target,
        position: {
          lon: Math.round(target.lon * 1e7) / 1e7,
          lat: Math.round(target.lat * 1e7) / 1e7,
        },
        collided: false,
      });
    }
  });
});

describe('HB4-2 (診断 H3): containment(親領域)も連動する自辺を壁にしてはならない', () => {
  it('親リングが共有する頂点をドラッグしても、その頂点に接続する親の辺は候補に残らない', () => {
    const root = holeTouchingTerritoryProject();
    const session = beginDrag(
      {
        tool: EDIT_TOOL.VertexMove,
        featureId: asFeatureId('leaf-t'),
        vertexId: asVertexId('shared-corner'),
        ringId: asRingId('h-r'),
      },
      { lon: 0, lat: 20 },
    );
    const { neighbours } = slideOneFrame(root, session, { lon: 4, lat: 16 });
    const containment = neighbours.containment;
    expect(containment).toBeDefined();

    const touchesDragged = (p: { lon: number; lat: number }): boolean =>
      Math.abs(p.lon - 0) < 1e-9 && Math.abs(p.lat - 20) < 1e-9;
    // 連動する親の辺(t-tr→shared / shared→t-bl)が壁として残っていないこと。
    expect(
      containment!.edges.filter((e) => touchesDragged(e.a) || touchesDragged(e.b)),
    ).toEqual([]);
    // 親の輪郭も「共有頂点が (0,20) のまま」の古い形で残っていないこと。
    expect(containment!.polygon.some((ring) => ring.some(touchesDragged))).toBe(false);
  });

  // fix-forward #1 (containment 経路): 親輪郭も **生の preview** で組み直されていたため、
  // constrainSlide が量子化した target との 5e-8 ズレで「親領域の外」と誤判定されうる。
  // その場合 constrainWithinParent は接続辺を除外済みなので交差を見つけられず、
  // largestSafePrefix が start まで戻して **押下点で固着** する。
  it('サブグリッド摂動を掛けた target でも親領域の壁で固着しない', () => {
    const root = holeTouchingTerritoryProject();
    const deltas = [-4.9e-8, -1e-8, 0, 1e-8, 4.9e-8];
    const failures: string[] = [];
    for (const dLon of deltas) {
      for (const dLat of deltas) {
        const session = beginDrag(
          {
            tool: EDIT_TOOL.VertexMove,
            featureId: asFeatureId('leaf-t'),
            vertexId: asVertexId('shared-corner'),
            ringId: asRingId('h-r'),
          },
          { lon: 0, lat: 20 },
        );
        const target = { lon: 4 + dLon, lat: 16 + dLat };
        const { slid } = slideOneFrame(root, session, target);
        const expected = {
          lon: Math.round(target.lon * 1e7) / 1e7,
          lat: Math.round(target.lat * 1e7) / 1e7,
        };
        if (slid.collided || slid.position.lon !== expected.lon || slid.position.lat !== expected.lat) {
          failures.push(`(${dLon}, ${dLat}) => ${JSON.stringify(slid)}`);
        }
      }
    }
    expect(failures).toEqual([]);
  });
});
