// U30 — 結合後の「上位領域の決定」と「プロパティの決定」(FR-52).
//
// 上位領域の決定は所属変更 (U28) と同型の 3 択 (既存 / 新規上位作成 / 親なし) であり、
// 共通部分は U28 の {@link ParentDecision} を再利用する (教訓 5.30 過少共有の戒め: 同型
// サブフローは単一実装を共有)。結合固有の事前条件は precondition.ts に別実装する
// (教訓 5.27 / 5.30 過剰共有の戒め)。
//
// プロパティの決定は結合固有の 2 択 (引き継ぎ / 新規入力) を、不正状態を表現不能にする
// 判別共用体 (技術方針 2.1) として固定する。

import type { BasicAttributes, ColorInfo } from '../attributes';
import type { FeatureId } from '../ids';
import { PARENT_DECISION, type ParentDecision } from '../affiliation/decision';

// 上位領域決定は U28 の同型サブフローを再利用する (FR-52 / FR-46 と同型)。
export {
  PARENT_DECISION,
  type ParentDecisionKind,
  type ParentDecision,
  type NewAggregateSpec,
  parentExisting,
  parentNone,
  parentCreate,
  parentCreateWithTerminal,
  CREATE_TERMINAL,
  type CreateTerminalKind,
} from '../affiliation/decision';

// --- プロパティの決定 (FR-52, 結合固有) -------------------------------------

export const PROPERTY_DECISION = {
  /** 結合対象いずれかのプロパティを引き継ぐ (どの対象かを ID で選ぶ)。 */
  Inherit: 'inherit',
  /** 新規にプロパティを入力する (追加時の入力フローを再利用)。 */
  New: 'new',
} as const;

export type PropertyDecisionKind =
  (typeof PROPERTY_DECISION)[keyof typeof PROPERTY_DECISION];

/**
 * 結合結果地物に与えるプロパティ値 (名称・存在期間・色・種別ラベル)。`new` 決定が
 * 直接運び、`inherit` 決定は対象から解決される。形状属性は含まない (末端は論理和、
 * 集約は下位の和として別途算出されるため)。
 */
export interface MergedProperties {
  readonly attributes: BasicAttributes;
  readonly color: ColorInfo;
  readonly kindLabel?: string;
}

/**
 * 「プロパティの決定」判別共用体 (不正状態を表現不能に, 技術方針 2.1)。
 *   - `inherit` : 引き継ぎ元の対象 ID を指定。実体化時にその対象のプロパティを複製。
 *   - `new`     : 新規プロパティ値を直接運ぶ。
 */
export type PropertyDecision =
  | { readonly kind: typeof PROPERTY_DECISION.Inherit; readonly sourceId: FeatureId }
  | { readonly kind: typeof PROPERTY_DECISION.New; readonly properties: MergedProperties };

export function propertyInherit(sourceId: FeatureId): PropertyDecision {
  return { kind: PROPERTY_DECISION.Inherit, sourceId };
}

export function propertyNew(properties: MergedProperties): PropertyDecision {
  return { kind: PROPERTY_DECISION.New, properties };
}

/** 上位領域決定が「親なし (最上位)」か。最上位フラグ⇔親なしの同値 (FR-39)。 */
export function isTopLevelDecision(decision: ParentDecision): boolean {
  return decision.kind === PARENT_DECISION.None;
}
