// U28 — 親候補の絞り込み検証述語 (FR-48, 教訓 5.27 / 5.25 / 5.26 / 5.28).
//
// 所属変更「固有」の事前条件をここに分離実装する (結合フローの事前条件と混同しない
// ＝教訓 5.27)。許可候補一覧の算出 (UI ピッカー用) と、確定前の合法性再検証は、
// 同一の検証述語 {@link isLegalNewParent} を共有する (教訓 5.26 / 単一の真実源)。
//
// 述語の構成 (FR-48):
//   1. 共通の事前条件 (同一地物でない・対象時刻に存在する・有効である)。
//      結合フローと別実装として持ち、安易に共有しない (教訓 5.27 / 5.30)。
//   2. 循環参照防止: 候補は「対象地物自身」または「対象の下位領域すべて (U08 で
//      列挙、循環に耐える走査＝教訓 5.28)」に含まれてはならない。ただし対象の
//      上位領域は直轄化のため候補に含む (FR-48 の例外を実装で削らない＝教訓 5.25)。
//   3. 存在期間整合: 候補上位領域の存在期間が対象の存在期間と両立し、対象を下位に
//      加えても「親領域＝下位領域の和」を将来満たせる位置にあること (U08 の形状＝和
//      検証の前提条件として評価)。
//
// 下位領域列挙・循環判定は U08 (forest) の循環安全走査を経由し再実装しない。

import { featureDisplayName, type Feature } from '../feature';
import { descendantIds, type Forest } from '../hierarchy/forest';
import type { FeatureId } from '../ids';

/** 機械可読な拒否種別 (受け入れ基準 3: テスト可能なフィールド)。 */
export const AFFILIATION_REJECT = {
  /** 候補が対象自身、または存在しない / 同一地物。 */
  SameFeature: 'same-feature',
  /** 候補が対象の下位領域 (孫含む) — 循環参照になる。 */
  Cycle: 'cycle',
  /** 候補の存在期間が対象と両立しない (親＝下位の和を将来満たせない)。 */
  ExistencePeriod: 'existence-period',
  /** 対象が対象時刻に存在しない / 解決できない。 */
  TargetMissing: 'target-missing',
  /** 直接所属変更の対象種別が不正 (集約を直接張り替えようとした等)。 */
  TargetKind: 'target-kind',
} as const;

export type AffiliationRejectKind =
  (typeof AFFILIATION_REJECT)[keyof typeof AFFILIATION_REJECT];

/** 検証述語の判定結果: 合法、または拒否種別を伴う非合法。 */
export type LegalityVerdict =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: AffiliationRejectKind };

const LEGAL: LegalityVerdict = { ok: true };

function illegal(reason: AffiliationRejectKind): LegalityVerdict {
  return { ok: false, reason };
}

/**
 * 存在期間 [startYear, endYear] が両立するか (閉区間の重なり)。トレランス/座標量子化
 * は形状に関する話であり、ここは年スカラーの区間重なりで判定する。対象を下位に加えた
 * とき「親領域＝下位領域の和」を将来満たせるためには、両者の存在期間が少なくとも一点で
 * 重なっている必要がある (重なりが空なら、その期間に親が子を含むことは原理的に不能)。
 */
export function existencePeriodsCompatible(a: Feature, b: Feature): boolean {
  const aStart = a.attributes.startYear;
  const aEnd = a.attributes.endYear;
  const bStart = b.attributes.startYear;
  const bEnd = b.attributes.endYear;
  return aStart <= bEnd && bStart <= aEnd;
}

/**
 * 候補 `candidateId` が対象 `targetId` の合法な新上位領域か、を判定する単一述語
 * (教訓 5.26: 候補算出と確定前検証で共有)。`forest` は対象時刻で確定済みの面情報集合
 * から構築されたもの。
 *
 * 判定順 (FR-48):
 *   1. 同一地物 / 候補不在 → SameFeature。
 *   2. 候補が対象の下位領域 (循環安全に列挙) → Cycle。対象の上位領域は除外しない
 *      (直轄化のため候補に含む＝教訓 5.25)。
 *   3. 存在期間が両立しない → ExistencePeriod。
 *
 * 性能: 候補ごとに対象の子孫集合を再走査すると O(n) の DFS が候補数ぶん走り、
 * 一覧算出が O(n²) に退化する (受け入れ基準 6)。対象の子孫は候補に依らず不変なので、
 * 呼び出し側が一度だけ算出した子孫集合 (Set) を `targetDescendants` で渡せる。
 * 省略時は本関数が単発呼び出し用に内部で 1 回だけ算出する (単一述語＝教訓 5.26)。
 */
export function isLegalNewParent(
  forest: Forest,
  targetId: FeatureId,
  candidateId: FeatureId,
  targetDescendants?: ReadonlySet<FeatureId>,
): LegalityVerdict {
  if (candidateId === targetId) return illegal(AFFILIATION_REJECT.SameFeature);

  const target = forest.byId.get(targetId);
  const candidate = forest.byId.get(candidateId);
  if (target === undefined) return illegal(AFFILIATION_REJECT.TargetMissing);
  if (candidate === undefined) return illegal(AFFILIATION_REJECT.SameFeature);

  // 循環参照防止: 候補が対象の子孫 (孫含む) に入っていれば循環になる。
  // descendantIds は visited 集合で再入を遮断するため、壊れた (循環) データでも
  // 有限に終わる (教訓 5.28)。対象の上位領域は子孫ではないので自然に候補に残る
  // (直轄化の例外を削らない＝教訓 5.25)。一覧算出からは事前計算済み集合を受け取り
  // O(1) 判定にする (上記性能注記); 渡されなければ単発算出する。
  const descendants =
    targetDescendants ?? new Set(descendantIds(forest, targetId));
  if (descendants.has(candidateId)) return illegal(AFFILIATION_REJECT.Cycle);

  // 存在期間整合 (親＝下位の和を将来満たせる位置にあること)。
  if (!existencePeriodsCompatible(target, candidate)) {
    return illegal(AFFILIATION_REJECT.ExistencePeriod);
  }

  return LEGAL;
}

/** 許可候補一覧の 1 件: 候補 ID とその表示名 (UI ピッカー用)。 */
export interface ParentCandidate {
  readonly featureId: FeatureId;
  /** UI 表示名 (面情報の名称属性)。 */
  readonly displayName: string;
}

/**
 * 許可候補一覧の算出 (公開する主関数の一つ): `(現在状態, 対象, 対象時刻) → 合法な
 * 既存上位領域候補の ID と表示名のリスト`。循環防止・存在期間整合で絞り込む。
 * UI が候補を隠していても確定前検証 ({@link isLegalNewParent}) が同一述語で再判定
 * するため、ショートカット・直接呼び出し経路から不正候補が入っても拒否される
 * (教訓 5.26)。
 *
 * 対象が集約地物の場合でも、本関数は「対象自身」を起点に候補を絞る。複数対象への
 * 一括適用 (集約の全下位領域展開) は proposal 側が担当するため、ここでは対象 1 件の
 * 候補集合を返す契約で固定する。
 */
export function allowedParentCandidates(
  forest: Forest,
  targetId: FeatureId,
): ParentCandidate[] {
  const out: ParentCandidate[] = [];
  // 対象の子孫集合は候補ループ中で不変なので一度だけ算出して O(1) 判定に使う。
  // これにより一覧算出が候補ごとの DFS 再走査による O(n²) に退化しない (受け入れ基準 6)。
  const targetDescendants = new Set(descendantIds(forest, targetId));
  for (const id of forest.orderedIds) {
    if (isLegalNewParent(forest, targetId, id, targetDescendants).ok) {
      const f = forest.byId.get(id);
      if (f === undefined) continue;
      out.push({ featureId: id, displayName: featureDisplayName(f) });
    }
  }
  return out;
}
