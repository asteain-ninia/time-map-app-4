// U30 — 合体 (結合) 編集案の組み立て・確定 (FR-50 / FR-51 / FR-52 / FR-94 / FR-95,
// 教訓 5.1 / 5.6 / 5.11 / 5.20 / 5.21 / 5.22 / 5.25 / 5.26 / 5.27).
//
// 本 module は結合フローの中核ドメインロジック:
//   1. 種別判定と 3 分岐 (FR-51, 教訓 5.6 結果状態判定 / §4 単一の真実源): 結合対象の
//      種別構成 (末端のみ / 集約のみ / 混在) を「下位領域を持つか」という結果状態で
//      判定し、1 箇所に集約する。種別ラベル (表示専用 FR-40) では判定しない。
//   2. 種別ごとの統合処理:
//      - 末端のみ: 各末端の形状の論理和 (U06 委譲) を取り 1 末端を新規生成。非隣接は
//        全片を採用して飛び地を持つ単一末端にする (教訓 5.1 全片採用)。
//      - 集約のみ: 各集約の直接下位領域を平坦化統合し、それらを下位に持つ 1 集約を
//        新規生成。下位の同一性は保ち上位参照だけ付け替える。元集約は同一性終了。
//      - 混在: 集約の下位領域に末端を加えた 1 集約を新規生成。末端は同一性を保ち下位
//        として継続。元集約は同一性終了。
//   3. 共通フロー (FR-52): 上位領域決定 (U28 同型サブフロー再利用) とプロパティ決定を
//      結果地物へ適用。
//   4. 確定前検証 (教訓 5.26): precondition.ts の単一述語を確定前にも通す。
//   5. 不可分の編集案 (FR-94, 教訓 5.11 / 5.20 / 5.21): 結果地物生成・元地物の同一性
//      終了・下位付け替え・参照掃除を 1 編集案へ束ね、created/deleted/survived ID 集合を
//      返す。新規 ID はコマンド結果に記録 (redo で再採番しない)。
//   6. 共有頂点継続 (FR-95): 末端のみ結合で作り直した頂点について旧→新対応写像を作り、
//      U11 の継続規則 (transferSharing) へ渡す素材を提供する。
//
// 確定後の整合性維持 (時間整合性・空間競合・競合解決・単一アンドゥ確定) は U13 へ委譲
// する (本 module は編集案を組むのみ)。共有状態は確定まで破壊更新しない (教訓 5.22):
// 検証用の作業集合を組み、違反時は何も適用せず操作前状態相当の拒否を返す。

import { createBasicAttributes, type BasicAttributes, type ColorInfo } from '../attributes';
import { quantizeCoordinate } from '../geometry/index';
import { alignMultiPolygon, normalizeCoordinate, referenceLonForMultiPolygon } from '../geo/index';
import { union, BOOLEAN_OP_STATUS } from '../geometry/boolean-ops';
import type { GeoMultiPolygon, GeoRing } from '../geometry/types';
import {
  createAggregateFeature,
  createLeafFeature,
  withAggregateChildIds,
  withParentId,
  type Feature,
  type LeafFeature,
} from '../feature';
import { buildForest, directChildIds, hasChildren, type Forest } from '../hierarchy/forest';
import { resolveLeafShape } from '../hierarchy/resolve-shape';
import { asFeatureId, asRingId, asVertexId, type FeatureId, type RingId, type VertexId } from '../ids';
import {
  createHoleRing,
  createShape,
  createTerritoryRing,
  isAlternationValid,
  type Ring,
  type Shape,
} from '../ring';
import { pointInPolygon, POINT_LOCATION } from '../geometry/index';
import { createVertex, getVertex, type Vertex, type VertexStore } from '../vertex';
import type { VertexRemap } from '../shared-vertex';
import { type WorldCoordinate } from '../coordinate';
import { createEditProposal, type EditProposal } from '../consistency/index';
import type { TimePoint } from '../time/time-point';
import { PARENT_DECISION, type ParentDecision } from '../affiliation/decision';
import {
  PROPERTY_DECISION,
  type MergedProperties,
  type PropertyDecision,
} from './decision';
import {
  MERGE_REJECT,
  validateMergePreconditions,
  type MergeRejectKind,
} from './precondition';
import {
  MSG_MERGE_INHERIT_SOURCE,
  MSG_MERGE_INTERNAL,
  MSG_MERGE_UNION_REJECTED,
  mergeRejectMessage,
} from './messages';

// --- ID ポート (注入; 純粋・決定的, 教訓 5.20 / 5.37) ------------------------

export interface MergeIdPorts {
  readonly nextFeatureId: () => FeatureId;
  readonly nextVertexId: () => VertexId;
  readonly nextRingId: () => RingId;
}

// --- 種別判定 (FR-51, 教訓 5.6 / §4 単一の真実源) ---------------------------

export const MERGE_KIND = {
  /** 全対象が末端地物 (下位領域なし)。 */
  LeafOnly: 'leaf-only',
  /** 全対象が集約地物 (下位領域あり)。 */
  AggregateOnly: 'aggregate-only',
  /** 末端と集約が混在。 */
  Mixed: 'mixed',
} as const;

export type MergeKind = (typeof MERGE_KIND)[keyof typeof MERGE_KIND];

/**
 * 結合対象集合の種別構成を判定する単一関数 (3 分岐を 1 箇所に集約)。判定は結果状態
 * (下位領域を持つか) で行う (教訓 5.6)。`targetIds` は事前条件検証を通った対象集合。
 */
export function classifyMerge(forest: Forest, targetIds: readonly FeatureId[]): MergeKind {
  let hasLeaf = false;
  let hasAggregate = false;
  for (const id of targetIds) {
    if (hasChildren(forest, id)) hasAggregate = true;
    else hasLeaf = true;
  }
  if (hasAggregate && hasLeaf) return MERGE_KIND.Mixed;
  if (hasAggregate) return MERGE_KIND.AggregateOnly;
  return MERGE_KIND.LeafOnly;
}

// --- フロー結果 (判別共用体; spec §成果物) ----------------------------------

export const MERGE_STATUS = {
  Proposal: 'proposal',
  Rejected: 'rejected',
} as const;

export type MergeStatus = (typeof MERGE_STATUS)[keyof typeof MERGE_STATUS];

/**
 * 結合編集案 (不変値)。確定前検証を通った変更の完全な記述。U13 の固定順序プロセス /
 * 単一アンドゥ単位へ渡せるよう、適用後の地物集合・頂点ストア・変更 ID 集合・共有継続
 * 素材を持つ。
 */
export interface MergeProposal {
  /** 種別 (末端のみ / 集約のみ / 混在)。 */
  readonly mergeKind: MergeKind;
  /** 結合対象 (入力順)。 */
  readonly targetIds: readonly FeatureId[];
  /** 結果地物の ID (新規)。 */
  readonly resultFeatureId: FeatureId;
  /** 適用後の面情報集合 (新規地物は末尾、同一性終了地物は除去済み)。 */
  readonly nextFeatures: readonly Feature[];
  /** 適用後の頂点ストア (末端のみ結合で作り直した頂点を含む)。 */
  readonly nextVertices: VertexStore;
  /** 生成した新規 ID 集合 (結果地物 + 新規上位領域; 初回生成 ID, 教訓 5.20)。 */
  readonly createdIds: readonly FeatureId[];
  /** 同一性を終了した (畳まれて消える) 地物の ID 集合 (FR-50)。 */
  readonly deletedIds: readonly FeatureId[];
  /** 参照/親子が変更され存続する地物の ID 集合 (継続する下位領域等, 教訓 5.23)。 */
  readonly survivedTouchedIds: readonly FeatureId[];
  /** 旧→新頂点対応写像 (FR-95) — U11 transferSharing が消費する。末端のみ結合で非空。 */
  readonly vertexRemap: VertexRemap;
}

export interface MergeRejected {
  readonly status: typeof MERGE_STATUS.Rejected;
  readonly kind: MergeRejectKind | 'union-rejected' | 'inherit-source' | 'hierarchy' | 'internal';
  readonly message: string;
  /** 機械可読詳細 (関与地物 ID 等)。 */
  readonly detail?: unknown;
}

export type MergeProposalResult =
  | { readonly status: typeof MERGE_STATUS.Proposal; readonly proposal: MergeProposal }
  | MergeRejected;

function reject(
  kind: MergeRejected['kind'],
  message: string,
  detail?: unknown,
): MergeRejected {
  return detail === undefined
    ? { status: MERGE_STATUS.Rejected, kind, message }
    : { status: MERGE_STATUS.Rejected, kind, message, detail };
}

// --- 末端のみ結合の形状論理和 (FR-51 / 教訓 5.1) ----------------------------

interface BuiltShape {
  readonly shape: Shape;
  readonly vertices: readonly Vertex[];
  /** 量子化座標 → 新規頂点 ID (旧→新対応の照合用, FR-95)。 */
  readonly byCoord: ReadonlyMap<string, VertexId>;
}

/**
 * 量子化座標のキー。経度は representative 分岐 [-180,180) に畳んでから量子化する
 * (FR-95): union のオペランドは alignMultiPolygon で連続フレーム (>180° を取り得る) へ
 * 揃えてから演算するため、シーム跨ぎで結合された頂点は出力上 190° のような連続値になり
 * 得る。一方、旧頂点ストアは representative (例 −170°) で格納されている。periodic に同一の
 * 点 (190° と −170°) が同じキーに落ちるよう先に正規化することで、旧→新対応 (buildRemap)
 * と頂点重複集約が world-turn ズレで取りこぼされないようにする。旧頂点は既に
 * representative なので正規化は恒等。
 */
function coordKey(c: WorldCoordinate): string {
  const q = quantizeCoordinate(normalizeCoordinate(c));
  return `${q.lon},${q.lat}`;
}

interface RawRing {
  readonly id: RingId;
  readonly vertexIds: readonly VertexId[];
  readonly coords: GeoRing;
  /** 多角形片の index 0 リング (外周/領土境界) なら true。 */
  readonly isOuter: boolean;
}

/** リングの符号付き面積の絶対値 (最小包含リング選択用)。 */
function ringAreaAbs(ring: GeoRing): number {
  let sum = 0;
  const n = ring.length;
  for (let i = 0; i < n; i += 1) {
    const a = ring[i];
    const b = ring[(i + 1) % n];
    if (a === undefined || b === undefined) continue;
    sum += a.lon * b.lat - b.lon * a.lat;
  }
  return Math.abs(sum) / 2;
}

/**
 * `inner` の代表点が `outer` の厳密内部にあるか。
 *
 * R3 seam alignment (audit root cause A): 両リングは同一 union 出力由来で通常は同じ
 * world-turn にあるが、seam をまたぐピース同士は per-ring の格納分岐が ±360° ずれ得る。
 * 共通アンカー (outer の外環基準) へ {@link alignMultiPolygon} で揃えてから包含述語を
 * 走らせ、単一真実源を再利用する (アルゴリズム再発明禁止)。single-branch 入力では
 * 恒等変換なので通常系は不変。
 */
function ringContains(outer: GeoRing, inner: GeoRing): boolean {
  if (inner[0] === undefined) return false;
  const ref = referenceLonForMultiPolygon([[outer]]);
  const [alignedOuter] = alignMultiPolygon([[outer]], ref);
  const [alignedInner] = alignMultiPolygon([[inner]], ref);
  const outerRing = alignedOuter?.[0];
  const probe = alignedInner?.[0]?.[0];
  if (outerRing === undefined || probe === undefined) return false;
  return pointInPolygon(probe, [outerRing]) === POINT_LOCATION.Inside;
}

/**
 * 生リング群を包含関係で領土→穴→領土→… の交互階層へ再親付けする (FR-24)。各リングの
 * 親は「自身を厳密に含む反対種別の最小面積リング」。包含親がなければ最上位領土。これに
 * より穴あき和 (ドーナツ状) でも交互不変条件を保つ。純粋・入力非破壊。
 */
function reparentByContainment(raws: readonly RawRing[]): Ring[] {
  const areaOf = new Map<RingId, number>();
  for (const r of raws) areaOf.set(r.id, ringAreaAbs(r.coords));

  const rings: Ring[] = [];
  for (const r of raws) {
    let bestParent: RawRing | undefined;
    let bestArea = Number.POSITIVE_INFINITY;
    for (const cand of raws) {
      if (cand.id === r.id) continue;
      if (cand.isOuter === r.isOuter) continue; // 親は種別が交互。
      if (!ringContains(cand.coords, r.coords)) continue;
      const a = areaOf.get(cand.id) ?? Number.POSITIVE_INFINITY;
      if (a < bestArea) {
        bestArea = a;
        bestParent = cand;
      }
    }
    if (r.isOuter) {
      rings.push(
        bestParent === undefined
          ? createTerritoryRing(r.id, r.vertexIds)
          : createTerritoryRing(r.id, r.vertexIds, bestParent.id),
      );
    } else {
      rings.push(
        bestParent === undefined
          ? createTerritoryRing(r.id, r.vertexIds) // 孤立穴は領土へ降格 (片落とし禁止)。
          : createHoleRing(r.id, r.vertexIds, bestParent.id),
      );
    }
  }
  return rings;
}

/**
 * 論理和の GeoMultiPolygon から {@link Shape} を構築する。リングごとに頂点 ID とリング
 * ID を採番し、包含で交互階層へ再親付けする。全片・全リングを採用する (教訓 5.1)。同一
 * 量子化座標は 1 頂点に集約し byCoord に記録する (FR-95 旧→新照合用)。
 */
function buildShapeFromMultiPolygon(mp: GeoMultiPolygon, ids: MergeIdPorts): BuiltShape {
  const vertices: Vertex[] = [];
  const byCoord = new Map<string, VertexId>();

  const mintRingVertices = (ring: GeoRing): VertexId[] => {
    const out: VertexId[] = [];
    for (const c of ring) {
      const key = coordKey(c);
      let vid = byCoord.get(key);
      if (vid === undefined) {
        vid = ids.nextVertexId();
        byCoord.set(key, vid);
        // Store the REPRESENTATIVE (folded) coordinate, never the aligned >180°
        // continuous one: every leaf vertex in the store is representative, so a
        // seam-merged vertex must round-trip to the same branch its neighbours use
        // (resolveLeafShape re-aligns on read). FR-95 key matching relies on this.
        vertices.push(createVertex(vid, quantizeCoordinate(normalizeCoordinate(c))));
      }
      out.push(vid);
    }
    return out;
  };

  const raws: RawRing[] = [];
  for (const poly of mp) {
    poly.forEach((ring, index) => {
      raws.push({
        id: ids.nextRingId(),
        vertexIds: mintRingVertices(ring),
        coords: ring,
        isOuter: index === 0,
      });
    });
  }
  const rings = reparentByContainment(raws);
  return { shape: createShape(rings), vertices, byCoord };
}

/** 末端対象群の形状を U06 の和で畳む。退化拒否は呼び出し側へ伝播。 */
function unionLeafShapes(
  forest: Forest,
  store: VertexStore,
  leafIds: readonly FeatureId[],
):
  | { readonly ok: true; readonly area: GeoMultiPolygon }
  | { readonly ok: false } {
  let acc: GeoMultiPolygon = [];
  for (const id of leafIds) {
    const f = forest.byId.get(id);
    if (f === undefined || f.kind !== 'leaf') return { ok: false };
    const area = resolveLeafShape(f.shape, store);
    if (area === undefined) return { ok: false };
    // R3 seam alignment (audit root cause A): resolveLeafShape returns RAW stored
    // representatives with zero seam handling, so a leaf whose territory straddles
    // the seam (or whose vertex list merely starts on the opposite seam side from
    // the accumulator) sits ~360° away from the running union. Unioned as-is, two
    // seam-adjacent leaves (e.g. +179 and −179, geometrically ~2° apart) are ~358°
    // apart and the union scatters them across the whole map instead of joining
    // them into one continuous merged terminal. Anchor BOTH operands onto ONE
    // common branch (the accumulator's outer-ring reference, falling back to the
    // leaf's own when the accumulator is empty) through the single alignment source
    // of truth before the op. For single-branch (non-seam) inputs this is the
    // identity, so the common case is unchanged.
    const ref =
      acc.length > 0 ? referenceLonForMultiPolygon(acc) : referenceLonForMultiPolygon(area);
    const merged = union(alignMultiPolygon(acc, ref), alignMultiPolygon(area, ref));
    if (merged.status === BOOLEAN_OP_STATUS.Rejected) return { ok: false };
    acc = merged.result;
  }
  return { ok: true, area: acc };
}

/**
 * 旧→新頂点対応写像を構築する (FR-95)。結合対象の各頂点について、その量子化座標が新規
 * 採番頂点 (byCoord) のどれかに一致すれば対応づける。和で消えた頂点は対応なし (U11 は
 * 対応のある頂点のみ引き継ぐ)。
 */
function buildRemap(
  store: VertexStore,
  targetVertexIds: ReadonlySet<VertexId>,
  byCoord: ReadonlyMap<string, VertexId>,
): VertexRemap {
  const remap = new Map<VertexId, VertexId>();
  for (const oldId of targetVertexIds) {
    const old = getVertex(store, oldId);
    if (old === undefined) continue;
    const newId = byCoord.get(coordKey(old.coordinate));
    if (newId !== undefined) remap.set(oldId, newId);
  }
  return remap;
}

/** 末端地物群が参照する全頂点 ID。 */
function collectLeafVertexIds(forest: Forest, leafIds: readonly FeatureId[]): ReadonlySet<VertexId> {
  const set = new Set<VertexId>();
  for (const id of leafIds) {
    const f = forest.byId.get(id);
    if (f === undefined || f.kind !== 'leaf') continue;
    for (const ring of f.shape.rings) for (const vid of ring.vertexIds) set.add(vid);
  }
  return set;
}

// --- プロパティ決定の実体化 (FR-52) -----------------------------------------

interface ResolvedProps {
  readonly attributes: BasicAttributes;
  readonly color: ColorInfo;
  readonly kindLabel?: string;
}

function resolvePropertyDecision(
  byId: ReadonlyMap<FeatureId, Feature>,
  decision: PropertyDecision,
):
  | { readonly ok: true; readonly props: ResolvedProps }
  | { readonly ok: false; readonly rejection: MergeRejected } {
  if (decision.kind === PROPERTY_DECISION.New) {
    return { ok: true, props: toResolvedProps(decision.properties) };
  }
  const source = byId.get(decision.sourceId);
  if (source === undefined) {
    return {
      ok: false,
      rejection: reject('inherit-source', MSG_MERGE_INHERIT_SOURCE, {
        sourceId: decision.sourceId,
      }),
    };
  }
  const props: ResolvedProps =
    source.kindLabel === undefined
      ? { attributes: source.attributes, color: source.color }
      : { attributes: source.attributes, color: source.color, kindLabel: source.kindLabel };
  return { ok: true, props };
}

function toResolvedProps(p: MergedProperties): ResolvedProps {
  return p.kindLabel === undefined
    ? { attributes: p.attributes, color: p.color }
    : { attributes: p.attributes, color: p.color, kindLabel: p.kindLabel };
}

// --- 上位領域決定の実体化 (FR-52; U28 同型, 最小要件「新規 1 つ」) -----------

interface RealizedParent {
  /** 結果地物の親 ID (none なら undefined = 最上位化)。 */
  readonly parentId: FeatureId | undefined;
  /** 生成した新規上位領域 (末尾追加用)。 */
  readonly created: readonly Feature[];
  readonly createdIds: readonly FeatureId[];
}

/**
 * 上位領域決定を実体化する。`create` は新規集約地物を 1 つ生成する (本ユニットの最小
 * 要件)。再帰的な多段上位積み上げは U28 のサブフローを利用する想定だが、本 module は
 * 単段生成までを担い、生成集約の上位は `above` が `none`/`existing` の場合のみ解決する。
 */
function realizeParent(
  decision: ParentDecision,
  ids: MergeIdPorts,
  period: { readonly startYear: number; readonly endYear: number },
  defaultColor: ColorInfo,
): RealizedParent {
  switch (decision.kind) {
    case PARENT_DECISION.None:
      return { parentId: undefined, created: [], createdIds: [] };
    case PARENT_DECISION.Existing:
      return { parentId: decision.parentId, created: [], createdIds: [] };
    case PARENT_DECISION.Create: {
      // 単段の新規上位を生成。`above` が existing なら既存上位へ接続、none なら最上位。
      const aboveId =
        decision.above.kind === PARENT_DECISION.Existing ? decision.above.parentId : undefined;
      const newId = ids.nextFeatureId();
      const attrs = createBasicAttributes(decision.spec.name, period.startYear, period.endYear);
      const optional =
        decision.spec.kindLabel !== undefined && aboveId !== undefined
          ? { kindLabel: decision.spec.kindLabel, parentId: aboveId }
          : decision.spec.kindLabel !== undefined
            ? { kindLabel: decision.spec.kindLabel }
            : aboveId !== undefined
              ? { parentId: aboveId }
              : {};
      const aggregate = createAggregateFeature(newId, attrs, defaultColor, [], optional);
      return { parentId: newId, created: [aggregate], createdIds: [newId] };
    }
  }
}

// --- 公開する主関数: 編集案の組み立て ---------------------------------------

export interface BuildMergeProposalInput {
  readonly features: readonly Feature[];
  readonly vertices: VertexStore;
  readonly targetIds: readonly FeatureId[];
  /** 結合の対象時間 (事前条件「対象時間に存在」の判定に用いる)。 */
  readonly atTime: number;
  readonly parentDecision: ParentDecision;
  readonly propertyDecision: PropertyDecision;
  readonly ids: MergeIdPorts;
}

/**
 * `(現在状態, 結合対象, 対象時間, 上位領域決定, プロパティ決定) → 編集案 または 拒否`。
 *
 * 確定前検証 (precondition.ts の単一述語) をここで通す (教訓 5.26)。共有状態は破壊更新
 * しない (教訓 5.22): 作業集合を組み、違反時は何も適用せず拒否を返す。種別 3 分岐は
 * classifyMerge で 1 箇所に集約する (§4 単一の真実源)。
 */
export function buildMergeProposal(input: BuildMergeProposalInput): MergeProposalResult {
  const { features, vertices, targetIds, atTime, parentDecision, propertyDecision, ids } = input;

  // 確定前事前条件検証 (開始前と同一述語, 教訓 5.26)。
  const verdict = validateMergePreconditions(features, targetIds, atTime);
  if (!verdict.ok) {
    return reject(verdict.reason, mergeRejectMessage(verdict.reason), {
      featureIds: verdict.featureIds,
    });
  }

  const forest = buildForest(features);
  const byId = forest.byId;
  const uniqueTargets = [...new Set(targetIds)];
  const mergeKind = classifyMerge(forest, uniqueTargets);

  // プロパティ実体化 (FR-52)。
  const propsResult = resolvePropertyDecision(byId, propertyDecision);
  if (!propsResult.ok) return propsResult.rejection;
  const props = propsResult.props;

  // 結果地物の存在期間 (対象群の包絡; 新規上位領域の期間にも用いる)。
  const period = resultPeriodOf(byId, uniqueTargets);

  // 上位領域実体化 (FR-52; U28 同型)。新規上位の色は集約既定色。
  const realizedParent = realizeParent(parentDecision, ids, period, props.color);

  const resultFeatureId = ids.nextFeatureId();

  switch (mergeKind) {
    case MERGE_KIND.LeafOnly:
      return assembleLeafOnly(
        features,
        vertices,
        forest,
        uniqueTargets,
        resultFeatureId,
        props,
        realizedParent,
        ids,
      );
    case MERGE_KIND.AggregateOnly:
    case MERGE_KIND.Mixed:
      return assembleAggregateResult(
        features,
        vertices,
        forest,
        uniqueTargets,
        mergeKind,
        resultFeatureId,
        props,
        realizedParent,
      );
  }
}

/** 結果地物 (および新規上位領域) の存在期間 = 対象群の包絡。 */
function resultPeriodOf(
  byId: ReadonlyMap<FeatureId, Feature>,
  targetIds: readonly FeatureId[],
): { readonly startYear: number; readonly endYear: number } {
  let start = Number.POSITIVE_INFINITY;
  let end = Number.NEGATIVE_INFINITY;
  for (const id of targetIds) {
    const f = byId.get(id);
    if (f === undefined) continue;
    start = Math.min(start, f.attributes.startYear);
    end = Math.max(end, f.attributes.endYear);
  }
  if (!Number.isFinite(start) || !Number.isFinite(end)) return { startYear: 0, endYear: 0 };
  return { startYear: start, endYear: end };
}

function leafOptional(
  parentId: FeatureId | undefined,
  kindLabel: string | undefined,
): { kindLabel?: string; parentId?: FeatureId } {
  if (kindLabel !== undefined && parentId !== undefined) return { kindLabel, parentId };
  if (kindLabel !== undefined) return { kindLabel };
  if (parentId !== undefined) return { parentId };
  return {};
}

// --- 末端のみ結合の組み立て (FR-51 / 教訓 5.1 / FR-95) -----------------------

function assembleLeafOnly(
  features: readonly Feature[],
  vertices: VertexStore,
  forest: Forest,
  targetIds: readonly FeatureId[],
  resultFeatureId: FeatureId,
  props: ResolvedProps,
  realizedParent: RealizedParent,
  ids: MergeIdPorts,
): MergeProposalResult {
  const unioned = unionLeafShapes(forest, vertices, targetIds);
  if (!unioned.ok) {
    return reject('union-rejected', MSG_MERGE_UNION_REJECTED, { targetIds });
  }
  const built = buildShapeFromMultiPolygon(unioned.area, ids);
  if (!isAlternationValid(built.shape)) {
    return reject('hierarchy', MSG_MERGE_INTERNAL, { resultFeatureId });
  }

  // 結果末端地物の生成 (新規 ID; 形状=論理和; 飛び地は複数領土リングで表現)。
  const optional = leafOptional(realizedParent.parentId, props.kindLabel);
  const resultLeaf = createLeafFeature(
    resultFeatureId,
    props.attributes,
    props.color,
    built.shape,
    optional,
  );

  // 旧→新頂点対応写像 (FR-95)。
  const targetVertexIds = collectLeafVertexIds(forest, targetIds);
  const vertexRemap = buildRemap(vertices, targetVertexIds, built.byCoord);

  // 同一性終了: 末端のみ結合では対象全件が消える (FR-50)。
  const deleted = new Set<FeatureId>(targetIds);
  const nextFeatures = removeFeatures(features, deleted)
    .concat(realizedParent.created)
    .concat(resultLeaf);

  // 頂点ストア: 新規頂点を追加 (旧頂点は U11 transferSharing が整理する素材として残す)。
  const nextVertices = addVertices(vertices, built.vertices);

  const createdIds = [...realizedParent.createdIds, resultFeatureId];
  const proposal: MergeProposal = {
    mergeKind: MERGE_KIND.LeafOnly,
    targetIds,
    resultFeatureId,
    nextFeatures,
    nextVertices,
    createdIds,
    deletedIds: [...deleted],
    survivedTouchedIds: [],
    vertexRemap,
  };
  return { status: MERGE_STATUS.Proposal, proposal };
}

// --- 集約のみ / 混在の組み立て (FR-51 / FR-35, 教訓 5.21 / 5.25) -------------

function assembleAggregateResult(
  features: readonly Feature[],
  vertices: VertexStore,
  forest: Forest,
  targetIds: readonly FeatureId[],
  mergeKind: typeof MERGE_KIND.AggregateOnly | typeof MERGE_KIND.Mixed,
  resultFeatureId: FeatureId,
  props: ResolvedProps,
  realizedParent: RealizedParent,
): MergeProposalResult {
  // 同一性を終了する側 = 対象のうち集約 (下位を結果集約へ移して消える)。
  // 同一性を継続する側 = (a) 各集約の直接下位領域、(b) 混在の末端対象。
  const deleted = new Set<FeatureId>();
  const continuingChildren: FeatureId[] = []; // 結果集約の下位になる ID (順序保持)。

  for (const id of targetIds) {
    if (hasChildren(forest, id)) {
      // 集約: 直接下位領域を平坦化して継続子に加える。集約自身は同一性終了。
      deleted.add(id);
      for (const childId of directChildIds(forest, id)) continuingChildren.push(childId);
    } else {
      // 末端 (混在のみ到達): 同一性を保ち下位として継続。
      continuingChildren.push(id);
    }
  }

  // 結果集約地物の生成 (形状属性なし, FR-35; childIds は parentId 張り替え後に同期)。
  const optional = leafOptional(realizedParent.parentId, props.kindLabel);
  const resultAggregate = createAggregateFeature(
    resultFeatureId,
    props.attributes,
    props.color,
    [],
    optional,
  );

  // 親子張り替え (教訓 5.21 参照掃除): 継続子の parentId を結果集約へ。元集約は除去。
  const continuingSet = new Set<FeatureId>(continuingChildren);
  const reparented = features.map((f) =>
    continuingSet.has(f.id) ? withParentId(f, resultFeatureId) : f,
  );

  let nextFeatures: Feature[] = removeFeatures(reparented, deleted);
  nextFeatures = nextFeatures.concat(realizedParent.created).concat(resultAggregate);

  // childIds 再同期 (parentId を単一真実源に集約の childIds を再構築; persistence /
  // deletion eligibility が childIds を権威データとするため整合維持)。
  const synced = syncAggregateChildIds(nextFeatures);

  const createdIds = [...realizedParent.createdIds, resultFeatureId];
  const proposal: MergeProposal = {
    mergeKind,
    targetIds,
    resultFeatureId,
    nextFeatures: synced.features,
    nextVertices: vertices, // 集約結合は頂点を作り直さない。
    createdIds,
    deletedIds: [...deleted],
    survivedTouchedIds: [...new Set<FeatureId>([...continuingChildren, ...synced.changedIds])],
    vertexRemap: new Map(),
  };
  return { status: MERGE_STATUS.Proposal, proposal };
}

// --- 共通ヘルパ -------------------------------------------------------------

/** 指定 ID 集合の地物を除去した新配列 (順序保持; 入力非破壊)。 */
function removeFeatures(features: readonly Feature[], remove: ReadonlySet<FeatureId>): Feature[] {
  return features.filter((f) => !remove.has(f.id));
}

/** 新規頂点群を追加した新ストア (入力非破壊)。 */
function addVertices(store: VertexStore, vertices: readonly Vertex[]): VertexStore {
  if (vertices.length === 0) return store;
  const byId = new Map(store.byId);
  for (const v of vertices) byId.set(v.id, v);
  return { byId };
}

/**
 * 確定状態 (parentId が単一真実源) から全集約地物の childIds を再構築する。親子張り替えは
 * parentId のみ更新するため集約の childIds は脱同期する。U28 と同型のため将来の単一実装
 * 共有候補だが、本 module では結合確定の作業集合に閉じて適用する。
 */
function syncAggregateChildIds(features: readonly Feature[]): {
  readonly features: readonly Feature[];
  readonly changedIds: ReadonlySet<FeatureId>;
} {
  const forest = buildForest(features);
  const changedIds = new Set<FeatureId>();
  const next = features.map((f) => {
    if (f.kind !== 'aggregate') return f;
    const desired = directChildIds(forest, f.id);
    if (sameIdList(f.childIds, desired)) return f;
    changedIds.add(f.id);
    return withAggregateChildIds(f, desired);
  });
  return { features: next, changedIds };
}

function sameIdList(a: readonly FeatureId[], b: readonly FeatureId[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

// --- U13 連携 — MergeProposal → EditProposal<Snapshot> (FR-94, §2.1.5) -------

/**
 * U13 の {@link EditProposal} が結合のために運ぶ不透明スナップショット: 適用後の面情報
 * 集合・頂点ストア・変更 ID 集合・共有継続素材を 1 値に詰める。U13 はこの中身を読まない
 * (Snapshot に総称) — host の applyProposal ポートが展開して結果地物生成 + 元地物消滅 +
 * 下位付け替え + 共有継続 (U11) を不可分に適用する (1 不可分コマンド, FR-94)。
 */
export interface MergeSnapshot {
  readonly mergeKind: MergeKind;
  readonly resultFeatureId: FeatureId;
  readonly nextFeatures: readonly Feature[];
  readonly nextVertices: VertexStore;
  readonly createdIds: readonly FeatureId[];
  readonly deletedIds: readonly FeatureId[];
  readonly survivedTouchedIds: readonly FeatureId[];
  readonly vertexRemap: VertexRemap;
}

/** 編集案を U13 スナップショット値へ詰める。純粋。 */
export function toMergeSnapshot(proposal: MergeProposal): MergeSnapshot {
  return {
    mergeKind: proposal.mergeKind,
    resultFeatureId: proposal.resultFeatureId,
    nextFeatures: proposal.nextFeatures,
    nextVertices: proposal.nextVertices,
    createdIds: proposal.createdIds,
    deletedIds: proposal.deletedIds,
    survivedTouchedIds: proposal.survivedTouchedIds,
    vertexRemap: proposal.vertexRemap,
  };
}

/**
 * 編集案を U13 {@link EditProposal} へ適合する (FR-94 / §2.1.5)。錨を打つ地物は結果
 * 地物 (新規生成された結合結果)。結合の全工程が不透明スナップショットに乗るため、U13 は
 * これを 1 つの不可分アンドゥ単位として確定する。`anchorTime` は確定する時刻 (呼び出し
 * 側が供給)。
 */
export function toMergeEditProposal(
  proposal: MergeProposal,
  anchorTime: TimePoint,
): EditProposal<MergeSnapshot> {
  return createEditProposal(proposal.resultFeatureId, anchorTime, toMergeSnapshot(proposal));
}

// 採番ユーティリティ (テスト・呼び出し側の利便)。
export { asFeatureId, asRingId, asVertexId };
export { MERGE_REJECT };
export type { MergeRejectKind };
export type { LeafFeature };
