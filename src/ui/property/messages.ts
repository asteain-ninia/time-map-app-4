// UI layer (U32 / property panel): Japanese UI strings (NFR 5.7 日本語 UI).
//
// All user-facing text for the property panel lives here in ONE place so the
// selection-display mapping (selection-display.ts) and the components reference
// the same constants — a case's message and its display condition stay
// one-to-one (受け入れ基準 1, 教訓 5.29). Stringly-duplicated copies would let a
// branch drift; the single table prevents it.

import { FEATURE_KIND, type FeatureKind } from '../../domain/feature';
import { MAX_DETAIL_DOCUMENT_LENGTH } from '../../domain/index';
// 鍵のラベルは `shell/strings.ts` が唯一の置き場（`shell/strings.ts` は何も import
// しないので循環しない）。下の {@link PROPERTY_STRINGS.viewOnlyNotice} が案内する
// ボタンの文字と、実際にボタンへ出る文字を**同じ 1 本から取る**（教訓 5.29）。
import { LOCK_LABELS } from '../shell/strings';

export const PROPERTY_STRINGS = {
  // --- 増分 4: 親（上位領域）欄と、線の長さ（現状.md B27 / G-1 / G-3）---------
  /** 親（所属）の欄名。用語は設計書 §H.1 の「上位領域」に合わせる。 */
  parentLabel: '上位領域',
  /** 上位領域が無い（最上位）ときの表示。追加フォームの言い方に揃える（B44）。 */
  parentNone: '上位領域なし',
  /** 親欄の 3 ボタン（設計書 §C.6 の 3 択 ＝ FR-46 must の入口）。 */
  parentPickLabel: '別の上位領域を選ぶ',
  parentCreateLabel: '新しく作る',
  parentClearLabel: '最上位へ',
  /**
   * 3 ボタンをまだ押せない理由（§H.5 の作法: 押せない部品には理由を添える）。
   * **押せるのに動かない部品を作らない** ―― 所属変更は「押した瞬間に手順へ入る」
   * 操作なので、手順そのものを作る増分 7 までは押せなくしておく。
   */
  parentDisabledReason: 'まだ使えません（所属を変えるのは次の段階です）',
  /** 線情報の長さ（G-1 / FR-19 must。面積と対になる読み取り専用の行）。 */
  lengthLabel: '長さ',
  lengthUnit: 'km',
  // -- selection-display cases (FR-83) ---------------------------------------
  /** 空選択: nothing is selected. */
  emptySelection: '地物が選択されていません。',
  /** 複数検出: vertex selection spans multiple features. */
  multipleFeatures: '複数の地物が選択されています。1件ずつ選択して編集してください。',
  /** 所有者不明: the selected vertices' owner cannot be resolved. */
  unknownOwner: '選択頂点の所有地物を特定できません。',
  /** 表示対象地物が解決できたがデータに存在しない (stale reference). */
  featureMissing: '選択された地物が見つかりません。',

  // -- basic info form (FR-97) -----------------------------------------------
  basicInfoTitle: '基本情報',
  nameLabel: '名前',
  /**
   * FR-40 の種別ラベル（「州」「都市」など利用者が自由に付ける表示用の文字列）。
   * 地物種別（点情報/線情報/末端地物/集約地物）とは**別物**なので、ラベルもそれと
   * 混ざらない言い方にする。
   */
  kindLabelLabel: '種別',
  kindLabelPlaceholder: '例: 州・都市（空欄可）',
  /** 本物の存続期間（錨の並びが正本, U-23）の行見出し。 */
  existenceLabel: '続く',
  /** 存続期間の「終わりが決まっていない」側の言い方。 */
  existenceOpenEnd: '継続中',
  /** 存続期間に穴があるときの区切り（「0年 → 2000年、3000年 → 継続中」）。 */
  existenceRunSeparator: '、',
  startYearLabel: '開始年',
  endYearLabel: '終了年',
  /** 畳んだ「詳しい属性」。飾りの開始年・終了年をここへ下ろした（裁定 §N-5 の (A)）。 */
  advancedAttributesTitle: '詳しい属性',
  advancedAttributesHint:
    'ここの開始年・終了年は表示用の属性で、直せません。地物がいつ現れていつ消えるかは、上の「続く」（歴史の錨の並び）が決めます。',
  /**
   * 面情報の面積 (FR-20). A read-only DERIVED value shown only for leaf (面) features:
   * the km² area of the resolved shape at the edit time, computed by the geodesy
   * unit's shapeAreaKm2 (単一真実源, src/domain/geo/geodesy.ts). Point / line features
   * have no area and never show this row. 赤道長・扁平率 (FR-109) と形状編集で再計算される。
   */
  areaLabel: '面積',
  /** Area unit — square kilometres (FR-20 / 技術方針 §2.9). */
  areaUnit: 'km²',
  colorSectionTitle: '色情報',
  autoColorLabel: '自動配色を許可',
  fillColorLabel: '塗り色',
  selectedColorLabel: '選択時色',
  borderColorLabel: '境界色',
  saveButton: '保存',
  /**
   * 「読むだけ」のあいだ、保存の列の代わりに出す断り書き。
   *
   * **無くなったボタンを指す文にしない**（増分 5 の手直し E1。旧文は「表示モードです。
   * 編集するには編集モードに切り替えてください。」で、モードの 3 ボタンが鍵 1 個に
   * 置き換わった増分 5 のあとは、**画面に存在しないボタンへの案内**になっていた）。
   * 行き先はアプリバーの鍵ひとつなので、その**ボタンに実際に出る文字**をそのまま埋める。
   */
  viewOnlyNotice: `いまは読むだけです。直すには上の鍵を「${LOCK_LABELS.unlocked}」にしてください。`,

  // -- anchor list / time bar (FR-84 / FR-60) --------------------------------
  anchorSectionTitle: '歴史の錨',
  anchorListEmpty: 'この地物には歴史の錨がありません。',
  openEndLabel: '継続中',
  editTargetBadge: '編集対象',
  /** 錨表の見出しに出す本数。 */
  anchorCount: (count: number): string => `${count.toLocaleString('ja-JP')} 本`,
  /** 既定は現在時刻の前後だけを出しているので、隠れている本数を言って広げる口を出す。 */
  anchorShowAll: (hidden: number): string =>
    `全部見る（あと ${hidden.toLocaleString('ja-JP')} 本）`,
  anchorShowNearby: '近くだけ見る',
  /** 終わりが決まっている錨の行に添える。 */
  anchorEndsAt: (end: string): string => `〜${end}`,
  /** 親の名前が引けなかったときの言い方（内部 id は画面に出さない、U-1）。 */
  unknownParentName: '別の地物',
  /**
   * 名前が空の地物の言い方。ドメインの `featureDisplayName` は名前が空のとき
   * **内部 id** を返すので、そのまま出すと確認の本文や見出しに `f-5-4` が出る
   * （U-1 違反）。出口 1 か所でこれに落とす（教訓 5.51）。
   */
  unnamedFeature: '名前のない地物',
  /** 存続期間の操作は押した瞬間に効くことを明記する（N-46 を揃えた残り）。 */
  intervalImmediateHint:
    'ここの操作は押した瞬間に効きます（Ctrl+Z で元に戻せます）。',

  // -- 存続期間編集 (HB3-12, FR-54〜FR-59) ------------------------------------
  /** Edit the anchor's appear-year (U09 changeStart). */
  startYearEditLabel: '開始年',
  /** Edit the anchor's disappear-year (U09 setEnd). */
  endYearEditLabel: '終了年',
  /** Title of the 開始 year/month/day input (FR-70 — shared YearMonthDayInput). */
  intervalStartTitle: '開始',
  /** Title of the 終了 year/month/day input (FR-70 — shared YearMonthDayInput). */
  intervalEndTitle: '終了',
  /**
   * Hint under the存続期間 editor: month/day are optional; leaving 未指定 keeps the
   * coarser granularity (年のみ / 年月まで) — 空欄=未指定を明示 (FR-70, 教訓 5.18).
   */
  intervalGranularityHint: '月・日は「未指定」で省略できます（年のみ／年月まで）。',
  /** Apply the existence-period edit. */
  intervalApplyLabel: '反映',
  /** Clear the end (open-ended / 継続中, U09 setEnd null). */
  intervalClearEndLabel: '継続中にする',
  /**
   * FR-70 (F2): switch an open-ended (継続中) end into concrete date entry. Required
   * before a non-null end TimePoint can be dispatched, so a 継続中 anchor is never
   * silently closed by an untouched「反映」(存続期間データ保護).
   */
  intervalSpecifyEndLabel: '終了を指定',
  /** Delete this anchor (U09 deleteAnchor). */
  intervalDeleteLabel: 'この錨を削除',
  /** Title for the per-anchor存続期間 editor disclosure. */
  intervalEditTitle: '存続期間を編集',
  intervalEditFailedPrefix: '存続期間を変更できません: ',

  // -- detail panel (FR-99 / FR-98) ------------------------------------------
  openDetailButton: '詳細表示',
  detailPanelTitlePrefix: '詳細: ',
  detailDocumentTitle: '詳細文書',
  /** 畳んだ節の見出し（設計書 §C.6 の「▸ 詳細文書（0 字）」）。 */
  detailDocumentTitleWithLength: (length: number): string =>
    `${'詳細文書'}（${length.toLocaleString('ja-JP')} 字）`,
  detailAttributesTitle: '属性',
  brokenImageAlt: '画像を表示できません',

  // -- 詳細文書の編集 (FR-98 後段, サイドバー PropertyPanel) -------------------
  /** The 閲覧 (sanitized preview) toggle of the詳細文書 editor. */
  detailDocViewToggle: '閲覧',
  /** The 編集 (raw Markdown textarea) toggle of the詳細文書 editor. */
  detailDocEditToggle: '編集',
  /** aria-label of the raw Markdown textarea. */
  detailDocTextareaLabel: '詳細文書（Markdown）',
  /** Shown when the詳細文書 has no content yet (preview placeholder). */
  detailDocEmpty: '詳細文書はまだありません。',
  /** 詳細文書に専用の保存ボタンが無くなったことを言う（N-46 を揃えた結果）。 */
  detailDocSaveHint: '名前や見た目と一緒に、下の保存ボタンで確定します。',

  // -- 地物種別 (種別) の日本語表示ラベル (要件定義書 §4) --------------------
  // 詳細パネル等の「種別」行に出るドメイン kind の日本語名。ドメインの
  // featureKindLabel は enum 生値 (英語: point/line/leaf/aggregate) を返すため、
  // ユーザー可視表示にはこちらを使う (実機報告「種別: aggregate って何?」の根治)。
  // kind 値そのものは不変・これは表示層の写像のみ。ユーザー編集可能な種別ラベル
  // FR-40 (kindLabel, 例「都市」) とは別物 (混同しない)。
  kindPoint: '点情報',
  kindLine: '線情報',
  kindLeaf: '末端地物',
  kindAggregate: '集約地物',

  // -- decision messages (教訓 5.12) -----------------------------------------
  dismissMessage: '閉じる',
  saveFailedPrefix: '保存に失敗しました: ',
  /**
   * Shown when a property edit is confirmed but no live edit-apply binding is
   * wired yet (the U13/属性編集 apply seam is unassigned new-domain work). The
   * save surfaces this honest error rather than reporting a silent success, so
   * the user is never told an edit landed when it did not (HB-3 Codex P1).
   */
  editNotWired: '属性編集の保存はこのビルドでは未対応です。',
  /** Enter を押したのに保存できないときの、理由が引けなかった場合の言い方（手直し B11）。 */
  saveUnavailable: 'いまは保存できません。上の編集時刻と鍵の状態を確かめてください。',
  /** 一覧のその場編集が、素性欄の打ちかけを守るために断る理由（手直し B11 / N-04）。 */
  quickEditDraftPending:
    'この地物は下段の「選んだ地物」で書きかけです。下段で保存するかやめるかしてから直してください。',

  // -- 打ちかけの下書きの扱い (N-04) -----------------------------------------
  /**
   * N-04: 打ちかけの文字が、錨を選ぶ・時間を動かすだけで**警告なく消えていた**。
   * 本設計は時刻を動かす頻度が上がるので被害が比例して増える（実装計画 増分 2 の
   * 中身 7）。捨てる前に必ず聞く。
   */
  draftDiscardTitle: '入力中の内容があります',
  draftDiscardBody: (where: string): string =>
    `${where}で入力した内容がまだ保存されていません。このままでは失われます。`,
  draftDiscardKeep: '元の場所へ戻る',
  draftDiscardDrop: '入力中の内容を捨てる',
  /** 打ちかけの発生場所の言い方（地物名＋年）。 */
  draftOrigin: (featureName: string, year: string): string => `${featureName}（${year}）`,

  // -- まとめ役の子の錨 (設計書 §C.6 / 裁定 §N-15) ---------------------------
  /**
   * 自分の履歴を持たない地物（実データで 86 件 = 3 つのまとめ役の子ぜんぶ）を選んだ
   * ときの断り書き。**錨の欄ごと消す**のをやめ、親の系列のうちその地物に関わる錨だけを
   * その場に出す。
   */
  inheritedAnchorNotice: (ownerName: string): string =>
    `この地物の歴史は親の「${ownerName}」が持っています。下の錨は、その系列のうちこの地物に関わるものだけです。`,
  /** 親を選び直すボタン。 */
  // 「親」は階層の内部語寄り。画面では上位領域（設計書 §H.1 / 増分 3 で素性欄の欄名を
  // 「上位領域」に統一した）に揃える（2026-09-05、増分 4 の手直し F3）。
  inheritedAnchorGoToOwner: '上位領域を見る',

  // --- 増分 7: 削除の 2 経路（設計書 §A.3）------------------------------------
  /**
   * **入口 A**（既定・目立つ位置）。「消す」と言われる操作の実体はたいてい消滅ではなく
   * 終了なので、こちらを存続期間の行の隣に置く（T25 の 30 秒への答え）。
   */
  endHereLabel: (year: string): string => `${year}に終わったことにする`,
  /** 入口 A の説明（押す前に何が起きるかを読めるように）。 */
  endHereHint: 'この年でこの地物が終わったことにします（削除ではありません。Ctrl+Z 1 回で戻せます）。',
  /** 入口 A が押せないとき（自分の歴史を持たない地物）。 */
  endHereNoOwnSeries: (ownerName: string): string =>
    `この地物の歴史は親の「${ownerName}」が持っているので、ここからは終わりを打てません。上位領域の側で記録してください。`,
  /** 入口 A が通ったときの結果の文。 */
  endHereDone: (name: string, year: string): string => `「${name}」は${year}で終わったことにしました。`,
  /** **入口 B** を畳んでおく節の見出し（設計書 §C.6 の「取り返しのつかないこと」）。 */
  dangerZoneTitle: '取り返しのつかないこと',
  /** 入口 B のボタン。 */
  deleteAllYearsLabel: 'この地物を全部の年から消す',

  // --- 増分 7: 影響ダイアログ（設計書 §A.3 / 中身 6）---------------------------
  impactTitle: (name: string): string => `「${name}」を全部の年から消します`,
  impactHeadingGone: '一緒に消えるもの',
  impactHeadingReferenced: '他から参照されているところ',
  impactHeadingAuto: '自動で消える地物',
  impactYear: (year: number): string => `${String(year)}年`,
  impactAnchors: (count: number, years: string): string =>
    `この地物の歴史の記録（錨）${String(count)} 件（${years}）`,
  impactNoOwnAnchors:
    'この地物は自分の歴史を持たず、上位領域の記録の中に居ます（錨は 0 件）',
  impactVertices: (count: number): string => `頂点 ${String(count)} 個`,
  impactVerticesAggregate:
    '頂点 0 個（この地物は下位をまとめる側なので自分の形を持ちません）',
  impactPromoted: (count: number, names: string): string =>
    `下位領域 ${String(count)} 件（${names}）が、すべての年で最上位へ移ります`,
  impactAutoRemoved: (count: number, names: string): string =>
    `${String(count)} 件（${names}）が、下位領域を全て失うため一緒に消えます`,
  impactAutoRemovedNone: 'なし（下位領域を全て失った集約は自動で消えます）',
  impactNamesWithRest: (names: string, rest: number): string =>
    `${names} ほか ${String(rest)} 件`,
  impactConfirm: '影響を整理して削除',
  impactCancel: 'やめる',
  impactUndoNote: '※ Ctrl+Z 1 回で戻せます',

  // --- 増分 7: 一括の種別付け（中身 8）----------------------------------------
  bulkKindTitle: (count: number): string => `${String(count)} 件へまとめて種別を付ける`,
  bulkKindHint:
    '印を付けた地物すべてに、いま見ている年で同じ種別を付けます。取り消しは Ctrl+Z 1 回です。',
  bulkKindInputLabel: '付ける種別',
  bulkKindEmptyNote: '空欄のまま確定すると、種別を外します。',
  bulkKindConfirm: '種別を付ける',
  bulkKindCancel: 'やめる',
  bulkKindCommitting: '種別を付けています…',
  bulkKindDone: (count: number, kindLabel: string): string =>
    kindLabel === ''
      ? `${String(count)} 件の種別を外しました。`
      : `${String(count)} 件へ種別「${kindLabel}」を付けました。`,
  bulkKindNoChange: '種別が変わる地物がありませんでした。',

  // --- 増分 7: N-05（錨・輪郭・頂点の削除に確認が無い）を同じ器に載せる（中身 7）----
  anchorDeleteTitle: (start: string): string => `${start}の記録（錨）を消します`,
  anchorDeleteLineRecord: (start: string): string =>
    `${start}から始まる、この地物の姿の記録が 1 件消えます`,
  anchorDeleteLineFallback:
    'この年からは、1 つ前の記録の姿がそのまま続くようになります（形・名前・種別・上位領域）',
  anchorDeleteConfirm: 'この記録を消す',
  ringDeleteTitle: (kind: string): string => `${kind}を消します`,
  ringDeleteLineShape: (kind: string): string => `この面から${kind}が 1 つ消えます`,
  /** **最後の外周を消すと面ごと消える**（設計書 §A.3 が名指しした事前の文）。 */
  ringDeleteLineLastTerritory:
    'これはこの面の最後の外周です。消すと、この年からこの地物そのものが消えます',
  ringDeleteConfirm: 'この輪郭を消す',
  vertexDeleteTitle: (count: number): string => `頂点 ${String(count)} 個を消します`,
  vertexDeleteLineCount: (count: number): string => `選んでいる頂点 ${String(count)} 個が消えます`,
  /** 頂点が減りすぎると面・線として成り立たなくなる（事前の文）。 */
  vertexDeleteLineBelowThreshold:
    '残る頂点が形として成り立たない数になるため、この年からこの地物そのものが消えます',
  vertexDeleteConfirm: 'この頂点を消す',
} as const;

/**
 * 地物種別 (種別) をユーザー可視の日本語ラベルへ写像する (要件定義書 §4: 点情報 /
 * 線情報 / 末端地物 / 集約地物). ドメインの kind 値 (point/line/leaf/aggregate) は
 * 不変で、これは表示層のみの写像 — domain の featureKindLabel は enum 生値 (英語) を
 * 返すため、詳細パネル等の「種別」表示にはこの関数を使う (単一真実源: 種別の日本語
 * 表示はここだけ、教訓 5.29). `Record<FeatureKind, string>` なので kind の追加は
 * コンパイルエラーで検出される (網羅性). ユーザー編集可能な種別ラベル FR-40
 * (kindLabel) とは別物。
 */
const FEATURE_KIND_JA: Readonly<Record<FeatureKind, string>> = {
  [FEATURE_KIND.Point]: PROPERTY_STRINGS.kindPoint,
  [FEATURE_KIND.Line]: PROPERTY_STRINGS.kindLine,
  [FEATURE_KIND.Leaf]: PROPERTY_STRINGS.kindLeaf,
  [FEATURE_KIND.Aggregate]: PROPERTY_STRINGS.kindAggregate,
};

export function featureKindJaLabel(kind: FeatureKind): string {
  return FEATURE_KIND_JA[kind];
}

/**
 * Format a shape area (km²) for the read-only 面積 row (FR-20). Mirrors the survey
 * unit's formatDistanceKm (ja-JP grouping + 2 fraction digits) so magnitudes read
 * consistently across the app (教訓 5.30). A non-finite value (e.g. a degenerate
 * shape whose vertices could not all resolve upstream) surfaces a dash rather than
 * "NaN km²" — the row is honest about an unresolvable value without crashing.
 */
/**
 * The WRITE-side over-length rejection for a 詳細文書 draft (FR-98). Shown BEFORE any
 * dispatch (the domain RangeError is the last防波堤, not the UX). Names the actual and
 * maximum lengths so the user knows how far over they are (honest, 教訓 5.26).
 */
export function detailDocumentTooLongMessage(length: number): string {
  const max = MAX_DETAIL_DOCUMENT_LENGTH.toLocaleString('ja-JP');
  const actual = length.toLocaleString('ja-JP');
  return `詳細文書が長すぎるため保存できません（${actual} 文字 / 上限 ${max} 文字）。`;
}

/**
 * 長さ（km）を画面に出す（G-1 / FR-19 must）。面積と **同じ丸め方**にしてある ――
 * 片方だけ桁が違うと、同じ素性欄の中で数字の読み方が 2 通りになる。
 */
export function formatLengthKm(km: number): string {
  if (!Number.isFinite(km)) {
    return `— ${PROPERTY_STRINGS.lengthUnit}`;
  }
  const rounded = km.toLocaleString('ja-JP', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return `${rounded} ${PROPERTY_STRINGS.lengthUnit}`;
}

export function formatAreaKm2(km2: number): string {
  if (!Number.isFinite(km2)) {
    return `— ${PROPERTY_STRINGS.areaUnit}`;
  }
  const rounded = km2.toLocaleString('ja-JP', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return `${rounded} ${PROPERTY_STRINGS.areaUnit}`;
}
