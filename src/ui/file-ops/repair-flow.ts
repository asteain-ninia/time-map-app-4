// UI layer (U39): the load-time consistency auto-repair flow model (FR-106).
//
// PURE & framework-free (受け入れ基準 7 / NFR 5.8 / 教訓 5.41): turns U14's
// load-time consistency report into a view-model, tracks the user's per-
// inconsistency repair choice, decides whether the selection is complete, and
// applies the chosen repairs through U14's RE-VALIDATED apply (`applyRepairChecked`).
// No React / Canvas / Electron here; the modal renders this and Vitest drives
// every branch without a DOM.
//
// SINGLE SOURCE OF TRUTH (spec §C / 教訓 5.30):
//   - the 7 inconsistency kinds, the per-kind repair OPTIONS, and the apply +
//     re-validation logic are owned by U14 (`domain/persistence`). This module
//     NEVER re-implements detection or repair; it builds the option list from
//     U14's `repairOptionsFor(inc)` PER INCONSISTENCY, so the choices are derived
//     dynamically per kind and never shared across kinds (過剰共有の戒め).
//   - all 7 kinds are presentable: the option list comes straight from U14, so a
//     kind is never silently dropped (省略しない, 受け入れ基準 3).
//
// 教訓 5.22 適用: repairs are applied to NEW project instances and re-validated by
// U14 before the caller reflects them; the input project is never mutated and a
// repair that does not resolve / introduces a new issue is reported (受け入れ基準 3
// 末項「確定までドメイン現状態を破壊しない」).

import type { Calendar } from '../../domain/time/calendar';
import { idToString } from '../../domain/ids';
import {
  applyRepairChecked,
  repairOptionsFor,
  type ConsistencyReport,
  type DomainProject,
  type Inconsistency,
  type RepairOption,
  type RepairOptionId,
} from '../../domain/persistence/index';

// --- view-model: one row per inconsistency ----------------------------------

/**
 * One inconsistency row for the modal (spec §C 一覧表示): the kind, the related
 * feature names/ids, the 作中時刻 / 時間範囲 (when scoped), a sub-cause detail, and
 * the per-kind repair OPTIONS to choose from (built from U14, never shared across
 * kinds). `index` is the stable key matching the report order so a choice targets
 * the right row.
 */
export interface RepairRow {
  /** Stable index = position in the report's inconsistency list. */
  readonly index: number;
  readonly inconsistency: Inconsistency;
  /** The repair options offered for THIS inconsistency's kind (U14, 動的). */
  readonly options: readonly RepairOption[];
}

/** Build the per-inconsistency rows from a U14 report (option lists from U14). */
export function buildRepairRows(report: ConsistencyReport): RepairRow[] {
  return report.inconsistencies.map((inconsistency, index) => ({
    index,
    inconsistency,
    // 種別ごとに U14 から動的に取得 (過剰共有しない, 受け入れ基準 3).
    options: repairOptionsFor(inconsistency),
  }));
}

/**
 * A short Japanese summary line for one inconsistency (FR-115). Names the related
 * features; the kind-specific label lives in {@link INCONSISTENCY_LABELS}. Pure.
 */
export function describeInconsistency(inc: Inconsistency): string {
  const names = inc.featureNames.length > 0
    ? inc.featureNames.join('、')
    : inc.featureIds.map(idToString).join('、');
  return `${INCONSISTENCY_LABELS[inc.kind]}（対象: ${names}）`;
}

/** Japanese label per inconsistency kind (FR-115; all 7 kinds, 省略しない). */
export const INCONSISTENCY_LABELS = {
  'missing-vertex-reference': '存在しない頂点参照',
  'tree-topology': '階層（ツリー）構造の不整合',
  'shape-preservation': '形状保持規則の違反',
  'terminal-exclusion': '末端地物の重なり',
  'aggregate-sum-mismatch': '集約と下位領域の和の不一致',
  'time-conflict': '時間（錨列）の矛盾',
  'anchor-spatial-overlap': '同時刻の地物どうしの空間的重なり',
} as const satisfies Record<Inconsistency['kind'], string>;

// --- user choices (per-inconsistency repair option) -------------------------

/**
 * The user's in-flight choices: for each inconsistency index, the chosen repair
 * option id. An index ABSENT from the map is undecided (教訓 5.18: absence is
 * membership, not a falsy value). Transient; discarded on apply-success / abort.
 */
export type RepairChoices = ReadonlyMap<number, RepairOptionId>;

/** The empty choice set (the reset value, 教訓 5.2). */
export const EMPTY_REPAIR_CHOICES: RepairChoices = new Map();

/** Set / change the chosen option for one inconsistency; returns a NEW map. */
export function setRepairChoice(
  choices: RepairChoices,
  index: number,
  optionId: RepairOptionId,
): RepairChoices {
  const next = new Map(choices);
  next.set(index, optionId);
  return next;
}

/**
 * Whether EVERY inconsistency has a chosen option (受け入れ基準 3: 各不整合に対し
 * 選択). An EMPTY report is trivially complete (教訓 5.18: 空レポートは正当値 — no
 * choice needed). Decided by count, never by a falsy short-circuit.
 */
export function allChoicesMade(rows: readonly RepairRow[], choices: RepairChoices): boolean {
  for (const row of rows) {
    if (!choices.has(row.index)) return false;
  }
  return true;
}

// --- applying the chosen repairs (U14 re-validated) -------------------------

/** Why a repair-apply pass did not finish with a fully-consistent project. */
export const REPAIR_OUTCOME = {
  /** Every chosen repair applied AND the project is now fully consistent. */
  Applied: 'applied',
  /** Not every inconsistency has a chosen option yet (caller must collect more). */
  Incomplete: 'incomplete',
  /** A chosen repair did not resolve its issue / left the project inconsistent. */
  Unresolved: 'unresolved',
} as const;

export type RepairOutcomeKind = (typeof REPAIR_OUTCOME)[keyof typeof REPAIR_OUTCOME];

/** Result of applying the chosen repairs (discriminated; 教訓 5.26 戻り値で扱う). */
export type RepairApplyResult =
  | { readonly outcome: typeof REPAIR_OUTCOME.Applied; readonly project: DomainProject }
  | { readonly outcome: typeof REPAIR_OUTCOME.Incomplete }
  | {
      readonly outcome: typeof REPAIR_OUTCOME.Unresolved;
      /** The project after the partial repairs (a new instance; not yet reflected). */
      readonly project: DomainProject;
      /** The remaining report so the modal can re-present the still-broken rows. */
      readonly remaining: ConsistencyReport;
    };

/**
 * Apply the user's chosen repairs to a NEW project instance and re-validate via
 * U14 (受け入れ基準 3 / 教訓 5.22). Each chosen option is applied in report order
 * through U14's `applyRepairChecked`, which re-runs the full consistency check on
 * a fresh instance — so the input project is never mutated and the final report
 * decides success. Returns:
 *   - Applied   when all chosen AND the final re-check is clean,
 *   - Incomplete when a row has no chosen option (the caller collects more),
 *   - Unresolved when repairs ran but the project is still inconsistent (the
 *     caller re-presents `remaining`).
 *
 * The caller reflects the returned project into the domain ONLY on `Applied`
 * (spec §C: 修復後データが妥当である結果を受けてからドメインへ反映する).
 */
export function applyChosenRepairs(
  project: DomainProject,
  rows: readonly RepairRow[],
  choices: RepairChoices,
  calendar: Calendar,
): RepairApplyResult {
  if (!allChoicesMade(rows, choices)) {
    return { outcome: REPAIR_OUTCOME.Incomplete };
  }

  let current = project;
  let lastRemaining: ConsistencyReport = { ok: true, inconsistencies: [] };
  for (const row of rows) {
    const optionId = choices.get(row.index);
    // allChoicesMade guarantees presence; the guard keeps the type total.
    if (optionId === undefined) return { outcome: REPAIR_OUTCOME.Incomplete };
    const applied = applyRepairChecked(current, row.inconsistency, optionId, calendar);
    current = applied.project;
    lastRemaining = applied.remaining;
  }

  // The project is acceptable ONLY if the FINAL re-check is fully consistent
  // (教訓 5.18: emptiness decided by the report's flag/length, not a short-circuit).
  if (lastRemaining.ok && lastRemaining.inconsistencies.length === 0) {
    return { outcome: REPAIR_OUTCOME.Applied, project: current };
  }
  return { outcome: REPAIR_OUTCOME.Unresolved, project: current, remaining: lastRemaining };
}
