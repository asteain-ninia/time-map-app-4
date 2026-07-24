// U26 — knife-tool UI strings (Japanese; FR-92 / FR-93 / FR-115, NFR 5.7).
//
// All user-facing knife text lives here as a single source so the controller /
// modal select by key and the wording is testable (教訓 5.26 同一文言を UI とテスト
// で共有). The per-phase ガイド文 itself comes from the domain (`knifeGuideText`);
// these are the BUTTON labels / titles / status text the React chrome shows.

export const KNIFE_STRINGS = {
  /** 継承先選択モーダル title (FR-93). */
  inheritorTitle: '継承先を選択',
  /**
   * Per-piece継承先 button label prefix (HB3-5/19 n-way). The modal appends the
   * piece number (面 1 / 面 2 / …) so it scales to any k+1 pieces, replacing the
   * fixed 2-way A/B labels.
   */
  chooseAsInheritor: 'こちらを継承先にする',
  /** The smaller-side preview caption (FR-93 小さい方プレビュー). */
  smallerHint: '小さい方を囲って表示しています。',
  /** Confirm the chosen継承先 (advance to非継承側プロパティ入力). */
  confirmInheritor: '継承先を確定',
  /** Cancel the whole knife operation. */
  cancel: 'キャンセル',
  /** 頂点取り消し (FR-78). */
  undoVertex: '最後の頂点を取り消す',
  /** Grid snap toggle (FR-78). */
  gridSnap: 'グリッドにスナップ',
  /** 非継承側プロパティ入力 heading (re-uses U23 form; FR-93). */
  newFeatureProps: '新規地物のプロパティ',
  /** Step-back from継承先選択 to分断線入力 (re-draw). */
  backToDrawing: '分断線を引き直す',
  /** ConflictPaused status (FR-62). */
  conflictPaused: '空間競合の解決待ちです。',
} as const;

/**
 * The 判断用メッセージ shown when the acquired target stops being a valid split target
 * mid-session (FR-113 個別非表示 / 種別オフ, or a time move to an instant where it is not
 * effective). The knife returns to 対象選択 with the tool still armed — the user did not
 * cancel, the target simply left the visible世界 (W3-AB fix-forward; 教訓 5.12 なぜ進めない
 * かを日本語で伝える).
 */
export const KNIFE_TARGET_GONE_MESSAGE =
  '対象の末端地物が表示されなくなったため、対象選択に戻りました。';

/** The developer-report hint appended to internal-error messages (FR-117). */
export const KNIFE_REPORT_HINT = 'お手数ですが開発者へ報告してください。';

/**
 * Ensure the「開発者へ報告」hint is present exactly once on an internal-error
 * message (FR-115 / FR-117). Mirrors add/conflict so a guarded internal error on
 * the knife save path is surfaced with the SAME guidance, not a raw message.
 */
export function withReportHint(message: string): string {
  return message.includes('開発者へ報告') ? message : `${message}\n${KNIFE_REPORT_HINT}`;
}
