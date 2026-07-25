// N725-9 集合デルタ拘束 — constrainSetSlide の不変条件 (FR-80 × FR-28 / FR-89).
//
// 裁定 (2026-07-25):「方向は主頂点、量は集合の交叉」。主頂点は今日どおり滑走してジェスチャ
// ベクトル d を決め、随伴は d のスカラー縮小しか要求できない。ここで固定するのは
//   P1 随伴ゼロなら constrainSlide と完全同値 (最強の非退行ゲート)
//   P2 剛体性 (全移動頂点が同一デルタ)
//   P3 排他 (どの移動頂点も静止末端の strict 内部に入らない)
//   P4 単調性 (随伴を増やすとスケールは単調非増加)
//   P5 変位ゼロなら滑走報告なし
//   P7 サブグリッド摂動でも偽衝突・固着が出ない
//   P8 ±360 シームで主頂点と随伴が引き裂かれない

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  constrainSetSlide,
  constrainSlide,
  type BoundaryEdge,
  type CandidateTerminal,
  type MovingVertexConstraint,
  type ParentContainment,
} from './slide';
import { coord } from './fixtures';
import { isPointStrictlyInside } from '../geometry/predicates';
import type { GeoPolygon } from '../geometry/types';
import type { WorldCoordinate } from '../coordinate';

/** A terminal occupying lon [10,14] × lat [0,4], with its four ring edges. */
function squareAt(id: string, ox: number, oy: number, size = 4): {
  polygon: GeoPolygon;
  edges: BoundaryEdge[];
  candidate: CandidateTerminal;
} {
  const polygon: GeoPolygon = [
    [coord(ox, oy), coord(ox + size, oy), coord(ox + size, oy + size), coord(ox, oy + size)],
  ];
  const ring = polygon[0]!;
  const edges: BoundaryEdge[] = ring.map((a, i) => ({
    featureId: id,
    edgeKey: `r:${i}`,
    a,
    b: ring[(i + 1) % ring.length]!,
  }));
  return { polygon, edges, candidate: { featureId: id, polygon } };
}

const WALL = squareAt('WALL', 10, 0);

function companion(
  from: WorldCoordinate,
  edges: readonly BoundaryEdge[] = [],
  candidates: readonly CandidateTerminal[] = [],
  containment?: ParentContainment,
): MovingVertexConstraint {
  return containment === undefined
    ? { vertexId: `c@${from.lon},${from.lat}`, from, edges, candidates }
    : { vertexId: `c@${from.lon},${from.lat}`, from, edges, candidates, containment };
}

// ---------------------------------------------------------------------------
// P1 — 随伴ゼロなら constrainSlide と完全同値
// ---------------------------------------------------------------------------

describe('P1 随伴なしの constrainSetSlide は constrainSlide と一致する (完全非退行)', () => {
  it('ランダム入力で position / boundaries / collided がビット単位で一致する', () => {
    fc.assert(
      fc.property(
        fc.double({ min: -20, max: 20, noNaN: true }),
        fc.double({ min: -20, max: 20, noNaN: true }),
        fc.double({ min: -20, max: 20, noNaN: true }),
        fc.double({ min: -20, max: 20, noNaN: true }),
        (sx, sy, tx, ty) => {
          const input = {
            start: coord(sx, sy),
            target: coord(tx, ty),
            edges: WALL.edges,
            candidates: [WALL.candidate],
          };
          const single = constrainSlide(input);
          const set = constrainSetSlide({ ...input, primaryFrom: input.start, companions: [] });
          expect(set.position.lon).toBe(single.position.lon);
          expect(set.position.lat).toBe(single.position.lat);
          expect(set.collided).toBe(single.collided);
          expect(set.boundaries).toEqual(single.boundaries);
          expect(set.retracted).toBe(false);
        },
      ),
      { numRuns: 300 },
    );
  });

  it('随伴が存在しても誰も障害物に触れなければ主頂点の結果はそのまま (量子化もしない)', () => {
    const target = coord(3.123456789, 1.987654321);
    const single = constrainSlide({
      start: coord(0, 0),
      target,
      edges: WALL.edges,
      candidates: [WALL.candidate],
    });
    const set = constrainSetSlide({
      start: coord(0, 0),
      target,
      edges: WALL.edges,
      candidates: [WALL.candidate],
      primaryFrom: coord(0, 0),
      companions: [companion(coord(0, 20))], // 障害物から遠い
    });
    expect(set.position.lon).toBe(single.position.lon);
    expect(set.position.lat).toBe(single.position.lat);
    expect(set.retracted).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// P2 / P3 — 剛体性と排他
// ---------------------------------------------------------------------------

describe('P2/P3 随伴が壁に阻まれると集合ごと縮む', () => {
  it('随伴の障害物が集合全体のデルタを縮め、全員が同一ベクトルで動く', () => {
    // 随伴 (8,2) は東へ 4 動くと WALL(10..14) の内部。壁の左辺 lon=10 で t=0.5。
    const r = constrainSetSlide({
      start: coord(0, 20),
      target: coord(4, 20),
      edges: [],
      candidates: [],
      primaryFrom: coord(0, 20),
      companions: [companion(coord(8, 2), WALL.edges, [WALL.candidate])],
    });
    expect(r.retracted).toBe(true);
    expect(r.delta.dLon).toBeCloseTo(2, 9);
    expect(r.delta.dLat).toBeCloseTo(0, 9);
    expect(r.position.lon).toBeCloseTo(2, 9);
    // P3: 随伴の最終位置は壁の strict 内部ではない。
    const moved = { lon: 8 + r.delta.dLon, lat: 2 + r.delta.dLat };
    expect(isPointStrictlyInside(moved, WALL.polygon)).toBe(false);
    // P2: 主頂点と随伴の変位は同一ベクトル。
    expect(r.position.lon - 0).toBeCloseTo(r.delta.dLon, 12);
  });

  it('複数の随伴があれば最も厳しいものが勝つ (交叉 = min)', () => {
    const near = squareAt('NEAR', 9, 0);
    const r = constrainSetSlide({
      start: coord(0, 20),
      target: coord(4, 20),
      edges: [],
      candidates: [],
      primaryFrom: coord(0, 20),
      companions: [
        companion(coord(8, 2), WALL.edges, [WALL.candidate]), // 2.0 まで
        companion(coord(8, 2.5), near.edges, [near.candidate]), // 1.0 まで
      ],
    });
    expect(r.delta.dLon).toBeCloseTo(1, 9);
  });

  it('随伴が既に壁に接していて 1 ミリも動けないならデルタはゼロ、滑走報告もしない (P5)', () => {
    // 随伴を壁の左辺のちょうど上 (境界 = 合法) に置く。東へ 2 動くと壁の strict 内部に
    // 入るので、許容スカラーは 0 に潰れる = 集合ごと 1 ミリも動けない。
    const r = constrainSetSlide({
      start: coord(0, 20),
      target: coord(2, 20),
      edges: [],
      candidates: [],
      primaryFrom: coord(0, 20),
      companions: [companion(coord(10, 2), WALL.edges, [WALL.candidate])],
    });
    expect(r.delta).toEqual({ dLon: 0, dLat: 0 });
    expect(r.collided).toBe(false);
    expect(r.boundaries).toEqual([]);
    expect(r.position).toEqual(coord(0, 20));
  });

  it('引き戻しの原因になった境界が boundaries に載る (強調表示の材料)', () => {
    const r = constrainSetSlide({
      start: coord(0, 20),
      target: coord(4, 20),
      edges: [],
      candidates: [],
      primaryFrom: coord(0, 20),
      companions: [companion(coord(8, 2), WALL.edges, [WALL.candidate])],
    });
    expect(r.boundaries.map((b) => b.featureId)).toContain('WALL');
  });
});

// ---------------------------------------------------------------------------
// P4 — 単調性
// ---------------------------------------------------------------------------

describe('P4 随伴を増やしてもスケールは単調非増加', () => {
  it('随伴の追加が移動量を増やすことはない', () => {
    fc.assert(
      fc.property(fc.double({ min: 0.1, max: 8, noNaN: true }), (dx) => {
        const base = {
          start: coord(0, 20),
          target: coord(dx, 20),
          edges: [] as BoundaryEdge[],
          candidates: [] as CandidateTerminal[],
          primaryFrom: coord(0, 20),
        };
        const few = constrainSetSlide({
          ...base,
          companions: [companion(coord(8, 2), WALL.edges, [WALL.candidate])],
        });
        const more = constrainSetSlide({
          ...base,
          companions: [
            companion(coord(8, 2), WALL.edges, [WALL.candidate]),
            companion(coord(8.5, 2), WALL.edges, [WALL.candidate]),
          ],
        });
        expect(more.delta.dLon).toBeLessThanOrEqual(few.delta.dLon + 1e-12);
      }),
      { numRuns: 200 },
    );
  });
});

// ---------------------------------------------------------------------------
// FR-89 — 随伴の親領域包含
// ---------------------------------------------------------------------------

describe('FR-89 随伴が親領域から出るなら集合ごと親境界で止まる', () => {
  const parent = squareAt('PARENT', 0, 0, 30);
  const containment: ParentContainment = {
    featureId: 'PARENT',
    polygon: parent.polygon,
    edges: parent.edges,
  };

  it('外周に近い随伴が外へ出るドラッグはデルタが縮む', () => {
    const r = constrainSetSlide({
      start: coord(5, 5),
      target: coord(10, 5),
      edges: [],
      candidates: [],
      primaryFrom: coord(5, 5),
      companions: [companion(coord(28, 5), [], [], containment)],
    });
    expect(r.delta.dLon).toBeCloseTo(2, 7);
    expect(r.retracted).toBe(true);
  });

  it('親領域内に収まるなら何も起きない', () => {
    const r = constrainSetSlide({
      start: coord(5, 5),
      target: coord(6, 5),
      edges: [],
      candidates: [],
      primaryFrom: coord(5, 5),
      companions: [companion(coord(20, 5), [], [], containment)],
    });
    expect(r.retracted).toBe(false);
    expect(r.position).toEqual(coord(6, 5));
  });
});

// ---------------------------------------------------------------------------
// 必須1 [HIGH] — 棄権の巻き添え + FULL デルタ親多角形 + scale>=1 バイパス
// ---------------------------------------------------------------------------

describe('必須1 親リング頂点を選択に加えても随伴の FR-28 判定が生き残る', () => {
  const OBS = squareAt('OBS', 22, 9, 2); // 静止末端 [22,24]×[9,11]

  /**
   * 穴頂点の親 = 外周リング [0,0]-[30,30]。外周の O_BR(30,0) と O_TR(30,30) が「選択に入って
   * いる」= 随伴として一緒に動く。近傍クエリはこの外周を「全移動頂点 = FULL デルタ位置」で
   * 焼き込む(`polygon`)ので、旧コードは随伴 H_BR の committed 位置 (28,10) を FULL デルタで
   * 縮んだ外周 [0..25] の外と誤読して棄権 → FR-28 も巻き添えで無効化していた。
   * `regionAtScaledDelta` は committed 外周を s·d だけずらした「s 一貫」形を返す。
   */
  function holeContainment(fullDeltaLon: number): ParentContainment {
    return {
      featureId: 'OUTER',
      // 旧近傍クエリが焼き込む FULL デルタ形 (O_BR/O_TR が +fullDeltaLon)。
      polygon: [
        [
          coord(0, 0),
          coord(30 + fullDeltaLon, 0),
          coord(30 + fullDeltaLon, 30),
          coord(0, 30),
        ],
      ],
      // 静止辺だけ (左辺 O_TL→O_BL)。O_BR/O_TR に接する 3 辺は HB4-2 で落ちている。
      edges: [{ featureId: 'OUTER', edgeKey: 'parent:left', a: coord(0, 30), b: coord(0, 0) }],
      // s 一貫: committed 外周 [0..30] の右 2 頂点を offset だけ動かす。
      regionAtScaledDelta: (offset) => [
        [
          coord(0, 0),
          { lon: 30 + offset.lon, lat: 0 + offset.lat },
          { lon: 30 + offset.lon, lat: 30 + offset.lat },
          coord(0, 30),
        ],
      ],
    };
  }

  it('随伴 H_BR は obs の strict 内部に入らない (棄権の巻き添え根治・RED→GREEN)', () => {
    // 主頂点 H_BL(10,10) を西へ5。d = (-5,0)。full delta lon = -5。
    const r = constrainSetSlide({
      start: coord(10, 10),
      target: coord(5, 10),
      edges: [],
      candidates: [],
      primaryFrom: coord(10, 10),
      companions: [
        companion(coord(28, 10), OBS.edges, [OBS.candidate], holeContainment(-5)), // 穴 BR
        companion(coord(30, 0)), // 外周 BR (それ自体は無拘束)
        companion(coord(30, 30)), // 外周 TR (それ自体は無拘束)
      ],
    });
    const movedHBR = { lon: 28 + r.delta.dLon, lat: 10 + r.delta.dLat };
    // 旧コード: 棄権 → d=-5 のまま → H_BR=(23,10) が obs の strict 内部 (RED)。
    expect(isPointStrictlyInside(movedHBR, OBS.polygon)).toBe(false);
    // obs 右辺 lon=24 で止まる ⇒ d=-4 (穴2頂点だけ選んだ場合と一致)。
    expect(r.delta.dLon).toBeCloseTo(-4, 7);
    expect(r.retracted).toBe(true);
  });

  it('偽ブロックしない (固着): 親外周ごと剛体移動する穴頂点は最後まで自由に動く', () => {
    // 外周 [0,0]-[10,10] の全頂点が選択に入り、穴頂点も同じ +3 で動く ⇒ 穴は常に内側。
    const movingParent: ParentContainment = {
      featureId: 'OUTER2',
      polygon: [[coord(3, 0), coord(13, 0), coord(13, 10), coord(3, 10)]], // FULL デルタ (東へ3)
      edges: [], // 全辺が移動頂点に接する = 静止辺なし
      regionAtScaledDelta: (offset) => [
        [
          { lon: 0 + offset.lon, lat: 0 + offset.lat },
          { lon: 10 + offset.lon, lat: 0 + offset.lat },
          { lon: 10 + offset.lon, lat: 10 + offset.lat },
          { lon: 0 + offset.lon, lat: 10 + offset.lat },
        ],
      ],
    };
    const r = constrainSetSlide({
      start: coord(5, 5),
      target: coord(8, 5), // 東へ3
      edges: [],
      candidates: [],
      primaryFrom: coord(5, 5),
      companions: [companion(coord(9, 5), [], [], movingParent)], // 東の縁に近い穴頂点
    });
    expect(r.retracted).toBe(false);
    expect(r.delta.dLon).toBeCloseTo(3, 9);
  });

  it('FR-89 も生きている: 親が動かない側では随伴が親境界で止まる (偽許容しない)', () => {
    // 外周は静止 (regionAtScaledDelta が offset を無視)。随伴 (28,5) が東へ出ようとする。
    const fixedParent: ParentContainment = {
      featureId: 'OUTER3',
      polygon: [[coord(0, 0), coord(30, 0), coord(30, 30), coord(0, 30)]],
      edges: [{ featureId: 'OUTER3', edgeKey: 'right', a: coord(30, 0), b: coord(30, 30) }],
      // 親頂点は選択外 = 動かない。offset を無視して committed 形を返す。
      regionAtScaledDelta: () => [[coord(0, 0), coord(30, 0), coord(30, 30), coord(0, 30)]],
    };
    const r = constrainSetSlide({
      start: coord(5, 5),
      target: coord(10, 5), // 東へ5
      edges: [],
      candidates: [],
      primaryFrom: coord(5, 5),
      companions: [companion(coord(28, 5), [], [], fixedParent)],
    });
    // 外周 lon=30 で止まる ⇒ d=+2。
    expect(r.delta.dLon).toBeCloseTo(2, 7);
    expect(r.retracted).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// P7 — サブグリッド摂動 (HB4-2 教訓 #1 と同型)
// ---------------------------------------------------------------------------

describe('P7 サブグリッド摂動で偽衝突も固着も起きない', () => {
  it('±4.9e-8 の摂動を掛けても随伴が壁を越えず、かつ前進が消えない', () => {
    const perturbations = [-4.9e-8, -1e-8, 0, 1e-8, 4.9e-8];
    for (const px of perturbations) {
      for (const py of perturbations) {
        const r = constrainSetSlide({
          start: coord(0, 20),
          target: { lon: 4 + px, lat: 20 + py },
          edges: [],
          candidates: [],
          primaryFrom: coord(0, 20),
          companions: [companion(coord(8, 2), WALL.edges, [WALL.candidate])],
        });
        const moved = { lon: 8 + r.delta.dLon, lat: 2 + r.delta.dLat };
        expect(isPointStrictlyInside(moved, WALL.polygon)).toBe(false);
        // 固着しない: 壁までの 2° は必ず進める。
        expect(r.delta.dLon).toBeGreaterThan(1.9);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// 必須4 [MED-6] — 解析的 firstContact が load-bearing (MUT-B 殺傷)
// ---------------------------------------------------------------------------

describe('必須4 薄い壁を随伴が「飛び越え」ても firstContact で引き戻される', () => {
  it('端点は壁の外でも、掃過セグメントが壁を貫くので delta.dLon=2 に縮む', () => {
    // 随伴 from=(8,2)・d=(+4,0)。薄い壁 [10,10.5]×[0,4]。端点 (12,2) は x=12>10.5 で壁の外
    // (= 点判定だけなら合法)。左辺 lon=10 を t=0.5 で貫くので firstContact が s=0.5 に縮める。
    // MUT-B (firstContact を undefined 固定) では端点合法のまま s=1 → 壁をトンネルして RED。
    const wall = {
      polygon: [[coord(10, 0), coord(10.5, 0), coord(10.5, 4), coord(10, 4)]] as GeoPolygon,
      edges: [
        { featureId: 'THIN', edgeKey: 'r:0', a: coord(10, 0), b: coord(10.5, 0) },
        { featureId: 'THIN', edgeKey: 'r:1', a: coord(10.5, 0), b: coord(10.5, 4) },
        { featureId: 'THIN', edgeKey: 'r:2', a: coord(10.5, 4), b: coord(10, 4) },
        { featureId: 'THIN', edgeKey: 'r:3', a: coord(10, 4), b: coord(10, 0) },
      ] as BoundaryEdge[],
    };
    const r = constrainSetSlide({
      start: coord(0, 20),
      target: coord(4, 20),
      edges: [],
      candidates: [],
      primaryFrom: coord(0, 20),
      companions: [companion(coord(8, 2), wall.edges, [{ featureId: 'THIN', polygon: wall.polygon }])],
    });
    expect(r.delta.dLon).toBeCloseTo(2, 9);
    expect(r.retracted).toBe(true);
    // 端点 (from + full delta) は確かに壁の外 (点判定だけでは素通りしてしまう配置であることの確認)。
    expect(isPointStrictlyInside({ lon: 12, lat: 2 }, wall.polygon)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// P8 — ±360 シーム
// ---------------------------------------------------------------------------

describe('P8 ±360 シームでも主頂点と随伴が引き裂かれない', () => {
  it('|生Δlon|>180 のドラッグでも最短デルタが縮むだけ (ブランチは変わらない)', () => {
    const r = constrainSetSlide({
      start: coord(179.9, 0),
      target: coord(-179.9, 0),
      edges: [],
      candidates: [],
      primaryFrom: coord(179.9, 0),
      companions: [companion(coord(179.9, 5))],
    });
    // 実移動は +0.2° 東。障害物がないので縮まない = constrainSlide の結果そのもの。
    expect(r.retracted).toBe(false);
    expect(r.delta.dLon).toBeCloseTo(0.2, 9);
    expect(r.position.lon).toBeCloseTo(-179.9, 9);
  });

  it('シーム越えで随伴が壁に当たれば、最短デルタのまま縮む (地球一周しない)', () => {
    // 随伴 (179.95, 5)。壁を (180.05..184.05) に置くと東へ 0.2 で内部へ入る。
    const seamWall = squareAt('SEAM', 180.05, 3);
    const r = constrainSetSlide({
      start: coord(179.9, 0),
      target: coord(-179.9, 0), // 生 Δlon = -359.8, 最短 +0.2
      edges: [],
      candidates: [],
      primaryFrom: coord(179.9, 0),
      companions: [companion(coord(179.95, 5), seamWall.edges, [seamWall.candidate])],
    });
    expect(r.delta.dLon).toBeGreaterThan(0);
    expect(r.delta.dLon).toBeLessThanOrEqual(0.2 + 1e-9);
    expect(Math.abs(r.delta.dLon)).toBeLessThan(180); // 地球一周ぶん飛んでいない
  });
});
