// UI layer (U35 / conflict): 重なりを解消したあとに状態行へ出す文（増分 8E / V13 ⑦）。
//
// **これが直すもの**: 解決を適用しても、状態行には止まっていた操作の名前（「地物の追加を
// 行いました」）しか出ず、**どの重なりをどう片付けたのか**が残らなかった。設計書 §E.1 の
// V13 ⑦は「アルラーク国とバアカの重なりを解消しました（1200年）」が消えずに残ることを
// 求める（状態行の「直前の結果」は時間では消えない＝K-7）。
//
// 純粋関数にして単体で検査する（教訓 5.41）。名前は重なりの行に出ているのと同じ呼び名
// （`Conflict` の `displayName`。名前が空なら「名前のない面（…年に作成）」＝N-18）を使う。

import type { Conflict } from '../../domain/consistency/index';
import { formatTimePoint } from '../timeline/time-display';

import { RESOLVED_STRINGS } from './strings';

/**
 * 解消した重なりの一覧から状態行の文を作る。年は最初の 1 件の重なりの年（後の年にだけ重なったなら
 * その年。範囲なら始まり）。一覧が空なら null（何も解消していないのに「解消しました」とは言わない）。
 */
export function conflictResolvedMessage(conflicts: readonly Conflict[]): string | null {
  const first = conflicts[0];
  if (first === undefined) return null;
  const when = formatTimePoint(first.time.kind === 'point' ? first.time.at : first.time.from);
  return conflicts.length === 1
    ? RESOLVED_STRINGS.one(first.a.displayName, first.b.displayName, when)
    : RESOLVED_STRINGS.many(first.a.displayName, first.b.displayName, conflicts.length - 1, when);
}
