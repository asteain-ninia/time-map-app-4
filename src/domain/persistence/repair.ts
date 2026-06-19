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

import { normalizeSeries } from '../anchor-series';
import type { Feature } from '../feature';
import { withParentId } from '../feature';
import type { Calendar } from '../time/calendar';
import type { FeatureId } from '../ids';
import { checkConsistency, INCONSISTENCY, type Inconsistency } from './consistency';
import type { DomainProject, FeatureHistory } from './serialize';

// --- repair option descriptors ----------------------------------------------

export const REPAIR_OPTION = {
  /** 存在しない頂点参照 → 当該地物を除外する。 */
  DropFeatureWithMissingVertex: 'drop-feature-missing-vertex',
  /** ツリー位相不整合 → 親参照を切って最上位化する。 */
  DetachToTopLevel: 'detach-to-top-level',
  /** ツリー位相不整合 → 当該地物を除外する。 */
  DropTopologyFeature: 'drop-topology-feature',
  /** 形状保持規則違反 → 当該地物を除外する。 */
  DropShapeRoleFeature: 'drop-shape-role-feature',
  /** 末端排他違反 / 錨間オーバーラップ → 当該地物の一方を除外する。 */
  DropOverlappingFeature: 'drop-overlapping-feature',
  /** 親=下位和不一致 → 当該集約地物を除外する（下位は最上位化）。 */
  DropAggregateFeature: 'drop-aggregate-feature',
  /** 時間矛盾 → 錨列を昇順に整列・重複解消（U09 normalizeSeries）。 */
  NormalizeSeries: 'normalize-series',
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
  [REPAIR_OPTION.DetachToTopLevel]: '親参照を解除して、この地物を最上位に変更します。',
  [REPAIR_OPTION.DropTopologyFeature]: '階層が壊れている地物を読み込みから除外します。',
  [REPAIR_OPTION.DropShapeRoleFeature]: '形状の規則に違反している地物を読み込みから除外します。',
  [REPAIR_OPTION.DropOverlappingFeature]: '重なっている地物の一方を読み込みから除外します。',
  [REPAIR_OPTION.DropAggregateFeature]: '下位領域と一致しない集約地物を除外し、下位を最上位化します。',
  [REPAIR_OPTION.NormalizeSeries]: '錨を時間順に整列し、重複・矛盾を解消します。',
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
      return [opt(REPAIR_OPTION.DetachToTopLevel), opt(REPAIR_OPTION.DropTopologyFeature)];
    case INCONSISTENCY.ShapePreservation:
      return [opt(REPAIR_OPTION.DropShapeRoleFeature)];
    case INCONSISTENCY.TerminalExclusion:
    case INCONSISTENCY.AnchorSpatialOverlap:
      return [opt(REPAIR_OPTION.DropOverlappingFeature)];
    case INCONSISTENCY.AggregateSumMismatch:
      return [opt(REPAIR_OPTION.DropAggregateFeature)];
    case INCONSISTENCY.TimeConflict:
      return [opt(REPAIR_OPTION.NormalizeSeries)];
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
  return { histories, settings: project.settings, baseMap: project.baseMap };
}

/** Remove the given feature ids from every snapshot. */
function dropFeatures(project: DomainProject, ids: readonly FeatureId[]): DomainProject {
  const drop = new Set<FeatureId>(ids);
  return mapSnapshotFeatures(project, (features) => features.filter((f) => !drop.has(f.id)));
}

/** Detach the given feature ids to top-level (clear parentId) in every snapshot. */
function detachToTopLevel(project: DomainProject, ids: readonly FeatureId[]): DomainProject {
  const detach = new Set<FeatureId>(ids);
  return mapSnapshotFeatures(project, (features) =>
    features.map((f) => (detach.has(f.id) ? withParentId(f, undefined) : f)),
  );
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
  return { histories, settings: project.settings, baseMap: project.baseMap };
}

/** Drop the FIRST of the overlapping pair (deterministic: the lower-ordered id). */
function dropOneOfPair(project: DomainProject, ids: readonly FeatureId[]): DomainProject {
  const first = ids[0];
  return first === undefined ? project : dropFeatures(project, [first]);
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
  switch (optionId) {
    case REPAIR_OPTION.DropFeatureWithMissingVertex:
    case REPAIR_OPTION.DropTopologyFeature:
    case REPAIR_OPTION.DropShapeRoleFeature:
      return dropFeatures(project, inc.featureIds);
    case REPAIR_OPTION.DetachToTopLevel:
      return detachToTopLevel(project, inc.featureIds);
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
 * inconsistency no longer appears. Pure: builds and validates a new instance,
 * never touching the input (教訓5.22 / R2).
 */
export function applyRepairChecked(
  project: DomainProject,
  inc: Inconsistency,
  optionId: RepairOptionId,
  calendar: Calendar,
): RepairApplication {
  const repaired = applyRepair(project, inc, optionId, calendar);
  const remaining = checkConsistency(repaired, calendar);
  const resolved = !remaining.inconsistencies.some((other) => sameInconsistency(inc, other));
  return { project: repaired, resolved, remaining };
}
