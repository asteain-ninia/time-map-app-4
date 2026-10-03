// UI layer (U35 / conflict): 重なり解決の画面に出す「地物の呼び名」（増分 8E / N-18）。
//
// **これが直すもの**: 重なりの行とラジオには、名前が空の面が **内部 ID**（`f-5-4 ／ f-b-a`）で
// 出ていた（現状分析 N-18）。追加の板は名前を空のまま確定できるので、これが既定の見え方だった。
// 内部 ID は利用者にとって何の手がかりにもならない（設計書 §H.1 の「内部語を出さない」）。
//
// 規則（設計書 §E.1 の V13 ③）: **名前があれば名前、空なら「名前のない面（1500年に作成）」**。
// 「作成」はその地物が最初に記録された年（いちばん早い錨の開始）で、同じ画面に出る年と同じ
// 書き方（`formatTimePoint`）を通す（教訓 5.30: 年の書き方は 1 か所）。
//
// **増分 8D と同じ呼び方**である。8D は修復ダイアログのために `src/ui/file-ops/repair-names.ts`
// を作っているが、その worktree はまだ取り込まれていないので、同じ呼び方の小さな関数をここに
// 置いた。**取り込みのときに 1 つにまとめる**（進捗 `docs/ui-redesign/進捗/増分8E.md` の申し送り）。

import type { Calendar } from '../../domain/time/calendar';
import { compare } from '../../domain/time/normalized';
import type { TimePoint } from '../../domain/time/time-point';
import { FEATURE_KIND, type Feature, type FeatureKind } from '../../domain/feature';
import type { FeatureId } from '../../domain/ids';
import type { FeatureHistory } from '../../domain/persistence/index';
import { stripInvisibleThenTrim } from '../../domain/text';
import { formatTimePoint } from '../timeline/time-display';

/** 名前が空のときに呼ぶ「何であるか」の語。重なりに出るのは面だけだが、全種類を網羅する。 */
const UNNAMED_KIND_WORD: Readonly<Record<FeatureKind, string>> = {
  [FEATURE_KIND.Point]: '点',
  [FEATURE_KIND.Line]: '線',
  [FEATURE_KIND.Leaf]: '面',
  [FEATURE_KIND.Aggregate]: 'まとめ役の地物',
};

/** 画面に出す言葉（教訓 5.19: 文言は定数を経由する）。 */
export const PARTICIPANT_NAME_STRINGS = {
  /** 「名前のない面（1500年に作成）」。 */
  unnamedWithYear: (kindWord: string, createdLabel: string): string =>
    `名前のない${kindWord}（${createdLabel}に作成）`,
  /** 作成の年が分からないとき（履歴に見つからない＝通常は起きない）。 */
  unnamed: (kindWord: string): string => `名前のない${kindWord}`,
} as const;

/**
 * その地物が **最初に記録された時刻**（どの系列でも、その地物を載せたいちばん早い錨の開始）。
 *
 * 地物はまとめ役の系列の中に居候していることがある（子が自分の系列を持たない）ので、
 * 自分の id の系列だけでなく、**載せている錨を全系列から探す**。見つからなければ undefined。
 */
export function createdAtOf(
  histories: readonly FeatureHistory[],
  featureId: FeatureId,
  calendar: Calendar,
): TimePoint | undefined {
  let earliest: TimePoint | undefined;
  for (const history of histories) {
    for (const entry of history.series.entries) {
      if (!entry.anchor.snapshot.features.some((f) => f.id === featureId)) continue;
      if (earliest === undefined || compare(entry.start, earliest, calendar) < 0) {
        earliest = entry.start;
      }
      // 系列の錨は開始の早い順に並んでいる（INV）ので、この系列で最初に見つかったものが
      // この系列でいちばん早い。残りは見なくてよい。
      break;
    }
  }
  return earliest;
}

/**
 * 重なり解決の行・ラジオに出す呼び名。**内部 ID は決して返さない**（N-18）。
 *
 * 名前は `featureDisplayName` と同じく、見えない文字を落としてから空かどうかを見る
 * （見えない文字だけの名前を「名前あり」と読まない）。
 */
export function participantDisplayName(feature: Feature, createdAt: TimePoint | undefined): string {
  const name = stripInvisibleThenTrim(feature.attributes.name);
  if (name.length > 0) return name;
  const word = UNNAMED_KIND_WORD[feature.kind];
  return createdAt === undefined
    ? PARTICIPANT_NAME_STRINGS.unnamed(word)
    : PARTICIPANT_NAME_STRINGS.unnamedWithYear(word, formatTimePoint(createdAt));
}
