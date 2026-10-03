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
  REPAIR_OPTION,
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
 *
 * **内部の ID（`f-5-4` など）は出さない**（増分 8D / N-22・N-18、設計書 §H.1 の U-1）。
 * 名前が空の地物と、名前の代わりに ID が入っている地物（時間の矛盾は歴史の ID を名前の欄へ
 * 入れてくる）は「名前のない地物」と数で言う。
 */
export function describeInconsistency(inc: Inconsistency): string {
  return `${INCONSISTENCY_LABELS[inc.kind]}（対象: ${targetNamesOf(inc)}）`;
}

/** 対象の地物の呼び名（名前があるものは名前、無いものは「名前のない地物 N 件」）。 */
function targetNamesOf(inc: Inconsistency): string {
  const idTexts = new Set(inc.featureIds.map(idToString));
  const named: string[] = [];
  for (const raw of inc.featureNames) {
    const name = raw.trim();
    if (name.length === 0 || idTexts.has(name)) continue;
    if (!named.includes(name)) named.push(name);
  }
  const unnamed = Math.max(0, Math.max(inc.featureIds.length, inc.featureNames.length) - named.length);
  const parts = [...named];
  if (unnamed > 0 || parts.length === 0) {
    parts.push(`名前のない地物 ${String(Math.max(unnamed, 1))} 件`);
  }
  return parts.join('、');
}

/**
 * 不整合の **細かい理由**（`detail` は機械向けの符号）を画面の言葉にする（増分 8D / N-22）。
 * 知らない符号は **出さない**（`null`）―― 英語の符号をそのまま見せるより、種類の名前だけの
 * ほうが読める。
 */
export function describeInconsistencyDetail(inc: Inconsistency): string | null {
  const detail = inc.detail;
  if (detail === undefined) return null;
  const known = DETAIL_TEXT[detail];
  if (known !== undefined) return known;
  const missing = /^missing:(.*)$/.exec(detail);
  if (missing !== null) {
    const count = missing[1]!.split(',').filter((s) => s.length > 0).length;
    return `存在しない頂点を ${String(count)} 個参照しています。`;
  }
  if (detail.startsWith('vertex:')) return '同じ頂点の座標が歴史によって違います。';
  const count = /^count:(\d+)$/.exec(detail);
  if (count !== null) return `同じ地物の歴史が ${count[1]!} 本あります。`;
  return null;
}

/** `detail` の符号 → 画面の言葉（固定の符号だけ。数を含むものは上の関数が組み立てる）。 */
const DETAIL_TEXT: Readonly<Record<string, string>> = {
  'top-level-mismatch': '最上位かどうかの印と、親の有無が食い違っています。',
  cycle: '親をたどると自分に戻ってきます。',
  'dangling-parent': '親として指している地物が見つかりません。',
  'child-parent-mismatch': '下位領域の一覧と、各地物が指している親が食い違っています。',
  'duplicate-id': '同じ地物が複数あります。',
  'leaf-empty-shape': '形がありません。',
  'aggregate-no-children': '下位領域が 1 つもありません。',
  'leaf-with-children': '末端なのに下位領域を持っています。',
  'positive-area-overlap': '面積のある重なりがあります。',
  'inter-child-gap': '下位領域どうしのあいだに隙間があります。',
  'same-time-spatial-conflict': '同じ時刻に重なっています。',
  'owner-feature-absent': 'この歴史の持ち主の地物が、どの年にも居ません。',
};

/**
 * 修復方法の **画面の文**（増分 8D / N-22）。ふだんは U14 の文（`option.label`）をそのまま
 * 使う。**内部の項目名（`childIds` / `parentId`）を含む文だけを画面側で言い換える**。
 *
 * 全部の方法の写像を UI に持たない（`Record<RepairOptionId, string>` にしない）のは、
 * 修復方法の一覧が U14 の側で増えたり並び替わったりしても、画面が型で壊れないようにする
 * ため ―― 言い換えが要るものだけを部分的に持つ。
 */
export function repairOptionText(option: RepairOption): string {
  return REPAIR_OPTION_TEXT_OVERRIDES[option.id] ?? option.label;
}

const REPAIR_OPTION_TEXT_OVERRIDES: Partial<Record<RepairOptionId, string>> = {
  [REPAIR_OPTION.ReconcileChildIds]:
    'まとめ役の下位領域の一覧を、各地物が指している親に合わせて作り直します。',
};

/**
 * どの行も **最初の方法を選んだ状態**から始める（増分 8D / 設計書 §E.1 の V14 の手順 (b)）。
 * 修復方法の並びは「おすすめ順で、先頭が既定」（U14 の `repairOptionsFor`）。方法が 1 つしか
 * 無い行はラジオを出さないので、ここで選んでおかないと［修復して読み込む］が押せない。
 */
export function defaultRepairChoices(rows: readonly RepairRow[]): RepairChoices {
  let choices = EMPTY_REPAIR_CHOICES;
  for (const row of rows) {
    const first = row.options[0];
    if (first !== undefined) choices = setRepairChoice(choices, row.index, first.id);
  }
  return choices;
}

/** Japanese label per inconsistency kind (FR-115; all 7 kinds, 省略しない). */
export const INCONSISTENCY_LABELS = {
  'missing-vertex-reference': '存在しない頂点参照',
  'tree-topology': '階層（ツリー）構造の不整合',
  'shape-preservation': '形状保持規則の違反',
  'ring-hierarchy-invalid': 'リング階層（領土と穴の入れ子関係・包含）の不整合',
  'terminal-exclusion': '末端地物の重なり',
  'aggregate-sum-mismatch': '集約と下位領域の和の不一致',
  'time-conflict': '時間（錨列）の矛盾',
  'anchor-spatial-overlap': '同時刻の地物どうしの空間的重なり',
  'orphan-history': '所有地物が存在しない孤立した歴史',
  'duplicate-owner-history': '同一地物を所有する歴史の重複',
  'vertex-coordinate-divergence': '共有頂点の座標が歴史間で食い違っている',
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
