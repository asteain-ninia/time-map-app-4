// UI layer (U39): the load-time consistency auto-repair flow model (FR-106).
//
// PURE & framework-free (受け入れ基準 7 / NFR 5.8 / 教訓 5.41): turns U14's
// load-time consistency report into a view-model, tracks the user's per-
// inconsistency repair choice, decides whether the selection is complete, and
// applies the chosen repairs through U14 and re-validates the result ONCE at the end.
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
import { idToString, type FeatureId } from '../../domain/ids';
import { repairTargetLabel, type RepairNamer } from './repair-names';
import {
  KEEP_REPAIR_OPTIONS,
  REPAIR_OPTION,
  applyRepairWithReport,
  checkConsistency,
  repairOptionsFor,
  repairOptionsInContext,
  type ConsistencyReport,
  type DomainProject,
  type Inconsistency,
  type RepairOption,
  type RepairOptionId,
} from '../../domain/persistence/index';
import {
  INCONSISTENCY_LABEL_TEXT,
  REPAIR_DETAIL_TEXT,
  REPAIR_FLOW_TEXT,
  REPAIR_OPTION_OVERRIDE_TEXT,
  REPAIR_OPTION_TEXT,
} from './strings';

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
  /** 選択肢の並びを変えた理由（1 行。無ければ省略）。板の行に出す。 */
  readonly note?: string;
}

/**
 * 読み込んだプロジェクト（`context`）があれば、それを見て選択肢を並べる（2026-10-04、B39 の
 * 戻しの再検証のガード B: 分け残しを作る修復が何も変えられない子を持つ末端は「そのまま残す」が既定）。
 * 板と適用は **同じ context で** 行を作ること（並びが割れると既定が食い違う）。
 */
export interface RepairRowContext {
  readonly project: DomainProject;
  readonly calendar: Calendar;
}

/** Build the per-inconsistency rows from a U14 report (option lists from U14). */
export function buildRepairRows(report: ConsistencyReport, context?: RepairRowContext): RepairRow[] {
  return report.inconsistencies.map((inconsistency, index) => {
    if (context === undefined) {
      // 種別ごとに U14 から動的に取得 (過剰共有しない, 受け入れ基準 3).
      return { index, inconsistency, options: repairOptionsFor(inconsistency) };
    }
    const { options, note } = repairOptionsInContext(inconsistency, context.project, context.calendar);
    return { index, inconsistency, options, ...(note === undefined ? {} : { note }) };
  });
}

/**
 * A short Japanese summary line for one inconsistency (FR-115). Names the related
 * features; the kind-specific label lives in {@link INCONSISTENCY_LABELS}. Pure.
 *
 * **内部の ID（`f-5-4` など）は出さない**（増分 8D / N-22・N-18、設計書 §H.1 の U-1）。
 *
 * 増分 8D の手直し: 読み込んだプロジェクトから作った `namer`（{@link buildRepairNamer}）が
 * あれば、対象を **1 件ずつ名前で** 呼ぶ。名前が無ければ「名前のない面（1500年に作成）」。
 * 同じ名前の地物が並ぶときは作成年を添えて見分ける。歴史の行（時間の矛盾・重複した歴史）は
 * 「〈名前〉の歴史」、孤立した歴史は持ち主がどの年にも居ないので、中に入っている地物の名前で
 * 「持ち主の居ない歴史（中の地物: A、B ほか N 件）」と呼ぶ。
 * `namer` が無いとき（報告しか無い呼び出し）は名前の欄を使う。空の欄は「名前のない地物」、
 * ID が入っている欄は「名前の分からない地物」と数える（名前が無いとは言わない ―― 時間の矛盾・
 * 孤立した歴史・重複した歴史は、名前があっても欄に ID を入れてくるので、分からないだけ）。
 */
export function describeInconsistency(inc: Inconsistency, namer?: RepairNamer): string {
  const target = namer === undefined ? targetNamesFromReport(inc) : targetNamesFromProject(inc, namer);
  return REPAIR_FLOW_TEXT.describe(INCONSISTENCY_LABELS[inc.kind], target);
}

/** 歴史を単位にする種類（対象は「〈持ち主〉の歴史」と呼ぶ）。 */
const HISTORY_KINDS: ReadonlySet<Inconsistency['kind']> = new Set([
  'time-conflict',
  'duplicate-owner-history',
]);

/** 孤立した歴史の中身の名前を、いくつまで並べるか。 */
const ORPHAN_MEMBER_NAMES = 3;

/** プロジェクトから名前を引いて、対象を 1 件ずつ呼ぶ。 */
function targetNamesFromProject(inc: Inconsistency, namer: RepairNamer): string {
  if (inc.kind === 'orphan-history') {
    return inc.featureIds.map((id) => orphanHistoryLabel(id, namer)).join(REPAIR_FLOW_TEXT.listSeparator);
  }
  const infos = inc.featureIds.map((id) => namer.featureInfo(id));
  const nameCounts = new Map<string, number>();
  for (const info of infos) {
    if (info.name !== null) nameCounts.set(info.name, (nameCounts.get(info.name) ?? 0) + 1);
  }
  const labels = infos.map((info) =>
    repairTargetLabel(info, info.name !== null && (nameCounts.get(info.name) ?? 0) > 1),
  );
  if (HISTORY_KINDS.has(inc.kind)) return labels.map((label) => REPAIR_FLOW_TEXT.historyOf(label)).join(REPAIR_FLOW_TEXT.listSeparator);
  return labels.length === 0 ? REPAIR_FLOW_TEXT.unknownNameTarget : labels.join(REPAIR_FLOW_TEXT.listSeparator);
}

/** 孤立した歴史の呼び名（持ち主が居ないので、中に入っている地物の名前で呼ぶ）。 */
function orphanHistoryLabel(ownerId: FeatureId, namer: RepairNamer): string {
  const members = namer.historyMembers(ownerId) ?? [];
  if (members.length === 0) return REPAIR_FLOW_TEXT.orphanEmpty;
  const shown = members.slice(0, ORPHAN_MEMBER_NAMES).map((id) => repairTargetLabel(namer.featureInfo(id)));
  const rest = members.length - shown.length;
  const more = rest > 0 ? REPAIR_FLOW_TEXT.orphanMore(String(rest)) : '';
  return REPAIR_FLOW_TEXT.orphanWithMembers(shown.join(REPAIR_FLOW_TEXT.listSeparator), more);
}

/**
 * 報告の名前の欄だけで呼ぶ（プロジェクトが手元に無いとき）。**対象ごとに** 名前があるかを
 * 見る ―― 名前を重複なしに数えてから引き算すると、同じ名前の地物 2 件が「州、名前のない
 * 地物 1 件」になっていた（GPT 指摘 7）。
 */
function targetNamesFromReport(inc: Inconsistency): string {
  const count = Math.max(inc.featureIds.length, inc.featureNames.length);
  const named: string[] = [];
  let unnamed = 0;
  let unknown = 0;
  for (let i = 0; i < count; i += 1) {
    const raw = (inc.featureNames[i] ?? '').trim();
    const id = inc.featureIds[i];
    if (raw.length === 0) unnamed += 1;
    else if (id !== undefined && raw === idToString(id)) unknown += 1;
    else named.push(raw);
  }
  const parts = [...named];
  if (unnamed > 0) parts.push(REPAIR_FLOW_TEXT.unnamedCount(String(unnamed)));
  if (unknown > 0 || parts.length === 0) {
    parts.push(REPAIR_FLOW_TEXT.unknownCount(String(Math.max(unknown, 1))));
  }
  return parts.join(REPAIR_FLOW_TEXT.listSeparator);
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
    return REPAIR_FLOW_TEXT.missingVertices(String(count));
  }
  if (detail.startsWith('vertex:')) return REPAIR_FLOW_TEXT.vertexDiverges;
  const count = /^count:(\d+)$/.exec(detail);
  if (count !== null) return REPAIR_FLOW_TEXT.duplicateHistories(count[1]!);
  return null;
}

/** `detail` の符号 → 画面の言葉（固定の符号だけ。数を含むものは上の関数が組み立てる）。 */
const DETAIL_TEXT: Readonly<Record<string, string>> = {
  'top-level-mismatch': REPAIR_DETAIL_TEXT.topLevelMismatch,
  cycle: REPAIR_DETAIL_TEXT.cycle,
  'dangling-parent': REPAIR_DETAIL_TEXT.danglingParent,
  'child-parent-mismatch': REPAIR_DETAIL_TEXT.childParentMismatch,
  'duplicate-id': REPAIR_DETAIL_TEXT.duplicateId,
  'leaf-empty-shape': REPAIR_DETAIL_TEXT.leafEmptyShape,
  'aggregate-no-children': REPAIR_DETAIL_TEXT.aggregateNoChildren,
  'leaf-with-children': REPAIR_DETAIL_TEXT.leafWithChildren,
  'positive-area-overlap': REPAIR_DETAIL_TEXT.positiveAreaOverlap,
  'inter-child-gap': REPAIR_DETAIL_TEXT.interChildGap,
  'same-time-spatial-conflict': REPAIR_DETAIL_TEXT.sameTimeSpatialConflict,
  'owner-feature-absent': REPAIR_DETAIL_TEXT.ownerFeatureAbsent,
};

/**
 * 修復方法の **画面の文**（増分 8D / N-22）。ふだんは U14 の文（`option.label`）をそのまま
 * 使う。**内部の項目名（`childIds` / `parentId`）を含む文だけを画面側で言い換える**。
 *
 * 全部の方法の写像を UI に持たない（`Record<RepairOptionId, string>` にしない）のは、
 * 修復方法の一覧が U14 の側で増えたり並び替わったりしても、画面が型で壊れないようにする
 * ため ―― 言い換えが要るものだけを部分的に持つ。
 */
export function repairOptionText(
  option: RepairOption,
  inc?: Inconsistency,
  namer?: RepairNamer,
): string {
  // 孤立した歴史を「捨てる」方法は、中に何件の地物の記録があるかを言う（本体の取り込み）。
  // 持ち主が居ないだけで中身はあるので、件数を見せないと「空のものを片付ける」と読める。
  if (option.id === REPAIR_OPTION.DropOrphanHistory && inc !== undefined && namer !== undefined) {
    const members = inc.featureIds.reduce(
      (sum, id) => sum + (namer.historyMembers(id)?.length ?? 0),
      0,
    );
    return REPAIR_OPTION_TEXT.dropOrphanHistoryWithCount(members);
  }
  return REPAIR_OPTION_TEXT_OVERRIDES[option.id] ?? option.label;
}

/** 件数つきの方法の文（{@link repairOptionText}）。 */
export { REPAIR_OPTION_TEXT };

const REPAIR_OPTION_TEXT_OVERRIDES: Partial<Record<RepairOptionId, string>> = {
  [REPAIR_OPTION.ReconcileChildIds]: REPAIR_OPTION_OVERRIDE_TEXT.reconcileChildIds,
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
  'missing-vertex-reference': INCONSISTENCY_LABEL_TEXT.missingVertexReference,
  'tree-topology': INCONSISTENCY_LABEL_TEXT.treeTopology,
  'shape-preservation': INCONSISTENCY_LABEL_TEXT.shapePreservation,
  'ring-hierarchy-invalid': INCONSISTENCY_LABEL_TEXT.ringHierarchyInvalid,
  'terminal-exclusion': INCONSISTENCY_LABEL_TEXT.terminalExclusion,
  'aggregate-sum-mismatch': INCONSISTENCY_LABEL_TEXT.aggregateSumMismatch,
  'time-conflict': INCONSISTENCY_LABEL_TEXT.timeConflict,
  'anchor-spatial-overlap': INCONSISTENCY_LABEL_TEXT.anchorSpatialOverlap,
  'orphan-history': INCONSISTENCY_LABEL_TEXT.orphanHistory,
  'duplicate-owner-history': INCONSISTENCY_LABEL_TEXT.duplicateOwnerHistory,
  'vertex-coordinate-divergence': INCONSISTENCY_LABEL_TEXT.vertexCoordinateDivergence,
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
  | {
      readonly outcome: typeof REPAIR_OUTCOME.Applied;
      readonly project: DomainProject;
      /**
       * 修復で捨てた記録の件数（「各地物に自分の年表を作って残す」で、同じ年に自分の年表の
       * 記録と食い違っていた孤立した歴史の記録）。0 なら何も捨てていない。
       */
      readonly discardedRecords: number;
      /** 「そのまま残す」を選んで、残したまま読み込む不整合（前の回の分も含む）。無ければ省略可。 */
      readonly kept?: readonly Inconsistency[];
    }
  | { readonly outcome: typeof REPAIR_OUTCOME.Incomplete }
  | {
      readonly outcome: typeof REPAIR_OUTCOME.Unresolved;
      /** The project after the partial repairs (a new instance; not yet reflected). */
      readonly project: DomainProject;
      /** The remaining report so the modal can re-present the still-broken rows. */
      readonly remaining: ConsistencyReport;
      /** ここまでに捨てた記録の件数（やり直しが通ったときに合わせて知らせる）。 */
      readonly discardedRecords: number;
      /** ここまでに「そのまま残す」を選んだ不整合（やり直しへ持ち越す）。無ければ省略可。 */
      readonly kept?: readonly Inconsistency[];
    };

/**
 * 「そのまま残す」を選んだ不整合と同じもの（種類・内訳・対象の地物が同じ。年は問わない）か。
 * 子を持つ末端は親（先頭の id）で、重なりは組（id の集合）で見る。
 */
function sameKeptIssue(kept: Inconsistency, inc: Inconsistency): boolean {
  if (kept.kind !== inc.kind || kept.detail !== inc.detail) return false;
  if (kept.kind === 'shape-preservation') {
    return kept.featureIds[0] !== undefined && kept.featureIds[0] === inc.featureIds[0];
  }
  if (kept.featureIds.length === 0 || kept.featureIds.length !== inc.featureIds.length) return false;
  const a = [...kept.featureIds].map(String).sort();
  const b = [...inc.featureIds].map(String).sort();
  return a.every((id, i) => id === b[i]);
}

/**
 * Apply the user's chosen repairs to a NEW project instance and re-validate via
 * U14 (受け入れ基準 3 / 教訓 5.22). Each chosen option is applied in report order
 * through U14's `applyRepairWithReport` (pure — the input project is never mutated),
 * and the FINAL report decides success.
 *
 * **整合検査は最後に 1 回だけ回す**（増分 7 の手直し 2 回目 / バグ狩り 2-2）。以前は 1 行ごとに
 * `applyRepairChecked` を通し、行ごとに全体の整合検査を前後 2 回ずつ回していた（実データの
 * 76 行で 99.5 秒、画面が止まる）。行ごとの `resolved` はここでは使っておらず、受け入れの
 * 判断は最後の検査だけで決まるので、結果は変わらない。Returns:
 *   - Applied   when all chosen AND the final re-check is clean,
 *   - Incomplete when a row has no chosen option (the caller collects more),
 *   - Unresolved when repairs ran but the project is still inconsistent (the
 *     caller re-presents `remaining`).
 *
 * The caller reflects the returned project into the domain ONLY on `Applied`
 * (spec §C: 修復後データが妥当である結果を受けてからドメインへ反映する).
 *
 * **「そのまま残す」を選んだ行は、残ったままでよい**（2026-10-04、B39 の再検証 3-1）。
 * 子を持つ末端の行で `KeepLeafWithChildren` を選ぶと、その地物の同じ種類の不整合は最後の
 * 検査に残っていても受け入れる（ほかの行が全部解ければ `Applied`）。前の回で残すと決めた
 * 行は `previouslyKept` で渡す（やり直しの板で聞き直さない）。残した行は `kept` で返し、
 * 呼び手が読み込みのあとに件数を知らせる。
 */
export function applyChosenRepairs(
  project: DomainProject,
  rows: readonly RepairRow[],
  choices: RepairChoices,
  calendar: Calendar,
  previouslyKept: readonly Inconsistency[] = [],
): RepairApplyResult {
  if (!allChoicesMade(rows, choices)) {
    return { outcome: REPAIR_OUTCOME.Incomplete };
  }

  let current = project;
  let discardedRecords = 0;
  const kept: Inconsistency[] = [...previouslyKept];
  for (const row of rows) {
    const optionId = choices.get(row.index);
    // allChoicesMade guarantees presence; the guard keeps the type total.
    if (optionId === undefined) return { outcome: REPAIR_OUTCOME.Incomplete };
    if (KEEP_REPAIR_OPTIONS.has(optionId)) kept.push(row.inconsistency);
    const applied = applyRepairWithReport(current, row.inconsistency, optionId, calendar);
    current = applied.project;
    discardedRecords += applied.discardedRecords;
  }
  const checked: ConsistencyReport = checkConsistency(current, calendar);
  const stillOpen = checked.inconsistencies.filter((inc) => !kept.some((k) => sameKeptIssue(k, inc)));
  const lastRemaining: ConsistencyReport =
    stillOpen.length === checked.inconsistencies.length
      ? checked
      : { ok: stillOpen.length === 0, inconsistencies: stillOpen };

  // The project is acceptable ONLY if the FINAL re-check is fully consistent
  // (教訓 5.18: emptiness decided by the report's flag/length, not a short-circuit) —
  // 「そのまま残す」を選んだ行の分は除いて数える。
  if (lastRemaining.ok && lastRemaining.inconsistencies.length === 0) {
    return { outcome: REPAIR_OUTCOME.Applied, project: current, discardedRecords, kept };
  }
  return {
    outcome: REPAIR_OUTCOME.Unresolved,
    project: current,
    remaining: lastRemaining,
    discardedRecords,
    kept,
  };
}
