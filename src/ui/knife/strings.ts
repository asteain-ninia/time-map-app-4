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
  /**
   * Cancel the whole knife operation.
   * 確定欄（176px）の語は **5 道具とも「やめる」**に揃える（増分 5 の手直し E2。
   * `ui/add/strings.ts` の `ADD_STRINGS.cancel` が先例で、同じ枠の中で語が割れていた）。
   */
  cancel: 'やめる',
  /** 頂点取り消し (FR-78)。語は設計書 §C.4 の［1 つ戻す］に揃える（増分 5 の手直し E2）。 */
  undoVertex: '1 つ戻す',
  /**
   * 分断線の確定（増分 5d でオプションバーの確定欄へ移したときに、直書きだった文言を
   * ここへ引き上げた ―― 画面に出る言葉は 1 か所に集める＝技術方針 5.5 / 教訓 5.19）。
   */
  confirmCut: '分断線を確定',
  /**
   * Grid snap toggle (FR-78)。「スナップ」は要件定義書の条文の語で、画面の第一表記は
   * §H.1 のとおり「吸着」、格子のほうは「グリッド」である（追加の道具の
   * `ADD_STRINGS.gridSnapLabel` が同じ 2 文字を出している）。増分 5 の手直し E2。
   */
  gridSnap: 'グリッド',
  /**
   * 素性入力の局面の「次の一手」（司令塔の決定 (5) / 設計書 §C.4）。
   *
   * **なぜ道具側で言い換えるか**: ドメインの案内文（`KNIFE_GUIDE.EnterProperties` ＝
   * 「新規地物のプロパティを入力してください。」）は **どこで入れるのか**を言っていない。
   * 地図の真ん中に板が出ていたころは目の前にあったので要らなかったが、素性は右パネルの
   * 「新規の姿」で受けるようになったので、**どこを見ればよいか**まで言わないと迷子になる。
   * 追加の道具の `ADD_STRINGS.nextStepPropertyForm`（「名前を入れて［保存］を押してください」）
   * と同じ調子で、行き先の 1 語だけを足した短い形にしてある。
   */
  nextStepEnterProperties: '右のパネルで名前を入れて［保存］を押してください',
  /** Step-back from継承先選択 to分断線入力 (re-draw). */
  backToDrawing: '分断線を引き直す',
  /** ConflictPaused status (FR-62). */
  conflictPaused: '空間競合の解決待ちです。',
  /**
   * 対象欄（240px）の頭に出す段階表示（設計書 §C.4 / バグ狩り #9）。**「手順」の 2 文字を
   * 必ず前に付ける** ―― 「2/4」だけだと「4 件中 2 件」と読み違えられる（§O の B-23）。
   *
   * 分ける道具の段は {@link KNIFE_STEP_COUNT} 個ある。§C.4 の表は「手順 1/3」と例示して
   * いるが、あれは継承先の選択と新しい地物の素性入力を 1 段に数えた見積りで、**実物は
   * 別々の板**である（`KNIFE_PHASE.ChoosingInheritor` と `EnteringProperties`）。画面に
   * 出す数は実物に合わせる ―― 段数が実物と違うと「あと何段あるか」が読めない。
   */
  stage: (step: number): string => `手順 ${String(step)}/${String(KNIFE_STEP_COUNT)}`,
} as const;

/**
 * 分ける道具の段数（設計書 §C.4 の「手順 n/m」の m）。
 *
 * 1 = 切る面を選ぶ / 2 = 分断線を引く / 3 = 継承先を選ぶ / 4 = 新しい地物の素性を入れる。
 */
export const KNIFE_STEP_COUNT = 4;

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
