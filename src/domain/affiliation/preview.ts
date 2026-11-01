// U28 — 所属変更を **確定する前に** 何が起きるかを数える説明器（増分 7 の中身 2b / 4）。
//
// 確定そのものは {@link buildAffiliationProposalForTargets} が持つ。この module は
// その手前で
//   1. **対象を洗い直す**（その年に居ないもの・空の集約を外し、件数と理由を返す）、
//   2. **集約を全下位領域へ展開する**（FR-48 後半。「対象は末端に限る」を壊さない）、
//   3. **直轄領（分け残し）が 1 件増えるかどうかと、その既定名称**を返す
// の 3 つを、確定と同じ述語・同じ規則で先に出す。
//
// **確定と別の規則を書かない**（教訓 5.26 / 5.29）。展開は {@link resolveTargetLeaves}、
// 直轄領の名前は {@link defaultDirectDomainName} を通す。ここに 2 つ目の判定を置くと、
// 画面の予告と実際の結果が食い違う。
//
// 文言は持たない（UI 側で組む）。返すのは機械可読な ID と件数だけである。

import { FEATURE_KIND, type Feature } from '../feature';
import type { FeatureId } from '../ids';
import { defaultDirectDomainName } from '../promotion/direct-domain';

import { PARENT_DECISION, type ParentDecision } from './decision';
import { resolveTargetLeaves } from './proposal';

/** 対象から外した理由（機械可読。文言は UI が付ける）。 */
export const AFFILIATION_TARGET_DROP = {
  /** その時刻に居ない（消えた・まだ生まれていない・ID が解決できない）。 */
  Missing: 'missing',
  /** 集約だが下位領域が 0 件（張り替えられる末端が無い）。 */
  EmptyAggregate: 'empty-aggregate',
} as const;

export type AffiliationTargetDropKind =
  (typeof AFFILIATION_TARGET_DROP)[keyof typeof AFFILIATION_TARGET_DROP];

/** 入力 1 件が「集約 → 全下位領域」へ展開されたことの記録。 */
export interface AffiliationTargetExpansion {
  readonly aggregateId: FeatureId;
  readonly leafIds: readonly FeatureId[];
}

/** 洗い直しの結果。 */
export interface AffiliationTargetPlan {
  /** 展開後の末端対象（入力順・重複なし）。これがそのまま確定の対象になる。 */
  readonly leafIds: readonly FeatureId[];
  /** 集約から展開したもの（画面に「集約地物 1 件を下位領域 60 件に広げました」と出す）。 */
  readonly expansions: readonly AffiliationTargetExpansion[];
  /** 外した入力と理由。 */
  readonly dropped: readonly {
    readonly featureId: FeatureId;
    readonly reason: AffiliationTargetDropKind;
  }[];
}

/**
 * 入力の対象 ID 群を、確定と同じ規則で末端の集合へ洗い直す（FR-48）。
 *
 * - 集約は **直接の下位領域**へ展開する（{@link resolveTargetLeaves} をそのまま使う）。
 * - その年に居ない ID は外して `Missing` を返す。
 * - 空の集約は外して `EmptyAggregate` を返す。
 *
 * **確定は 1 件でも不正があれば全体を拒否する**が、こちらは「外して先へ進める」ための
 * 材料を返す —— 画面は外した件数と理由を出したうえで、残りで確定できる（設計書 §D.2 の
 * 「洗い直しと、外した件数と理由を状態行に出す」）。
 */
export function planAffiliationTargets(
  features: readonly Feature[],
  targetIds: readonly FeatureId[],
): AffiliationTargetPlan {
  const leafOrder: FeatureId[] = [];
  const seen = new Set<FeatureId>();
  const expansions: AffiliationTargetExpansion[] = [];
  const expanded = new Set<FeatureId>();
  const dropped: { featureId: FeatureId; reason: AffiliationTargetDropKind }[] = [];

  /**
   * 集約地物を **末端まで**展開する（反証 2-10）。`resolveTargetLeaves` は直接の子しか
   * 返さないので、集約地物の下に集約地物が居ると「末端に限る」（FR-48 前半）を破った
   * まま確定へ流れる。ここで葉に達するまで畳む ―― 予告と確定が同じ集合を見る
   * （教訓 5.26 / 5.29）。
   */
  const toLeaves = (rootId: FeatureId): readonly FeatureId[] | undefined => {
    const first = resolveTargetLeaves(features, rootId);
    if (first === undefined) return undefined;
    const out: FeatureId[] = [];
    const visited = new Set<FeatureId>([rootId]);
    const queue: FeatureId[] = [...first];
    while (queue.length > 0) {
      const id = queue.shift();
      if (id === undefined) continue;
      if (visited.has(id)) continue;
      visited.add(id);
      const next = resolveTargetLeaves(features, id);
      if (next === undefined || (next.length === 1 && next[0] === id)) {
        out.push(id);
        continue;
      }
      queue.push(...next);
    }
    return out.length === 0 && first.length === 1 && first[0] === rootId ? [rootId] : out;
  };

  for (const targetId of targetIds) {
    // **下位領域を 1 つも持たない「集約地物」は外す**（増分 7）。`resolveTargetLeaves` は
    // 親子を `parentId` から数えるので、宣言だけが集約で子が居ない地物は「末端」として
    // 自分自身を返す ―― そのまま確定へ流すと **集約そのものの親を張り替える**ことになり、
    // FR-48 前半の「対象は末端に限る」から外れる。ここで種別を見て断る。
    const declared = features.find((f) => f.id === targetId);
    if (declared !== undefined && declared.kind === FEATURE_KIND.Aggregate) {
      const expanded = resolveTargetLeaves(features, targetId) ?? [];
      if (expanded.length === 0 || (expanded.length === 1 && expanded[0] === targetId)) {
        dropped.push({ featureId: targetId, reason: AFFILIATION_TARGET_DROP.EmptyAggregate });
        continue;
      }
    }
    const leaves = toLeaves(targetId);
    if (leaves === undefined) {
      dropped.push({ featureId: targetId, reason: AFFILIATION_TARGET_DROP.Missing });
      continue;
    }
    if (leaves.length === 0) {
      dropped.push({ featureId: targetId, reason: AFFILIATION_TARGET_DROP.EmptyAggregate });
      continue;
    }
    // 展開が起きたのは「返ってきた集合が自分 1 件ではない」とき（結果状態で判定＝教訓 5.6）。
    // **同じ集約地物を 2 回渡されても 1 本しか記録しない**（反証 1-1）。旧版は
    // 「集約地物 1 件を 60 件に広げました」が 2 行出ていた。
    if (!(leaves.length === 1 && leaves[0] === targetId) && !expanded.has(targetId)) {
      expanded.add(targetId);
      expansions.push({ aggregateId: targetId, leafIds: leaves });
    }
    for (const id of leaves) {
      if (seen.has(id)) continue;
      seen.add(id);
      leafOrder.push(id);
    }
  }

  return { leafIds: leafOrder, expansions, dropped };
}

/**
 * 決定を辿って「**外から子を 1 つ得ることになる既存の地物**」の ID を返す。
 *
 * - `existing(X)` → X（対象がそのまま X の子になる）。
 * - `create(spec, above)` → `above` を再帰的に辿る（新しい集約が `above` の子になる）。
 * - `none` → undefined（誰も子を得ない）。
 */
export function gainingParentId(decision: ParentDecision): FeatureId | undefined {
  switch (decision.kind) {
    case PARENT_DECISION.Existing:
      return decision.parentId;
    case PARENT_DECISION.Create:
      return gainingParentId(decision.above);
    case PARENT_DECISION.None:
      return undefined;
  }
}

/** 直轄領が 1 件増える見込みと、その既定名称（G-4 / FR-37 must）。 */
export interface DirectDomainPreview {
  /** 分け残しの持ち主になる地物（＝子を得る形状持ち末端）。 */
  readonly ownerId: FeatureId;
  /** その地物の名前（画面の予告文に出す）。 */
  readonly ownerName: string;
  /** 既定名称「<元名> 直轄領」。利用者はこれを上書きできる。 */
  readonly defaultName: string;
}

/**
 * この決定で **直轄領（分け残し）が生まれるか**を先に見る（FR-37）。
 *
 * 生まれるのは「**自分の形を持つ末端が、外から子を得たとき**」だけである（集約は形を
 * 持たないので分け残しが無い）。確定側の {@link generateDirectDomains} と同じ条件を、
 * 決定から先読みしている。
 *
 * **形の差が空（子が親を完全に覆う）なら実際には作られない**が、それは頂点の実体を
 * 解かないと分からない。画面は「1 件増えます」と予告し、名前を先に聞く —— 予告が
 * 外れる側（増えない）は害が無く、逆に「聞かないまま作る」ほうが取り返しがつかない。
 */
export function previewDirectDomain(
  features: readonly Feature[],
  decision: ParentDecision,
): DirectDomainPreview | null {
  const ownerId = gainingParentId(decision);
  if (ownerId === undefined) return null;
  const owner = features.find((f) => f.id === ownerId);
  if (owner === undefined) return null;
  if (owner.kind === FEATURE_KIND.Aggregate) return null; // 集約は形を持たない（FR-35）。
  if (owner.kind !== FEATURE_KIND.Leaf) return null; // 点・線は親になれない（ParentKind で拒否）。
  const ownerName = owner.attributes.name;
  return { ownerId, ownerName, defaultName: defaultDirectDomainName(ownerName) };
}
