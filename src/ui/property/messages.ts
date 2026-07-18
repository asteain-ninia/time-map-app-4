// UI layer (U32 / property panel): Japanese UI strings (NFR 5.7 日本語 UI).
//
// All user-facing text for the property panel lives here in ONE place so the
// selection-display mapping (selection-display.ts) and the components reference
// the same constants — a case's message and its display condition stay
// one-to-one (受け入れ基準 1, 教訓 5.29). Stringly-duplicated copies would let a
// branch drift; the single table prevents it.

import { FEATURE_KIND, type FeatureKind } from '../../domain/feature';
import { MAX_DETAIL_DOCUMENT_LENGTH } from '../../domain/index';

export const PROPERTY_STRINGS = {
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
  startYearLabel: '開始年',
  endYearLabel: '終了年',
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
  viewOnlyNotice: '表示モードです。編集するには編集モードに切り替えてください。',

  // -- anchor list / time bar (FR-84 / FR-60) --------------------------------
  anchorSectionTitle: '歴史の錨',
  anchorListEmpty: 'この地物には歴史の錨がありません。',
  viewModeList: 'リスト表示',
  viewModeTimeBar: '時間バー表示',
  openEndLabel: '継続中',
  editTargetBadge: '編集対象',

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
   * 開始年 / 終了年 が永続化可能な整数範囲（±100万年）外のときの保存拒否理由
   * (bughunt 第12波 #2). WRITE 側でこれを弾かないと、フォームは受理しても READ 側
   * schema (yearSchema = 同じ isPersistedYear 境界) が load 時に manifest 全体を
   * 拒否し .tmap が二度と開けなくなる（書込⊆読込の非対称）。タイムライン年と同一の
   * 単一真実源 isPersistedYear で判定する。
   */
  yearOutOfRange:
    '開始年・終了年は ±100万年 の整数で入力してください（小数・範囲外は保存できません）。',
  /**
   * Shown when a property edit is confirmed but no live edit-apply binding is
   * wired yet (the U13/属性編集 apply seam is unassigned new-domain work). The
   * save surfaces this honest error rather than reporting a silent success, so
   * the user is never told an edit landed when it did not (HB-3 Codex P1).
   */
  editNotWired: '属性編集の保存はこのビルドでは未対応です。',
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
