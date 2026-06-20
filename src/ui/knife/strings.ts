// U26 — knife-tool UI strings (Japanese; FR-92 / FR-93 / FR-115, NFR 5.7).
//
// All user-facing knife text lives here as a single source so the controller /
// modal select by key and the wording is testable (教訓 5.26 同一文言を UI とテスト
// で共有). The per-phase ガイド文 itself comes from the domain (`knifeGuideText`);
// these are the BUTTON labels / titles / status text the React chrome shows.

export const KNIFE_STRINGS = {
  /** 継承先選択モーダル title (FR-93). */
  inheritorTitle: '継承先を選択',
  /** Label for choosing side A as the継承先. */
  chooseSideA: 'こちらを継承先にする（A）',
  /** Label for choosing side B as the継承先. */
  chooseSideB: 'こちらを継承先にする（B）',
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
