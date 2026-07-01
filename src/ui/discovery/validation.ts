// U41 — input validation/sanitize for this unit's own inputs (FR-116, ui layer).
//
// 機能宣言: すべてのユーザー入力に検証と無害化を横断適用する共通基盤を提供し、本ユニット
// 自身の入力 (検索クエリ・フィルター設定値・透明度の数値範囲) にも自己適用する。検証は
// スキーマを単一宣言として書き、そこから型を導出する (技術方針 2.10「検証ロジックと型が
// 二重定義される偶発的複雑性を排除」)。検証結果は「ユーザー通知用の日本語メッセージ」と
// 「テスト可能な戻り値 (成功/失敗+理由)」の両方で扱う (教訓 5.26).
//
// 適用 (教訓 5.26「拒否理由は通知用メッセージとテスト可能フィールドの両方を返す」):
// 各 validate* は { ok, value } / { ok:false, reason, message } を返し、`reason`
// (機械可読) と `message` (日本語) を一対一に対応させる。これがこのユニットの「検証を
// 必ず通す共通入口 (境界ヘルパー)」であり、未検証入力が下流 (検索・フィルター・描画) へ
// 流入しない規約の実体である (技術方針 2.10 / R8).
//
// マークダウン詳細文書等の外部由来テキストのサニタイズは依存ユニットのレンダラ
// (U32 markdown.ts) が持つ本体を「必ず通す」横断規約として扱い、検索前処理の素テキスト化
// は search.ts の前段で行う (sanitize.ts)。

import { z } from 'zod';

import { stripInvisibleThenTrim } from '../../domain/text';
import { OPACITY_MAX, OPACITY_MIN } from './filter-state';
import { VALIDATION_STRINGS } from './strings';

/**
 * A validation outcome: success carries the parsed value, failure carries BOTH a
 * machine-readable `reason` (tests assert on this) and a日本語 `message` (the UI
 * shows this) — one-to-one (教訓 5.26 / 5.10). Generic so every validator shares
 * the shape.
 */
export type ValidationResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reason: ValidationReason; readonly message: string };

/**
 * The machine-readable rejection reasons. Code branches on these constants, the
 * UI maps each to ONE message (validationMessage) — never a bare literal
 * (教訓 5.19 / 5.26).
 */
export const VALIDATION_REASON = {
  /** The search query was empty / whitespace-only. */
  EmptyQuery: 'emptyQuery',
  /** The search query exceeded the maximum length. */
  QueryTooLong: 'queryTooLong',
  /** The opacity value was not a finite number in [0, 1]. */
  OpacityOutOfRange: 'opacityOutOfRange',
  /** The depth threshold was not a finite non-negative integer. */
  DepthInvalid: 'depthInvalid',
} as const;

export type ValidationReason =
  (typeof VALIDATION_REASON)[keyof typeof VALIDATION_REASON];

/** Map a machine reason to its single日本語 message (FR-115, 教訓 5.26). */
export function validationMessage(reason: ValidationReason): string {
  switch (reason) {
    case VALIDATION_REASON.EmptyQuery:
      return VALIDATION_STRINGS.emptyQuery;
    case VALIDATION_REASON.QueryTooLong:
      return VALIDATION_STRINGS.queryTooLong;
    case VALIDATION_REASON.OpacityOutOfRange:
      return VALIDATION_STRINGS.opacityOutOfRange;
    case VALIDATION_REASON.DepthInvalid:
      return VALIDATION_STRINGS.depthInvalid;
  }
}

function fail<T>(reason: ValidationReason): ValidationResult<T> {
  return { ok: false, reason, message: validationMessage(reason) };
}

// --- search query (FR-116 自己適用) -----------------------------------------

/**
 * Maximum accepted search-query length in CODE POINTS (defensive bound, NFR 5.5).
 * Counted by code point, not UTF-16 code unit, so a surrogate-pair glyph (emoji)
 * costs 1 like any other character rather than halving the effective limit.
 */
export const MAX_QUERY_LENGTH = 256;

/** Code-point length (a surrogate pair counts as 1), the unit the bound uses. */
function codePointLength(s: string): number {
  return [...s].length;
}

/**
 * The single schema declaration for a search query — type is DERIVED from it
 * (技術方針 2.10, no second definition). Invisible/zero-width code points are
 * stripped before trimming (domain single source, 教訓 5.30) so an invisible-only
 * query collapses to empty and is rejected; non-empty and length-bounded by code
 * point (not UTF-16 unit) so emoji do not halve the effective limit.
 */
export const searchQuerySchema = z
  .string()
  .transform((s) => stripInvisibleThenTrim(s))
  .pipe(
    z
      .string()
      .min(1)
      .refine((s) => codePointLength(s) <= MAX_QUERY_LENGTH),
  );

/** The validated search query type, derived from the schema (no duplication). */
export type SearchQuery = z.infer<typeof searchQuerySchema>;

/**
 * Validate a raw search query. Maps Zod's failure to the unit's reason/message
 * pair so the call site gets a testable reason and the UI a日本語 message. This
 * is the common入口 every search path funnels through (技術方針 2.10 / R8).
 */
export function validateSearchQuery(raw: string): ValidationResult<SearchQuery> {
  const parsed = searchQuerySchema.safeParse(raw);
  if (parsed.success) return { ok: true, value: parsed.data };
  // Distinguish empty from too-long by the same normalized form the schema uses
  // (invisible-stripped + trimmed) so an invisible-only query maps to Empty, not
  // TooLong (one-to-one mapping, 教訓 5.26).
  const normalized = stripInvisibleThenTrim(raw);
  if (normalized.length === 0) return fail(VALIDATION_REASON.EmptyQuery);
  return fail(VALIDATION_REASON.QueryTooLong);
}

// --- opacity (FR-116 自己適用: 透明度の数値範囲) ------------------------------

/** The single schema for an opacity value: finite number in [0, 1]. */
export const opacitySchema = z
  .number()
  .finite()
  .min(OPACITY_MIN)
  .max(OPACITY_MAX);

export type ValidOpacity = z.infer<typeof opacitySchema>;

/** Validate an opacity value (FR-116). Out-of-range / non-finite is rejected. */
export function validateOpacity(raw: number): ValidationResult<ValidOpacity> {
  const parsed = opacitySchema.safeParse(raw);
  if (parsed.success) return { ok: true, value: parsed.data };
  return fail(VALIDATION_REASON.OpacityOutOfRange);
}

// --- depth threshold (FR-116 自己適用: フィルター設定値) ----------------------

/** The single schema for a depth threshold: non-negative integer. */
export const depthThresholdSchema = z.number().int().nonnegative();

export type ValidDepth = z.infer<typeof depthThresholdSchema>;

/** Validate a depth-threshold value (FR-116). */
export function validateDepthThreshold(raw: number): ValidationResult<ValidDepth> {
  const parsed = depthThresholdSchema.safeParse(raw);
  if (parsed.success) return { ok: true, value: parsed.data };
  return fail(VALIDATION_REASON.DepthInvalid);
}
