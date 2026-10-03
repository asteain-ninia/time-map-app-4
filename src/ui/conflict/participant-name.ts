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
// **呼び名の規則はここ 1 か所**（`docs/現状.md` B75。増分 8A〜8E の取り込みでまとめた）。
// 増分 8D の修復ダイアログ（`src/ui/file-ops/repair-names.ts`）も、名前の取り出し・種類の語・
// 「名前のない面（…年に作成）」の文をここから引く。8D と 8E が別々の worktree で同じ呼び方を
// 作っていたので、取り込みのときに次の和でそろえた: 見えない文字を落とす（8E）・内部 ID と
// 同じ名前は名前と見なさない（8D）・まとめ役も「面」と呼ぶ（8D。地図の上では面に見える）・
// 年は `formatTimePoint` / `formatYear` で書く（8E。紀元前も「紀元前300年」）。

import type { Calendar } from '../../domain/time/calendar';
import { compare } from '../../domain/time/normalized';
import type { TimePoint } from '../../domain/time/time-point';
import { FEATURE_KIND, type Feature, type FeatureKind } from '../../domain/feature';
import { idToString, type FeatureId } from '../../domain/ids';
import type { FeatureHistory } from '../../domain/persistence/index';
import { stripInvisibleThenTrim } from '../../domain/text';
import { formatTimePoint } from '../timeline/time-display';

/**
 * 名前が空のときに呼ぶ「何であるか」の語。**まとめ役も「面」と呼ぶ**（地図の上では面に
 * 見える。設計書 §H.1 の例は「名前のない面（1500年に作成）」の 1 通り）。
 */
export const UNNAMED_KIND_WORD: Readonly<Record<FeatureKind, string>> = {
  [FEATURE_KIND.Point]: '点',
  [FEATURE_KIND.Line]: '線',
  [FEATURE_KIND.Leaf]: '面',
  [FEATURE_KIND.Aggregate]: '面',
};

/** 種類の分からない地物（どこにも見つからない）を呼ぶ語。 */
export const UNKNOWN_KIND_WORD = '地物';

/** 画面に出す言葉（教訓 5.19: 文言は定数を経由する）。 */
export const PARTICIPANT_NAME_STRINGS = {
  /** 「名前のない面（1500年に作成）」。 */
  unnamedWithYear: (kindWord: string, createdLabel: string): string =>
    `名前のない${kindWord}（${createdLabel}に作成）`,
  /** 作成の年が分からないとき（履歴に見つからない＝通常は起きない）。 */
  unnamed: (kindWord: string): string => `名前のない${kindWord}`,
  /** 同じ名前の地物を見分けるために作成の年を添える「州（900年に作成）」。 */
  namedWithYear: (name: string, createdLabel: string): string => `${name}（${createdLabel}に作成）`,
} as const;

/**
 * 地物の名前の欄から、画面で呼べる名前を取り出す。見えない文字を落として空になる・
 * 内部 ID と同じ（検出が名前の欄に ID を入れてくることがある）なら null（＝名前が無い）。
 */
export function visibleFeatureName(feature: Pick<Feature, 'id' | 'attributes'>): string | null {
  const name = stripInvisibleThenTrim(feature.attributes.name);
  if (name.length === 0 || name === idToString(feature.id)) return null;
  return name;
}

/**
 * 呼び名を組み立てる 1 本。名前があれば名前（`withYear` なら作成の年を添える）、無ければ
 * 「名前のない〇（〇年に作成）」。**内部 ID は決して返さない**（N-18・N-22）。
 */
export function featureCallName(
  name: string | null,
  kindWord: string,
  createdLabel: string | undefined,
  withYear = false,
): string {
  if (name === null) {
    return createdLabel === undefined
      ? PARTICIPANT_NAME_STRINGS.unnamed(kindWord)
      : PARTICIPANT_NAME_STRINGS.unnamedWithYear(kindWord, createdLabel);
  }
  return withYear && createdLabel !== undefined
    ? PARTICIPANT_NAME_STRINGS.namedWithYear(name, createdLabel)
    : name;
}

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
 * （見えない文字だけの名前を「名前あり」と読まない）。組み立ては {@link featureCallName}。
 */
export function participantDisplayName(feature: Feature, createdAt: TimePoint | undefined): string {
  return featureCallName(
    visibleFeatureName(feature),
    UNNAMED_KIND_WORD[feature.kind],
    createdAt === undefined ? undefined : formatTimePoint(createdAt),
  );
}
