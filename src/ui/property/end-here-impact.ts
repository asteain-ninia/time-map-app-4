// UI layer (素性欄 / 右クリック): **まとめ役を「この年に終わったことにする」前に見せる影響**
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
import { PROPERTY_STRINGS } from './messages';

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
  /** 後の年の錨で再び現れるならその年の表示（「1700年」）。ずっと終わるなら省く。 */
  readonly reappearsLabel?: string;
}): EndHereImpactView {
  const { targetName, yearLabel, promotedCount, promotedNames, reappearsLabel } = input;
  return {
    title: PROPERTY_STRINGS.endHereImpactTitle(targetName, yearLabel),
    groups: [
      {
        testId: 'ends',
        heading: PROPERTY_STRINGS.endHereImpactHeadingEnds,
        lines: [PROPERTY_STRINGS.endHereImpactLineEnds(yearLabel)],
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
    ],
    // 実行ボタンは **素性欄のボタンと同じ文**（「1500年に終わったことにする」）。押した
    // 部品と、出る板と、起きることが 1 本の線でつながる。
    confirmLabel: PROPERTY_STRINGS.endHereLabel(yearLabel),
    cancelLabel: PROPERTY_STRINGS.impactCancel,
    note: PROPERTY_STRINGS.impactUndoNote,
  };
}
