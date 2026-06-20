// U28 — 所属変更編集案の組み立て・確定 (FR-46〜FR-49 / FR-94, 教訓 5.6/5.21/5.22/5.25).
//
// 本 module は所属変更フローの中核ドメインロジック:
//   1. 対象範囲の限定と複数対象展開 (FR-48): 直接所属変更は末端地物のみ。集約地物が
//      対象に渡された場合は「全下位領域を対象とする」展開を行い、各下位領域へ同一の
//      新上位領域決定を一括適用する (集約を直接張り替えない＝教訓 5.25)。末端/集約の
//      判別は結果状態 (下位領域の有無) で行う (教訓 5.6)。
//   2. 新上位領域の決定の実体化 (FR-46/47): `existing`/`none`/`create` を解釈し、
//      `create` では新規集約地物を再帰的に生成して中間階層を後付け挿入する。生成 ID は
//      id-generator から採番し、初回生成 ID をコマンド結果に記録する (redo で再採番
//      しない＝教訓 5.20)。
//   3. 確定前検証 (教訓 5.22/5.26): 循環・存在期間・対象種別を {@link isLegalNewParent}
//      と同一述語で検証し、違反すれば共有状態を一切変更せず拒否する。
//   4. 親子張り替え＋自動消滅 (FR-35/41, 教訓 5.6/5.21): 張り替え後の結果状態で全下位
//      領域を失った集約地物を U31 の sweep+prune で自動消滅させ、参照掃除・連鎖剪定まで
//      同一操作内で行う。解体はこの仕組みで成立する。
//   5. 確定後整合性 (FR-94, 教訓 5.22): 確定前に U08 の階層整合性検証を再実行し、違反
//      すれば確定せず状態を破棄して拒否する。
//
// 飛び地化 (FR-49) は本 module で拒否しない: 陸続き判定を合否条件にしない。集約形状＝
// 下位領域の和の算出 (複数独立リング) は U08→U06 に委譲され、本 module は「飛び地化
// しても拒否しない」ことのみ保証する。

import { createBasicAttributes, createColorInfo, type ColorInfo } from '../attributes';
import {
  createAggregateFeature,
  withAggregateChildIds,
  withParentId,
  type Feature,
} from '../feature';
import { sweepAndPruneAnchor } from '../deletion/sweep';
import { buildForest, directChildIds, hasChildren } from '../hierarchy/forest';
import { validateHierarchy } from '../hierarchy/validate';
import { asFeatureId, type FeatureId } from '../ids';
import { nextRawId, type IdGeneratorState, type TimeSource } from '../id-generator';
import type { VertexStore } from '../vertex';
import {
  AFFILIATION_REJECT,
  existencePeriodsCompatible,
  isLegalNewParent,
  type AffiliationRejectKind,
} from './candidates';
import {
  PARENT_DECISION,
  type NewAggregateSpec,
  type ParentDecision,
} from './decision';
import {
  MSG_AFFILIATION_EXISTENCE,
  MSG_AFFILIATION_HIERARCHY,
  MSG_AFFILIATION_TARGET_KIND,
  MSG_AFFILIATION_TARGET_MISSING,
  affiliationRejectMessage,
} from './messages';

/** 新規上位領域 (集約地物) に与える既定の色情報。形状は持たない (FR-35)。 */
const DEFAULT_AGGREGATE_COLOR: ColorInfo = createColorInfo(true, '#cccccc', '#ffaa00', '#666666');

// --- フロー結果 (判別共用体; spec §成果物) ----------------------------------

export const AFFILIATION_STATUS = {
  /** 確定済み: 次状態・変更 ID 集合・新規 ID・削除 ID を伴う。 */
  Committed: 'committed',
  /** 拒否: 機械可読な拒否種別 + 日本語メッセージ。 */
  Rejected: 'rejected',
} as const;

export type AffiliationStatus =
  (typeof AFFILIATION_STATUS)[keyof typeof AFFILIATION_STATUS];

/**
 * 所属変更編集案 (不変値)。確定前検証を通った変更の完全な記述。U13 の固定順序
 * プロセス / 単一アンドゥ単位へ渡せるよう、適用後の地物集合と変更 ID 集合を持つ。
 */
export interface AffiliationProposal {
  /** 展開後の対象 (末端地物群)。集約が渡された場合は全下位領域へ展開済み。 */
  readonly targetIds: readonly FeatureId[];
  /** 適用後の面情報集合 (入力順を可能な限り保持、新規地物は末尾)。 */
  readonly nextFeatures: readonly Feature[];
  /** 生成した新規上位領域 (集約地物) の ID 集合 (初回生成 ID, 教訓 5.20)。 */
  readonly createdIds: readonly FeatureId[];
  /** 自動消滅で削除された集約地物の ID 集合 (連鎖剪定含む, 教訓 5.21)。 */
  readonly deletedIds: readonly FeatureId[];
  /** 参照/親子が変更され存続する地物の ID 集合 (通知対象, 教訓 5.23)。 */
  readonly survivedTouchedIds: readonly FeatureId[];
  /** 次の id-generator 状態 (新規地物採番後)。呼び出し側が引き継ぐ。 */
  readonly idState: IdGeneratorState;
}

export interface AffiliationRejected {
  readonly status: typeof AFFILIATION_STATUS.Rejected;
  readonly kind: AffiliationRejectKind | 'hierarchy' | 'internal';
  readonly message: string;
  /** 機械可読詳細 (関与地物 ID 等)。 */
  readonly detail?: unknown;
}

/** 編集案組み立ての結果: 編集案、または拒否。 */
export type ProposalResult =
  | { readonly status: 'proposal'; readonly proposal: AffiliationProposal }
  | AffiliationRejected;

function reject(
  kind: AffiliationRejected['kind'],
  message: string,
  detail?: unknown,
): AffiliationRejected {
  return detail === undefined
    ? { status: AFFILIATION_STATUS.Rejected, kind, message }
    : { status: AFFILIATION_STATUS.Rejected, kind, message, detail };
}

// --- 対象範囲の限定と複数対象展開 (FR-48, 教訓 5.6/5.25/5.10) ----------------

/**
 * 直接所属変更の対象 (末端地物群) を解決する。
 *   - 対象が末端 (下位領域なし, 結果状態判定＝教訓 5.6) → その 1 件。
 *   - 対象が集約 (下位領域あり) → 「全下位領域を対象とする」展開 (直接の子のみ;
 *     各子に同一決定を適用すると、子がさらに集約でも子の親が付け替わるため集約全体の
 *     上位が移る。集約自身は直接張り替えない＝教訓 5.25)。
 *
 * 対象が存在しなければ undefined (呼び出し側が TargetMissing を返す)。
 */
export function resolveTargetLeaves(
  features: readonly Feature[],
  targetId: FeatureId,
): readonly FeatureId[] | undefined {
  const forest = buildForest(features);
  if (!forest.byId.has(targetId)) return undefined;
  if (hasChildren(forest, targetId)) {
    // 集約: 直接の下位領域すべてを対象に展開する (生の ID セットまで, 教訓 5.10)。
    return directChildIds(forest, targetId);
  }
  return [targetId];
}

// --- 新上位領域の決定の実体化 (FR-46/47, 教訓 5.20) --------------------------

interface RealizedDecision {
  /** 末端対象に割り当てる親 ID。`none` の場合は undefined (最上位化)。 */
  readonly parentId: FeatureId | undefined;
  /** 生成した新規集約地物 (末尾に追加する。順序: 下位→上位)。 */
  readonly created: readonly Feature[];
  readonly createdIds: readonly FeatureId[];
  readonly idState: IdGeneratorState;
}

/** 実体化の結果: 成功した実体化、または確定前検証で拒否。 */
type RealizeResult =
  | { readonly ok: true; readonly realized: RealizedDecision }
  | { readonly ok: false; readonly rejection: AffiliationRejected };

/**
 * 決定 `decision` を実体化する。`create` は新規集約地物を生成し、その親を `above` の
 * 再帰実体化で決める (中間階層の後付け挿入＝再帰の段数, FR-47)。生成 ID は採番し
 * 既存 ID と衝突しないようにする (教訓 5.37)。
 *
 * 確定前検証 (基準 3 / FR-48): `create` の上位 (`above`) が既存最上位 (`existing`) の
 * 場合、生成した中間集約 (期間=対象群の包絡) と既存上位の間にも循環・存在期間整合を
 * 適用する。新規中間集約は leaf-vs-newAgg 検証を素通りしうるため、生成集約 vs その親
 * (existing) の整合を再帰の各段でここで確定前に検証する (報告された blocking 修正)。
 */
function realizeDecision(
  decision: ParentDecision,
  existing: ReadonlySet<string>,
  idState: IdGeneratorState,
  now: TimeSource,
  start: number,
  end: number,
  byId: ReadonlyMap<FeatureId, Feature>,
): RealizeResult {
  switch (decision.kind) {
    case PARENT_DECISION.None:
      return ok({ parentId: undefined, created: [], createdIds: [], idState });
    case PARENT_DECISION.Existing:
      return ok({ parentId: decision.parentId, created: [], createdIds: [], idState });
    case PARENT_DECISION.Create: {
      // まず自身の集約地物 ID を採番する。
      const gen = nextRawId('f', idState, now, existing);
      const newId = asFeatureId(gen.value);
      const taken = new Set(existing);
      taken.add(gen.value);

      // さらに上位 (above) を再帰実体化。生成された上位地物の親 ID を、この集約の
      // 親として使う。
      const aboveResult = realizeDecision(decision.above, taken, gen.state, now, start, end, byId);
      if (!aboveResult.ok) return aboveResult;
      const above = aboveResult.realized;

      const aggregate = buildNewAggregate(newId, decision.spec, above.parentId, start, end);

      // 生成集約 vs その親 (above) の確定前整合 (基準 3 / FR-48)。`above` が既存地物
      // (existing decision の解決先) で、かつ新規生成でない場合のみ既存上位との整合を
      // 検証する。新規集約同士 (create→create) の整合は包絡が単調に広がるため両立する
      // が、既存上位は固定期間なので「生成集約=対象包絡」が既存上位の期間に収まる
      // 位置にあるか (将来 親領域=下位の和 を満たせるか) を検証しなければならない。
      const aboveParentId = above.parentId;
      if (aboveParentId !== undefined && above.created.length === 0) {
        // above は既存地物 (decision.above が `existing`)。生成集約とその既存親の整合。
        const existingParent = byId.get(aboveParentId);
        if (existingParent === undefined) {
          return rejectResult(
            reject(AFFILIATION_REJECT.SameFeature, MSG_AFFILIATION_TARGET_MISSING, {
              newParentId: aboveParentId,
            }),
          );
        }
        if (!existencePeriodsCompatible(aggregate, existingParent)) {
          return rejectResult(
            reject(AFFILIATION_REJECT.ExistencePeriod, MSG_AFFILIATION_EXISTENCE, {
              createdAggregateId: newId,
              newParentId: aboveParentId,
            }),
          );
        }
      }

      return ok({
        parentId: newId,
        created: [...above.created, aggregate],
        createdIds: [...above.createdIds, newId],
        idState: above.idState,
      });
    }
  }
}

function ok(realized: RealizedDecision): RealizeResult {
  return { ok: true, realized };
}

function rejectResult(rejection: AffiliationRejected): RealizeResult {
  return { ok: false, rejection };
}

/** 新規集約地物を生成する (形状なし, FR-35; 種別ラベルは表示専用, FR-40)。 */
function buildNewAggregate(
  id: FeatureId,
  spec: NewAggregateSpec,
  parentId: FeatureId | undefined,
  startYear: number,
  endYear: number,
): Feature {
  const attrs = createBasicAttributes(spec.name, startYear, endYear);
  // 集約地物の childIds は forest 走査では使われない (親子関係は parentId が単一真実源)
  // が、型上の集約地物として childIds を持つ。下位領域はこの後 parentId 張り替えで
  // 接続されるため、初期 childIds は空でよい (検証は forest 由来)。
  const optional =
    spec.kindLabel !== undefined && parentId !== undefined
      ? { kindLabel: spec.kindLabel, parentId }
      : spec.kindLabel !== undefined
        ? { kindLabel: spec.kindLabel }
        : parentId !== undefined
          ? { parentId }
          : {};
  return createAggregateFeature(id, attrs, DEFAULT_AGGREGATE_COLOR, [], optional);
}

// --- 編集案の組み立て (公開する主関数 2) -------------------------------------

export interface BuildProposalOptions {
  /** 新規地物採番用の id-generator 状態 (省略時は 0 初期化相当を呼び出し側が用意)。 */
  readonly idState: IdGeneratorState;
  /** 採番用の時刻ソース (注入, 教訓 5.15)。 */
  readonly now: TimeSource;
  /**
   * 新規上位領域の存在期間 (省略時は対象群の存在期間の包絡を用いる)。集約は下位領域の
   * 和なので、下位を包含できる存在期間が必要。
   */
  readonly newAggregateStart?: number;
  readonly newAggregateEnd?: number;
  /**
   * U08 形状=和・隙間なし検査用の頂点ストア (基準 5 / FR-35)。指定すると確定後の
   * {@link validateHierarchy} で集約形状=下位領域の和・隙間なし検査が有効化される。
   * 省略時は位相検査 (最上位同値・循環・dangling・空集約) のみ (形状検査スキップ)。
   */
  readonly vertexStore?: VertexStore;
}

/**
 * `(現在状態, 対象, 新上位領域決定, オプション) → 編集案 または 拒否`。
 * 確定前検証 (循環・存在期間・対象種別) をここで通す。共有状態は破壊更新しない
 * (教訓 5.22): 検証用に新しい配列を組み、違反時は何も適用せず拒否を返す。
 *
 * 対象 ID が集約なら全下位領域へ展開する (FR-48)。複数対象 (連邦化等) は
 * {@link buildAffiliationProposalForTargets} を直接呼ぶ。
 */
export function buildAffiliationProposal(
  features: readonly Feature[],
  targetId: FeatureId,
  decision: ParentDecision,
  options: BuildProposalOptions,
): ProposalResult {
  const targetLeaves = resolveTargetLeaves(features, targetId);
  if (targetLeaves === undefined) {
    return reject(AFFILIATION_REJECT.TargetMissing, MSG_AFFILIATION_TARGET_MISSING, { targetId });
  }
  if (targetLeaves.length === 0) {
    // 集約だが下位領域 0 件 (空集約): 直接張り替えできる末端がない。
    return reject(AFFILIATION_REJECT.TargetKind, MSG_AFFILIATION_TARGET_KIND, { targetId });
  }
  return buildProposalForLeaves(features, targetLeaves, decision, options);
}

/**
 * 複数の対象 ID を受け取り、全対象へ同一の新上位領域決定を一括適用する (FR-48 / 基準 2)。
 *
 * 連邦化はこの経路で表現する: 相互に無関係な複数の最上位地物に共通の新規最上位
 * (create→NewTop) を割り当てると、全対象が新規最上位の下位領域になり、新規最上位が
 * 唯一のルートになる。`create` 決定では新規最上位を **1 度だけ生成**して全対象を
 * 再親付けする (各対象ごとに別の集約を作らない)。
 *
 * 集約 ID が渡された場合は各 ID を全下位領域へ展開し、展開後の末端集合をまとめて
 * 一括適用する。展開後 0 件の集約 (空集約) が含まれていれば対象種別不正で拒否する。
 */
export function buildAffiliationProposalForTargets(
  features: readonly Feature[],
  targetIds: readonly FeatureId[],
  decision: ParentDecision,
  options: BuildProposalOptions,
): ProposalResult {
  if (targetIds.length === 0) {
    return reject(AFFILIATION_REJECT.TargetMissing, MSG_AFFILIATION_TARGET_MISSING, { targetIds });
  }
  // 各対象 ID を末端集合へ展開し統合する (重複は除く, 生の ID セット, 教訓 5.10)。
  const leafSet = new Set<FeatureId>();
  for (const targetId of targetIds) {
    const leaves = resolveTargetLeaves(features, targetId);
    if (leaves === undefined) {
      return reject(AFFILIATION_REJECT.TargetMissing, MSG_AFFILIATION_TARGET_MISSING, { targetId });
    }
    if (leaves.length === 0) {
      return reject(AFFILIATION_REJECT.TargetKind, MSG_AFFILIATION_TARGET_KIND, { targetId });
    }
    for (const id of leaves) leafSet.add(id);
  }
  return buildProposalForLeaves(features, [...leafSet], decision, options);
}

/**
 * 展開済みの末端対象集合に同一決定を一括適用する内部実装。`create` は新規集約を
 * 1 度だけ生成し、全末端をその新規集約へ再親付けする。
 */
function buildProposalForLeaves(
  features: readonly Feature[],
  targetLeaves: readonly FeatureId[],
  decision: ParentDecision,
  options: BuildProposalOptions,
): ProposalResult {
  // 既存 ID 集合 (採番衝突回避, 教訓 5.37)。
  const existing = new Set<string>(features.map((f) => f.id));

  // 新規上位領域の存在期間: 指定がなければ対象群の包絡を用いる。
  const period = aggregatePeriod(features, targetLeaves, options);

  // 決定の実体化 (新規集約地物の生成)。`existing` を破壊更新しないよう複製を渡す。
  // 既存地物 byId は create→existing の確定前期間検証に用いる。
  const byId = new Map<FeatureId, Feature>(features.map((f) => [f.id, f] as const));
  const realizeResult = realizeDecision(
    decision,
    new Set(existing),
    options.idState,
    options.now,
    period.start,
    period.end,
    byId,
  );
  if (!realizeResult.ok) return realizeResult.rejection;
  const realized = realizeResult.realized;

  // 実体化後の全地物集合 (新規地物を末尾に追加した検証用の作業集合)。
  const withCreated: Feature[] = [...features, ...realized.created];

  // 確定前検証: 各末端対象について、新親 (realized.parentId) が合法か。
  // `none` (parentId undefined = 最上位化) は循環・存在期間の対象外 (常に合法)。
  const verifyForest = buildForest(withCreated);
  if (realized.parentId !== undefined) {
    const newParentId = realized.parentId;
    for (const leafId of targetLeaves) {
      const verdict = isLegalNewParent(verifyForest, leafId, newParentId);
      if (!verdict.ok) {
        return reject(verdict.reason, affiliationRejectMessage(verdict.reason), {
          targetId: leafId,
          newParentId,
        });
      }
    }
  }

  // 親子張り替え: 各末端対象の parentId を新親へ。`none` は参照を外す (最上位化)。
  const reparented = withCreated.map((f) =>
    targetLeaves.includes(f.id) ? withParentId(f, realized.parentId) : f,
  );

  // 自動消滅判定 (結果状態, 教訓 5.6) + 参照掃除 + 連鎖剪定 (教訓 5.21)。
  // 張り替えにより全下位領域を失った集約地物を検出して消滅させる。
  // sweep は「明示削除対象」を起点にするが、ここでは明示削除はなく、張り替えで空に
  // なった集約のみを剪定したい。空集約の検出 → 連鎖剪定を sweep に委譲する。
  const emptied = emptiedAggregateIds(reparented, realized.createdIds);
  const swept = sweepAndPruneAnchor(reparented, emptied);

  // 集約地物 childIds の再同期 (報告 blocking 修正)。U28 内部検証は parentId を単一
  // 真実源とするため childIds 不整合でも素通りするが、persistence/serialize と
  // deletion/eligibility は childIds を権威データとして同期維持する不変条件を前提と
  // する。最終 parentId 関係 (sweep 後の確定状態) から全集約の childIds を再構築し、
  // (a) 新規生成集約に実子を設定、(b) 子を失った既存親集約から該当 ID を除去する。
  const synced = syncAggregateChildIds(swept.features);

  // 確定後整合性の再検証 (U08; 基準 5 / FR-94, 教訓 5.22/5.26)。違反すれば確定せず
  // 拒否。vertexStore を渡すと形状=和・隙間なし検査まで有効化される (基準 5 中核要件)。
  const validation = validateHierarchy(
    synced.features,
    options.vertexStore !== undefined ? { vertexStore: options.vertexStore } : {},
  );
  if (!validation.ok) {
    return reject('hierarchy', MSG_AFFILIATION_HIERARCHY, validation.violations);
  }

  // 通知対象 (存続側): 張り替えた末端 + sweep が編集した残存 + childIds が同期で
  // 変化した集約 (旧親=子を失った側 / 新規・既存の新親=子を得た側) + 新規生成。
  const survivedTouched = new Set<FeatureId>();
  for (const id of targetLeaves) if (!swept.removedIds.has(id)) survivedTouched.add(id);
  for (const id of swept.editedIds) survivedTouched.add(id);
  for (const id of synced.changedIds) survivedTouched.add(id);

  const proposal: AffiliationProposal = {
    targetIds: targetLeaves,
    nextFeatures: synced.features,
    createdIds: realized.createdIds,
    deletedIds: [...swept.removedIds],
    survivedTouchedIds: [...survivedTouched],
    idState: realized.idState,
  };
  return { status: 'proposal', proposal };
}

/**
 * 張り替え後の地物集合で、全下位領域を失った集約地物の ID を返す。生成したばかりの
 * 新規集約 (createdIds) は、対象がこれから接続される/された側なので空でも消さない…
 * のではなく、結果状態で空ならば消す。ただし「対象を受け取る親」は張り替え済みなので
 * 通常は空にならない。元の集約 (対象を失った側) のみが空になる。判定は結果状態のみ
 * (教訓 5.6): 経路ではなく「直接下位領域 0 件か」で決める。
 *
 * 新規生成した集約が結果として空 (誰も接続されなかった) の場合は、それも消滅対象に
 * 含めると連邦化/自治化で誤って消える恐れがあるため除外する: 新規集約は対象の新親
 * として必ず 1 件以上の対象を受け取る前提で生成される。
 */
function emptiedAggregateIds(
  features: readonly Feature[],
  createdIds: readonly FeatureId[],
): ReadonlySet<FeatureId> {
  const forest = buildForest(features);
  const createdSet = new Set<FeatureId>(createdIds);
  const out = new Set<FeatureId>();
  for (const f of features) {
    if (createdSet.has(f.id)) continue; // 新規集約は剪定対象から除外。
    if (f.kind !== 'aggregate') continue;
    if (!hasChildren(forest, f.id)) out.add(f.id); // 結果状態: 下位 0 件 (教訓 5.6)。
  }
  return out;
}

/**
 * 確定状態 (parentId が単一真実源) から全集約地物の childIds を再構築する。U28 の
 * 親子張り替えは parentId のみを更新するため、集約地物の childIds は脱同期する:
 * 旧親には移動した子が残り、新規生成集約は空のまま。serialize 往復・deletion
 * eligibility は childIds を権威データとして扱うため、確定前にここで同期する。
 *
 * childrenOf (forest) を子の権威ソースとして各集約の childIds を再生成する。順序は
 * forest の入力順 (= 地物配列順) で安定。childIds が実際に変化した集約 ID を
 * changedIds で返し、通知対象 (旧親/新親) に含める。
 */
function syncAggregateChildIds(features: readonly Feature[]): {
  readonly features: readonly Feature[];
  readonly changedIds: ReadonlySet<FeatureId>;
} {
  const forest = buildForest(features);
  const changedIds = new Set<FeatureId>();
  const next = features.map((f) => {
    if (f.kind !== 'aggregate') return f;
    const desired = directChildIds(forest, f.id);
    if (sameIdList(f.childIds, desired)) return f;
    changedIds.add(f.id);
    return withAggregateChildIds(f, desired);
  });
  return { features: next, changedIds };
}

/** 2 つの ID 配列が同一 (順序込み) か。childIds 再同期の no-op 判定用。 */
function sameIdList(a: readonly FeatureId[], b: readonly FeatureId[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/** 新規上位領域の存在期間: 明示指定 > 対象群の包絡。 */
function aggregatePeriod(
  features: readonly Feature[],
  targetLeaves: readonly FeatureId[],
  options: BuildProposalOptions,
): { readonly start: number; readonly end: number } {
  if (options.newAggregateStart !== undefined && options.newAggregateEnd !== undefined) {
    return { start: options.newAggregateStart, end: options.newAggregateEnd };
  }
  const byId = new Map(features.map((f) => [f.id, f] as const));
  let start = Number.POSITIVE_INFINITY;
  let end = Number.NEGATIVE_INFINITY;
  for (const id of targetLeaves) {
    const f = byId.get(id);
    if (f === undefined) continue;
    start = Math.min(start, f.attributes.startYear);
    end = Math.max(end, f.attributes.endYear);
  }
  if (!Number.isFinite(start) || !Number.isFinite(end)) return { start: 0, end: 0 };
  const s = options.newAggregateStart ?? start;
  const e = options.newAggregateEnd ?? end;
  return { start: s, end: e };
}
