// U28 — 所属変更フロー: 「新上位領域の決定」の判別共用体 (FR-46 / FR-47).
//
// 割譲・連邦化・独立・帰属・直轄化・自治化・解体は、いずれも別個の操作種別では
// なく「対象地物の新しい上位領域をどう決めるか」という同一フローのパラメータ違い
// として表現される (FR-46)。本 module はその決定を、不正状態を表現不能にする判別
// 共用体 (技術方針 2.1) として固定する。
//
//   - `existing` : 既存面情報 (許可候補一覧の 1 件) を新上位領域に選ぶ。
//   - `none`     : 親なし＝最上位領域へ (上位領域参照を外す)。最上位フラグ⇔親なし
//                  の同値 (FR-39) は U03 が parentId の有無で表すため、ここでも参照を
//                  外すこと自体が最上位化を意味する。
//   - `create`   : 新規上位領域 (集約地物) を作成し、対象の新上位領域に割り当てる。
//                  作成サブフローは末端 (既存最上位を上に置く＝帰属 / 新規最上位を
//                  作成) を持ち、さらに上位領域を再帰的に積み上げられる。中間階層の
//                  後付け挿入 (自治化) は再帰の段数として表現される (FR-47)。
//
// 本 module は純粋な型と factory のみ。フロー本体に「操作種別」を直接受け取る分岐
// 入力は存在しない (種別は対応表上の解釈であり、コードのパラメータは対象と本決定
// のみ) — これを型で固定する (受け入れ基準 1)。

import type { FeatureId } from '../ids';

export const PARENT_DECISION = {
  /** 既存面情報を新上位領域に選ぶ (割譲・帰属・直轄化)。 */
  Existing: 'existing',
  /** 親なし＝最上位領域へ (独立・解体の構成要素)。 */
  None: 'none',
  /** 新規上位領域 (集約地物) を作成して割り当てる (連邦化・自治化)。 */
  Create: 'create',
} as const;

export type ParentDecisionKind = (typeof PARENT_DECISION)[keyof typeof PARENT_DECISION];

/**
 * 新規上位領域作成サブフローの末端 (判別共用体)。再帰の終端を型で固定する。
 *   - `existing-top` : 既存の最上位面情報を、作成した新規上位領域の上位に置く (帰属)。
 *   - `new-top`      : 新規の最上位面情報を作成する (連邦化のルート / 単純な新規最上位)。
 */
export const CREATE_TERMINAL = {
  ExistingTop: 'existing-top',
  NewTop: 'new-top',
} as const;

export type CreateTerminalKind = (typeof CREATE_TERMINAL)[keyof typeof CREATE_TERMINAL];

/**
 * 新規上位領域の生成仕様 (名称・種別ラベル)。集約地物は形状属性を保持せず、形状は
 * 下位領域の和として算出される (FR-35)。種別ラベルは表示専用で検証に一切関与しない
 * (FR-40)。
 */
export interface NewAggregateSpec {
  /** 集約地物の名称。 */
  readonly name: string;
  /** 表示専用の種別ラベル (任意)。検証・候補絞り込みに関与しない (FR-40)。 */
  readonly kindLabel?: string;
}

/**
 * 「新上位領域の決定」判別共用体。`create` の上位決定フィールドが自身と同じ判別
 * 共用体を再帰的に持つことで、中間階層を任意段数で表現できる (FR-47)。
 */
export type ParentDecision =
  | { readonly kind: typeof PARENT_DECISION.Existing; readonly parentId: FeatureId }
  | { readonly kind: typeof PARENT_DECISION.None }
  | {
      readonly kind: typeof PARENT_DECISION.Create;
      /** 生成する集約地物の名称・種別ラベル。 */
      readonly spec: NewAggregateSpec;
      /**
       * 生成した集約地物の、さらに上位の決定 (再帰)。同じ判別共用体なので、
       * `create` を積み上げれば中間階層を多段挿入できる。
       */
      readonly above: ParentDecision;
    };

// --- 末端 (CreateTerminal) を `above` で表現するための糖衣 -------------------
//
// サブフローの末端は ParentDecision の `existing` / `none` で表現する:
//   - ExistingTop (帰属) = 末端で既存最上位を新規上位領域の上に置く = above が
//     `existing`(既存最上位 ID)。
//   - NewTop = 新規上位領域がそのまま最上位 = above が `none`。

export function parentExisting(parentId: FeatureId): ParentDecision {
  return { kind: PARENT_DECISION.Existing, parentId };
}

export const parentNone: ParentDecision = { kind: PARENT_DECISION.None };

export function parentCreate(spec: NewAggregateSpec, above: ParentDecision): ParentDecision {
  return { kind: PARENT_DECISION.Create, spec, above };
}

/**
 * 新規上位領域を作成し、その末端を `terminal` で指定する糖衣 factory。
 *   - `ExistingTop` は既存最上位 `topId` を上に置く (帰属相当 / 自治化の末端)。
 *   - `NewTop` は新規上位領域自身をルートにする (連邦化のルート)。
 */
export function parentCreateWithTerminal(
  spec: NewAggregateSpec,
  terminal:
    | { readonly kind: typeof CREATE_TERMINAL.ExistingTop; readonly topId: FeatureId }
    | { readonly kind: typeof CREATE_TERMINAL.NewTop },
): ParentDecision {
  const above =
    terminal.kind === CREATE_TERMINAL.ExistingTop ? parentExisting(terminal.topId) : parentNone;
  return parentCreate(spec, above);
}
