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

  // --- 増分 7: N-12 / 洗い直し -------------------------------------------------
  /**
   * **同じ地物をもう一度押したとき**（N-12 / 増分 7 の中身 10）。旧版はここで黙って
   * 対象を外していたので、外れたことに気づかないまま次のクリックが「新しい対象」と
   * して読まれていた。**外さずに、そう言う。**
   */
  samePickNotice: '同じ地物です。対象はそのままにしました（外すときは［選択を外す］か Esc）。',
  /** 確定の直前に洗い直したら 1 件も残らなかった。 */
  noTargetsLeft: 'いまの年に、所属を変えられる地物がありません。',

  // --- 増分 7: 3 択の板（中身 1・2・4・11）--------------------------------------
  /** 板の見出し。 */
  optionsTitle: '所属の変え方を選ぶ',
  /** 板の説明（見出しの下）。 */
  optionsHint: '選んだ地物を、どこの下に入れるかを決めます。',
  /** 上位領域の 3 択の枠見出し。 */
  parentHeading: '新しい上位領域',
  /**
   * 3 択の 1 つ目。**用語集の 7 操作名を説明文に出す**（N-31 / 設計書 §H.1 / 増分 7 の
   * 中身 11）。ボタンのラベルにはしない ―― 画面の第一表記は平たい言葉で、内部の
   * 分類名は説明として添える。
   */
  parentExisting: '既存の上位領域から選ぶ（割譲・帰属・直轄化）',
  /** 3 択の 2 つ目。 */
  parentCreate: '新しい上位領域を作る（連邦化・自治化）',
  /** 3 択の 3 つ目。 */
  parentNone: '最上位へ（独立）',
  /** 用語集の 7 つ目（解体）の行き先を書いておく。3 択には入らない操作である。 */
  parentDismantleNote:
    '解体（まとめ役をやめて下位を全部ばらす）は、まとめ役の素性欄から行います。',
  /** 既存から選ぶときの木の読み上げ名。 */
  parentExistingPickLabel: '上位領域にする地物',
  /** 木の絞り込み欄。 */
  parentExistingFilterLabel: '名前で絞り込む',
  /** 候補が 1 件も無いとき。 */
  parentExistingEmpty: '選べる上位領域がありません。',
  /** 新しく作るときの名前欄。 */
  parentCreateNameLabel: '新しい上位領域の名前',
  /** 新しく作るときの種別欄（FR-40。表示専用のラベル）。 */
  parentCreateKindLabel: '種別（例: 連邦）',
  /** 新しく作るものを、さらにどこへ置くか。 */
  parentCreateTerminalHeading: '作った上位領域の置き場所',
  /** 新しく作るものを最上位に置く（連邦化のルート）。 */
  parentCreateTerminalTop: '最上位に置く',
  /** 新しく作るものを既存の上位領域の下に置く（自治化・帰属）。 */
  parentCreateTerminalUnder: '既存の上位領域の下に置く',

  // --- 直轄領の名前（G-4 / FR-37 must）-----------------------------------------
  /** 分け残しの名前欄の見出し。 */
  directDomainHeading: '分け残し（直轄領）の名前',
  /** 分け残しが増えることの予告（設計書 §E.1 の V7）。 */
  directDomainNotice: (ownerName: string): string =>
    `「${ownerName}」は自分の形を持っているので、子に分けなかった残りの領域が 1 件増えます。名前は今なら変えられます。`,
  /** 分け残しの名前欄の読み上げ名。 */
  directDomainNameLabel: '分け残しの名前',

  // --- 予告文（設計書 §C.6 / §E.1）---------------------------------------------
  /** 何件をどこへ入れるか（3 択の下に出す）。 */
  previewInto: (count: number, parentName: string): string =>
    `${String(count)} 件をまとめて「${parentName}」の下に入れます。`,
  /** 新しく作る枝の予告。 */
  previewCreate: (count: number, newName: string): string =>
    `新しい上位領域「${newName}」を作り、${String(count)} 件をその下に入れます。`,
  /** 最上位へ（独立）の予告。 */
  previewNone: (count: number): string =>
    `${String(count)} 件をどこにも所属しない状態（最上位）にします。`,
  /**
   * どの年に記録が増えるか（V6 の確認の文）。**実際の増え方に合わせる**（反証 2-3 /
   * Fable #2）。旧版は枝によらず「元の上位領域と、移す地物の両方に増えます」と
   * 言い切っていたが、実際は
   *   - 移す地物が自分の系列を持っていなければ、まず **自分の系列が起きる**（決定 (1)）、
   *   - 元の上位領域にも記録が増える（子が減った姿）、
   *   - 新しい上位領域を作る枝では **作った上位領域**にも 1 本目の記録が生まれる、
   * で、枝と相手によって増える場所が違う。文を分けて、起きることだけを言う。
   */
  //
  // **元の上位領域を持たない対象だけなら「元の上位領域」を言わない**（増分 7 の手直し 2 回目 /
  // バグ狩り 2-5）。最上位の国を連邦化する（よくある操作）たびに、増えない場所を 1 句
  // 言っていた。`withOrigin` は「対象のうち元の上位領域を持つものが 1 件以上あるか」。
  previewAnchorsInto: (year: string, withOrigin: boolean): string =>
    withOrigin
      ? `${year}の記録が、移す地物・元の上位領域・行き先の上位領域に増えます。`
      : `${year}の記録が、移す地物・行き先の上位領域に増えます。`,
  previewAnchorsCreate: (year: string, withOrigin: boolean): string =>
    withOrigin
      ? `${year}の記録が、移す地物・元の上位領域に増え、新しく作る上位領域には 1 本目の記録が生まれます。`
      : `${year}の記録が移す地物に増え、新しく作る上位領域には 1 本目の記録が生まれます。`,
  previewAnchorsNone: (year: string, withOrigin: boolean): string =>
    withOrigin
      ? `${year}の記録が、移す地物・元の上位領域に増えます。`
      : `${year}の記録が、移す地物に増えます。`,
  /** 決定 (1): まとめ役の錨に居候している地物は、ここで自分の系列を持つ。 */
  previewMaterialize: (count: number): string =>
    `${String(count)} 件は上位領域の記録の中に居るので、この操作で自分の歴史を持つようになります（全部の年の記録を写します）。`,
  /** 取り消しの一言（どの枝でも最後に出す）。 */
  previewUndo: '取り消しは Ctrl+Z 1 回です。',
  /** 子を全部失って自動で消えるまとめ役（解体の主経路。反証 2-4）。 */
  previewAutoRemoved: (names: string): string =>
    `「${names}」は下位領域を全て失うので、この年から自動で消えます。`,
  /** 分け残しが生まれる枝の予告（反証 2-5）。 */
  previewDirectDomain: (ownerName: string, directDomainName: string): string =>
    `「${ownerName}」は形を持たないまとめ役に変わり、いまの形は新しい末端「${directDomainName}」へ移ります。`,
  /** 断られた理由を板の本文に出す（Fable #6）。 */
  previewIneligible: (parentName: string, reason: string): string =>
    `「${parentName}」は行き先にできません: ${reason}`,
  /** まとめ役を対象にしたとき、下位領域へ広げたことを言う（FR-48 後半）。 */
  previewExpanded: (aggregateName: string, count: number): string =>
    `「${aggregateName}」はまとめ役なので、その下位領域 ${String(count)} 件を対象にしました。`,
  /** 洗い直しで外したもの（その年に居ない）。 */
  previewDroppedMissing: (count: number): string =>
    `${String(count)} 件は、いまの年に存在しないので対象から外しました。`,
  /** 洗い直しで外したもの（空のまとめ役）。 */
  previewDroppedEmpty: (count: number): string =>
    `${String(count)} 件は、下位領域を 1 つも持たないまとめ役なので対象から外しました。`,
  /** 板の見出しに件数を出す（Fable #16: 何件を相手にしているのかが題で読める）。 */
  /** 帯の対象欄で複数を名乗る（反証 2-2）。 */
  targetWithRest: (head: string, rest: number): string => `${head} ほか ${String(rest)} 件`,
  optionsTitleWithCount: (count: number): string => `所属を変える（対象 ${String(count)} 件）`,
  /** 板の確定ボタン。確定欄の語と揃える。 */
  optionsConfirm: '所属を変える',
  /** 板の取りやめ。**「やめる」ではない** ―― 選んだ地物は保ったまま板だけ閉じる。 */
  optionsCancel: '選び直す',

  // --- 進行表示（中身 9）--------------------------------------------------------
  /** 確定に時間がかかるあいだ出す文。 */
  committing: '所属を変えています…',
} as const;

/**
 * 所属変更の段数（設計書 §C.4 の「手順 n/m」の m）。
 * 1 = 所属を変える地物を選ぶ / 2 = 新しい上位領域を選ぶ / 3 = 確定する。
 */
export const REPARENT_STEP_COUNT = 3;

export type ReparentStringKey = keyof typeof REPARENT_STRINGS;
