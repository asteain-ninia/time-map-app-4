// UI layer (素性欄 / 右クリック): **集約地物を「この年に終わったことにする」前に見せる影響**
//（司令塔の決定 (2)。設計書 §A.3 の入口 A）。
//
// 決定 (2) は「子を黙って道連れにしない。押す前に影響（『下位領域 n 件は、この年から
// 最上位になります』）を **削除と同じ影響の器**で見せ、確定したら子はその年から最上位に
// なる」と言っている。ドメインの確定（`createAnchorIntervalCommandForRoot`）は既に子を
// 起こして最上位にしているので、ここは **押す前の文**だけを作る。
//
// 数え上げは呼び出し側が確定と同じ `planEnding`（`domain/affiliation/interval-edit.ts`。
// 確定の `editFeatureInterval` を空打ちする）から引き、**直接の子のうちその年に居るもの**だけを
// 渡す（孫は数えない。その年より前に終わっていた子は画面上の姿が変わらないので、
// 「この年から最上位になります」と言うと嘘になる）。終わらせる地物が後の年の錨で再び
// 現れるなら、その年も渡す（子が最上位なのはその年まで）。純粋なので単体で固定できる。

import type { ImpactGroup } from '../shell/ImpactConfirmDialog';

import { summarizeNames } from './delete-impact';
import { PROPERTY_STRINGS, PROPERTY_TEXT } from './messages';

/** 一緒に終わる集約地物 1 件（名前と年。`whole` は記録ごと無くなるもの）。 */
export interface CascadedImpact {
  readonly name: string;
  readonly yearLabel: string;
  readonly whole?: boolean;
}

/**
 * 一緒に終わる集約地物の行。「この年に終わったことにする」の板と錨を消す板が同じ 1 本を使う
 * （B78、教訓 5.44）。1 つの地物に切れ目がいくつもあると同じ文が並ぶので、同じ行はまとめる。
 */
export function cascadedImpactLines(cascaded: readonly CascadedImpact[]): readonly string[] {
  return [
    ...new Set(
      cascaded.map((c) =>
        c.whole === true
          ? PROPERTY_STRINGS.endHereImpactCascadedWhole(c.name)
          : PROPERTY_STRINGS.endHereImpactCascaded(c.name, c.yearLabel),
      ),
    ),
  ];
}

/**
 * 存続期間の欄の編集で集約地物が一緒に終わったときの状態行。名前が 1 つも引けなければ `null`
 * （B78 で検査できるよう、`App` の中から出した）。
 */
export function intervalCascadeStatus(
  names: readonly string[],
  wholeNames: readonly string[],
): string | null {
  if (names.length === 0 && wholeNames.length === 0) return null;
  return (
    (names.length > 0
      ? PROPERTY_STRINGS.intervalCascaded(names.join(PROPERTY_TEXT.nameSeparator))
      : PROPERTY_STRINGS.intervalChanged) +
    (wholeNames.length > 0
      ? PROPERTY_STRINGS.endHereDoneCascadedWhole(wholeNames.join(PROPERTY_TEXT.nameSeparator))
      : '')
  );
}

/** 影響の板へ渡す一式。 */
export interface EndHereImpactView {
  readonly title: string;
  readonly groups: readonly ImpactGroup[];
  readonly confirmLabel: string;
  readonly cancelLabel: string;
  readonly note: string;
}

export function buildEndHereImpactView(input: {
  /** 終わらせる地物の名前。 */
  readonly targetName: string;
  /** 終わる年の表示（「1500年」）。 */
  readonly yearLabel: string;
  /** その年から最上位になる下位領域の件数（名前が引けないものも数える）。 */
  readonly promotedCount: number;
  /** その名前（引けたものだけ）。 */
  readonly promotedNames: readonly string[];
  /** 途切れの後に再び現れるならその年の表示（「1700年」）。ずっと終わるなら省く。 */
  readonly reappearsLabel?: string;
  /** 一緒に終わる、その年より後の途切れずに続いていた記録の件数（手直し 3 回目）。 */
  readonly trimmedCount?: number;
  /**
   * 下位領域を全て失って一緒に終わる集約地物（名前と年。手直し 3 回目 1-1）。`whole` はどの年にも
   * 下位領域が居なくなって記録ごと無くなるもの（4 回目 #1）。
   */
  readonly cascaded?: readonly CascadedImpact[];
  /** 一緒に終わる後ろの記録の中の、別の上位領域への所属（名前と年。4 回目 #2）。 */
  readonly laterAffiliations?: readonly { readonly name: string; readonly yearLabel: string }[];
}): EndHereImpactView {
  const { targetName, yearLabel, promotedCount, promotedNames, reappearsLabel } = input;
  const trimmed = input.trimmedCount ?? 0;
  const cascaded = input.cascaded ?? [];
  const laterAffiliations = input.laterAffiliations ?? [];
  return {
    title: PROPERTY_STRINGS.endHereImpactTitle(targetName, yearLabel),
    groups: [
      {
        testId: 'ends',
        heading: PROPERTY_STRINGS.endHereImpactHeadingEnds,
        lines: [
          PROPERTY_STRINGS.endHereImpactLineEnds(yearLabel),
          ...(trimmed > 0 ? [PROPERTY_STRINGS.endHereImpactTrimmed(yearLabel, trimmed)] : []),
          ...laterAffiliations.map((a) =>
            PROPERTY_STRINGS.endHereImpactLaterAffiliation(a.name, a.yearLabel),
          ),
        ],
      },
      {
        testId: 'promoted',
        heading: PROPERTY_STRINGS.endHereImpactHeadingPromoted,
        lines:
          promotedCount === 0
            ? []
            : [
                PROPERTY_STRINGS.endHereImpactPromoted(promotedCount, summarizeNames(promotedNames)),
                ...(reappearsLabel === undefined
                  ? []
                  : [PROPERTY_STRINGS.endHereImpactReappears(reappearsLabel)]),
              ],
      },
      {
        testId: 'cascaded',
        heading: PROPERTY_STRINGS.endHereImpactHeadingCascaded,
        lines: cascadedImpactLines(cascaded),
      },
    ],
    // 実行ボタンは **素性欄のボタンと同じ文**（「1500年に終わったことにする」）。押した
    // 部品と、出る板と、起きることが 1 本の線でつながる。
    confirmLabel: PROPERTY_STRINGS.endHereLabel(yearLabel),
    cancelLabel: PROPERTY_STRINGS.impactCancel,
    note: PROPERTY_STRINGS.impactUndoNote,
  };
}
