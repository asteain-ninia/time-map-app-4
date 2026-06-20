// U29 — 末端→集約遷移 と 直轄領自動生成・集約地物の自動消滅 (FR-35 / FR-36 / FR-37 /
// FR-39 / FR-41 / FR-94). 全て pure domain (技術方針 2.13): Electron/React/Canvas
// 非依存, Vitest 単体実行可。入力状態を破壊更新しない (Immer 不要の純粋再構築)。
//
// 本 module は所属変更フロー (U28) が「ある末端地物が下位領域を獲得する」結果を渡して
// きたとき起動される遷移変換を提供する。不可分な 1 変換として以下を組み立てる:
//   1. 末端→集約遷移 (FR-36): 元末端地物の同一性 (同一 ID) を保ったまま、その時刻から
//      集約地物として継続させる。名称・種別ラベル・属性・色を引き継ぎ、形状属性を破棄する
//      (判別共用体: 集約地物に shape フィールドが存在しないため、型レベルで形状破棄が保証)。
//   2. 直轄領の差分算出と自動生成 (FR-37): 「元形状 − 下位領域の和」を U06 のラッパ経由で
//      算出し、差分が空 (トレランス内面積ゼロ) でなければ 1 つの直轄領 末端地物を生成して
//      新集約地物の下位領域に追加する。差分が複数片なら 1 直轄領の複数領土リング (飛び地)。
//   3. 集約地物の自動消滅 (FR-41): 遷移後の結果状態で直接下位領域が 0 個になった集約地物を
//      その時刻以降 非存在 (削除) とし、参照掃除・連鎖剪定まで U31 の sweep へ委譲する。
//   4. 構造化結果 (FR-94 / 教訓 5.11): 遷移地物 ID・生成直轄領 ID・消滅集約 ID を返し、
//      U28・選択再解決・整合性維持 (U13) が後続処理を組み立てられるようにする。
//
// 結果状態で判定する (教訓 5.6): 遷移トリガーは操作種別フラグでなく「下位領域を 1 個以上
// 持つか」、自動消滅トリガーは「直接下位領域 0 個か」で判定する。空集合の獲得は遷移しない
// (FR-35 集約地物を空で新設する入口を設けない / 基準 7)。
//
// 確定前検証 (教訓 5.26): 組み立てた結果状態を U08 の階層不変条件検証 (形状=和・隙間なし・
// 最上位同値・循環) へ通し、違反すれば確定せず拒否を返す (テスト可能な戻り値)。

import { withName, type BasicAttributes } from '../attributes';
import {
  FEATURE_KIND,
  createAggregateFeature,
  createLeafFeature,
  type AggregateFeature,
  type Feature,
  type LeafFeature,
} from '../feature';
import { unwrapRing, worldWrapReplicas } from '../geo/index';
import {
  difference as geoDifference,
  isMultiPolygonEmpty,
  isOk,
  union as geoUnion,
  type GeoMultiPolygon,
  type GeoRing,
} from '../geometry/index';
import { sweepAndPruneAnchor } from '../deletion/sweep';
import { buildForest, directChildIds, hasChildren, type Forest } from '../hierarchy/forest';
import { resolveFeatureArea, resolveLeafShape } from '../hierarchy/resolve-shape';
import { validateHierarchy } from '../hierarchy/validate';
import { asFeatureId, asRingId, asVertexId, type FeatureId } from '../ids';
import { nextRawId, type IdGeneratorState, type TimeSource } from '../id-generator';
import type { VertexStore } from '../vertex';
import { setVertex } from '../vertex';
import {
  buildDirectDomainShape,
  directDomainName,
  type DirectDomainIdPorts,
} from './direct-domain';

// ---------------------------------------------------------------------------
// 公開する判別共用体 — 遷移結果 (spec §成果物)
// ---------------------------------------------------------------------------

export const PROMOTION_STATUS = {
  /** 確定済み: 次状態 + 構造化結果。 */
  Committed: 'committed',
  /** 実行せず (空集合の獲得 = 遷移しない, FR-35 / 基準 7)。 */
  NoOp: 'no-op',
  /** 拒否: 機械可読な拒否種別 + 関与 ID (確定前検証違反など)。 */
  Rejected: 'rejected',
} as const;

export type PromotionStatus = (typeof PROMOTION_STATUS)[keyof typeof PROMOTION_STATUS];

export const PROMOTION_REJECT = {
  /** 遷移対象が存在しない / 末端地物でない (元形状を持たない)。 */
  TargetInvalid: 'target-invalid',
  /** 獲得される下位領域に存在しない ID が含まれる。 */
  ChildMissing: 'child-missing',
  /** 元形状 / 下位領域の和 / 差分が U06 で解決できなかった (退化・不正形状)。 */
  GeometryUnresolved: 'geometry-unresolved',
  /** 確定前の U08 階層不変条件検証で違反が出た (形状=和・隙間なし等)。 */
  HierarchyInvalid: 'hierarchy-invalid',
  /**
   * 遷移集約の派生面積 (下位領域 + 直轄領の和) が元末端地物形状からはみ出す／隙間を
   * 残す (基準 9b)。U08 の checkAggregateShapes は集約に stored shape が無いため inter-
   * child gap しか見ず元形状との一致は検査しない (tautological として省略) ので、本経路
   * で originalShapeMp と双方向比較して直轄領 reparent 誤り・rewrap 誤差・退化を捕える。
   */
  ShapeMismatch: 'shape-mismatch',
} as const;

export type PromotionRejectKind =
  (typeof PROMOTION_REJECT)[keyof typeof PROMOTION_REJECT];

/**
 * 構造化結果 (基準 8 / FR-94 / 教訓 5.11): 後続の選択再解決・整合性検証が組み立てられる
 * 最小情報。テストで厳密比較できる。
 */
export interface PromotionOutcome {
  /** 集約地物へ遷移した地物の識別子 (同一性保持: 元末端地物と同一 ID)。 */
  readonly promotedFeatureId: FeatureId;
  /** 自動生成した直轄領 末端地物の識別子 (生成した場合のみ; 差分空なら undefined)。 */
  readonly directDomainFeatureId?: FeatureId;
  /** 自動消滅させた集約地物の識別子集合 (連鎖剪定含む; 無ければ空)。 */
  readonly disappearedFeatureIds: readonly FeatureId[];
}

/** 確定済み遷移: 適用後の状態 + 構造化結果。状態は錨スナップショット相当 (FR-54)。 */
export interface PromotionCommitted {
  readonly status: typeof PROMOTION_STATUS.Committed;
  /** 遷移時刻以降の地物集合 (新集約・直轄領を含み、消滅集約を除く)。 */
  readonly nextFeatures: readonly Feature[];
  /** 直轄領が参照する新規頂点を追加した頂点ストア (元ストアは不変)。 */
  readonly nextVertices: VertexStore;
  /** 次の id-generator 状態 (直轄領・頂点・リング採番後)。呼び出し側が引き継ぐ。 */
  readonly idState: IdGeneratorState;
  readonly outcome: PromotionOutcome;
}

export interface PromotionNoOp {
  readonly status: typeof PROMOTION_STATUS.NoOp;
}

export interface PromotionRejected {
  readonly status: typeof PROMOTION_STATUS.Rejected;
  readonly kind: PromotionRejectKind;
  /** 関与した地物 ID (拒否理由の機械可読詳細)。 */
  readonly featureIds: readonly FeatureId[];
}

export type PromotionResult = PromotionCommitted | PromotionNoOp | PromotionRejected;

function rejected(kind: PromotionRejectKind, featureIds: readonly FeatureId[]): PromotionRejected {
  return { status: PROMOTION_STATUS.Rejected, kind, featureIds };
}

// ---------------------------------------------------------------------------
// 入力契約 (U28 → 本ユニット; spec §依存 U28)
// ---------------------------------------------------------------------------

export interface PromoteToAggregateInput {
  /** 現在状態 (遷移時刻のスナップショットの地物集合)。 */
  readonly features: readonly Feature[];
  /** 形状解決用の頂点ストア (元末端地物・下位領域の形状を参照)。 */
  readonly vertices: VertexStore;
  /** 下位領域を獲得する末端地物の識別子。 */
  readonly targetId: FeatureId;
  /**
   * 獲得される下位領域の識別子集合。これらは既に `features` 上で `targetId` を親と
   * する (U28 が parentId 張り替え済みの状態を渡す) こと。空集合は遷移しない
   * (FR-35 / 基準 7: 集約地物を空で新設しない)。
   */
  readonly acquiredChildIds: readonly FeatureId[];
  /** 直轄領 名称の上書き値 (任意; U28 のダイアログが収集)。 */
  readonly directDomainNameOverride?: string;
  /** 新規地物・頂点・リング採番用の id-generator 状態。 */
  readonly idState: IdGeneratorState;
  /** 採番用の時刻ソース (注入, 教訓 5.15)。 */
  readonly now: TimeSource;
}

// ---------------------------------------------------------------------------
// 形状解決ヘルパ (R3 seam-unwrap を通してから U06 へ)
// ---------------------------------------------------------------------------

/** 多重ポリゴンの各リングを seam-unwrap して連続経度にする (技術方針 R3)。 */
function unwrapMultiPolygon(mp: GeoMultiPolygon): GeoMultiPolygon {
  return mp.map((poly) => poly.map((ring: GeoRing) => unwrapRing([...ring])));
}

/**
 * `clip` の全片を ±360° 世界ラップ replica で複製し、連続座標上で 1 つの多重ポリゴンへ
 * 合成する (技術方針 R3 / U05 worldWrapReplicas)。`subject` を固定し `clip` を replica で
 * 整列するための前処理: seam をまたいで別々の 360° 窓に分断された片 (例 [170,180] と
 * [-180,-170]) を、subject の連続窓 ([170,190]) に重なる replica まで含めることで連結
 * 比較できるようにする。片落とし禁止 (教訓 5.1): 全 replica・全片を保持する。
 */
function replicateAcrossSeam(clip: GeoMultiPolygon): GeoMultiPolygon {
  const out: GeoRing[][] = [];
  for (const poly of clip) {
    if (poly.length === 0) continue;
    const outer = poly[0]!;
    // 各片の外環の連続窓に合わせて ±360° replica を生成。穴環も同じ turn でずらして
    // 外環と整合させる (穴を落とさない)。
    for (const rep of worldWrapReplicas(outer)) {
      const shifted: GeoRing[] = poly.map((ring) =>
        ring.map((c) => ({ lon: c.lon + rep.turns * 360, lat: c.lat })),
      );
      out.push(shifted);
    }
  }
  return out;
}

/**
 * seam (経度 ±180) を考慮した面積等価判定。両辺を連続座標へ展開し、一方向差分ごとに
 * clip 側を ±360° 世界ラップ replica で整列してから U06 差分が空かを判定する。これにより
 * seam をまたぐ領域が representative 空間で別々の 360° 窓に分断されていても正しく一致判定
 * できる。U06 差分が拒否されたら不一致扱い (defense 層が形状を拒んだ = 等価を確認できない)。
 */
function areasEqualSeamAware(a: GeoMultiPolygon, b: GeoMultiPolygon): boolean {
  const ua = unwrapMultiPolygon(a);
  const ub = unwrapMultiPolygon(b);
  return directionalSeamDiffEmpty(ua, ub) && directionalSeamDiffEmpty(ub, ua);
}

/** (subject \ clip±replicas) が U06 トレランス内で空かを判定する (連続座標前提)。 */
function directionalSeamDiffEmpty(subject: GeoMultiPolygon, clip: GeoMultiPolygon): boolean {
  const diff = geoDifference(subject, replicateAcrossSeam(clip));
  if (!isOk(diff)) return false;
  return isMultiPolygonEmpty(diff.result);
}

// ---------------------------------------------------------------------------
// 公開: 末端→集約遷移 (spec §成果物 主関数)
// ---------------------------------------------------------------------------

/**
 * `(現在状態, 遷移対象, 獲得下位領域, 名称上書き, 採番状態) → 遷移結果`。
 *
 * 遷移・直轄領生成・自動消滅を 1 つの不可分変換として組み立て、確定前に U08 検証へ通す。
 * 純粋: 入力は破壊しない。空集合の獲得は NoOp (FR-35 / 基準 7)。
 */
export function promoteLeafToAggregate(input: PromoteToAggregateInput): PromotionResult {
  const { features, vertices, targetId, acquiredChildIds, idState, now } = input;

  // 空集合の獲得は遷移しない (FR-35 集約地物を空で新設する入口なし / 基準 7)。
  if (acquiredChildIds.length === 0) {
    return { status: PROMOTION_STATUS.NoOp };
  }

  const byId = new Map<FeatureId, Feature>(features.map((f) => [f.id, f] as const));
  const target = byId.get(targetId);
  if (target === undefined || target.kind !== FEATURE_KIND.Leaf) {
    return rejected(PROMOTION_REJECT.TargetInvalid, [targetId]);
  }

  // 獲得下位領域の存在検査。
  for (const cid of acquiredChildIds) {
    if (!byId.has(cid)) return rejected(PROMOTION_REJECT.ChildMissing, [cid]);
  }

  // --- 元形状 (遷移前の末端地物の形状) ---------------------------------------
  const originalShapeMp = resolveLeafShape((target as LeafFeature).shape, vertices);
  if (originalShapeMp === undefined) {
    return rejected(PROMOTION_REJECT.GeometryUnresolved, [targetId]);
  }

  // --- 下位領域の和 (獲得された全領域; 片落とし禁止 教訓 5.1) -----------------
  // 形状解決は forest 経由 (resolveFeatureArea) で末端・集約いずれの下位領域でも
  // 派生形状の単一解決判定に乗せる (教訓 5.29)。
  const forestBefore = buildForest(features);
  const childUnion = unionChildAreas(forestBefore, vertices, acquiredChildIds);
  if (childUnion === undefined) {
    return rejected(PROMOTION_REJECT.GeometryUnresolved, [...acquiredChildIds]);
  }

  // --- 差分 (元形状 − 下位領域の和) を U06 経由で算出 (R3 unwrap 済み座標上) ---
  const diff = geoDifference(
    unwrapMultiPolygon(originalShapeMp),
    unwrapMultiPolygon(childUnion),
  );
  if (!isOk(diff)) {
    return rejected(PROMOTION_REJECT.GeometryUnresolved, [targetId]);
  }
  // 差分が空 (U06 トレランス内面積ゼロ) なら直轄領を生成しない (基準 3)。
  const hasDirectDomain = !isMultiPolygonEmpty(diff.result);

  // --- id 採番ポート (新規生成 ID は復元可能な形で結果へ; 教訓 5.20 / 5.37) -----
  const existing = new Set<string>(features.map((f) => f.id));
  for (const v of vertices.byId.keys()) existing.add(v);
  let gen: IdGeneratorState = idState;
  const mint = (prefix: string): string => {
    const r = nextRawId(prefix, gen, now, existing);
    gen = r.state;
    existing.add(r.value);
    return r.value;
  };

  // --- 直轄領 末端地物の生成 (差分が非空のときのみ; FR-37) --------------------
  let directDomain: LeafFeature | undefined;
  let nextVertices = vertices;
  if (hasDirectDomain) {
    const idPorts: DirectDomainIdPorts = {
      nextVertexId: () => asVertexId(mint('v')),
      nextRingId: () => asRingId(mint('r')),
    };
    const built = buildDirectDomainShape(diff.result, idPorts);
    if (built === undefined) {
      // 差分は非空だが形状を組み立てられなかった (退化)。直轄領なしでは隙間が残り
      // FR-39 を満たせないため拒否する (基準 9 / 教訓 5.26)。
      return rejected(PROMOTION_REJECT.GeometryUnresolved, [targetId]);
    }
    const ddId = asFeatureId(mint('f'));
    const ddName = directDomainName(target.attributes.name, input.directDomainNameOverride);
    const ddAttrs: BasicAttributes = withName(target.attributes, ddName);
    // 直轄領は新集約地物 (= targetId) の下位領域。元末端地物の色を引き継ぐ。
    directDomain = createLeafFeature(ddId, ddAttrs, target.color, built.shape, {
      parentId: targetId,
    });
    for (const v of built.vertices) nextVertices = setVertex(nextVertices, v);
  }

  // --- 末端→集約遷移 (FR-36): 同一 ID・属性引き継ぎ・形状破棄 -----------------
  // 直接下位領域 = 獲得分 + (生成された) 直轄領。
  const childIds: FeatureId[] = [...acquiredChildIds];
  if (directDomain !== undefined) childIds.push(directDomain.id);
  const promoted = promoteFeature(target as LeafFeature, childIds);

  // --- 適用後の地物集合を組み立てる (純粋再構築) -----------------------------
  // 元末端地物を集約へ差し替え、直轄領を末尾に追加する。
  const applied: Feature[] = features.map((f) => (f.id === targetId ? promoted : f));
  if (directDomain !== undefined) applied.push(directDomain);

  // --- 集約地物の自動消滅 + 参照掃除 + 連鎖剪定 (FR-41 / 教訓 5.6 / 5.21) -----
  // 遷移後の結果状態で直接下位領域 0 個になった集約地物を消滅させる。獲得により元親を
  // 失った集約が空になるケース等を、明示削除起点なしで結果状態から検出する (教訓 5.6)。
  // 遷移したばかりの集約 (promoted) と新規直轄領は除外する (空ではないため通常該当
  // しないが、保険として除外集合に入れる)。
  const protectedIds = new Set<FeatureId>([targetId]);
  if (directDomain !== undefined) protectedIds.add(directDomain.id);
  const emptied = emptiedAggregateIds(applied, protectedIds);
  const swept = sweepAndPruneAnchor(applied, emptied);

  // --- 集約地物 childIds の再同期 (parentId が単一真実源; persistence/eligibility
  //     は childIds を権威データとして扱うため確定前に同期, U28 と同じ規律) -------
  const synced = syncAggregateChildIds(swept.features);

  // --- 確定前検証 (教訓 5.26 / U08): 形状=和・隙間なし・最上位同値・循環 --------
  const validation = validateHierarchy(synced.features, { vertexStore: nextVertices });
  if (!validation.ok) {
    const ids = new Set<FeatureId>();
    for (const v of validation.violations) for (const id of v.featureIds) ids.add(id);
    return rejected(PROMOTION_REJECT.HierarchyInvalid, [...ids]);
  }

  // --- 形状保存検証 (基準 9b / 教訓 5.26): 集約派生面積 = 元末端地物形状 -----------
  // U08 の checkAggregateShapes は集約に stored shape が無いため inter-child gap しか
  // 検査せず、結果集約面積が元形状からはみ出す／隙間を残す不正構成 (直轄領 reparent 誤り・
  // rewrap 誤差・退化) を検出できない。ここで遷移集約の派生面積を forest から解決し、
  // originalShapeMp と seam を考慮した双方向差分比較 (areasEqualSeamAware) で拒否する。
  //
  // R3 注意 (世界端): seam (経度 ±180) をまたぐと比較が窓ズレを起こす。promotedArea は
  // 子 (生 representative 座標) + 直轄領 (rewrapRing 済み representative 座標) を U06 で
  // representative 空間 union した結果なので、seam をまたぐ領域は ±180 で分断され別片
  // (例: [170,180] と [-180,-170]) になる。一方 originalShapeMp は resolveLeafShape の
  // 非展開出力で、seam をまたぐ単一リング ([170,-170,...]) は polygon-clipping には世界の
  // 大半を覆うボックスに見える。両者を素朴に (あるいは片ごとに独立 unwrap して) 比較すると、
  // 分断片が別々の 360° 窓 ([170,180] と [-180,-170]) に置かれて連結せず、正当な seam 遷移を
  // false 拒否する (基準10 回帰)。そこで areasEqualSeamAware で双方を連続座標へ展開し、
  // 一方を ±360° 世界ラップ replica で整列してから U06 双方向差分が空になるかを判定する。
  const syncedForest = buildForest(synced.features);
  const promotedArea = resolveFeatureArea(syncedForest, nextVertices, targetId);
  if (promotedArea.status !== 'ok') {
    return rejected(PROMOTION_REJECT.GeometryUnresolved, [targetId]);
  }
  if (!areasEqualSeamAware(promotedArea.area, originalShapeMp)) {
    return rejected(PROMOTION_REJECT.ShapeMismatch, [targetId]);
  }

  const outcome: PromotionOutcome = {
    promotedFeatureId: targetId,
    ...(directDomain !== undefined ? { directDomainFeatureId: directDomain.id } : {}),
    disappearedFeatureIds: [...swept.removedIds],
  };

  return {
    status: PROMOTION_STATUS.Committed,
    nextFeatures: synced.features,
    nextVertices,
    idState: gen,
    outcome,
  };
}

// ---------------------------------------------------------------------------
// 末端→集約遷移の実体 (FR-36): 同一性保持・属性引き継ぎ・形状破棄
// ---------------------------------------------------------------------------

/**
 * 元末端地物を、その同一性 (同一 ID) を保ったまま集約地物へ遷移させる (FR-36)。名称・
 * 種別ラベル・属性・色・親 (上位領域参照) を引き継ぎ、形状属性 (Shape) は破棄する。
 *
 * 形状破棄は判別共用体で型レベル保証される: AggregateFeature に `shape` フィールドが
 * 存在しないため、引き継ぎ漏れや形状残留は表現不能 (技術方針 2.1 / FR-35)。
 */
export function promoteFeature(
  leaf: LeafFeature,
  childIds: readonly FeatureId[],
): AggregateFeature {
  // 引き継ぐ任意フィールド (kindLabel / parentId) を exactOptionalPropertyTypes に
  // 沿って組み立てる。
  const optional =
    leaf.kindLabel !== undefined && leaf.parentId !== undefined
      ? { kindLabel: leaf.kindLabel, parentId: leaf.parentId }
      : leaf.kindLabel !== undefined
        ? { kindLabel: leaf.kindLabel }
        : leaf.parentId !== undefined
          ? { parentId: leaf.parentId }
          : {};
  return createAggregateFeature(leaf.id, leaf.attributes, leaf.color, childIds, optional);
}

// ---------------------------------------------------------------------------
// 下位領域の和 (片落とし禁止 教訓 5.1; 派生形状の単一解決判定 教訓 5.29)
// ---------------------------------------------------------------------------

/** 獲得下位領域それぞれの派生形状 (U08 単一解決) を U06 union で全片合成する。 */
function unionChildAreas(
  forest: Forest,
  store: VertexStore,
  childIds: readonly FeatureId[],
): GeoMultiPolygon | undefined {
  let acc: GeoMultiPolygon = [];
  for (const cid of childIds) {
    const res = resolveFeatureArea(forest, store, cid);
    if (res.status !== 'ok') return undefined;
    const merged = geoUnion(acc, res.area);
    if (!isOk(merged)) return undefined;
    acc = merged.result;
  }
  return acc;
}

// ---------------------------------------------------------------------------
// 自動消滅判定 (結果状態 教訓 5.6) + childIds 再同期 (U28 と同じ規律)
// ---------------------------------------------------------------------------

/**
 * 遷移後の地物集合で、直接下位領域 0 個になった集約地物の ID を返す (結果状態判定,
 * 教訓 5.6)。`protectedIds` (遷移した集約・新規直轄領) は除外する。判別は kind が
 * aggregate かつ forest 上の直接子が 0 個か (経路ではなく結果状態で判定)。
 */
export function emptiedAggregateIds(
  features: readonly Feature[],
  protectedIds: ReadonlySet<FeatureId>,
): ReadonlySet<FeatureId> {
  const forest = buildForest(features);
  const out = new Set<FeatureId>();
  for (const f of features) {
    if (protectedIds.has(f.id)) continue;
    if (f.kind !== FEATURE_KIND.Aggregate) continue;
    if (!hasChildren(forest, f.id)) out.add(f.id); // 結果状態: 下位 0 件 (教訓 5.6)。
  }
  return out;
}

/**
 * 確定状態 (parentId が単一真実源) から全集約地物の childIds を再構築する。遷移・張り
 * 替え・sweep 後の parentId 関係を権威ソースとして childIds を再生成し、脱同期を解消
 * する (U28 buildProposalForLeaves と同じ規律; persistence / deletion eligibility が
 * childIds を権威データとして扱うため)。
 */
export function syncAggregateChildIds(features: readonly Feature[]): {
  readonly features: readonly Feature[];
  readonly changedIds: ReadonlySet<FeatureId>;
} {
  const forest = buildForest(features);
  const changedIds = new Set<FeatureId>();
  const next = features.map((f) => {
    if (f.kind !== FEATURE_KIND.Aggregate) return f;
    const desired = directChildIds(forest, f.id);
    if (sameIdList(f.childIds, desired)) return f;
    changedIds.add(f.id);
    return { ...f, childIds: desired };
  });
  return { features: next, changedIds };
}

function sameIdList(a: readonly FeatureId[], b: readonly FeatureId[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
  return true;
}
