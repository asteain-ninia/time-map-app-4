// U23 — add-tool Japanese UI strings (FR-115 / FR-117, 日本語のみ UI / NFR 5.7).
//
// All user-facing text for the add flow is collected here as constants (技術方針
// §5.5: 文言を定数モジュールへ集約). The rejection mapping turns the domain's
// machine-readable reject kinds into Japanese messages; a serious internal
// inconsistency appends the「開発者へ報告してください」guidance (FR-117).

import {
  SHAPE_REJECT,
  type ShapeRejection,
} from '../../domain/add/index';

/** The「開発者へ報告」suffix for internal inconsistencies (FR-117). */
export const REPORT_HINT = '（問題が続く場合は開発者へ報告してください）';

export const ADD_STRINGS = {
  toolPoint: '点を追加',
  toolLine: '線を追加',
  toolFace: '面を追加',
  completeLine: '線を確定',
  completeFace: '面を閉じて確定',
  completePoint: '点を確定',
  cancel: '追加をキャンセル',
  undoVertex: '直前の頂点を取り消す',
  gridSnap: 'グリッドスナップ',
  // property form
  formTitle: '新規地物のプロパティ',
  fieldName: '名前',
  fieldParent: '親領域',
  parentNone: '親なし（最上位領域へ）',
  save: '保存',
  // parent re-validation notice
  parentClearedNotice:
    '選択していた親領域が現在時刻では存在しないため、親選択を解除しました。',
  conflictPaused:
    '空間的な競合が見つかりました。競合解決を行ってください。',
} as const;

/** Append the「開発者へ報告」hint to an internal-error message (FR-117). */
export function withReportHint(message: string): string {
  return `${message}${REPORT_HINT}`;
}

/**
 * Map a {@link ShapeRejection} to a Japanese message (FR-115). The too-few-
 * vertices message names the required minimum so the user knows what to do.
 */
export function shapeRejectionMessage(rejection: ShapeRejection): string {
  switch (rejection.kind) {
    case SHAPE_REJECT.TooFewVertices: {
      const required = rejection.required ?? 0;
      return `頂点が足りません。確定には${required}個以上の頂点が必要です。`;
    }
    case SHAPE_REJECT.SelfIntersecting:
      return '面の輪郭が自己交差しています。交差しない形状にしてください。';
  }
}
