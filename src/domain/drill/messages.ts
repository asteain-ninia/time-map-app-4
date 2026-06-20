// U27 — Japanese user-facing messages for the穴あけによる新地物生成 (FR-45 / FR-115).
//
// Single source for UI notification + test assertion (教訓5.26: 拒否理由は通知用文言
// とテスト可能な戻り値の両方で扱う). Each rejection kind maps to one Japanese message;
// the machine-readable kind lives in `drill-geometry.ts`'s discriminated result.

import { DRILL_REJECT, type DrillRejectKind } from './drill-geometry';

/** Japanese rejection messages (FR-115). Keyed by the machine-readable kind. */
export const DRILL_REJECT_MESSAGE: Readonly<Record<DrillRejectKind, string>> = {
  [DRILL_REJECT.NotTerminal]:
    '集約地物には穴あけできません。末端地物を選んでください。',
  [DRILL_REJECT.DegenerateRegion]:
    '指定領域の頂点が足りません。3 頂点以上で領域を指定してください。',
  [DRILL_REJECT.SelfIntersecting]:
    '指定領域が自己交差しています。交差しないように指定し直してください。',
  [DRILL_REJECT.NotContained]:
    '指定領域が末端地物の内部に収まっていません。外周境界の内側で指定してください。',
  [DRILL_REJECT.InvalidShape]:
    '穴あけ後の形状が不正になります。指定領域を変更してください。',
  [DRILL_REJECT.Unresolvable]:
    '対象面の形状を取得できませんでした。',
  [DRILL_REJECT.Internal]:
    '内部エラーが発生しました。開発者へ報告してください。',
};

/** Resolve the Japanese message for a rejection kind (FR-115). */
export function drillRejectMessage(kind: DrillRejectKind): string {
  return DRILL_REJECT_MESSAGE[kind];
}
