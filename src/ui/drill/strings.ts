// U27 — 穴あけによる新地物生成 (drill) UI strings (FR-45 / FR-92 / FR-115, NFR 5.7).
//
// All user-facing drill text lives here as a single source so the controller / hook
// select by key and the copy is testable (教訓 5.19 / 5.26 同一文言を UI とテストで
// 共有). No component embeds a bare literal inline. The DOMAIN rejection文言
// (drillRejectMessage in domain/drill/messages.ts) is used DIRECTLY at the reject site
// to avoid a second definition (二重定義回避); only the flow chrome text lives here.

export const DRILL_STRINGS = {
  /** Guide: pick the target末端 face to drill a hole in (no face selected yet). */
  guideSelectTarget: '穴をあける末端地物をクリックで選択してください。',
  /** Guide while placing the region's vertices (target chosen). */
  guideDrawRegion: 'くり抜く領域の頂点をクリックで追加してください（3 点以上で確定できます）。',
  /** Guide while entering the new feature's properties (region confirmed). */
  guideEnterProperties: '生成される新しい地物のプロパティを入力してください。',
  /** Confirm the drafted region (advance to新地物プロパティ入力). */
  confirmRegion: '穴あけを確定',
  /** 頂点取り消し (FR-78)。語は設計書 §C.4 の［1 つ戻す］に揃える（増分 5 の手直し E2）。 */
  undoVertex: '1 つ戻す',
  /**
   * Cancel the whole drill operation.
   * 確定欄（176px）の語は **5 道具とも「やめる」**に揃える（増分 5 の手直し E2。
   * `ui/add/strings.ts` の `ADD_STRINGS.cancel` が先例）。
   */
  cancel: 'やめる',
  /**
   * 素性入力の局面の「次の一手」（司令塔の決定 (5) / 設計書 §C.4）。
   *
   * **なぜ言い換えるか**: {@link DRILL_STRINGS.guideEnterProperties}（「生成される新しい
   * 地物のプロパティを入力してください。」）は **どこで入れるのか**を言っていない。地図の
   * 真ん中に板が出ていたころは目の前にあったので要らなかったが、素性は右パネルの
   * 「新規の姿」で受けるようになったので、行き先まで言わないと迷子になる。追加の道具の
   * `ADD_STRINGS.nextStepPropertyForm` と同じ調子で短くする。
   */
  nextStepEnterProperties: '右のパネルで名前を入れて［保存］を押してください',
  /** ConflictPaused status (FR-62). */
  conflictPaused: '空間競合の解決待ちです。',
  /** LEAF gate refusal (集約 body クリック時): a non-leaf cannot be drilled. */
  notLeaf: '集約地物には穴あけできません。末端地物を選んでください。',
  /** The target vanished mid-draft (time move / delete). */
  targetGone: '対象面が見つかりませんでした。',
  /**
   * 対象欄（240px）の頭に出す段階表示（設計書 §C.4 / バグ狩り #9）。**「手順」の 2 文字を
   * 必ず前に付ける** ―― 「1/3」だけだと「3 件中 1 件」と読み違えられる（§O の B-23）。
   *
   * 穴あけの段は {@link DRILL_STEP_COUNT} 個（1 = 対象を選ぶ / 2 = くり抜く形を描く /
   * 3 = 新しい地物の素性を入れる）。設計書 §C.4 の「手順 1/3 対象: バアカ」と同じ数である。
   */
  stage: (step: number): string => `手順 ${String(step)}/${String(DRILL_STEP_COUNT)}`,
} as const;

/**
 * 穴あけの段数（設計書 §C.4 の「手順 n/m」の m）。
 * 1 = 対象を選ぶ / 2 = くり抜く形を描く / 3 = 新しい地物の素性を入れる。
 */
export const DRILL_STEP_COUNT = 3;

export type DrillStringKey = keyof typeof DRILL_STRINGS;

/** The developer-report hint appended to internal-error messages (FR-117). */
export const DRILL_REPORT_HINT = 'お手数ですが開発者へ報告してください。';

/**
 * Ensure the「開発者へ報告」hint is present exactly once on an internal-error message
 * (FR-115 / FR-117). Mirrors knife/add so a guarded internal error on the drill save
 * path is surfaced with the SAME guidance, not a raw message.
 */
export function withReportHint(message: string): string {
  return message.includes('開発者へ報告') ? message : `${message}\n${DRILL_REPORT_HINT}`;
}
