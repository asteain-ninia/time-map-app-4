// U41 — feature search over the VISIBLE母集合 (FR-113, 教訓 5.3 / 5.5, ui layer).
//
// 機能宣言: 地物を名前・説明・属性値で検索し、結果をハイライト・結果へジャンプする。検索
// 対象・結果は「現在 UI 上に表示されている要素 (現在時刻に存在し、表示制御で表示状態に
// ある地物)」を基準にする (FR-113).
//
// 適用 (教訓 5.3「操作対象は表示状態に限定する」, 引用: ユーザー操作の対象は『現在 UI 上に
// 表示されている要素』に限定する。データソース全体を直接検索せず、表示状態 (リアクティブ
// 派生状態) を基準にする): `searchFeatures` は呼び出し側が渡す「表示状態の母集合」
// (visibility.ts の visible 判定を通った地物) のみを走査し、非表示・非存在の地物を結果に
// 混ぜない。現在時刻・表示制御が変われば母集合が変わるので結果も同じ基準で再評価される
// (教訓 5.5/5.6): 再評価は入力経路でゲートせず、毎回母集合から導出する。
//
// 純粋: 母集合 + クエリ → 結果。マッチング判定は副作用なく Vitest 単体テスト可能
// (NFR 5.8). 説明テキストは呼び出し側が toSearchableText (sanitize.ts) で素テキスト化
// した値を渡す規約 (検索前サニタイズ, FR-116).

import type { FeatureId } from '../../domain/ids';

import type { FeatureKindAxis } from './axes';

/**
 * One searchable record from the VISIBLE母集合. The caller (the adapter over
 * U32) builds these ONLY from features that passed the display resolution
 * (visibility.ts) at the current time — so a record existing here already means
 * "visible now" (教訓 5.3). `description` MUST be the sanitized素テキスト
 * (sanitize.toSearchableText), never raw Markdown/HTML (FR-116).
 */
export interface SearchableFeature {
  readonly id: FeatureId;
  readonly kind: FeatureKindAxis;
  /** 名前 (FR-97). */
  readonly name: string;
  /** 説明 — サニタイズ済み素テキスト (FR-98 / FR-116). */
  readonly description: string;
  /** 属性値 (種別ラベル FR-40 / 年代 FR-97 ほか) を文字列化した検索対象。 */
  readonly attributes: readonly string[];
}

/** Which field a match was found in (for highlight / result display). */
export const MATCH_FIELD = {
  Name: 'name',
  Description: 'description',
  Attribute: 'attribute',
} as const;

export type MatchField = (typeof MATCH_FIELD)[keyof typeof MATCH_FIELD];

/** One search hit: the feature + which fields matched the (normalized) query. */
export interface SearchHit {
  readonly featureId: FeatureId;
  readonly name: string;
  /** Every field the query matched in (at least one). */
  readonly matchedFields: readonly MatchField[];
}

/**
 * The search result set. `query` echoes the normalized query so the UI can
 * highlight it; `hits` are in母集合 order. A判断用 result (教訓 5.12): the UI
 * keeps this until a new search / explicit clear, not on an unrelated click.
 */
export interface SearchResult {
  readonly query: string;
  readonly hits: readonly SearchHit[];
}

/** Case/width-insensitive normalization for matching (ja/en friendly fold). */
function fold(s: string): string {
  return s.normalize('NFKC').toLowerCase();
}

/**
 * Search the VISIBLE母集合 for `normalizedQuery` (already validated/trimmed by
 * validation.validateSearchQuery). Matches name / sanitized description /
 * attribute values via substring (fold-normalized). Returns hits in母集合 order;
 * a feature absent from `corpus` (= not visible/present) can never appear
 * (教訓 5.3). Pure — same corpus + query ⇒ same result (教訓 5.5/5.6 再評価は
 * 母集合から導出).
 */
export function searchFeatures(
  corpus: readonly SearchableFeature[],
  normalizedQuery: string,
): SearchResult {
  const needle = fold(normalizedQuery);
  const hits: SearchHit[] = [];

  for (const f of corpus) {
    const matchedFields: MatchField[] = [];
    if (fold(f.name).includes(needle)) matchedFields.push(MATCH_FIELD.Name);
    if (fold(f.description).includes(needle)) {
      matchedFields.push(MATCH_FIELD.Description);
    }
    if (f.attributes.some((a) => fold(a).includes(needle))) {
      matchedFields.push(MATCH_FIELD.Attribute);
    }
    if (matchedFields.length > 0) {
      hits.push({ featureId: f.id, name: f.name, matchedFields });
    }
  }

  return { query: normalizedQuery, hits };
}

/**
 * Re-evaluate an existing result against the CURRENT母集合 (教訓 5.5/5.6): drop
 * hits whose feature is no longer visible/present (the corpus no longer contains
 * it). This is the SAME criterion as the original search — derived from the
 * corpus, not gated on which input path changed (時刻変更・フィルター変更の全経路
 * で同じ再評価)。Returns a fresh result; pure.
 */
export function reevaluateResult(
  previous: SearchResult,
  corpus: readonly SearchableFeature[],
): SearchResult {
  const present = new Set<FeatureId>(corpus.map((f) => f.id));
  return {
    query: previous.query,
    hits: previous.hits.filter((h) => present.has(h.featureId)),
  };
}

/** The highlight set the draw layer subscribes to (FR-113 結果ハイライト). */
export function highlightIds(result: SearchResult): Set<FeatureId> {
  return new Set(result.hits.map((h) => h.featureId));
}

// --- jump target evaluation (FR-113 結果へジャンプ, 教訓 5.5) ----------------

/** The outcome of asking "can we jump to / select this hit right now?" */
export const JUMP_OUTCOME = {
  /** The feature is present at the current time → camera move + select. */
  Selectable: 'selectable',
  /** The feature is visible母集合 but jumping then it has no anchor at time →
   *  camera move only, NO selection, show案内 (教訓 5.5). */
  PresentNoSelect: 'presentNoSelect',
  /** The feature is no longer in母集合 (became hidden/absent) → no jump, 案内. */
  Gone: 'gone',
} as const;

export type JumpOutcome = (typeof JUMP_OUTCOME)[keyof typeof JUMP_OUTCOME];

/**
 * Decide what a jump to `featureId` should do, given the current母集合 and
 * whether the feature is selectable (exists at the current time per U16/U32).
 * This keeps the "存在しなければ選択せず案内を表示" rule (受け入れ基準2) in ONE
 * pure place; the UI maps the outcome to camera/selection actions + a日本語案内.
 */
export function evaluateJump(
  featureId: FeatureId,
  corpus: readonly SearchableFeature[],
  selectableAtTime: boolean,
): JumpOutcome {
  const inCorpus = corpus.some((f) => f.id === featureId);
  if (!inCorpus) return JUMP_OUTCOME.Gone;
  return selectableAtTime ? JUMP_OUTCOME.Selectable : JUMP_OUTCOME.PresentNoSelect;
}
