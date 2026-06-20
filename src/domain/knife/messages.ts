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
