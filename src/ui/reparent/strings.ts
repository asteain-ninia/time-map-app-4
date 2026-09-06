// U28 — 所属変更 (reparent / affiliation-change) UI strings (FR-46〜FR-49 / FR-92).
//
// All user-facing strings for the reparent controller live here so the UI layer never
// embeds bare literals in JSX (教訓 5.19) and the copy is a single source.

export const REPARENT_STRINGS = {
  /** Guide before a target is chosen (the first click). */
  guidePickTarget: '所属を変更する地物をクリックで選択してください。',
  /** Guide once a target is chosen (pick the new上位領域). */
  guidePickParent: '新しい上位領域とする地物をクリックで選択してください。',
  /** Confirm button label. */
  confirm: '所属変更を確定',
  /** Confirm-detach (最上位化 / make-top-level, parentNone) button label (FR-46 独立). */
  confirmNone: '最上位へ (所属を外す)',
  /** Clear-selection button label。「クリア」は §H.1 に無い語（増分 5 の手直し E2）。 */
  clear: '選択を外す',
  /**
   * Cancel button label。確定欄（176px）の語は **5 道具とも「やめる」**に揃える
   * （増分 5 の手直し E2。`ui/add/strings.ts` の `ADD_STRINGS.cancel` が先例）。
   */
  cancel: 'やめる',
  /**
   * 対象欄（240px）の頭に出す段階表示（設計書 §C.4 / バグ狩り #9）。**「手順」の 2 文字を
   * 必ず前に付ける** ―― 「2/3」だけだと「3 件中 2 件」と読み違えられる（§O の B-23）。
   *
   * 段は {@link REPARENT_STEP_COUNT} 個（1 = 所属を変える地物を選ぶ / 2 = 新しい上位領域を
   * 選ぶ / 3 = 確定する）。設計書 §C.4 の「**手順 2/3** 対象: 南ケナ州 → 親: ?」と同じ数。
   */
  stage: (step: number): string => `手順 ${String(step)}/${String(REPARENT_STEP_COUNT)}`,
  /**
   * 対象欄の名前。設計書 §C.4 の「対象: 南ケナ州 → 親: ?」の形 ―― **移し先まで見せる**。
   * 旧版は対象の名前しか出しておらず、どこへ移そうとしているのかが画面のどこにも出て
   * いなかった（次の一手は「新しい上位領域を選んでください」と言うだけ）。
   */
  targetWithParent: (target: string, parent: string): string => `${target} → 親: ${parent}`,
  /** まだ移し先を選んでいないときの「親」の欄（§C.4 の例そのまま）。 */
  parentUnset: '?',
  /** 最上位化（所属を外す）を選んだときの「親」の欄。 */
  parentDetached: '最上位（所属なし）',

  // --- 最上位化の確認（増分 5 の手直し B4 / バグ狩り B-1 / E4）------------------
  /** 確認の板の見出し。 */
  detachConfirmTitle: '所属を外しますか？',
  /**
   * 確認の板の本文。**何が起きるかを言う**（「よろしいですか？」だけにしない）――
   * 削除の確認と同じ作法で、押した結果を見せてから確定する。
   */
  detachConfirmBody:
    'この地物はどこにも所属しなくなります（上位領域が無くなります）。よろしいですか？',
  /** 確認の板の「はい」。何をするかを言い切る（「OK」にしない）。 */
  detachConfirmYes: '最上位へ移す',
  /** 確認の板の「いいえ」。確定欄の語と揃える。 */
  detachConfirmNo: 'やめる',
} as const;

/**
 * 所属変更の段数（設計書 §C.4 の「手順 n/m」の m）。
 * 1 = 所属を変える地物を選ぶ / 2 = 新しい上位領域を選ぶ / 3 = 確定する。
 */
export const REPARENT_STEP_COUNT = 3;

export type ReparentStringKey = keyof typeof REPARENT_STRINGS;
