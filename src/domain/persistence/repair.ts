// U14 — user-selectable AUTO-REPAIR options for the FR-106 inconsistencies, and
// their pure application (input project → repaired project), with a re-validation
// guard.
//
// 教訓5.22 / R2: a repair is applied to a NEW instance; the input project is
// never mutated. After applying we RE-RUN the consistency check (and the schema
// round-trip) so a repair that does not actually resolve the issue — or that
// introduces a new one — is reported rather than silently accepted (受け入れ基準5).
//
// Repair OPTIONS are offered per inconsistency kind (spec §修復オプションの例).
// Each option is a pure descriptor (id + 日本語 label + a kind it applies to);
// applying an option transforms the project. We deliberately do NOT share a
// single repair routine across kinds whose exclusion rules differ (教訓5.30 過剰
// 共有の戒め): each kind gets its own apply function.
//
// Time-conflict repair (FR-106 f) re-orders / de-overlaps the series via the U09
// `normalizeSeries` — the SINGLE owner of the time-reorg rules (单一真实源). It can
// never produce a 0-entry series (受け入れ基準5: 錨列が0件になる結果は許可しない):
// normalizeSeries preserves at least the entries it is given, and we never call
// it with an empty list.
//
// Pure & framework-free.

import { createAnchor, createAnchorSnapshot } from '../anchor';
import {
  createAnchorEntry,
  normalizeSeries,
  resolveAt,
  withUniqueAnchorId,
  type AnchorEntry,
} from '../anchor-series';
import { deriveAnchorId } from '../anchor-id';
import type { Feature, LeafFeature } from '../feature';
import {
  FEATURE_KIND,
  createLeafFeature,
  pruneVertexStore,
  referencedVertexIds,
  withAggregateChildIds,
  withParentId,
} from '../feature';
import { materializeOwnSeries } from '../affiliation/materialize';
import {
  absentParentIntervals,
  clearParentWithin,
  cutSeries,
  emptyAggregateIntervals,
  presenceOf,
  subtractIntervals,
  syncAggregateChildIds,
  type TimeInterval,
} from '../affiliation/interval-edit';
import { buildForest, directChildIds } from '../hierarchy/forest';
import { resolveFeatureArea } from '../hierarchy/resolve-shape';
import { HIERARCHY_VIOLATION, areasEqualWithinTolerance } from '../hierarchy/validate';
import { buildDirectDomainForLeaf, promoteFeature, type DirectDomainMintPorts } from '../promotion';
import { createIdGeneratorState, nextRawId } from '../id-generator';
import type { Calendar } from '../time/calendar';
import { compare } from '../time/normalized';
import type { TimePoint } from '../time/time-point';
import {
  asAnchorId,
  asFeatureId,
  asRingId,
  asVertexId,
  idToString,
  type FeatureId,
  type VertexId,
} from '../ids';
import { createVertex, createVertexStore, type Vertex, type VertexStore } from '../vertex';
import { coordinatesEqual } from '../coordinate';
import {
  checkConsistency,
  INCONSISTENCY,
  SHAPE_DETAIL_LEAF_WITH_CHILDREN,
  type Inconsistency,
} from './consistency';
import type { DomainProject, FeatureHistory } from './serialize';

// --- repair option descriptors ----------------------------------------------

export const REPAIR_OPTION = {
  /** 存在しない頂点参照 → 当該地物を除外する。 */
  DropFeatureWithMissingVertex: 'drop-feature-missing-vertex',
  /** ツリー位相不整合 → 親参照を切って最上位化する（全部の年で）。 */
  DetachToTopLevel: 'detach-to-top-level',
  /**
   * その年に居ない親を指している → **親が居ない区間だけ**最上位にする（増分 7 の手直し 3 回目 1-2。
   * ほかの年の所属はそのまま。既定）。
   */
  DetachToTopLevelWithin: 'detach-to-top-level-within',
  /**
   * 下位領域が 1 件も無いまとめ役 → **子の居ない区間だけ**そのまとめ役を無くす（子の居る年の記録は
   * そのまま。増分 7 の手直し 3 回目 1-2。既定）。一度も子を持たないまとめ役には効かない。
   */
  RemoveEmptyAggregateIntervals: 'remove-empty-aggregate-intervals',
  /** ツリー位相不整合 → 当該地物を除外する。 */
  DropTopologyFeature: 'drop-topology-feature',
  /** 集約の childIds と parentId の乖離 → childIds を parentId から再構築する。 */
  ReconcileChildIds: 'reconcile-child-ids',
  /** 形状保持規則違反 → 当該地物を除外する。 */
  DropShapeRoleFeature: 'drop-shape-role-feature',
  /**
   * 形状保持規則違反（子を持つ末端 = FR-35 末端→集約 過渡状態）→ FR-37 直轄領（元形状−子の和）
   * を実体化して当該末端を集約地物へ昇格する（面積保存・地物削除ゼロの非破壊修復）。
   */
  MaterializeDirectDomain: 'materialize-direct-domain',
  /** リング階層不整合（穴の親不在・包含/交差違反など）→ 当該地物を除外する。 */
  DropRingHierarchyFeature: 'drop-ring-hierarchy-feature',
  /** 末端排他違反 / 錨間オーバーラップ → 当該地物の一方を除外する。 */
  DropOverlappingFeature: 'drop-overlapping-feature',
  /** 親=下位和不一致 → 当該集約地物を除外する（下位は最上位化）。 */
  DropAggregateFeature: 'drop-aggregate-feature',
  /** 時間矛盾 → 錨列を昇順に整列・重複解消（U09 normalizeSeries）。 */
  NormalizeSeries: 'normalize-series',
  /** 孤立した歴史（所有地物が全スナップショットに不在）→ 当該歴史を除外する。 */
  DropOrphanHistory: 'drop-orphan-history',
  /**
   * 孤立した歴史 → **中に居る地物ごとに系列を起こす**（中身を捨てない救済。司令塔の決定 (3)）。
   * 持ち主が居なくなった歴史でも、その錨には子や孫の記録がそのまま残っていることが多い。
   * 中身を捨てると実データで数十件の地物が丸ごと消えるので、こちらを既定にする。
   */
  MaterializeOrphanHistory: 'materialize-orphan-history',
  /** 同一地物を所有する重複した歴史 → 先頭のみ残し、重複分を除外する。 */
  DropDuplicateOwnerHistories: 'drop-duplicate-owner-histories',
  /** 共有頂点の座標が歴史間で食い違う → 全スナップショットを最初の座標へ揃える。 */
  ReconcileVertexCoordinate: 'reconcile-vertex-coordinate',
} as const;

export type RepairOptionId = (typeof REPAIR_OPTION)[keyof typeof REPAIR_OPTION];

export interface RepairOption {
  readonly id: RepairOptionId;
  /** 日本語 label shown to the user (FR-115). */
  readonly label: string;
  /** The inconsistency kind this option resolves. */
  readonly appliesTo: Inconsistency['kind'];
}

const LABELS: Readonly<Record<RepairOptionId, string>> = {
  [REPAIR_OPTION.DropFeatureWithMissingVertex]:
    '存在しない頂点を参照している地物を読み込みから除外します。',
  [REPAIR_OPTION.DetachToTopLevel]: '親参照を解除して、この地物を最上位に変更します（全部の年で）。',
  [REPAIR_OPTION.DetachToTopLevelWithin]:
    '上位領域が居ない年の間だけ、この地物を最上位にします（ほかの年の所属と記録はそのまま残ります）。',
  [REPAIR_OPTION.RemoveEmptyAggregateIntervals]:
    '下位領域が 1 件も居ない年の間だけ、このまとめ役を無くします（下位領域の居る年の記録はそのまま残ります）。',
  [REPAIR_OPTION.DropTopologyFeature]: '階層が壊れている地物を読み込みから除外します。',
  [REPAIR_OPTION.ReconcileChildIds]:
    '集約地物の下位領域一覧（childIds）を、各地物の親参照（parentId）に合わせて再構築します。',
  [REPAIR_OPTION.DropShapeRoleFeature]: '形状の規則に違反している地物を読み込みから除外します。',
  [REPAIR_OPTION.MaterializeDirectDomain]:
    '直轄領（元の形状から下位領域を除いた領域）を生成して集約化し、元の領域を保持したまま修復します（地物は削除しません）。',
  [REPAIR_OPTION.DropRingHierarchyFeature]:
    'リング階層（領土と穴の入れ子関係・包含）が壊れている地物を読み込みから除外します。',
  [REPAIR_OPTION.DropOverlappingFeature]: '重なっている地物の一方を読み込みから除外します。',
  [REPAIR_OPTION.DropAggregateFeature]: '下位領域と一致しない集約地物を除外し、下位を最上位化します。',
  [REPAIR_OPTION.NormalizeSeries]: '錨を時間順に整列し、重複・矛盾を解消します。',
  [REPAIR_OPTION.DropOrphanHistory]:
    '所有する地物が存在しない歴史（空のタイムライン）を読み込みから除外します。',
  [REPAIR_OPTION.MaterializeOrphanHistory]:
    '持ち主の居ない歴史の中に残っている地物を、全部の年ぶん地物ごとの歴史へ移します（地物は削除しません）。',
  [REPAIR_OPTION.DropDuplicateOwnerHistories]:
    '同一地物を所有する歴史が複数あるとき、先頭の歴史のみを残して重複分を読み込みから除外します。',
  [REPAIR_OPTION.ReconcileVertexCoordinate]:
    '同一の頂点が歴史間で異なる座標を持つとき、最初に現れた座標へすべて揃えます。',
};

/**
 * The repair options offered for one inconsistency (1 つ以上, 受け入れ基準5). The
 * order is the recommended presentation order; the first is the default.
 */
export function repairOptionsFor(inc: Inconsistency): RepairOption[] {
  const opt = (id: RepairOptionId): RepairOption => ({
    id,
    label: LABELS[id],
    appliesTo: inc.kind,
  });
  switch (inc.kind) {
    case INCONSISTENCY.MissingVertexReference:
      return [opt(REPAIR_OPTION.DropFeatureWithMissingVertex)];
    case INCONSISTENCY.TreeTopology:
      // A childIds⇔parentId divergence is repaired by REBUILDING childIds from the
      // authoritative parent relation (the source of truth the whole hierarchy /
      // shape path reads). Detach / drop are still offered as fallbacks. Other
      // topology sub-causes (cycle / dangling-parent / top-level-flag) keep the
      // original detach / drop options only.
      if (inc.detail === HIERARCHY_VIOLATION.ChildParentMismatch) {
        return [
          opt(REPAIR_OPTION.ReconcileChildIds),
          opt(REPAIR_OPTION.DetachToTopLevel),
          opt(REPAIR_OPTION.DropTopologyFeature),
        ];
      }
      // その年に居ない親を指す形は、**親が居ない区間だけ**外すのを既定にする（増分 7 の手直し
      // 3 回目 1-2）。全部の年で外すと、ほかの年の正しい所属まで消える。
      if (inc.detail === HIERARCHY_VIOLATION.DanglingParent) {
        return [
          opt(REPAIR_OPTION.DetachToTopLevelWithin),
          opt(REPAIR_OPTION.DetachToTopLevel),
          opt(REPAIR_OPTION.DropTopologyFeature),
        ];
      }
      return [opt(REPAIR_OPTION.DetachToTopLevel), opt(REPAIR_OPTION.DropTopologyFeature)];
    case INCONSISTENCY.ShapePreservation:
      // A declared LEAF that has ACQUIRED children (detail=leaf-with-children) is the
      // FR-35 末端→集約 過渡状態 the add flow legitimately leaves behind (resolve-shape /
      // leaf-with-children-footprint pin it as a valid mid-state). It can be repaired
      // NON-DESTRUCTIVELY by materialising its FR-37 直轄領 (元形状 − 子の和) as a new 末端
      // child and promoting the leaf to a shapeless aggregate — 面積保存・地物削除ゼロ, the
      // same canonicalisation the 所属変更 commit performs. Offered FIRST (recommended);
      // Drop stays as a last-resort fallback. Other shape sub-causes (leaf-empty-shape /
      // aggregate-no-children) carry NO shape to materialise, so they keep Drop only.
      if (inc.detail === SHAPE_DETAIL_LEAF_WITH_CHILDREN) {
        return [
          opt(REPAIR_OPTION.MaterializeDirectDomain),
          opt(REPAIR_OPTION.DropShapeRoleFeature),
        ];
      }
      // 下位領域の居ないまとめ役は、**子の居ない区間だけ**無くすのを既定にする（増分 7 の手直し
      // 3 回目 1-2）。読み込みから除外すると、子の居た年の記録まで全部の年から消える。
      if (inc.detail === 'aggregate-no-children') {
        return [
          opt(REPAIR_OPTION.RemoveEmptyAggregateIntervals),
          opt(REPAIR_OPTION.DropShapeRoleFeature),
        ];
      }
      return [opt(REPAIR_OPTION.DropShapeRoleFeature)];
    case INCONSISTENCY.RingHierarchyInvalid:
      return [opt(REPAIR_OPTION.DropRingHierarchyFeature)];
    case INCONSISTENCY.TerminalExclusion:
    case INCONSISTENCY.AnchorSpatialOverlap:
      return [opt(REPAIR_OPTION.DropOverlappingFeature)];
    case INCONSISTENCY.AggregateSumMismatch:
      return [opt(REPAIR_OPTION.DropAggregateFeature)];
    case INCONSISTENCY.TimeConflict:
      return [opt(REPAIR_OPTION.NormalizeSeries)];
    case INCONSISTENCY.OrphanHistory:
      // **既定は「各地物に自分の年表を作って残す」**（所有者の裁定 2026-09-07。原則:
      // 削除以外でデータが勝手に消えるのは良くない）。持ち主が居ない歴史でも、その錨には
      // 子・孫の記録が残っている。「捨てる」は最後の手段として残す。
      //
      // 以前これを既定にできなかったのは、起こした系列を歴史の **末尾へ足していた**
      // からである。並びが変わると、時刻ごとの頂点の束（後に来た方が勝つ）と、食い違う
      // 頂点を揃える修復（先に見えた方を正とする）の勝ち負けが入れ替わり、重なりが一度
      // 隠れて次の修復で「新しい不整合」として現れる（seed 36002 / 36004）。後始末として
      // 起こした系列を写し元の位置に置くようにした（affiliation/materialize.ts）。
      return [
        opt(REPAIR_OPTION.MaterializeOrphanHistory),
        opt(REPAIR_OPTION.DropOrphanHistory),
      ];
    case INCONSISTENCY.DuplicateOwnerHistory:
      return [opt(REPAIR_OPTION.DropDuplicateOwnerHistories)];
    case INCONSISTENCY.VertexCoordinateDivergence:
      return [opt(REPAIR_OPTION.ReconcileVertexCoordinate)];
  }
}

// --- application: pure project transforms -----------------------------------

/** Map a per-snapshot feature transform across every anchor in every history. */
function mapSnapshotFeatures(
  project: DomainProject,
  transform: (features: readonly Feature[]) => Feature[],
): DomainProject {
  const histories: FeatureHistory[] = project.histories.map((h) => ({
    featureId: h.featureId,
    series: {
      entries: h.series.entries.map((e) => ({
        anchor: {
          id: e.anchor.id,
          snapshot: {
            features: transform(e.anchor.snapshot.features),
            vertices: e.anchor.snapshot.vertices,
          },
        },
        start: e.start,
        end: e.end,
      })),
    },
  }));
  // Spread the input so every optional project field (e.g. uiSettings, FR-109/110)
  // survives the transform; only `histories` is replaced. Rebuilding the project as
  // an explicit { histories, settings, baseMap } literal would silently DROP
  // uiSettings, leaving the domain root inconsistent after any repair.
  return { ...project, histories };
}

/**
 * Remove the given feature ids from every snapshot AND drop any FeatureHistory
 * those ids own. Dropping the snapshot occurrences alone would leave the owning
 * history (project.histories keyed by featureId) behind as a zombie/orphan series
 * whose snapshots no longer contain their owner feature — which the consistency
 * check `detectOrphanHistories` flags. Both must be removed atomically so a repair
 * cannot manufacture a new inconsistency (受け入れ基準5 適用後に新たな不整合を作らない).
 */
function dropFeatures(project: DomainProject, ids: readonly FeatureId[]): DomainProject {
  const drop = new Set<FeatureId>(ids);
  const filtered = mapSnapshotFeatures(project, (features) =>
    // Remove the targets AND scrub them from every SURVIVOR's references in BOTH
    // directions (教訓5.21): clear a parentId that points at a dropped feature
    // (else a dangling 上位領域参照 remains) AND drop the id from any aggregate's
    // childIds (else a dangling 下位領域参照 — the bug this repair previously
    // manufactured). Removing the feature alone left both kinds of dangling
    // reference behind, so the repaired project still failed validation.
    scrubReferences(
      features.filter((f) => !drop.has(f.id)),
      drop,
    ),
  );
  // Drop the histories owned by a removed feature (zombie-history prevention).
  const histories = filtered.histories.filter((h) => !drop.has(h.featureId));
  // Spread to preserve optional project fields (uiSettings); see mapSnapshotFeatures.
  return { ...filtered, histories };
}

/**
 * Scrub every reference to a removed id out of the surviving features, BOTH
 * directions (教訓5.21): clear a parentId pointing at a removed feature and drop
 * removed ids from any aggregate's childIds. Pure: returns a new feature list,
 * reusing unchanged feature instances.
 */
function scrubReferences(
  features: readonly Feature[],
  removed: ReadonlySet<FeatureId>,
): Feature[] {
  return features.map((f) => {
    let next = f;
    if (next.parentId !== undefined && removed.has(next.parentId)) {
      next = withParentId(next, undefined);
    }
    if (next.kind === FEATURE_KIND.Aggregate) {
      const kept = next.childIds.filter((cid) => !removed.has(cid));
      if (kept.length !== next.childIds.length) {
        next = withAggregateChildIds(next, kept);
      }
    }
    return next;
  });
}

/**
 * Rebuild every aggregate's `childIds` from the authoritative parent relation so
 * the two encodings agree (FR-34 / U08 単一真実源). parentId is the source of truth the
 * whole hierarchy / shape path reads; childIds is the redundant view, so reconciling
 * means regenerating the view — never the other way (which could resurrect a child the
 * parent path already dropped). Pure.
 *
 * **時刻ごとに揃える**（増分 7 の手直し 2 回目 / バグ狩り §3）: 子が自分の系列を持つ
 * まとめ役（連邦化で束ねた・外から移した子）の子は、まとめ役の錨の中には居ない。錨 1 枚
 * だけで子を数え直すと子の並びが空になり、時刻ごとの検査では食い違いが残ったまま
 * （修復しても「解消できなかった」）になっていた。自分の系列を持つまとめ役は、時刻ごとの
 * 実際の所属で揃える（`syncAggregateChildIds`。区間の途中で子が出入りすれば錨を割る）。
 * 錨に居候しているまとめ役（自分の系列を持たない）だけは、従来どおりその錨の中で揃える。
 */
function reconcileChildIds(project: DomainProject, calendar: Calendar): DomainProject {
  const owners = new Set<FeatureId>(project.histories.map((h) => h.featureId));
  const perSnapshot = mapSnapshotFeatures(project, (features) => {
    const forest = buildForest(features);
    return features.map((f) => {
      if (f.kind !== FEATURE_KIND.Aggregate || owners.has(f.id)) return f;
      const derived = directChildIds(forest, f.id);
      if (idArraysEqual(f.childIds, derived)) return f;
      return withAggregateChildIds(f, [...derived]);
    });
  });
  const aggregateOwners: FeatureId[] = [];
  for (const h of perSnapshot.histories) {
    const isAggregate = h.series.entries.some((e) =>
      e.anchor.snapshot.features.some((f) => f.id === h.featureId && f.kind === FEATURE_KIND.Aggregate),
    );
    if (isAggregate) aggregateOwners.push(h.featureId);
  }
  return {
    ...perSnapshot,
    histories: syncAggregateChildIds(perSnapshot.histories, aggregateOwners, calendar),
  };
}

/** Order-sensitive id-array equality (avoids rebuilding an unchanged aggregate). */
function idArraysEqual(a: readonly FeatureId[], b: readonly FeatureId[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/** Detach the given feature ids to top-level (clear parentId) in every snapshot. */
function detachToTopLevel(project: DomainProject, ids: readonly FeatureId[]): DomainProject {
  const detach = new Set<FeatureId>(ids);
  return mapSnapshotFeatures(project, (features) =>
    features.map((f) => (detach.has(f.id) ? withParentId(f, undefined) : f)),
  );
}

/**
 * その年に居ない親を指している地物の親を、**親が居ない区間だけ**外す（増分 7 の手直し 3 回目 1-2）。
 * 地物が自分の系列を持たなければ、先に全部の年の記録を自分の系列へ起こす（中身は捨てない）。
 * 親の子の並びも時刻ごとに揃える。純粋。
 */
function detachWhereParentAbsent(
  project: DomainProject,
  ids: readonly FeatureId[],
  calendar: Calendar,
): DomainProject {
  let histories: readonly FeatureHistory[] = project.histories;
  for (const id of ids) {
    histories = materializeOwnSeries(histories, [id], calendar).histories;
    const parents = new Set<FeatureId>();
    for (const [parentId, intervals] of absentParentIntervals(histories, id, calendar)) {
      histories = clearParentWithin(histories, [id], parentId, intervals, calendar);
      parents.add(parentId);
    }
    if (parents.size > 0) histories = syncAggregateChildIds(histories, parents, calendar);
  }
  return histories === project.histories ? project : { ...project, histories };
}

/**
 * 下位領域の居ないまとめ役を、**子の居ない区間だけ**無くす（増分 7 の手直し 3 回目 1-2）。一度も
 * 子を持たないまとめ役・自分の系列を持たないまとめ役には効かない（そのまま返す ―― 未解決として
 * 次の方法を選ぶことになる）。上位領域の子の並びも時刻ごとに揃える。純粋。
 */
function removeEmptyAggregateIntervals(
  project: DomainProject,
  ids: readonly FeatureId[],
  calendar: Calendar,
): DomainProject {
  let histories: readonly FeatureHistory[] = project.histories;
  for (const id of ids) {
    const intervals = emptyAggregateIntervals(histories, id, calendar);
    if (intervals.length === 0) continue;
    const index = histories.findIndex((h) => h.featureId === id);
    const own = index >= 0 ? histories[index] : undefined;
    if (own === undefined) continue;
    const cut = cutSeries(own.series, id, intervals, calendar);
    histories = histories.map((h, i) => (i === index ? { featureId: id, series: cut } : h));
    const parents = new Set<FeatureId>();
    for (const entry of own.series.entries) {
      const parentId = entry.anchor.snapshot.features.find((f) => f.id === id)?.parentId;
      if (parentId !== undefined) parents.add(parentId);
    }
    if (parents.size > 0) histories = syncAggregateChildIds(histories, parents, calendar);
  }
  return histories === project.histories ? project : { ...project, histories };
}

/** Detach any feature whose parent is in `ids` (so children of a dropped aggregate survive). */
function detachChildrenOf(project: DomainProject, ids: readonly FeatureId[]): DomainProject {
  const parents = new Set<FeatureId>(ids);
  return mapSnapshotFeatures(project, (features) =>
    features.map((f) => (f.parentId !== undefined && parents.has(f.parentId)
      ? withParentId(f, undefined)
      : f)),
  );
}

/** Re-normalize the anchor series of the given feature histories (FR-106 f). */
function normalizeHistories(
  project: DomainProject,
  featureIds: readonly FeatureId[],
  calendar: Calendar,
): DomainProject {
  const target = new Set<FeatureId>(featureIds);
  const histories: FeatureHistory[] = project.histories.map((h) =>
    target.has(h.featureId)
      ? { featureId: h.featureId, series: normalizeSeries(h.series.entries, calendar) }
      : h,
  );
  // Spread to preserve optional project fields (uiSettings); see mapSnapshotFeatures.
  return { ...project, histories };
}

/** Remove the FeatureHistory entries owned by the given ids (orphan-history repair). */
function dropHistories(project: DomainProject, ids: readonly FeatureId[]): DomainProject {
  const drop = new Set<FeatureId>(ids);
  // **落とすのは孤立した歴史だけ**（増分 7 の手直し 項目 10）。歴史は持ち主 id で引かれる
  // ので、id が一致する歴史を全部落とすと、同じ id で **持ち主がちゃんと居る**重複した
  // 歴史まで巻き込んで地物が丸ごと失われていた（所有者の原則「削除以外でデータが勝手に
  // 消えるのは良くない」に反する）。判定は検出（`detectOrphanHistories`）と同じ述語。
  // Spread to preserve optional project fields (uiSettings); see mapSnapshotFeatures.
  return {
    ...project,
    histories: project.histories.filter((h) => !(drop.has(h.featureId) && isOrphanHistory(h))),
  };
}

/**
 * 持ち主が自分の歴史のどの錨にも居ない（孤立した歴史）か。検出
 * （`consistency.ts` の `detectOrphanHistories`）と同じ述語で、修復の側はこれ 1 本を見る。
 */
function isOrphanHistory(history: FeatureHistory): boolean {
  return !history.series.entries.some((e) =>
    e.anchor.snapshot.features.some((f) => f.id === history.featureId),
  );
}

/**
 * 孤立した歴史（持ち主 id が `ownerIds` に居て、かつ持ち主が居ない歴史）に居候している
 * 地物の id。**同じ持ち主 id の歴史が複数あっても、孤立した方だけを数える** ――
 * `residentFeatureIds` は最初に見つかった同 id の歴史を読むので、持ち主の居る重複が
 * 先に並んでいると起こす相手を取り違え、孤立した方の子を起こさないまま落としていた
 * （項目 10）。
 */
function orphanResidentIds(
  histories: readonly FeatureHistory[],
  ownerIds: readonly FeatureId[],
): readonly FeatureId[] {
  const owners = new Set<FeatureId>(ownerIds);
  const seen = new Set<FeatureId>();
  const out: FeatureId[] = [];
  for (const history of histories) {
    if (!owners.has(history.featureId) || !isOrphanHistory(history)) continue;
    for (const entry of history.series.entries) {
      for (const f of entry.anchor.snapshot.features) {
        if (seen.has(f.id)) continue;
        seen.add(f.id);
        if (histories.some((h) => h.featureId === f.id)) continue; // 既に自分の系列がある
        out.push(f.id);
      }
    }
  }
  return out;
}

/**
 * For each owner id in `ids`, keep only the FIRST FeatureHistory keyed by it and drop
 * the rest, collapsing a duplicate-owner timeline to a single deterministic one. The
 * first occurrence (file order) is authoritative; later duplicates are removed. The
 * remaining history is left intact (its snapshots are not touched), so this repair
 * never manufactures an orphan/missing-vertex issue out of the survivor. Pure.
 */
function dropDuplicateOwnerHistories(
  project: DomainProject,
  ids: readonly FeatureId[],
): DomainProject {
  const targets = new Set<FeatureId>(ids);
  const seen = new Set<FeatureId>();
  const histories = project.histories.filter((h) => {
    if (!targets.has(h.featureId)) return true;
    if (seen.has(h.featureId)) return false; // a later duplicate → drop.
    seen.add(h.featureId);
    return true; // the first occurrence → keep.
  });
  // Spread to preserve optional project fields (uiSettings); see mapSnapshotFeatures.
  return { ...project, histories };
}

/**
 * Reconcile a shared vertex whose coordinate diverges across histories to ONE canonical
 * coordinate (FR-106 拡張): the FIRST body seen for that id (in history → entry → store
 * order) is authoritative — the same reference the divergence detector compares against —
 * and every later snapshot body for that id is overwritten to match. This collapses the
 * same-id coordinate disagreement to a single source of truth (R6) without dropping any
 * feature, so the boundary re-joins rather than tearing. Pure: returns a new project,
 * reusing unchanged anchors/snapshots. A no-op when no snapshot carries the id.
 */
function reconcileVertexCoordinate(
  project: DomainProject,
  vertexId: VertexId,
): DomainProject {
  // The canonical coordinate for EVERY vertex id: the FIRST body seen for that id in
  // the detector's traversal order (history → entry → store). We collect ALL of them
  // up-front, then reconcile not only the named `vertexId` but every OTHER id whose
  // bodies also disagree across snapshots.
  //
  // Reconciling only the single named vertex is unsafe when MORE THAN ONE shared
  // vertex diverges at the same slice: the spatial checks ((d) terminal-exclusion /
  // (g) anchor-spatial-overlap) read the time-slice's last-write-wins MERGED store,
  // so while ONE divergent vertex is still present a feature's effective geometry can
  // overlap a neighbour's — meaning a per-vertex reconcile TRANSIENTLY manufactures a
  // terminal/spatial-overlap (a NEW inconsistency) that `applyRepairChecked` then
  // correctly refuses to certify, deadlocking the safe-repair fixpoint. Aligning all
  // co-divergent boundary vertices to their single source of truth (R6) in ONE
  // application restores the consistent base geometry atomically — matching this
  // option's stated intent (同一頂点の座標を…すべて揃える) — so the repair converges
  // without ever passing through a geometry-broken intermediate. Idempotent: on a
  // project with a single divergence it rewrites exactly that one vertex.
  void vertexId; // every divergent id is reconciled; the named one is included.
  //
  // **正とするのは「その錨の地物が実際に使っている」頂点の最初の版**（2026-10-03、
  // 裁定 (b) の後始末）。どの地物も参照していない頂点の版は、別の錨から紛れ込んだ
  // 写し（`pruneVertexStore` の注記にある「漏れた頂点」）であって座標の根拠にならない。
  // 以前は参照の有無を見ずに最初の版を正としていたので、孤立した歴史を救済して歴史の
  // 並びが変わると、紛れ込んだ版が「最初」になり、使われている形の方を壊して穴が外へ
  // はみ出した（性質検査 seed 36004）。参照されている版が 1 つも無い id だけ、従来どおり
  // 最初に見えた版を正とする。
  const canonicalById = new Map<VertexId, Vertex>();
  const firstSeenById = new Map<VertexId, Vertex>();
  for (const h of project.histories) {
    for (const e of h.series.entries) {
      const cited = new Set<VertexId>();
      for (const f of e.anchor.snapshot.features) {
        for (const id of referencedVertexIds(f)) cited.add(id);
      }
      for (const body of e.anchor.snapshot.vertices.byId.values()) {
        if (!firstSeenById.has(body.id)) firstSeenById.set(body.id, body);
        if (cited.has(body.id) && !canonicalById.has(body.id)) canonicalById.set(body.id, body);
      }
    }
  }
  for (const [id, body] of firstSeenById) {
    if (!canonicalById.has(id)) canonicalById.set(id, body);
  }
  if (canonicalById.size === 0) return project; // no vertices at all → nothing to do.

  const histories: FeatureHistory[] = project.histories.map((h) => ({
    featureId: h.featureId,
    series: {
      entries: h.series.entries.map((e) => {
        const store = e.anchor.snapshot.vertices;
        // Rewrite only the bodies that DISAGREE with their canonical coordinate, so an
        // anchor whose every vertex already matches keeps its referential identity.
        let byId: Map<VertexId, Vertex> | undefined;
        for (const body of store.byId.values()) {
          const canonical = canonicalById.get(body.id)!;
          if (coordinatesEqual(body.coordinate, canonical.coordinate)) continue;
          if (byId === undefined) byId = new Map(store.byId);
          byId.set(body.id, createVertex(body.id, canonical.coordinate));
        }
        if (byId === undefined) return e;
        return {
          anchor: {
            id: e.anchor.id,
            snapshot: {
              features: e.anchor.snapshot.features,
              vertices: { byId },
            },
          },
          start: e.start,
          end: e.end,
        };
      }),
    },
  }));
  // Spread to preserve optional project fields (uiSettings); see mapSnapshotFeatures.
  return { ...project, histories };
}

/** Drop the FIRST of the overlapping pair (deterministic: the lower-ordered id). */
function dropOneOfPair(project: DomainProject, ids: readonly FeatureId[]): DomainProject {
  const first = ids[0];
  return first === undefined ? project : dropFeatures(project, [first]);
}

// --- FR-37 直轄領 materialisation (NON-DESTRUCTIVE leaf-with-children repair) -----
//
// A declared LEAF that has ACQUIRED children (ShapePreservation detail=leaf-with-children)
// is the FR-35 末端→集約 過渡状態 the add flow legitimately leaves behind (resolve-shape /
// leaf-with-children-footprint pin it as a valid mid-state). At load it trips
// ShapePreservation, and the ONLY prior repair was DropShapeRoleFeature = DELETE the parent
// = 元領域 (元形状 − 子の和) の沈黙損失 (実ユーザーデータ損失). This repair instead does what the
// 所属変更 commit does at FR-37: materialise the 直轄領 (元形状 − 子の和) as a NEW 末端地物 child
// and promote the leaf to a shapeless aggregate — 面積保存・地物削除ゼロ.
//
// SINGLE SOURCE OF TRUTH (教訓 5.29): the 直轄領 geometry is built by the promotion unit's
// buildDirectDomainForLeaf (resolveLeafShape + 子の和 + seam 整列 差分 + buildDirectDomainShape)
// and the leaf→aggregate transition by promoteFeature — this module re-implements NO boolean
// ops / no geometry.
//
// ID SAFETY (最重要, 教訓 5.37 / 5.20): every minted id (直轄領 feature/vertex/ring) comes from
// a DETERMINISTIC generator SEEDED with EVERY raw id already in the project (collectRawIds,
// the domain twin of App の collectProjectRawIds) plus a FIXED time source, so the output is a
// pure, idempotent function of the input and every new id is DISJOINT from all existing ids.
// The 直轄領 feature id is minted ONCE and reused at every anchor the leaf is a
// leaf-with-children at, so a MULTI-ANCHOR leaf yields ONE 直轄領 identity whose history spans
// exactly the matching existence intervals; untouched anchors keep their own snapshot (FR-55).
//
// AREA GUARD (面積保存): checkAggregateShapes does NOT compare an aggregate against a former
// leaf shape (its own comment: inter-child gap のみ), so a rewrap / reparent bug would pass
// load-time re-validation while SILENTLY losing area — the exact bug class this repair exists to
// fix. We therefore assert resolveFeatureArea(leaf) is unchanged (within U08 tolerance) BEFORE
// committing each anchor; any mismatch / unresolved geometry BAILS the whole repair (returns the
// project UNCHANGED). applyRepairChecked then reports it Unresolved and the Drop fallback remains,
// so an imperfect materialisation can never corrupt or lose data (教訓 5.22 / 5.26).

/** Collect EVERY raw feature / vertex / ring id anywhere in the project (採番衝突回避 種). */
function collectRawIds(project: DomainProject): Set<string> {
  const ids = new Set<string>();
  for (const history of project.histories) {
    ids.add(idToString(history.featureId));
    for (const entry of history.series.entries) {
      const snap = entry.anchor.snapshot;
      for (const v of snap.vertices.byId.keys()) ids.add(idToString(v));
      for (const f of snap.features) {
        ids.add(idToString(f.id));
        if (f.kind === FEATURE_KIND.Point) ids.add(idToString(f.vertexId));
        else if (f.kind === FEATURE_KIND.Line) {
          for (const vid of f.vertexIds) ids.add(idToString(vid));
        } else if (f.kind === FEATURE_KIND.Leaf) {
          for (const ring of f.shape.rings) {
            ids.add(idToString(ring.id));
            for (const vid of ring.vertexIds) ids.add(idToString(vid));
          }
        }
      }
    }
  }
  return ids;
}

/** The combined EFFECTIVE state at `atTime`, matching the consistency check's view. */
function effectiveStateAt(
  project: DomainProject,
  atTime: TimePoint,
  calendar: Calendar,
): { readonly features: readonly Feature[]; readonly store: VertexStore } {
  const features: Feature[] = [];
  const seen = new Set<FeatureId>();
  const vertices: Vertex[] = [];
  for (const h of project.histories) {
    const res = resolveAt(h.series, atTime, calendar);
    if (res.kind !== 'present') continue;
    const snap = res.entry.anchor.snapshot;
    for (const f of snap.features) {
      if (seen.has(f.id)) continue; // dedup by id (one feature owns one effective state).
      seen.add(f.id);
      features.push(f);
    }
    for (const v of snap.vertices.byId.values()) vertices.push(v);
  }
  return { features, store: createVertexStore(vertices) };
}

/** A deterministic anchor id for a materialised 直轄領 entry (unique per leaf id + start). */
function directDomainAnchorId(ddId: FeatureId, start: TimePoint): string {
  return `repair-dd:${idToString(ddId)}@${timePointKey(start)}`;
}

function timePointKey(tp: TimePoint): string {
  switch (tp.granularity) {
    case 'year':
      return String(tp.year);
    case 'yearMonth':
      return `${tp.year}-${tp.month}`;
    case 'yearMonthDay':
      return `${tp.year}-${tp.month}-${tp.day}`;
  }
}

/** One anchor-entry rewrite: promote the leaf to its aggregate in a specific snapshot. */
interface LeafPromotion {
  readonly historyIndex: number;
  readonly entryIndex: number;
  readonly promoted: Feature;
}

/** One 直轄領 existence interval: the materialised leaf + its private vertices, [start,end). */
interface DirectDomainInterval {
  readonly start: TimePoint;
  readonly end: TimePoint | null;
  readonly directDomain: LeafFeature;
  readonly vertices: readonly Vertex[];
}

/**
 * Materialise the FR-37 直轄領 for a leaf-with-children inconsistency: at every anchor the
 * target leaf is a declared leaf that has children, replace the leaf with its shapeless
 * aggregate and generate a 直轄領 (元形状 − 子の和) child. Returns a NEW project (教訓 5.22);
 * on ANY unresolved geometry / area mismatch it returns the input project UNCHANGED so the
 * re-validation guard reports Unresolved rather than committing a lossy result.
 */
function materializeDirectDomain(
  project: DomainProject,
  inc: Inconsistency,
  calendar: Calendar,
): DomainProject {
  const targetId = inc.featureIds[0];
  if (targetId === undefined) return project;

  // Deterministic, project-disjoint id minting (教訓 5.37 / 5.20 / NFR 5.8): the generator
  // starts fresh, reads a FIXED time source, and skips every id already in the project, so
  // the result is a pure idempotent function of the input and every new id is disjoint.
  const reserved = collectRawIds(project);
  let gen = createIdGeneratorState();
  const now = (): number => 0;
  const mint = (prefix: string): string => {
    const r = nextRawId(prefix, gen, now, reserved);
    gen = r.state;
    reserved.add(r.value);
    return r.value;
  };
  // ONE 直轄領 feature identity for this leaf, reused across every anchor (多錨: 単一同一性).
  const ddId = asFeatureId(mint('f'));
  const ports: DirectDomainMintPorts = {
    nextVertexId: () => asVertexId(mint('v')),
    nextRingId: () => asRingId(mint('r')),
    nextFeatureId: () => asFeatureId(mint('f')),
  };

  const promotions: LeafPromotion[] = [];
  const intervals: DirectDomainInterval[] = [];

  for (let hi = 0; hi < project.histories.length; hi += 1) {
    const history = project.histories[hi]!;
    for (let ei = 0; ei < history.series.entries.length; ei += 1) {
      const entry = history.series.entries[ei]!;
      const here = entry.anchor.snapshot.features.find((f) => f.id === targetId);
      if (here === undefined || here.kind !== FEATURE_KIND.Leaf) continue; // not a leaf here.

      const atTime = entry.start;
      const { features, store } = effectiveStateAt(project, atTime, calendar);
      const forest = buildForest(features);
      const childIds = directChildIds(forest, targetId);
      if (childIds.length === 0) continue; // not a leaf-with-children at this anchor.

      const leaf = features.find((f) => f.id === targetId);
      if (leaf === undefined || leaf.kind !== FEATURE_KIND.Leaf) return project; // defensive.

      // 面積 BEFORE: a declared leaf-with-children resolves to 元形状 ∪ 子の和 (resolve-shape).
      const areaBefore = resolveFeatureArea(forest, store, targetId);
      if (areaBefore.status !== 'ok') return project;

      // 直轄領 geometry via the promotion unit's single source of truth (教訓 5.29).
      const built = buildDirectDomainForLeaf(leaf, forest, childIds, store, ports);
      if (built.kind === 'unresolved') return project; // 差分解決不能 → bail (元形状の沈黙損失防止).

      let directDomain: LeafFeature | undefined;
      let newVertices: readonly Vertex[] = [];
      let promotedChildIds: readonly FeatureId[] = childIds;
      if (built.kind === 'domain') {
        // Re-mint the 直轄領 under the ONE stable ddId (multi-anchor identity), keeping its
        // attributes / color / shape and parenting it to the promoted leaf. 分け残しの印は
        // 作り直しても運ぶ（所属変更・細分と **同じ印**を読み込みの修復も立てる。裁定
        // 2026-09-07）。印の有無は生成元（buildDirectDomainForLeaf）にそのまま従う。
        directDomain = createLeafFeature(
          ddId,
          built.directDomain.attributes,
          built.directDomain.color,
          built.directDomain.shape,
          {
            parentId: targetId,
            ...(built.directDomain.directDomain === true ? { directDomain: true as const } : {}),
          },
        );
        newVertices = built.newVertices;
        promotedChildIds = [...childIds, ddId];
      }
      // built.kind === 'empty' → 子が親を完全被覆 → pure aggregate, no 直轄領 needed.

      const promoted = promoteFeature(leaf, promotedChildIds);

      // 面積 AFTER = union(直轄領, 子) = 元形状 ∪ 子の和. Assert it equals BEFORE (面積保存 guard):
      // checkAggregateShapes will not catch an area loss here, so this is the sole guard.
      const afterFeatures: Feature[] = features.map((f) => (f.id === targetId ? promoted : f));
      if (directDomain !== undefined) afterFeatures.push(directDomain);
      const afterStore =
        directDomain !== undefined
          ? createVertexStore([...store.byId.values(), ...newVertices])
          : store;
      const areaAfter = resolveFeatureArea(buildForest(afterFeatures), afterStore, targetId);
      if (areaAfter.status !== 'ok') return project;
      if (!areasEqualWithinTolerance(areaBefore.area, areaAfter.area)) return project; // 面積損失 → bail.

      promotions.push({ historyIndex: hi, entryIndex: ei, promoted });
      if (directDomain !== undefined) {
        intervals.push({ start: entry.start, end: entry.end, directDomain, vertices: newVertices });
      }
    }
  }

  if (promotions.length === 0) return project; // the leaf was never a leaf-with-children.

  const promotionByKey = new Map<string, Feature>();
  for (const p of promotions) promotionByKey.set(`${p.historyIndex}:${p.entryIndex}`, p.promoted);

  // Rewrite each affected anchor snapshot: swap the leaf for its aggregate and prune the now-
  // unreferenced shape vertices (削除は参照掃除まで 教訓 5.21; the aggregate cites no vertices,
  // its 元形状 survives as the separate 直轄領 history). Untouched anchors keep referential
  // identity (FR-55). Spread preserves optional project fields (uiSettings; see repair.ts spread).
  const histories: FeatureHistory[] = project.histories.map((history, hi) => {
    if (!promotions.some((p) => p.historyIndex === hi)) return history;
    const entries = history.series.entries.map((entry, ei) => {
      const promoted = promotionByKey.get(`${hi}:${ei}`);
      if (promoted === undefined) return entry;
      const snap = entry.anchor.snapshot;
      const features = snap.features.map((f) => (f.id === targetId ? promoted : f));
      return {
        anchor: {
          id: entry.anchor.id,
          snapshot: createAnchorSnapshot(features, pruneVertexStore(snap.vertices, features)),
        },
        start: entry.start,
        end: entry.end,
      };
    });
    return { featureId: history.featureId, series: { entries } };
  });

  // Append the 直轄領 as its OWN history (mirrors the 所属変更 apply's createdIds path): one
  // anchor per matching existence interval, ordered by start so the series is valid.
  if (intervals.length > 0) {
    const entries = [...intervals]
      .sort((a, b) => compare(a.start, b.start, calendar))
      .map((iv) => {
        const store = pruneVertexStore(createVertexStore([...iv.vertices]), [iv.directDomain]);
        const anchor = createAnchor(
          asAnchorId(directDomainAnchorId(ddId, iv.start)),
          createAnchorSnapshot([iv.directDomain], store),
        );
        return createAnchorEntry(anchor, iv.start, iv.end);
      });
    histories.push({ featureId: ddId, series: { entries } });
  }

  // Spread to preserve optional project fields (uiSettings); see mapSnapshotFeatures.
  return { ...project, histories };
}

/**
 * 孤立した歴史の居候のうち、**既に自分の系列を持っている**地物の記録を、その系列が
 * 覆っていない年の分だけ自分の系列へ時刻順に足す（増分 7 の手直し 2 回目 / 反証 #2・GPT #1）。
 *
 * 以前は「既に自分の系列がある」居候を起こさずに孤立した歴史ごと落としていたので、一部の
 * 年だけ自分の系列を持つ子の、その外の年の記録が黙って消えていた。同じ年に両方の記録が
 * あるときは自分の系列の側を正とし、中身が食い違っていた孤立した歴史の側の記録は数える
 * （`discarded`。修復の報告に件数を出す）。純粋。
 */
function mergeOrphanRecordsIntoOwnSeries(
  histories: readonly FeatureHistory[],
  ownerIds: readonly FeatureId[],
  residentsWithOwn: ReadonlySet<FeatureId>,
  calendar: Calendar,
): { readonly histories: readonly FeatureHistory[]; readonly discarded: number } {
  if (residentsWithOwn.size === 0) return { histories, discarded: 0 };
  const owners = new Set<FeatureId>(ownerIds);
  const additions = new Map<FeatureId, AnchorEntry[]>();
  let discarded = 0;
  for (const orphan of histories) {
    if (!owners.has(orphan.featureId) || !isOrphanHistory(orphan)) continue;
    const entries = orphan.series.entries;
    entries.forEach((entry, i) => {
      const next = entries[i + 1];
      const end =
        entry.end === null
          ? (next?.start ?? null)
          : next !== undefined && compare(next.start, entry.end, calendar) < 0
            ? next.start
            : entry.end;
      if (end !== null && compare(entry.start, end, calendar) >= 0) return;
      for (const f of entry.anchor.snapshot.features) {
        if (!residentsWithOwn.has(f.id)) continue;
        const own = histories.find((h) => h.featureId === f.id && !isOrphanHistory(h));
        if (own === undefined) continue;
        const covered = presenceOf(own.series, calendar);
        const record: TimeInterval = { start: entry.start, end };
        const uncovered = subtractIntervals([record], covered, calendar);
        const store = pruneVertexStore(entry.anchor.snapshot.vertices, [f]);
        const list = additions.get(f.id) ?? [];
        for (const piece of uncovered) {
          list.push(
            createAnchorEntry(
              createAnchor(deriveAnchorId(f.id, piece.start), createAnchorSnapshot([f], store)),
              piece.start,
              piece.end,
            ),
          );
        }
        additions.set(f.id, list);
        // 覆われていた年に、自分の系列と違う中身があったか（あれば捨てた記録として数える）。
        const overlap = subtractIntervals([record], uncovered, calendar)[0];
        if (overlap !== undefined) {
          const r = resolveAt(own.series, overlap.start, calendar);
          const mine = r.kind === 'present' ? r.entry.anchor.snapshot.features.find((x) => x.id === f.id) : undefined;
          // 居なくなった持ち主を指す親は修復で外れるので、中身の比較では見ない。
          const comparable =
            f.parentId !== undefined && owners.has(f.parentId) ? withParentId(f, undefined) : f;
          const mineComparable =
            mine?.parentId !== undefined && owners.has(mine.parentId) ? withParentId(mine, undefined) : mine;
          if (mineComparable === undefined || JSON.stringify(mineComparable) !== JSON.stringify(comparable)) {
            discarded += 1;
          }
        }
      }
    });
  }
  if (additions.size === 0) return { histories, discarded };
  const out = histories.map((h) => {
    const extra = additions.get(h.featureId);
    if (extra === undefined || extra.length === 0 || isOrphanHistory(h)) return h;
    const merged: AnchorEntry[] = [...h.series.entries];
    for (const e of extra) merged.push(createAnchorEntry(withUniqueAnchorId(merged, e.anchor), e.start, e.end));
    return { featureId: h.featureId, series: normalizeSeries(merged, calendar) };
  });
  return { histories: out, discarded };
}

/**
 * 孤立した歴史（持ち主が全スナップショットに不在）の中に残っている地物を、地物ごとの
 * 歴史へ移す（司令塔の決定 (3)）。移し終えて空になった歴史は落とす。中身を捨てないので
 * 古いファイルの救済になる。既に自分の系列を持つ居候は、その系列が覆っていない年の記録を
 * 足す（{@link mergeOrphanRecordsIntoOwnSeries}）。純粋。
 */
function materializeOrphanHistories(
  project: DomainProject,
  ownerIds: readonly FeatureId[],
  calendar: Calendar,
): DomainProject {
  return materializeOrphanHistoriesWithReport(project, ownerIds, calendar).project;
}

function materializeOrphanHistoriesWithReport(
  project: DomainProject,
  ownerIds: readonly FeatureId[],
  calendar: Calendar,
): { readonly project: DomainProject; readonly discarded: number } {
  // 起こす相手は **孤立した方の歴史の居候だけ**（項目 10。持ち主の居る同 id の歴史を
  // 読まない）。
  const residents = orphanResidentIds(project.histories, ownerIds);
  const withOwn = orphanResidentsWithOwnSeries(project.histories, ownerIds);
  const merged = mergeOrphanRecordsIntoOwnSeries(project.histories, ownerIds, withOwn, calendar);
  const histories: readonly FeatureHistory[] = materializeOwnSeries(
    merged.histories,
    residents,
    calendar,
  ).histories;
  // 移し終えてもなお持ち主が居ない歴史は、もう中身が無い（あるいは中身が既に別の
  // 歴史を持っている）ので落とす。
  const orphan = new Set<FeatureId>(ownerIds);
  const remaining = histories.filter((h) => !orphan.has(h.featureId) || !isOrphanHistory(h));
  // Spread to preserve optional project fields (uiSettings); see mapSnapshotFeatures.
  const moved: DomainProject = { ...project, histories: remaining };

  // **消えた親を指す parentId を残さない**（裁定「子は最上位へ昇格」/ 決定 (1)）。
  // 起こした地物の親は、その孤立した歴史の持ち主だったことが多く、その持ち主は
  // いま落としたところである。指したままにすると読み込みの階層検査が別の不整合を
  // 出し、修復が不動点へ収束しない（性質検査 seed=36004 が実際にそれを捕まえた）。
  const alive = new Set<FeatureId>();
  for (const history of moved.histories) {
    for (const entry of history.series.entries) {
      for (const f of entry.anchor.snapshot.features) alive.add(f.id);
    }
  }
  const dangling: FeatureId[] = [];
  for (const history of moved.histories) {
    for (const entry of history.series.entries) {
      for (const f of entry.anchor.snapshot.features) {
        if (f.parentId !== undefined && !alive.has(f.parentId)) dangling.push(f.id);
      }
    }
  }
  return {
    project: dangling.length === 0 ? moved : detachToTopLevel(moved, dangling),
    discarded: merged.discarded,
  };
}

/** 孤立した歴史の居候のうち、既に自分の系列を持つもの（{@link orphanResidentIds} の裏）。 */
function orphanResidentsWithOwnSeries(
  histories: readonly FeatureHistory[],
  ownerIds: readonly FeatureId[],
): ReadonlySet<FeatureId> {
  const owners = new Set<FeatureId>(ownerIds);
  const out = new Set<FeatureId>();
  for (const history of histories) {
    if (!owners.has(history.featureId) || !isOrphanHistory(history)) continue;
    for (const entry of history.series.entries) {
      for (const f of entry.anchor.snapshot.features) {
        if (histories.some((h) => h.featureId === f.id && !isOrphanHistory(h))) out.add(f.id);
      }
    }
  }
  return out;
}

/**
 * {@link applyRepair} と同じ修復を当て、**捨てた記録の件数**も返す（修復の報告に出す）。
 * 件数が出るのはいまのところ「各地物に自分の年表を作って残す」だけ（同じ年に自分の系列の
 * 記録と食い違う孤立した歴史の記録は、自分の系列の側を正として捨てる）。
 */
export function applyRepairWithReport(
  project: DomainProject,
  inc: Inconsistency,
  optionId: RepairOptionId,
  calendar: Calendar,
): { readonly project: DomainProject; readonly discardedRecords: number } {
  if (
    optionId === REPAIR_OPTION.MaterializeOrphanHistory &&
    repairOptionsFor(inc).some((o) => o.id === optionId)
  ) {
    const done = materializeOrphanHistoriesWithReport(project, inc.featureIds, calendar);
    return { project: done.project, discardedRecords: done.discarded };
  }
  return { project: applyRepair(project, inc, optionId, calendar), discardedRecords: 0 };
}

/**
 * Apply the chosen repair option for one inconsistency, returning a NEW project
 * (教訓5.22: the input is never mutated). Unknown / mismatched option↔kind pairs
 * return the project unchanged so a caller cannot accidentally corrupt state.
 */
export function applyRepair(
  project: DomainProject,
  inc: Inconsistency,
  optionId: RepairOptionId,
  calendar: Calendar,
): DomainProject {
  // GUARD (受け入れ基準5 / 教訓5.22): an option only describes a repair for the
  // inconsistency KIND it was offered for (repairOptionsFor). The switch below
  // dispatches purely on optionId and would otherwise apply e.g. a Drop*/Detach
  // transform to inc.featureIds regardless of whether that option was ever
  // offered for inc.kind — so a mismatched, replayed, or forged option↔inc pair
  // (e.g. DropAggregateFeature against a TimeConflict) would silently delete /
  // re-parent the arbitrary feature sitting at inc.featureIds[0]. Reject any
  // such pair by returning the project UNCHANGED (the input is never mutated),
  // so no repair runs that was not actually offered for this inconsistency.
  if (!repairOptionsFor(inc).some((o) => o.id === optionId)) return project;
  switch (optionId) {
    case REPAIR_OPTION.DropFeatureWithMissingVertex:
    case REPAIR_OPTION.DropTopologyFeature:
    case REPAIR_OPTION.DropShapeRoleFeature:
    case REPAIR_OPTION.DropRingHierarchyFeature:
      return dropFeatures(project, inc.featureIds);
    case REPAIR_OPTION.MaterializeDirectDomain:
      return materializeDirectDomain(project, inc, calendar);
    case REPAIR_OPTION.DetachToTopLevel:
      return detachToTopLevel(project, inc.featureIds);
    case REPAIR_OPTION.DetachToTopLevelWithin:
      return detachWhereParentAbsent(project, inc.featureIds, calendar);
    case REPAIR_OPTION.RemoveEmptyAggregateIntervals:
      return removeEmptyAggregateIntervals(project, inc.featureIds, calendar);
    case REPAIR_OPTION.ReconcileChildIds:
      return reconcileChildIds(project, calendar);
    case REPAIR_OPTION.DropOverlappingFeature:
      return dropOneOfPair(project, inc.featureIds);
    case REPAIR_OPTION.DropAggregateFeature: {
      // Drop the aggregate (first id) and re-parent its children to top-level so
      // the sub-regions are not orphaned (空配列は真値, 教訓5.18).
      const aggregateId = inc.featureIds[0];
      if (aggregateId === undefined) return project;
      const detached = detachChildrenOf(project, [aggregateId]);
      return dropFeatures(detached, [aggregateId]);
    }
    case REPAIR_OPTION.NormalizeSeries:
      return normalizeHistories(project, inc.featureIds, calendar);
    case REPAIR_OPTION.MaterializeOrphanHistory:
      return materializeOrphanHistories(project, inc.featureIds, calendar);
    case REPAIR_OPTION.DropOrphanHistory:
      return dropHistories(project, inc.featureIds);
    case REPAIR_OPTION.DropDuplicateOwnerHistories:
      return dropDuplicateOwnerHistories(project, inc.featureIds);
    case REPAIR_OPTION.ReconcileVertexCoordinate: {
      // The divergent vertex id rides in `detail` as `vertex:<id>` (see consistency.ts
      // detectVertexDivergence). Without it there is nothing to reconcile → no-op.
      const prefix = 'vertex:';
      if (inc.detail === undefined || !inc.detail.startsWith(prefix)) return project;
      const vertexId = asVertexId(inc.detail.slice(prefix.length));
      return reconcileVertexCoordinate(project, vertexId);
    }
  }
}

// --- re-validation guard (受け入れ基準5: 適用後に全不変条件を再検証) ----------

export interface RepairApplication {
  /** The project after the repair (a new instance). */
  readonly project: DomainProject;
  /** True iff the SPECIFIC inconsistency is gone AND no new one was introduced. */
  readonly resolved: boolean;
  /** The full report after applying (empty ⇔ fully consistent). */
  readonly remaining: ReturnType<typeof checkConsistency>;
}

/** Structural identity used to decide whether `inc` still appears after repair. */
function sameInconsistency(a: Inconsistency, b: Inconsistency): boolean {
  if (a.kind !== b.kind) return false;
  if (a.detail !== b.detail) return false;
  if (a.featureIds.length !== b.featureIds.length) return false;
  for (let i = 0; i < a.featureIds.length; i += 1) {
    if (a.featureIds[i] !== b.featureIds[i]) return false;
  }
  return true;
}

/**
 * Apply a repair AND re-validate (受け入れ基準5). Returns the repaired project, a
 * full re-check report, and a `resolved` flag that is true iff the targeted
 * inconsistency no longer appears AND the repair introduced NO new inconsistency
 * (受け入れ基準5: 適用後に新たな不整合を作らない). Pure: builds and validates a new
 * instance, never touching the input (教訓5.22 / R2).
 *
 * 教訓5.18 / R2: checking ONLY that the target disappeared is insufficient — a
 * repair that removes the target but manufactures a fresh violation (e.g. dropping
 * the sole missing-vertex child of an aggregate, leaving the aggregate childless →
 * a NEW AggregateSumMismatch / ShapePreservation / OrphanHistory) would otherwise
 * report resolved:true and let the UI commit a still-inconsistent project. So we
 * compare the BEFORE / AFTER reports and require that `remaining` contain no
 * inconsistency that was absent from the pre-repair report. Inconsistencies that
 * already existed (the project may carry several, repaired one at a time) are NOT
 * counted as "new", so resolving one issue at a time still progresses.
 */
export function applyRepairChecked(
  project: DomainProject,
  inc: Inconsistency,
  optionId: RepairOptionId,
  calendar: Calendar,
): RepairApplication {
  const before = checkConsistency(project, calendar);
  const repaired = applyRepair(project, inc, optionId, calendar);
  const remaining = checkConsistency(repaired, calendar);

  // (1) the SPECIFIC targeted inconsistency must be gone.
  const targetGone = !remaining.inconsistencies.some((other) => sameInconsistency(inc, other));
  // (2) NO inconsistency may appear in `remaining` that was absent BEFORE the
  // repair (a repair must never GROW the report — 受け入れ基準5). Pre-existing
  // inconsistencies are matched and consumed one-for-one so a duplicate that was
  // already present twice does not look "new" while a genuinely added duplicate
  // does. Anything left unmatched in `remaining` is freshly introduced.
  const introducedNothingNew = !hasNewInconsistency(before.inconsistencies, remaining.inconsistencies);

  const resolved = targetGone && introducedNothingNew;
  return { project: repaired, resolved, remaining };
}

/**
 * True iff `after` contains an inconsistency that is not accounted for by `before`
 * (i.e. the repair manufactured a NEW violation). Matching is one-for-one on
 * structural identity (sameInconsistency): each `before` entry can excuse at most
 * one `after` entry, so an entry whose multiplicity GREW counts as new.
 */
function hasNewInconsistency(
  before: readonly Inconsistency[],
  after: readonly Inconsistency[],
): boolean {
  const available = [...before];
  for (const a of after) {
    const idx = available.findIndex((b) => sameInconsistency(a, b));
    if (idx === -1) return true; // not present before → newly introduced.
    available.splice(idx, 1); // consume one matching pre-existing entry.
  }
  return false;
}
