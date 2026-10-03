// U41 — Japanese UI text for filter / search / errors / diagnostics (FR-115 /
// FR-118, 技術方針 5.5, ui layer).
//
// 機能宣言: 本ユニットが追加する UI 文言 (フィルター/検索の UI ラベル・ヘルプ・例示、
// エラーメッセージ、ツールチップ) を日本語で文言定数モジュールへ集約する。i18n 抽象
// レイヤ (翻訳キー解決・ロケール切替) は設けない (FR-115).
//
// 適用 (教訓 5.30「過少共有と過剰共有の両方を戒める」/ 単一の真実源): 先行ユニット U20 の
// 文言定数モジュール (src/ui/shell/strings.ts) は「シェル骨格・メニュー・ツール・モード」
// の文言を、U13/U37 等の各 messages/strings は各機能の文言を担う。本ユニットの文言は
// U20 の語彙と重複しない「発見・健全性・バリデーション」固有のものに限り、ここへ集約する
// (二重に文言モジュールを作らない)。後続ユニットは同じカテゴリ分け・命名 (XXX_STRINGS の
// const オブジェクト、キーは用途) で文言を追加できる。
//
// すべて日本語。コンポーネント・定数は本モジュールのキーを参照し、インラインのリテラルを
// 持たない (教訓 5.19).

/** Display-control (filter) UI labels, hints and examples (FR-113 / FR-118). */
export const FILTER_STRINGS = {
  /** Section heading for the feature display-control panel (地物一覧区画内)。 */
  sectionTitle: '地物の表示制御',
  sectionHelp:
    '種別・深さ・地物ごとに表示/非表示を切り替え、不透明度や強調を調整できます。これらは見え方だけを変え、地物データそのものは変更しません。',
  // 種別軸 (FR-113)
  /**
   * 点 / 線 / 面 の可視軸の枠見出し。
   *
   * **2026-09-05 の手直し（F3。設計書 §H.1 の N-50）**: 前は「種別で表示」「種別を強調」で、
   * **枠の中の 3 行はどちらも「点情報 / 線情報 / 面情報」と同じ**だった。区別が 11px の
   * 灰色の枠見出しだけに載っていたので、行だけを見ると自分がどちらの軸を押しているのか
   * 分からない。**行の文言そのものに区別を入れる**（下の `kindVisibleRowLabel` /
   * `kindEmphasizeRowLabel`）。
   *
   * §H.1 の第一表記は「点を隠す」だが、**この升目は「入れると出る」向き**なので、
   * そのまま「隠す」にすると意味が裏返る。向きに合わせて「出す」にしてある。
   */
  kindGroupLabel: '地図に出す種類',
  kindPointLabel: '点情報',
  kindLineLabel: '線情報',
  kindAreaLabel: '面情報',
  kindGroupHint: '点・線・面のうち地図に表示する種別を選びます。',
  // 階層深度軸 (FR-38)
  depthLabel: '深さで表示',
  depthHint:
    '指定した深さまでの面情報のみ表示します（最上位=0、子は親+1）。空欄ですべての深さを表示します。',
  depthExample: '例: 「2」を指定すると深さ 0〜2 の面情報だけが表示されます。',
  // 個別地物軸 (FR-113)
  individualHideLabel: 'この地物を非表示',
  individualHint: '選んだ地物だけを個別に非表示にできます。',
  /** 「個別非表示 n 件を全て再表示」button label (n = 現在の個別非表示件数). */
  showAllHiddenLabel: (count: number): string => `個別非表示 ${count} 件を全て再表示`,
  // 不透明度 (FR-113)
  opacityLabel: '不透明度',
  opacityHint:
    '表示中の地物の不透明度を0〜1で調整します（1で不透明、0で透明）。',
  // 強調 (FR-113)
  emphasizeLabel: '強調表示',
  emphasizeHint:
    '指定した種別・深さ・地物を目立たせ、それ以外を薄くします。目立たせるのは一時的な見え方で、保存する見た目は変えません。',
  /** 右クリック「強調を解除」/ 個別地物の強調解除 (対象1件). */
  emphasizeClearLabel: '強調を解除',
  /** 右クリック「この地物を強調」(individualHideLabel と対称の個別地物操作). */
  emphasizeFeatureLabel: 'この地物を強調',
  /** パネルの種別強調トグル群 (kindGroupLabel と対称). */
  emphasizeKindGroupLabel: '目立たせる種類',
  /** 可視軸の 1 行（「点情報を出す」）。 */
  kindVisibleRowLabel: (kind: string): string => `${kind}を出す`,
  /** 強調軸の 1 行（「点情報を目立たせる」）。 */
  kindEmphasizeRowLabel: (kind: string): string => `${kind}を目立たせる`,
  emphasizeKindGroupHint:
    '選んだ種別を目立たせ、それ以外の地物を薄くします。隠すのとは別の軸です。',
  // --- 増分 4: オプションバーの「表示 ▾」（C7 で一覧の下からここへ移した）---------
  /** 設定欄のボタンの文字（「表示 ▾」）。 */
  displayMenuLabel: '表示',
  /** 種別（FR-40 の札）ごとの 3 トグルの群。 */
  kindLabelGroupLabel: '種別ごとの見え方',
  kindLabelGroupHint:
    '「島国」「州」のように付けた種別ごとに、隠す・薄くする・目立たせるを切り替えます。押した瞬間に効き、もう一度押すと解除します（取り消しの対象ではありません）。',
  kindLabelHide: '隠す',
  kindLabelDim: '薄くする',
  kindLabelEmphasize: '目立たせる',
  kindLabelCount: (n: number): string => `${String(n)}件`,
  kindLabelEmpty: 'まだ種別が 1 つも付いていません。',
  /** 深さの強調（G-6 / R8。`filter-state.ts` に在るのに呼び出し元が無かった軸）。 */
  emphasizeDepthLabel: '深さで目立たせる',
  emphasizeDepthHint:
    '指定した深さ以上の面情報を目立たせ、それ以外を薄くします（最上位=0、子は親+1）。',
  /** 強調の脱出口 — 種別・地物のどの強調も一括で解除する (強調中のみ活性). */
  emphasizeClearAllLabel: '強調をすべて解除',
  // --- 増分 4 の手直し E1: 表示 ▾ の先頭に出す「外れている」の知らせ（設計書 §D.6）--
  /**
   * 選んでいる地物が表示条件から外れているときの知らせ。
   *
   * **「深さを自動で上げる」は採らなかった**（設計書 §D.6 の規則②。増分 4 で不採用）
   * ので、代わりに **緩める操作をボタンにして見せる**（§H.5「次の一手をボタンにする」）。
   * 黙って特別扱いせず、外れていること・いま一時的に描いていること・戻し方の 3 つを出す。
   */
  hiddenSelectionTitle: 'この地物は表示条件から外れています',
  hiddenSelectionBody:
    '選んでいるあいだだけ地図に描いています。下のボタンで表示条件を緩めると、選択を外しても見えたままになります。',
  /** 緩めるボタン（軸ごと）。 */
  relaxIndividualLabel: 'この地物を表示する',
  relaxKindLabelLabel: (label: string): string => `種別「${label}」を表示する`,
  relaxKindLabel: (kind: string): string => `${kind}を表示する`,
  relaxDepthLabel: (depth: number): string => `深さ ${String(depth)} まで表示する`,
  // --- 増分 8E（G-12）: 緯経線グリッドの強調（FR-13）-----------------------------------
  /** 表示の設定の中の小見出し。 */
  gridGroupLabel: '緯経線グリッド',
  /** 赤道・0 度・180 度の線を強調するか（既定は強調する）。 */
  gridEmphasisLabel: '赤道・0度・180度の線を強調する',
  gridEmphasisHint:
    'この 3 本を太い赤線で描きます。外すと、ほかの緯線・経線と同じ線で描きます。保存ファイルには入りません。',
} as const;

// 検索モーダルの文言（`SEARCH_STRINGS`）は **2026-09-05 の増分 4 の手直しで消した**。
//
// 増分 4 で「地物を検索」は一覧の絞り込み欄へ統合され（E-6）、モーダルは画面から
// 無くなった。文言だけが残っていて、しかも中身は古い例（種別ラベルが「都市」＝
// `docs/現状.md` B45）だったので、**画面に出ないのに用語の食い違いとして数えられる**
// 状態になっていた。到達できない文言は消す（開発ガイド §2.11 の裏面）。
//
// 探す規則そのもの（`search.ts` / `adapters.ts`）は残してある ―― 説明・属性値で
// 絞り込む話（B53 / 増分 8E）でそのまま使う材料だからで、消すと作り直しになる。
// いまは画面から呼ばれていないことをここに明記しておく。

/** Validation messages — one per machine reason (FR-115 / FR-116, 教訓 5.26). */
export const VALIDATION_STRINGS = {
  emptyQuery: '検索キーワードを入力してください。',
  queryTooLong:
    '検索キーワードが長すぎます。256文字以内で入力してください。',
  opacityOutOfRange:
    '不透明度は0以上1以下の数値で指定してください。',
  depthInvalid:
    '深さは 0 以上の整数で指定してください。',
} as const;

/** Error-handling / report-hint messages (FR-115 / FR-117). */
export const ERROR_HANDLING_STRINGS = {
  /** The boundary error-boundary fallback title. */
  fallbackTitle: '表示中に問題が発生しました',
  /** The boundary error-boundary fallback body (recovery guidance). */
  fallbackBody:
    'この部分の表示を中断しました。操作をやり直しても改善しない場合は、お手数ですが開発者へ報告してください。',
  /** Suffix appended to unrecoverable/unexpected errors (FR-115). */
  reportHint: 'お手数ですが開発者へ報告してください。',
  /** Prefix for a recoverable (user-actionable) error. */
  recoverablePrefix: '入力内容を確認してください: ',
  /** Generic unexpected-error lead-in (FR-117). */
  unexpectedLead: '予期しないエラーが発生しました。',
} as const;

/** Diagnostics-view labels (FR-117 診断情報). */
export const DIAGNOSTICS_STRINGS = {
  /** Menu/command label (ヘルプメニュー). */
  commandLabel: '診断情報を表示',
  panelTitle: '診断情報',
  help:
    'アプリ内部のエラーログとアプリ概況を表示します。情報は端末内にのみ記録され、外部へ送信されません。',
  logSectionTitle: 'エラーログ（直近）',
  summarySectionTitle: 'アプリ概況',
  emptyLog: '記録されたエラーはありません。',
  /** Column / field labels for a log entry. */
  fieldRecordedAt: '記録時刻（実時間）',
  fieldContextTime: '操作時の作中時刻',
  fieldLevel: '種別',
  fieldMessage: 'メッセージ',
  fieldContext: '操作文脈',
  fieldCause: '原因',
  /** Note about privacy (FR-117 / FR-02). */
  privacyNote:
    '診断情報には個人情報やプロジェクトの内容は含めていません。外部送信も行いません。',
} as const;

/**
 * 地物一覧（台帳）の文言（増分 4 / 設計書 §C.5 / §H.1）。
 *
 * **画面の第一表記は設計書 §H.1 に従う**: 台帳 → 「地物一覧」、素性欄 → 「選んだ地物」、
 * 束 → 「作業のまとまり」、種別ラベル → 「種別」、階層深度 → 「深さ」。内部語をそのまま
 * 画面へ出さない（U-1 / N-30）。
 */
export const LEDGER_STRINGS = {
  /** 絞り込み欄（Ctrl+F の行き先）。**「地物を検索」はこの欄に統合した**（E-6）。 */
  filterPlaceholder: '名前・種別で絞り込み',
  filterAria: '地物一覧を名前・種別で絞り込み',
  /** 件数（絞り込みなし）。 */
  countAll: (total: number): string => `${String(total)}件`,
  /** 件数（絞り込み中）。 */
  countFiltered: (shown: number, total: number): string =>
    `${String(shown)} / ${String(total)}件`,
  emptyFeatures: '地物がありません。地図に地物を追加すると一覧に表示されます。',
  emptyAnchors: '歴史の錨がありません。地物の履歴がここに表示されます。',
  noMatch: '絞り込み条件に一致する項目がありません。',
  /** 母集団の切替（U-18 の裁定どおり 2 つのまま。§N-14 の (A)）。 */
  modeAria: '一覧の見方',
  modeCurrentLabel: '現在時刻',
  modeHistoryLabel: '通史',
  /** 木 / 平 の切替（G-7 / FR-111）。 */
  treeLabel: '木',
  flatLabel: '平',
  treeTitle: '階層をたどって並べます。',
  flatTitle: '絞り込んだ結果を平らに並べます。',
  /** 行の部品。 */
  expandLabel: (name: string): string => `${name} の下位領域を開く`,
  collapseLabel: (name: string): string => `${name} の下位領域を閉じる`,
  hideLabel: (name: string): string => `${name} を隠す`,
  showLabel: (name: string): string => `${name} を表示する`,
  /**
   * 隠れている行の説明（手直し B1 / 決定 (2)）。**行は消さずに 🚫 を出す**ので、
   * どの条件で隠れているかと、そのボタンで何が起きるかを言う。
   */
  hiddenTitleIndividual: 'この地物だけを隠しています。押すと表示に戻します。',
  hiddenTitleKindLabel: (label: string): string =>
    `種別「${label}」を隠しているので地図に出ていません。押すとこの種別を表示に戻します。`,
  /**
   * **押しても戻らない 2 つ**（2026-09-06、2 回目の手直し）。
   *
   * 点線面の軸と深さは「この地物だけ」では外せない条件なので、行のボタンは断る
   * （下の `showRefusedKind` / `showRefusedDepth`）。それなのに吹き出しは
   * 「押すとこの地物だけ表示に戻します。」と書いていた ―― **説明と実際が逆**で、
   * 押した人は断られてから初めて知る。吹き出しの側を実際の行き先に合わせる。
   */
  hiddenTitleKind:
    '点・線・面の表示で隠れています。オプションバーの「表示 ▾」で戻してください。',
  hiddenTitleDepth: '深さの条件で隠れています。オプションバーの「表示 ▾」で戻してください。',
  /** 上の 2 つ（点線面・深さ）は行のボタンでは外せない条件なので、断りの理由を出す。 */
  showRefusedKind:
    '点・線・面の表示で隠れています。オプションバーの「表示 ▾」で戻してください。',
  showRefusedDepth:
    '深さの条件で隠れています。オプションバーの「表示 ▾」で戻してください。',
  anchorCount: (n: number): string => `${String(n)}本`,
  anchorCountTitle: (n: number): string => `歴史の錨 ${String(n)} 本`,
  /**
   * 行の「済」の印と、その説明。
   *
   * 設計書 §H.1 は済の第一表記を **「名前を直しました／種別を直しました」**（何を
   * 直したかを書く）と決めている。28px の行に入るのは 1 文字なので、**印は「済」の
   * まま、説明に何を直したかを書く**（2026-09-05、増分 4 の手直し F3）。
   */
  doneMark: '済',
  doneTitleName: '名前を直しました（作ったときの名前と違います）。',
  doneTitleKindLabel: '種別を直しました（作ったときの種別と違います）。',
  doneTitleBoth: '名前と種別を直しました（作ったときと違います）。',
  /** 重複名の見分け（3 段）。 */
  qualifierParent: (parentName: string): string => `〈${parentName}〉`,
  /** 上の書式の開き括弧。段の判定にも使うので 1 か所に置く。 */
  qualifierParentOpen: '〈',
  pathSeparator: ' › ',
  noParent: '上位領域なし',
  /** 3 段目: 束の通し番号（あれば）と代表点の座標。 */
  qualifierPosition: (index: number | null, coordinate: string | null): string => {
    const parts: string[] = [];
    if (index !== null) parts.push(`#${String(index)}`);
    if (coordinate !== null) parts.push(coordinate);
    return parts.length === 0 ? '' : parts.join(' ／ ');
  },
  /** 短い座標（行が 28px なので 6 桁は入らない）。 */
  coordinate: (lat: string, lon: string): string => `${lat} ${lon}`,
  north: '北',
  south: '南',
  east: '東',
  west: '西',
  unknownCoordinate: '—',
  /** 通史の行（年 — 名前）。 */
  historyRowLabel: (year: string, name: string): string => `${year} — ${name}`,
  /**
   * 一覧の状態行（手直し A1 / B11）。
   *
   * **束が無いときは出さない**（件数は絞り込み欄の右にもう出ているので、同じ数を
   * 2 か所に置くだけの行になる）。低い窓では 1 行が行 1 つぶんの高さに相当する。
   */
  footer: (shown: number, total: number, done: number | null): string =>
    done === null
      ? `${String(total)} 件中 ${String(shown)} 件を表示`
      : `${String(total)} 件中 ${String(shown)} 件を表示 ／ 済 ${String(done)} 件`,
  /** 隠れている行の件数（絞り込み欄の右に足す）。 */
  hiddenCount: (n: number): string => `（うち ${String(n)} 件は非表示）`,
  /** 送りが末尾から先頭へ回り込んだ（手直し B11）。 */
  bundleWrapped: '末尾まで来たので、先頭の未処理へ戻りました。',
  /** 束が全部済んだ（送りの行き先が無い）。 */
  bundleAllDone: 'このまとまりは全部済みました。',
  /** その場編集の断り（手直し B11）。 */
  renameEmpty: '名前は空にできません。もとの名前のままにしました。',
  /** 通史の行が押せない理由（手直し G3）。 */
  historyRowHiddenTitle:
    'この錨の年では、この地物は表示条件から外れています。表示 ▾ で戻すと選べます。',
  /** その場編集（F2 / ダブルクリック）。 */
  renameAria: (name: string): string => `${name} の名前`,
  /**
   * 対象の印の升目（`markedFeatures`。増分 7 / 設計書 §D.5・§C.5）。**選択とは別概念**
   * なので「選ぶ」ではなく「対象にする」と言う ―― 選択は 0 か 1 件、印は集合である。
   */
  markAria: (name: string): string => `${name} を対象にする`,
  /** 印の件数（一覧の見出しに出す）。 */
  markedCount: (count: number): string => `対象 ${String(count)} 件`,
  /** 印を全部外す。 */
  clearMarks: '対象を全部外す',
  /** 読むだけのときは印を付けられない（司令塔の決定 (11)）。 */
  markReadOnly: '読むだけの状態では対象の印を付けられません。鍵を開けてから使ってください。',
  /** 絞り込みの結果すべてに印を付ける／外す（バグ狩り #14 の観察）。 */
  markAllVisible: '表示中の全部に印',
  unmarkAllVisible: '表示中の印を外す',
  markAllVisibleDone: (count: number): string => `表示中の ${String(count)} 件に印を付けました。`,
  markAllVisibleCleared: (count: number): string =>
    `表示中の ${String(count)} 件の印を外しました。`,
  kindLabelAria: (name: string): string => `${name} の種別`,
  renameHint: 'Enter で確定、Escape でやめる',
  /** 読むだけのときに、その場編集を断る理由（K-6 / G-23 の共通枠へ出す）。 */
  editRefusedViewOnly: '「読むだけ」の状態なので直せません。上の鍵を「直せる」にしてください。',
  /** 上の断りに添える「次の一手」のボタン（手直し E1 / 設計書 §H.5）。 */
  unlockLabel: '鍵を「直せる」にする',
  /** 打ちかけを捨てた理由（手直し G1 / K-5）。黙って消えないように必ず出す。 */
  editDiscardedContextChanged:
    '年・鍵・道具が変わったので、一覧で打ちかけていた名前は捨てました（打ち始めた年と違う年へ保存しないため）。もう一度どうぞ。',
  /**
   * **ほかの場所を押して打ちかけが消えた理由**（2026-09-06、2 回目の手直し）。
   *
   * その場編集の入力欄は焦点を失うと打ちかけを捨てる。Escape は利用者が自分で
   * やめたのだから黙ってよいが、状態行やモードのボタンを押しただけで消えるのは
   * **利用者から見て理由が無い**。年が動いたときと同じように、必ず理由を出す。
   */
  editDiscardedBlur:
    'ほかの場所を押したので、一覧で打ちかけていた名前は捨てました。もう一度どうぞ。',
  /**
   * **やり直して通ったときの知らせ**（2026-09-06、2 回目の手直し）。
   *
   * 断りは状態行の「直前の結果」に残る（K-7: 起きた事実は消さない）。だから断られた
   * 操作をやり直して通っても、**古い断りが画面に居座り、直っていないように読める**。
   * 「次の一手」を下ろすだけでは足りないので、通ったことも同じ場所へ書いて上書きする。
   */
  shownAgain: (name: string): string => `${name} を表示に戻しました。`,
  kindLabelShownAgain: (label: string): string => `種別「${label}」を表示に戻しました。`,
} as const;

/**
 * 作業のまとまり（内部語では「束」。設計書 §C.5 / §H.1）の文言。
 *
 * **束 ＝「絞り込み式を 1 回だけ走らせた結果を、そのときの並びと名前ごと固定したもの」。**
 */
export const BUNDLE_STRINGS = {
  label: '作業',
  selectAria: '作業のまとまりを選ぶ',
  expressionAria: '作業のまとまりの絞り込み式',
  expressionPlaceholder: '絞り込みの式（例: 付近の領域[0-9]+$）',
  makeLabel: 'この結果をまとめる',
  /** 束を作れたときの知らせ（2026-09-06。古い断りを上書きする）。 */
  made: (n: number): string => `${String(n)} 件の作業のまとまりを作りました。`,
  makeTitle: 'いまの絞り込みの結果を、並びと当時の名前ごと固定します。',
  clearLabel: 'やめる',
  prevLabel: '◀ 前へ',
  nextLabel: '次へ ▶',
  /** 「3 / 220」。 */
  position: (index: number, total: number): string =>
    `${String(index)} / ${String(total)}`,
  onlyUnfinishedLabel: '未処理だけ',
  emptyResult: 'この式に当てはまる地物がありません。式を書き換えてください。',
  /** **内部の英語をそのまま出さない**（手直し B11）。読めない式は「読めない」で足りる。 */
  invalidExpression:
    '式の書き方が読み取れません。括弧の対応や記号を見直してください（例: 付近の領域[0-9]+$）。',
  /** 空の式は何にでも当たるので断る（手直し B11）。 */
  emptyExpression:
    '式が空です。空の式はすべての地物に当たってしまうので、まとめる形を書いてください。',
  allDone: 'このまとまりは全部済んでいます。',
  /** まだ選べない既定（配線が揃っていない束の形）。 */
  presetUnavailable: (label: string): string => `${label}（まだ使えません）`,
  /** 束に残っているが、いまの年には居ないメンバー（手直し G2）。 */
  unavailableMembers: (n: number): string =>
    `このまとまりの ${String(n)} 件は、いまの年には居ません（消したか、まだ現れていません）。送りでは飛ばします。`,
  /** 束の既定の式 10 種（設計書 §C.5 の表）。実データの命名規約はアプリが知らないので、
   *  式そのものを画面に出して編集できるようにする。 */
  presetKana1: '仮名: ○○付近の領域NN',
  presetKana2: '仮名: ○○の島NN',
  presetKana3: '仮名: （○○不明国X）',
  presetKana4: '仮名: ○○の海域NN',
  presetKana5: '仮名: ??? を含む',
  presetDuplicateName: '名前が重複しているもの',
  presetNoKindLabel: '種別が付いていないもの',
  presetChangedThisYear: 'この年に変わったもの',
  presetFamily: 'この地物の家族（親・自分・子孫）',
  presetMarked: '手で印を付けたもの',
} as const;

/**
 * 「どこへでも移動」（Ctrl+P。設計書 §C.2 の 26）の文言。
 *
 * **年を属性の検索対象に入れない**（C10 の罠を作り直さない）。数字だけなら年、文字を
 * 含むなら地物名だけを探す。
 */
export const JUMP_STRINGS = {
  title: 'どこへでも移動',
  inputAria: '地物名・年・コマンドを打つ',
  placeholder: '地物名／年／> でコマンド',
  yearCandidate: (year: string): string => `${year} へ移動`,
  /**
   * **時間軸の範囲の外の年**（2026-09-06、2 回目の手直し）。押せない候補として出す。
   * 旧版は普通の候補として出し、押すと黙って端へ丸めていた（表示と行き先が違う）。
   */
  yearOutOfTimeline: (year: string, min: string, max: string): string =>
    `${year}（時間軸の範囲外。いまの時間軸は ${min}〜${max}）`,
  commandPrefixHint: '> を先頭に付けるとコマンドを探します。',
  more: (n: number): string => `ほかに ${String(n)} 件（Enter で一覧に出す）`,
  noCandidate: '当てはまるものがありません。',
  closeLabel: '閉じる',
} as const;
