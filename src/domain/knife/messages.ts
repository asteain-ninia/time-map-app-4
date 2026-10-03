// U26 — Japanese guide text for the knife tool (FR-92 / FR-115).
//
// 操作ガイド文を画面上に常時表示し、現在のステートに応じて文面を切り替える (FR-92). The
// strings live here (a single source) so the render/UI layer just selects by
// phase and the wording is testable (教訓5.26 同一文言を UI とテストで共有).

import { KNIFE_PHASE, type KnifeState } from './session';
import { MIN_POINTS_TO_CLOSE } from './knife-line';

export const KNIFE_GUIDE = {
  SelectTarget: '分割する末端地物を選択してください。',
  DrawCutEmpty: '分断線を引いて対象面を貫いてください。',
  DrawCutClosable: `${MIN_POINTS_TO_CLOSE} 点以上で中心の円をクリックすると閉じます。`,
  ChooseInheritor: '継承先を選び、確定してください。小さい方を囲って表示しています。',
  EnterProperties: '新規地物のプロパティを入力してください。',
} as const;

/** 分割を断る理由の文（FR-115）。`split-geometry.ts` の `SPLIT_REJECT_MESSAGE` が引く。 */
export const SPLIT_REJECT_TEXT = {
  notTerminal: '集約地物は分割できません。末端地物を選んでください。',
  doesNotPierce: '分断線が対象面を 2 つに分けていません。面を貫くように引いてください。',
  tooFewVertices: '分割結果が 3 頂点未満になります。分断線を引き直してください。',
  invalidShape: '分割結果が不正な形状になります。分断線を引き直してください。',
  unresolvable: '対象面の形状を取得できませんでした。',
  degenerateLine: '分断線の点が足りません。',
  selfIntersectingCut: '分断線が自己交差しています。交差しないように引き直してください。',
  chordOutsidePieces:
    '分断線の途中の区間が、切り分けた片のどれにも入りませんでした。分断線を引き直してください。',
  chordEmptiesSide:
    '分断線の途中の区間で片を切ると、片側が空になりました。分断線を引き直してください。',
  // 利用者はナイフでは頂点を打たないので「途中に点を打つ」とは言えない。この道具で実際に
  // 取れる次の手は「別の場所で切る」なので、そう書く (追加の道具の文言と同じ趣旨)。
  longEdge:
    '切り口が世界を半周以上します。別の場所で切ってください（1 辺で経度 180 度以上は保存できません）。',
} as const;

/**
 * The guide line for the current phase (FR-92). While drawing, the message
 * upgrades to the閉じる案内 once enough points are placed (≥3) so the固定円ヒント is
 * surfaced only when閉線 is actually possible (受け入れ基準3).
 */
export function knifeGuideText(state: KnifeState): string {
  switch (state.phase) {
    case KNIFE_PHASE.Inactive:
      return '';
    case KNIFE_PHASE.SelectingTarget:
      return KNIFE_GUIDE.SelectTarget;
    case KNIFE_PHASE.DrawingCut:
      return state.line.points.length >= MIN_POINTS_TO_CLOSE
        ? `${KNIFE_GUIDE.DrawCutEmpty}${KNIFE_GUIDE.DrawCutClosable}`
        : KNIFE_GUIDE.DrawCutEmpty;
    case KNIFE_PHASE.ChoosingInheritor:
      return KNIFE_GUIDE.ChooseInheritor;
    case KNIFE_PHASE.EnteringProperties:
      return KNIFE_GUIDE.EnterProperties;
  }
}
