// 保存の直前の整合検査（司令塔の決定 (3)、増分 7 の手直し 2 回目で年を見るように直した）。
//
// **これが守るもの**: アプリ自身が「開き直すと地物が失われるファイル」を書かないこと。
// 読み込み時の修復（consistency / repair）は *開くとき*の防波堤なので、書くときに
// 壊れていれば「開いたら直せますよ」と言われるだけで、書いた時点の記録は既に危うい。
//
// 見つけるものは 2 段に分かれる。
//
//   **止める**（どの年で見ても壊れている。修復で中身が落ちうる）:
//   1. 持ち主の居ない系列 — 歴史の持ち主が、その歴史のどの錨にも居ない。中に居候して
//      いる子の記録は、読み込みの修復で「中身を捨てる」を選ばれると丸ごと消える。
//   2. どの年にも居ない親を指す parentId — 親をどの年からも消したのに、子の parentId が
//      親を指したまま。
//
//   **聞く**（年をまたぐ食い違い。読み込みの検査は年ごとに見るので、開くと修復を聞かれる）:
//   3. その年に居ない親を指す parentId（親は別の年には居る）／集約地物の下位領域の並びがその年の
//      実際の所属と食い違う／集約地物にその年の下位領域が無い／その年の所属が輪になる、など。判定は読み込みの検査と同じ
//      `checkHierarchyOverTime`（同じ時刻の切り方・同じ判定）。**保存を止めて利用者を
//      行き止まりにしない**ために、理由（どの地物が・何年に・どの親を）を見せて
//      ［このまま保存する（次に開くときに修復されます）］［やめる］を選ばせる。
//
// 以前は親の存否を「全部の年に居る地物の集合」で見ていたので、親が別の年に居れば 3 を
// 通していた（`docs/現状.md` B67・GPT #4）。
//
// 純粋: 入力を変更せず、問題の一覧を返すだけ。文言の組み立てもここ 1 か所。

import { HIERARCHY_VIOLATION } from '../hierarchy/validate';
import type { FeatureId } from '../ids';
import { resolveAt } from '../anchor-series';
import type { Calendar } from '../time/calendar';
import type { TimePoint } from '../time/time-point';

import { emptyAggregateIntervals } from '../affiliation/interval-edit';

import { INCONSISTENCY, checkHierarchyOverTime } from './consistency';
import type { DomainProject } from './serialize';
import { PERSISTENCE_MESSAGES } from './messages';

/** 保存前に見つかった問題の種類。 */
export const PRE_SAVE_PROBLEM = {
  /** 歴史の持ち主が、その歴史のどの錨にも居ない（止める）。 */
  OrphanHistory: 'orphan-history',
  /** どの年にも居ない親を parentId が指している（止める）。 */
  DanglingParent: 'dangling-parent',
  /** その年に居ない親を指している（親は別の年には居る。聞く）。 */
  ParentAbsentThatYear: 'parent-absent-that-year',
  /** 集約地物の下位領域の並びが、その年の実際の所属と食い違う（聞く）。 */
  ChildListMismatch: 'child-list-mismatch',
  /** 集約地物にその年の下位領域が 1 件も無い（聞く）。 */
  EmptyAggregate: 'empty-aggregate',
  /** その年の所属が輪になる・最上位の印が食い違う、など（聞く）。 */
  OtherHierarchy: 'other-hierarchy',
} as const;

export type PreSaveProblemKind = (typeof PRE_SAVE_PROBLEM)[keyof typeof PRE_SAVE_PROBLEM];

export interface PreSaveProblem {
  readonly kind: PreSaveProblemKind;
  /** 持ち主の居ない系列ならその持ち主、親の食い違いならその子、子の並びならその集約地物。 */
  readonly featureId: FeatureId;
  /** 親を指しているときだけ、指している先。 */
  readonly parentId?: FeatureId;
  /** 年をまたぐ食い違い（聞く側）のときだけ、食い違っている年。 */
  readonly atTime?: TimePoint;
  /** 子の並びの食い違いのときだけ、食い違っている子。 */
  readonly relatedIds?: readonly FeatureId[];
  /**
   * 子の居ない集約地物のときだけ: 次に開いたとき、既定の修復（子の居ない区間だけ無くす）が
   * 効くか（4 回目 #1 (ii)。一度も子を持たない・自分の系列を持たない集約地物には効かない）。
   */
  readonly intervalRepairable?: boolean;
}

/** 保存を止める種類か（止めない種類は利用者に聞く）。 */
export function isBlockingPreSaveProblem(problem: PreSaveProblem): boolean {
  return (
    problem.kind === PRE_SAVE_PROBLEM.OrphanHistory ||
    problem.kind === PRE_SAVE_PROBLEM.DanglingParent
  );
}

/**
 * 保存しようとしている企画に、開き直すと地物が失われる形・修復を聞かれる形が混ざって
 * いないかを見る。見つからなければ空配列（空配列は真値＝「問題なし」）。
 */
export function checkBeforeSave(
  project: DomainProject,
  calendar: Calendar,
): readonly PreSaveProblem[] {
  const problems: PreSaveProblem[] = [];

  // すべての錨に居る地物 id を 1 度だけ集める（「どの年にも居ない」はこの集合で見る）。
  const alive = new Set<FeatureId>();
  for (const history of project.histories) {
    for (const entry of history.series.entries) {
      for (const f of entry.anchor.snapshot.features) alive.add(f.id);
    }
  }

  for (const history of project.histories) {
    const ownerPresent = history.series.entries.some((e) =>
      e.anchor.snapshot.features.some((f) => f.id === history.featureId),
    );
    if (!ownerPresent) {
      problems.push({ kind: PRE_SAVE_PROBLEM.OrphanHistory, featureId: history.featureId });
    }
  }

  const reported = new Set<string>();
  for (const history of project.histories) {
    for (const entry of history.series.entries) {
      for (const f of entry.anchor.snapshot.features) {
        const parentId = f.parentId;
        if (parentId === undefined) continue;
        if (alive.has(parentId)) continue;
        const key = `${String(f.id)}->${String(parentId)}`;
        if (reported.has(key)) continue;
        reported.add(key);
        problems.push({
          kind: PRE_SAVE_PROBLEM.DanglingParent,
          featureId: f.id,
          parentId,
        });
      }
    }
  }

  // 年をまたぐ食い違い（読み込みの検査と同じ判定）。上の「どの年にも居ない親」と同じ組は
  // 重ねて出さない。同じ地物・同じ種類は最初の年だけ出す（年の数だけ並べない）。
  const parentAt = (id: FeatureId, at: TimePoint): FeatureId | undefined => {
    for (const history of project.histories) {
      const r = resolveAt(history.series, at, calendar);
      if (r.kind !== 'present') continue;
      const f = r.entry.anchor.snapshot.features.find((x) => x.id === id);
      if (f !== undefined) return f.parentId;
    }
    return undefined;
  };
  const seenYearly = new Set<string>();
  for (const inc of checkHierarchyOverTime(project.histories, calendar)) {
    const head = inc.featureIds[0];
    if (head === undefined) continue;
    if (inc.detail === HIERARCHY_VIOLATION.DanglingParent) {
      const parentId = inc.atTime === undefined ? undefined : parentAt(head, inc.atTime);
      if (parentId === undefined || !alive.has(parentId)) continue; // 止める側で出している
      const key = `p:${String(head)}->${String(parentId)}`;
      if (seenYearly.has(key)) continue;
      seenYearly.add(key);
      problems.push({
        kind: PRE_SAVE_PROBLEM.ParentAbsentThatYear,
        featureId: head,
        parentId,
        ...(inc.atTime === undefined ? {} : { atTime: inc.atTime }),
      });
      continue;
    }
    if (inc.kind === INCONSISTENCY.ShapePreservation && inc.detail !== 'aggregate-no-children') {
      continue; // 形の無い末端などは保存前の検査の範囲外（読み込みの修復に任せる）
    }
    const kind =
      inc.detail === HIERARCHY_VIOLATION.ChildParentMismatch
        ? PRE_SAVE_PROBLEM.ChildListMismatch
        : inc.detail === 'aggregate-no-children'
          ? PRE_SAVE_PROBLEM.EmptyAggregate
          : PRE_SAVE_PROBLEM.OtherHierarchy;
    const key = `${kind}:${String(head)}`;
    if (seenYearly.has(key)) continue;
    seenYearly.add(key);
    problems.push({
      kind,
      featureId: head,
      relatedIds: inc.featureIds.slice(1),
      ...(inc.atTime === undefined ? {} : { atTime: inc.atTime }),
      ...(kind === PRE_SAVE_PROBLEM.EmptyAggregate
        ? { intervalRepairable: emptyAggregateIntervals(project.histories, head, calendar).length > 0 }
        : {}),
    });
  }

  return problems;
}

/** 保存を止めるときの文言。止める問題が無ければ `null`（＝止めない）。 */
export function preSaveBlockMessage(
  problems: readonly PreSaveProblem[],
  nameOf: (id: FeatureId) => string | undefined,
): string | null {
  const blocking = problems.filter(isBlockingPreSaveProblem);
  if (blocking.length === 0) return null;
  const orphans = blocking.filter((p) => p.kind === PRE_SAVE_PROBLEM.OrphanHistory);
  const dangling = blocking.filter((p) => p.kind === PRE_SAVE_PROBLEM.DanglingParent);
  const label = (id: FeatureId): string => nameOf(id) ?? String(id);
  const heads: string[] = [];
  if (orphans.length > 0) {
    const head = orphans[0];
    heads.push(
      orphans.length === 1
        ? PERSISTENCE_MESSAGES.preSaveOrphanOne(label(head!.featureId))
        : PERSISTENCE_MESSAGES.preSaveOrphanMany(orphans.length, label(head!.featureId)),
    );
  }
  if (dangling.length > 0) {
    const head = dangling[0];
    heads.push(
      dangling.length === 1
        ? PERSISTENCE_MESSAGES.preSaveDanglingOne(label(head!.featureId))
        : PERSISTENCE_MESSAGES.preSaveDanglingMany(dangling.length, label(head!.featureId)),
    );
  }
  return PERSISTENCE_MESSAGES.preSaveBlocked(heads.join(PERSISTENCE_MESSAGES.preSaveHeadSeparator));
}

/** 聞く板に並べる 1 行ごとの理由（止めない問題だけ）。名前で言う。 */
export function preSaveConfirmLines(
  problems: readonly PreSaveProblem[],
  nameOf: (id: FeatureId, at: TimePoint | undefined) => string | undefined,
  yearLabel: (at: TimePoint) => string,
): readonly string[] {
  const lines: string[] = [];
  for (const p of problems) {
    if (isBlockingPreSaveProblem(p)) continue;
    const at = p.atTime;
    const year = at === undefined ? '' : yearLabel(at);
    const name = (id: FeatureId): string => nameOf(id, at) ?? nameOf(id, undefined) ?? String(id);
    // **次に開くときに、既定の修復が実際に何をするか**まで言う（増分 7 の手直し 3 回目 1-3）。
    // 既定の修復はどれも区間の単位で、ほかの年の記録には触らない（`repair.ts` の先頭の方法）。
    if (p.kind === PRE_SAVE_PROBLEM.ParentAbsentThatYear && p.parentId !== undefined) {
      lines.push(
        PERSISTENCE_MESSAGES.preSaveParentAbsent(name(p.featureId), year, name(p.parentId)) +
          PERSISTENCE_MESSAGES.preSaveParentAbsentRepair,
      );
    } else if (p.kind === PRE_SAVE_PROBLEM.ChildListMismatch) {
      const related = (p.relatedIds ?? []).map(name).join(PERSISTENCE_MESSAGES.preSaveRelatedSeparator);
      lines.push(
        (related === ''
          ? PERSISTENCE_MESSAGES.preSaveChildListMismatch(name(p.featureId), year)
          : PERSISTENCE_MESSAGES.preSaveChildListMismatchWithRelated(name(p.featureId), year, related)) +
          PERSISTENCE_MESSAGES.preSaveChildListMismatchRepair,
      );
    } else if (p.kind === PRE_SAVE_PROBLEM.EmptyAggregate) {
      // 既定の修復が効く形のときだけ「無くします」と言う。効かない形（どの年にも下位領域が無い・
      // 自分の年表を持たない）は、開くと聞かれることを正直に言う（4 回目 #1 (ii)）。
      lines.push(
        PERSISTENCE_MESSAGES.preSaveEmptyAggregate(name(p.featureId), year) +
          (p.intervalRepairable === true
            ? PERSISTENCE_MESSAGES.preSaveEmptyAggregateRepairable(name(p.featureId))
            : PERSISTENCE_MESSAGES.preSaveEmptyAggregateAsk),
      );
    } else {
      lines.push(
        PERSISTENCE_MESSAGES.preSaveTopologyOther(name(p.featureId), year),
      );
    }
  }
  return lines;
}
