// U25 — ring-edit (穴 / 飛び地 の追加・削除) UI strings (FR-22 / FR-24 / FR-92 /
// FR-115, NFR 5.7).
//
// All user-facing ring-edit text lives here as a single source so the controller /
// hook select by key and the copy is testable (教訓 5.19 / 5.26 同一文言を UI とテスト
// で共有). No component embeds a bare literal inline.

export const RING_EDIT_STRINGS = {
  /** Guide: pick the target face whose rings to edit (no face selected yet). */
  guideSelectTarget: '穴 / 飛び地を編集する面をクリックで選択してください。',
  /** Guide while placing the new ring's vertices (add sub-mode, face chosen). */
  guideDrawRing:
    '穴 / 飛び地の頂点をクリックで追加してください（面の内側なら穴、外側なら飛び地。3 点以上で確定できます）。',
  /** Guide: pick the face whose ring to delete (delete sub-mode, no face chosen yet). */
  guideSelectDeleteTarget: '穴 / 領土リングを削除する面をクリックで選択してください。',
  /** Guide in the delete sub-mode: click inside a ring to remove it. */
  guideDeleteRing: '削除する穴 / 領土リングの内側をクリックしてください。',
  /**
   * The target-selection click missed every face (教訓 5.12: 無反応にしない). The
   * production hit-test is 穴透過, so the 面 must be picked on its SOLID fill — a
   * click in a hole void or off the map surfaces this instead of doing nothing.
   */
  faceNotFound: '面が見つかりませんでした。編集する面の塗りつぶし部分をクリックしてください。',
  /** The clicked feature was not an individual leaf face (aggregate / point / line). */
  selectLeafTarget: '末端地物を選択してください。',
  /** Confirm the drafted ring (穴 / 飛び地). */
  confirmRing: 'リングを確定',
  /** 最後の頂点を取り消す (FR-78). */
  undoVertex: '最後の頂点を取り消す',
  /** Grid snap toggle (FR-78). */
  gridSnap: 'グリッドにスナップ',
  /** Cancel the whole ring-edit operation. */
  cancel: 'キャンセル',
  /** Toggle between add (穴 / 飛び地追加) and delete (リング削除) sub-modes. */
  switchToDelete: 'リング削除モードへ',
  switchToAdd: 'リング追加モードへ',
  /** Dismiss a rejection notice. */
  dismiss: '閉じる',
} as const;

export type RingEditStringKey = keyof typeof RING_EDIT_STRINGS;

/**
 * Map a domain {@link RingRejectKind} to a user-facing Japanese message (教訓 5.12 /
 * 5.26). Every reject reason the add / delete commands can return is covered so a
 * refusal always surfaces an honest reason rather than a raw enum (FR-115).
 */
export const RING_REJECT_MESSAGES = {
  'too-few-vertices': 'リングには 3 点以上の頂点が必要です。',
  'no-enclosing-territory': '穴を作成できる領土が見つかりませんでした。領土の内側をクリックしてください。',
  'hierarchy-invalid': 'リングの階層構造が不正になるため、この形状は確定できません。',
  'target-not-found': '対象のリングが見つかりませんでした。',
} as const;
