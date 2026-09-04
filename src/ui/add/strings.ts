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
  // 確定欄（176px）のラベル。**設計書 §C.4 の語**に揃える（増分 3 の手直し C1）。
  // 実測で［面を閉じて確定］＋［追加をキャンセル］は 176px からはみ出していた。
  // 欄の名前が「確定」なので、ラベルに「確定」を繰り返さず、その道具で何が起きるかだけを言う。
  completeLine: '線を確定',
  completeFace: '閉じて確定',
  completePoint: '点を確定',
  cancel: 'やめる',
  undoVertex: '1 つ戻す',
  // property form
  formTitle: '新しい地物',
  fieldName: '名前',
  // 欄名は素性欄（`ui/property/messages.ts`）と揃えて「種別」にする（増分 3 の手直し F2）。
  // 同じ値（FR-40 の種別ラベル）を画面の 2 か所で違う名前で呼んでいた。
  fieldKindLabel: '種別',
  fieldKindLabelHint: '国・州・島 など',
  // 用語集（要件定義書 §6）の語は「上位領域」である。「親領域／親なし」は内部語だった。
  fieldParent: '上位領域',
  parentNone: '上位領域なし（いちばん上に置く）',
  save: '保存',
  // FR-62 の一時停止。「空間的な競合」は内部語なので、起きたことをそのまま言う。
  conflictPaused:
    '他の地物と重なっています。重なりの解決を行ってください。',

  // --- 増分 3（吸着・拒否理由・N-51）。オプションバーの「次の一手」欄へ出す文 ---

  /** 面を描いている間の案内（設計書 §C.4 の表）。 */
  nextStepFace: 'もう 1 点打つか、Enter で閉じて確定します',
  /** 面を描き始める前（頂点 0 個）の案内。 */
  nextStepFaceEmpty: '地図をクリックすると頂点を置きます',
  /** 面がまだ閉じられない（頂点 1〜2 個）ときの案内。`n` は足りない数。 */
  nextStepFaceMore: (n: number): string => `あと ${String(n)} 点で閉じられます`,
  nextStepLine: 'Enter で確定します',
  nextStepLineEmpty: '地図をクリックすると頂点を置きます',
  nextStepPoint: '地図をクリックすると点を置きます',
  /** 道具名（オプションバーの 112px の区画）。 */
  toolNameFace: '▱ 面を描く',
  toolNameLine: '╱ 線を描く',
  toolNamePoint: '· 点を置く',
  /** 対象欄（240px）。`{n}` は打った頂点の数。 */
  targetVertices: (n: number): string => `頂点 ${n} 個（未確定）`,

  /**
   * FR-29 の拒否（現状は `return current` の無反応 ＝ 現状分析 C1）。
   * **他の面の内側には面の頂点を置けない**。名前が分かるときは名前を出す。
   */
  insideTerminalRefused: (where: string): string =>
    `ここは${where}の内側です。面の頂点は他の面の内側には置けません。外側を押すか、その面を分ける道具を使ってください。`,
  insideTerminalRefusedUnnamed:
    'ここは既存の面の内側です。面の頂点は他の面の内側には置けません。外側を押すか、その面を分ける道具を使ってください。',

  /** 同じ頂点へ 2 回続けて吸着しようとしたとき（長さ 0 の辺を作らない）。 */
  snapAlreadyUsed: 'その頂点はもう使っています。別の場所を押してください。',

  /**
   * 緯度 ±90 度の外（増分 3 の手直し A6。バグ狩り #3）。北極の上にも南極の下にも場所は無い。
   * 状態行が同じ場所で座標を「—」と出しているのに、クリックだけ通っていた。
   */
  outsideWorldRefused:
    'そこは世界の外です（北緯 90 度より上・南緯 90 度より下には置けません）。地図の中を押してください。',

  /**
   * 入れ子（親の中に子を描く）だと分かったときの案内。カーソルを乗せている間に
   * 「次の一手」へ出して、**次の一手を予告する**（増分 3 の手直し B3）。
   */
  insideTerminalNesting: (name: string): string =>
    `ここは「${name}」の内側です。このまま全部内側に打つと、「${name}」の中の領域になります。`,
  insideTerminalNestingUnnamed:
    'ここは既存の面の内側です。このまま全部内側に打つと、その面の中の領域になります。',

  /**
   * FR-77 / GPT #3: 保存の直前に見直したら、選んだ上位領域がこの形を含んでいなかった。
   * 形を確定してから名前を打つまでのあいだに、年が動く・別の編集が入る、が起こりうる。
   */
  parentDoesNotContain:
    '選んだ上位領域は、いまこの形を含んでいません。上位領域を選び直すか、「上位領域なし」で保存してください。',

  /** N-51: 1 辺で経度 180 度以上を渡る辺（技術方針 §6.8）。 */
  longEdgeRefused:
    'この辺は世界を半周以上します。途中に点を打ってください（1 辺で経度 180 度以上は保存できません）。',

  /** 吸着したことの予告（設計書 §E.1 の V2「◯◯の頂点に合わせます」）。 */
  snapPreview: (name: string): string => `「${name}」の頂点に合わせます`,
  snapPreviewUnnamed: '既存の頂点に合わせます',

  // --- 吸着 ▾ ポップオーバー（設計書 §C.4） ---
  snapMenuLabel: '吸着',
  snapEnabled: '吸着する',
  snapVertex: '頂点',
  snapEdge: '辺',
  snapIntersection: '交点',
  snapNotYet: 'まだ使えません',
  snapTolerance: '許容',
  snapToleranceUnit: 'px',
  gridSnapLabel: 'グリッド',

  /** G-8: 年代は「いま見ている年」を継ぐ。何年に記録されるかを押す前に見せる。 */
  eraFromCurrent: (year: number): string => `年代: ${String(year)}年（いま見ている年を継ぎます）`,
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
    case SHAPE_REJECT.LongEdge:
      return ADD_STRINGS.longEdgeRefused;
  }
}
