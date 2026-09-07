// 保存の直前の整合検査（司令塔の決定 (3)）。
//
// **これが守るもの**: アプリ自身が「開き直すと地物が失われるファイル」を書かないこと。
// 読み込み時の修復（consistency / repair）は *開くとき*の防波堤なので、書くときに
// 壊れていれば「開いたら直せますよ」と言われるだけで、書いた時点の記録は既に危うい。
// 増分 7 の実データで実際に起きたのは次の 2 つで、どちらもここで止める。
//
//   1. 持ち主の居ない系列 — 歴史の持ち主が、その歴史のどの錨にも居ない。中に居候して
//      いる子の記録は、読み込みの修復で「中身を捨てる」を選ばれると丸ごと消える。
//   2. 消えた親を指す parentId — 親をどの年からも消したのに、子の parentId が親を
//      指したまま。読み込みの階層検査に引っかかり、修復で子が落とされうる。
//
// どちらも「所属を動かすときは記録の置き場まで動かす」（決定 (1)）を守っていれば
// 起きない。起きたときは保存を止めて理由を出し、取り消しで戻れることを伝える。
//
// 純粋: 入力を変更せず、問題の一覧を返すだけ。文言の組み立てもここ 1 か所。

import type { FeatureId } from '../ids';

import type { DomainProject } from './serialize';

/** 保存前に見つかった問題の種類。 */
export const PRE_SAVE_PROBLEM = {
  /** 歴史の持ち主が、その歴史のどの錨にも居ない。 */
  OrphanHistory: 'orphan-history',
  /** どこにも居ない親を parentId が指している。 */
  DanglingParent: 'dangling-parent',
} as const;

export type PreSaveProblemKind = (typeof PRE_SAVE_PROBLEM)[keyof typeof PRE_SAVE_PROBLEM];

export interface PreSaveProblem {
  readonly kind: PreSaveProblemKind;
  /** 持ち主の居ない系列ならその持ち主、消えた親を指す parentId ならその子。 */
  readonly featureId: FeatureId;
  /** 消えた親を指す parentId のときだけ、指している先。 */
  readonly parentId?: FeatureId;
}

/**
 * 保存しようとしている企画に、開き直すと地物が失われる形が混ざっていないかを見る。
 * 見つからなければ空配列（空配列は真値＝「問題なし」）。
 */
export function checkBeforeSave(project: DomainProject): readonly PreSaveProblem[] {
  const problems: PreSaveProblem[] = [];

  // すべての錨に居る地物 id を 1 度だけ集める（親の存否はこの集合で見る）。
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

  return problems;
}

/** 保存を止めるときの文言。問題が無ければ `null`（＝止めない）。 */
export function preSaveBlockMessage(
  problems: readonly PreSaveProblem[],
  nameOf: (id: FeatureId) => string | undefined,
): string | null {
  if (problems.length === 0) return null;
  const orphans = problems.filter((p) => p.kind === PRE_SAVE_PROBLEM.OrphanHistory);
  const dangling = problems.filter((p) => p.kind === PRE_SAVE_PROBLEM.DanglingParent);
  const label = (id: FeatureId): string => nameOf(id) ?? String(id);
  const heads: string[] = [];
  if (orphans.length > 0) {
    const head = orphans[0];
    heads.push(
      orphans.length === 1
        ? `持ち主の居ない歴史が 1 件あります（${label(head!.featureId)}）`
        : `持ち主の居ない歴史が ${orphans.length} 件あります（${label(head!.featureId)} ほか）`,
    );
  }
  if (dangling.length > 0) {
    const head = dangling[0];
    heads.push(
      dangling.length === 1
        ? `消えた上位領域を指している地物が 1 件あります（${label(head!.featureId)}）`
        : `消えた上位領域を指している地物が ${dangling.length} 件あります（${label(head!.featureId)} ほか）`,
    );
  }
  return `保存を中止しました: ${heads.join('。')}。このまま保存すると、開き直したときに地物が失われます。直前の操作を Ctrl+Z で取り消してから保存してください。`;
}
