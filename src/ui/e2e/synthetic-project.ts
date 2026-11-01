// E2E 専用の合成データ生成（増分 4。T-2「隠し観測・投入口は仕様として残し、足す一方にする」）。
//
// **なぜ要るか**: 受け入れ条件に「**5,000 行の合成データで台帳の DOM ノードが 20 個以下**」
// がある（設計書 §F.3 / 実装計画 §4）。5,000 件を画面の操作で作るのは現実的でないし、
// 5,000 件入りの `.gimoza` をリポジトリへ置くのも重い（実データ 775 件で 2MB）。
// **その場で組んでドメインへ流し込む口**を 1 つだけ開ける。
//
// **本番ビルドでは生えない。** 登録は `registerE2eHarnessAction` を通り、preload の
// E2E ブリッジ（`E2E_TEST=1` のときだけ main が積む旗）が無ければ no-op になる。
//
// 形は「1 度に全部が現在時刻に存在する末端地物」で、階層は付けない（台帳の行数と
// 仮想スクロールを測るのが目的で、階層の畳み込みは別の検査が見る）。頂点は 1 件につき
// 4 つの小さな四角で、地図の描画が重くならないよう **世界の端に等間隔で並べる**。

import { createBasicAttributes, createColorInfo } from '../../domain/attributes';
import { createAnchor } from '../../domain/anchor';
import { createAnchorEntry } from '../../domain/anchor-series';
import {
  createAggregateFeature,
  createLeafFeature,
  createLineFeature,
  createPointFeature,
  type Feature,
} from '../../domain/feature';
import { asAnchorId, asFeatureId, asRingId, asVertexId, type VertexId } from '../../domain/ids';
import type { DomainProject, FeatureHistory } from '../../domain/persistence/index';
import { createHoleRing, createShape, createTerritoryRing } from '../../domain/ring';
import { timePointYear } from '../../domain/time/time-point';
import { createVertex, createVertexStore } from '../../domain/vertex';

/** 合成データの 1 件あたりの四角の一辺（度）。小さくして描画を軽くする。 */
const SIDE_DEG = 0.05;

/**
 * `count` 件の末端地物を持つプロジェクトを組む。名前は `合成地物0001` の形で、
 * **並びは id の昇順**（束の並びと通し番号の検査が読みやすい）。
 *
 * 既存のプロジェクトの設定（暦・測地・格子）はそのまま引き継ぐ ―― 設定まで作り替えると、
 * 合成データを載せたあとの画面が「別のアプリ」になってしまう。
 */
export function buildSyntheticProject(base: DomainProject, count: number): DomainProject {
  const color = createColorInfo(true, '#90caf9', '#ffb300', '#0d47a1');
  const histories: FeatureHistory[] = [];
  for (let i = 0; i < count; i += 1) {
    const key = String(i).padStart(4, '0');
    // 世界を 100 列で折り返して並べる（-179 ～ +179 / -89 ～ +89 の中に収まる）。
    const lon = -179 + (i % 100) * 3.5;
    const lat = -89 + Math.floor(i / 100) * 1.7;
    const corners: readonly [number, number][] = [
      [lon, lat],
      [lon + SIDE_DEG, lat],
      [lon + SIDE_DEG, lat + SIDE_DEG],
      [lon, lat + SIDE_DEG],
    ];
    const vertices = corners.map((c, j) =>
      createVertex(asVertexId(`syn-${key}-v${String(j)}`), { lon: c[0], lat: c[1] }),
    );
    const feature = createLeafFeature(
      asFeatureId(`syn-${key}`),
      createBasicAttributes(`合成地物${key}`, 0, 9999),
      color,
      createShape([createTerritoryRing(asRingId(`syn-r-${key}`), vertices.map((v) => v.id))]),
      { kindLabel: i % 2 === 0 ? '合成の州' : '合成の国' },
    );
    // **1 地物 = 1 スナップショット**（自分と自分の頂点だけ）。実データもこの形である
    // （錨 1 本が世界全部を持つ形にすると、`featuresAt` が 履歴数 × 地物数 になって
    // 5,000 件では二乗の仕事になり、読み込みそのものが検査の対象になってしまう）。
    const anchor = createAnchor(asAnchorId(`syn-a-${key}`), {
      features: [feature],
      vertices: createVertexStore(vertices),
    });
    histories.push({
      featureId: feature.id,
      series: { entries: [createAnchorEntry(anchor, timePointYear(0))] },
    });
  }
  return { ...base, histories };
}

/**
 * **1 地物が `count` 本の錨を持つ**プロジェクトを組む（増分 6）。受け入れ条件
 * （設計書 §F.2）が「選択中の 1 地物が 5 万錨を持つ合成データ」で書かれているので、
 * その形をその場で作る口を開ける。5 万錨入りの `.gimoza` はリポジトリへ置けない
 * （錨 1 本＝スナップショット 1 部なので、実データ換算で数百 MB になる）。
 *
 * `asAggregateChild` を立てると **集約地物の下位領域**の形にする ―― 自分の履歴を持たず、
 * 親（集約地物）の系列に自分が入っている。§F.2 の「集約地物の下位領域でも同じ条件を満たす」
 * を測るための形で、実データの 86 件と同じ構造である。
 */
export function buildSyntheticAnchorProject(
  base: DomainProject,
  count: number,
  options?: {
    readonly asAggregateChild?: boolean;
    /**
     * **1 年の中に錨を並べる**（束の吹き出しの相手。設計書 §F.2 規則 6-2 の
     * 「1 年に複数の錨があるとき」）。開始は月日で分ける ―― 系列の不変条件 INV-1 は
     * 開始時刻が厳密に増加することを求めるので、同じ日には置けない。
     * 12 本まで（月ごと）。
     */
    readonly withinOneYear?: number;
  },
): DomainProject {
  const asChild = options?.asAggregateChild ?? true;
  const withinOneYear = options?.withinOneYear ?? 0;
  const color = createColorInfo(true, '#90caf9', '#ffb300', '#0d47a1');
  const childId = asFeatureId('syn-anchor-child');
  const parentId = asFeatureId('syn-anchor-parent');
  const entries = [];
  for (let i = 0; i < count; i += 1) {
    // 形をわずかに動かして「その錨で何かが変わった」ようにする ―― 集約地物の下位領域の
    // 選り分け（`isRelevantAnchor`）が全部を「関わる」と判定する形にしておかないと、
    // 母数が 0 になって測りたいものが測れない。
    const lon = -10 + (i % 1000) * 0.001;
    const lat = 10 + Math.floor(i / 1000) * 0.001;
    const vertices = [
      [lon, lat],
      [lon + SIDE_DEG, lat],
      [lon + SIDE_DEG, lat + SIDE_DEG],
      [lon, lat + SIDE_DEG],
    ].map((c, j) =>
      createVertex(asVertexId(`syn-anchor-v${String(i)}-${String(j)}`), {
        lon: c[0] as number,
        lat: c[1] as number,
      }),
    );
    const child = createLeafFeature(
      childId,
      createBasicAttributes('合成の錨だらけ', 0, 9999),
      color,
      createShape([
        createTerritoryRing(asRingId(`syn-anchor-r${String(i)}`), vertices.map((v) => v.id)),
      ]),
      {
        kindLabel: '合成の州',
        ...(asChild ? { parentId } : {}),
      },
    );
    const features = asChild
      ? [
          createAggregateFeature(
            parentId,
            createBasicAttributes('合成の集約地物', 0, 9999),
            color,
            [childId],
            { kindLabel: '合成の国' },
          ),
          child,
        ]
      : [child];
    const anchor = createAnchor(asAnchorId(`syn-anchor-a${String(i)}`), {
      features,
      vertices: createVertexStore(vertices),
    });
    // 既定は 1 年に 1 本（0 年・1 年・…）。`withinOneYear` を渡した先頭のぶんだけは
    // **同じ年の別の月**に置き、束の吹き出しへ到達できる形にする。
    const start =
      i < withinOneYear
        ? { granularity: 'yearMonth' as const, year: 1200, month: (i % 12) + 1 }
        : timePointYear(withinOneYear > 0 ? 1201 + i : i);
    entries.push(createAnchorEntry(anchor, start));
  }
  // 系列の持ち主は、集約地物の下位領域のときは **親**（実データと同じ形）。
  return {
    ...base,
    histories: [{ featureId: asChild ? parentId : childId, series: { entries } }],
  };
}

/** 合成した錨だらけの地物の id（E2E がそのまま選べるように公開する）。 */
export const SYNTHETIC_ANCHOR_FEATURE_ID = 'syn-anchor-child';
/** 同じく集約地物（親）の id。 */
export const SYNTHETIC_ANCHOR_PARENT_ID = 'syn-anchor-parent';

/** 合成の入れ子（集約地物 + その錨に居候する子）の id（E2E がそのまま選べるように公開）。 */
export const SYNTHETIC_NEST_PARENT_ID = 'syn-nest-parent';
export const SYNTHETIC_NEST_PARENT_NAME = '合成の連邦';
export const SYNTHETIC_NEST_OUTSIDER_ID = 'syn-nest-outsider';
export const SYNTHETIC_NEST_OUTSIDER_NAME = '合成の外の国';
/** 子の表示名（`合成州 01` …）。E2E が名前で行を選ぶ。 */
export function syntheticNestChildName(index: number): string {
  return `合成州 ${String(index + 1).padStart(2, '0')}`;
}

/**
 * **記録の置き場の検査のための合成データ**（司令塔の決定 (1)(2)。増分 7 の手直し A）。
 *
 * 実データの「デーレ共和国 60 州」と同じ形を作る ―― 集約地物 1 件が系列を持ち、
 * その錨のスナップショットの中に `childCount` 件の子が居る（**子は自分の系列を
 * 持たない**）。錨は `years` のぶんだけ並べるので、「全部の年の記録を写す」が
 * 効いているかを画面から数えられる。
 *
 * 別の親へ移す先として、最上位の面「合成の外の国」を 1 件だけ自分の系列つきで置く。
 * 子は横に並べた正方形で、集約地物の形＝子の和になる（FR-35 を満たす）。
 */
export function buildSyntheticNestedProject(
  base: DomainProject,
  childCount: number,
  years: readonly number[] = [1000, 1200],
): DomainProject {
  const color = createColorInfo(true, '#a5d6a7', '#ff7043', '#1b5e20');
  const parentId = asFeatureId(SYNTHETIC_NEST_PARENT_ID);
  const outsiderId = asFeatureId(SYNTHETIC_NEST_OUTSIDER_ID);
  const childIds = Array.from({ length: childCount }, (_, i) =>
    asFeatureId(`syn-nest-child-${String(i)}`),
  );

  const tile = (
    idPart: string,
    index: number,
    row: number,
  ): { vertices: ReturnType<typeof createVertex>[]; ringId: string } => {
    const lon = -20 + index * SIDE_DEG;
    const lat = 10 + row * SIDE_DEG;
    const vertices = [
      [lon, lat],
      [lon + SIDE_DEG, lat],
      [lon + SIDE_DEG, lat + SIDE_DEG],
      [lon, lat + SIDE_DEG],
    ].map((c, j) =>
      createVertex(asVertexId(`v-${idPart}-${String(j)}`), {
        lon: c[0] as number,
        lat: c[1] as number,
      }),
    );
    return { vertices, ringId: `r-${idPart}` };
  };

  const entries = years.map((year) => {
    const vertices: ReturnType<typeof createVertex>[] = [];
    const children = childIds.map((childId, i) => {
      const t = tile(`${String(i)}-${String(year)}`, i, 0);
      vertices.push(...t.vertices);
      return createLeafFeature(
        childId,
        createBasicAttributes(syntheticNestChildName(i), 0, 9999),
        color,
        createShape([createTerritoryRing(asRingId(t.ringId), t.vertices.map((v) => v.id))]),
        { kindLabel: '合成の州', parentId },
      );
    });
    const parent = createAggregateFeature(
      parentId,
      createBasicAttributes(SYNTHETIC_NEST_PARENT_NAME, 0, 9999),
      color,
      childIds,
      { kindLabel: '合成の国' },
    );
    return createAnchorEntry(
      createAnchor(asAnchorId(`syn-nest-a-${String(year)}`), {
        features: [parent, ...children],
        vertices: createVertexStore(vertices),
      }),
      timePointYear(year),
    );
  });

  const outsiderTile = tile('outsider', 0, 4);
  const outsider = createLeafFeature(
    outsiderId,
    createBasicAttributes(SYNTHETIC_NEST_OUTSIDER_NAME, 0, 9999),
    color,
    createShape([
      createTerritoryRing(
        asRingId(outsiderTile.ringId),
        outsiderTile.vertices.map((v) => v.id),
      ),
    ]),
    { kindLabel: '合成の国' },
  );

  return {
    ...base,
    histories: [
      { featureId: parentId, series: { entries } },
      {
        featureId: outsiderId,
        series: {
          entries: [
            createAnchorEntry(
              createAnchor(asAnchorId('syn-nest-a-outsider'), {
                features: [outsider],
                vertices: createVertexStore(outsiderTile.vertices),
              }),
              timePointYear(years[0] ?? 1000),
            ),
          ],
        },
      },
    ],
  };
}

/** 集約地物を動かす検査の合成データの id（E2E がそのまま読めるように公開）。 */
export const SYNTHETIC_MOVE_IDS = {
  federation: 'syn-move-federation',
  region: 'syn-move-region',
  stateA: 'syn-move-a',
  stateB: 'syn-move-b',
  stateC: 'syn-move-c',
  stateD: 'syn-move-d',
  neighbour: 'syn-move-neighbour',
  road: 'syn-move-road',
  town: 'syn-move-town',
  sealed: 'syn-move-sealed',
  sealedState: 'syn-move-sealed-state',
  sealedRoad: 'syn-move-sealed-road',
} as const;

/** 下位の末端地物の 1 辺（度）。 */
const MOVE_TILE_DEG = 20;

/**
 * **集約地物を［動かす］で引く検査のための合成データ**（所有者の裁定 2026-11-01）。
 * `buildSyntheticNestedProject` の子は頂点を共有しないので、共有の扱いを確かめられない。こちらは
 * 東西に並べた帯で、隣どうしが同じ頂点 id を引く。
 *
 *     連邦（集約。系列あり。錨 1000・1500）
 *       ├ 地方（集約。連邦の錨に居る）
 *       │   ├ 州 A（連邦の錨に居る。穴あり。西南の角を線情報と共有）
 *       │   └ 州 B（連邦の錨に居る。飛び地あり）
 *       ├ 州 C（自分の系列を持つ。錨 1000・1500。東の辺を隣の国と共有）
 *       └ 州 D（1500 年の連邦の錨にだけ居る）
 *     隣の国（最上位の末端。自分の系列）
 *     街道（線情報。州 A の西南の角を引く）
 *     町（点情報。州 A の上に描かれ、頂点は共有しない）
 *     封じられた連合（集約）— 州の頂点を全部、外の線情報が引いているので何も動かせない
 */
export function buildSyntheticAggregateMoveProject(base: DomainProject): DomainProject {
  const ids = SYNTHETIC_MOVE_IDS;
  const color = createColorInfo(true, '#a5d6a7', '#ff7043', '#1b5e20');
  const attrs = (name: string): ReturnType<typeof createBasicAttributes> =>
    createBasicAttributes(name, 0, 9999);
  const v = (id: string, lon: number, lat: number): ReturnType<typeof createVertex> =>
    createVertex(asVertexId(`mv-${id}`), { lon, lat });
  const S = MOVE_TILE_DEG;
  const LAT = 0;
  const column = (x: number): readonly [ReturnType<typeof createVertex>, ReturnType<typeof createVertex>] => [
    v(`b${String(x)}`, -40 + x * S, LAT),
    v(`t${String(x)}`, -40 + x * S, LAT + S),
  ];
  const [b0, t0] = column(0);
  const [b1, t1] = column(1);
  const [b2, t2] = column(2);
  const [b3, t3] = column(3);
  const [b4, t4] = column(4);
  const box = (name: string, lon: number, lat: number, size: number): ReturnType<typeof createVertex>[] => [
    v(`${name}0`, lon, lat),
    v(`${name}1`, lon + size, lat),
    v(`${name}2`, lon + size, lat + size),
    v(`${name}3`, lon, lat + size),
  ];
  const idsOf = (vs: readonly ReturnType<typeof createVertex>[]): VertexId[] => vs.map((x) => x.id);
  const holeA = box('hole-a', -34, LAT + 6, 8);
  const islandB = box('island-b', -14, LAT + 30, 8);
  const boxD = box('d', -40, LAT - 30, 15);
  const roadEnd = v('road-end', -60, LAT - 10);
  const sealedBox = box('sealed', 40, LAT + 30, 15);

  const federationId = asFeatureId(ids.federation);
  const regionId = asFeatureId(ids.region);
  const stateA = createLeafFeature(
    asFeatureId(ids.stateA),
    attrs('州A'),
    color,
    createShape([
      createTerritoryRing(asRingId('mv-ra'), idsOf([b0, b1, t1, t0])),
      createHoleRing(asRingId('mv-ra-hole'), idsOf(holeA), asRingId('mv-ra')),
    ]),
    { parentId: regionId },
  );
  const stateB = createLeafFeature(
    asFeatureId(ids.stateB),
    attrs('州B'),
    color,
    createShape([
      createTerritoryRing(asRingId('mv-rb'), idsOf([b1, b2, t2, t1])),
      createTerritoryRing(asRingId('mv-rb-island'), idsOf(islandB)),
    ]),
    { parentId: regionId },
  );
  const stateC = createLeafFeature(
    asFeatureId(ids.stateC),
    attrs('州C'),
    color,
    createShape([createTerritoryRing(asRingId('mv-rc'), idsOf([b2, b3, t3, t2]))]),
    { parentId: federationId },
  );
  const stateD = createLeafFeature(
    asFeatureId(ids.stateD),
    attrs('州D'),
    color,
    createShape([createTerritoryRing(asRingId('mv-rd'), idsOf(boxD))]),
    { parentId: federationId },
  );
  const neighbour = createLeafFeature(
    asFeatureId(ids.neighbour),
    attrs('隣の国'),
    color,
    createShape([createTerritoryRing(asRingId('mv-rn'), idsOf([b3, b4, t4, t3]))]),
  );
  const road = createLineFeature(asFeatureId(ids.road), attrs('街道'), color, idsOf([b0, roadEnd]));
  const region = createAggregateFeature(regionId, attrs('地方'), color, [stateA.id, stateB.id], {
    parentId: federationId,
  });
  const federation = (withD: boolean) =>
    createAggregateFeature(federationId, attrs('連邦'), color, [
      regionId,
      stateC.id,
      ...(withD ? [stateD.id] : []),
    ]);
  const ownVertices = [b0, t0, b1, t1, ...holeA, b2, t2, ...islandB];
  const entry = (
    idPart: string,
    year: number,
    features: readonly Feature[],
    vertices: readonly ReturnType<typeof createVertex>[],
  ) =>
    createAnchorEntry(
      createAnchor(asAnchorId(`mv-a-${idPart}-${String(year)}`), {
        features,
        vertices: createVertexStore(vertices),
      }),
      timePointYear(year),
    );

  const townBody = v('town', -23, LAT + 15);
  const town = createPointFeature(asFeatureId(ids.town), attrs('町'), color, townBody.id);
  const sealedId = asFeatureId(ids.sealed);
  const sealedState = createLeafFeature(
    asFeatureId(ids.sealedState),
    attrs('封じられた州'),
    color,
    createShape([createTerritoryRing(asRingId('mv-rs'), idsOf(sealedBox))]),
    { parentId: sealedId },
  );
  const sealed = createAggregateFeature(sealedId, attrs('封じられた連合'), color, [sealedState.id]);
  const sealedRoad = createLineFeature(
    asFeatureId(ids.sealedRoad),
    attrs('環状道'),
    color,
    idsOf(sealedBox),
  );

  return {
    ...base,
    histories: [
      {
        featureId: federationId,
        series: {
          entries: [
            entry('fed', 1000, [federation(false), region, stateA, stateB], ownVertices),
            entry('fed', 1500, [federation(true), region, stateA, stateB, stateD], [...ownVertices, ...boxD]),
          ],
        },
      },
      {
        featureId: stateC.id,
        series: {
          entries: [
            entry('c', 1000, [stateC], [b2, b3, t3, t2]),
            entry('c', 1500, [stateC], [b2, b3, t3, t2]),
          ],
        },
      },
      {
        featureId: neighbour.id,
        series: { entries: [entry('n', 1000, [neighbour], [b3, b4, t4, t3])] },
      },
      { featureId: road.id, series: { entries: [entry('r', 1000, [road], [b0, roadEnd])] } },
      { featureId: town.id, series: { entries: [entry('t', 1000, [town], [townBody])] } },
      {
        featureId: sealedId,
        series: { entries: [entry('s', 1000, [sealed, sealedState], sealedBox)] },
      },
      {
        featureId: sealedRoad.id,
        series: { entries: [entry('sr', 1000, [sealedRoad], sealedBox)] },
      },
    ],
  };
}
