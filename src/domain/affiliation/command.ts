// U28 — 所属変更フローの単一アンドゥ単位コマンド (FR-94, 教訓 5.11/5.20/5.23).
//
// 編集案 (AffiliationProposal) を、不可分の 1 コマンドとして組む。フロー確定の全変更
// (親子張り替え＋新規上位領域生成＋中間階層挿入＋集約地物の自動消滅＋複数対象の一括
// 適用) を 1 回のアンドゥで全復元できる単一コマンドとする。コマンドが 2 個以上に
// 割れないことを型で固定する (受け入れ基準 5)。
//
// 状態 `S` は「面情報集合のスナップショット」。U03/U08 のフル状態ルートに接続する際は
// このコマンドを composite の 1 要素として U13 へ渡す (spec §依存 U13)。ここでは
// readonly Feature[] を直接の状態とする最小コマンドを提供し、両側テストで契約を固定
// する (教訓 5.33/5.34)。
//
// execute / redo は記録済みの編集案をそのまま再適用し、新規 ID を再採番しない
// (教訓 5.20)。undo は元の地物集合へ戻す。touched は created∪survived∪deleted を
// 対称に通知する (教訓 5.23)。

import {
  defineCommandKind,
  type Command,
  type CommandOutcome,
} from '../command/command';
import { createCommandResult, type CommandResult } from '../command/result';
import type { Feature } from '../feature';
import { asFeatureId, type DomainId, type FeatureId } from '../ids';
import type { AffiliationProposal } from './proposal';

/** 所属変更コマンドの状態: 面情報集合のスナップショット。 */
export type AffiliationState = readonly Feature[];

export const AFFILIATION_COMMAND_KIND = defineCommandKind('affiliation-change');
export const AFFILIATION_COMMAND_LABEL = '所属変更';

function toDomainIds(ids: readonly FeatureId[]): DomainId[] {
  // FeatureId は DomainId の構成要素。明示変換でブランドを保つ。
  return ids.map((id) => asFeatureId(id));
}

function resultFor(proposal: AffiliationProposal): CommandResult {
  return createCommandResult({
    survived: toDomainIds(proposal.survivedTouchedIds),
    created: toDomainIds(proposal.createdIds),
    deleted: toDomainIds(proposal.deletedIds),
  });
}

/**
 * 編集案を単一アンドゥ単位のコマンドへ包む。`baseline` は確定前の面情報集合
 * (undo の戻り先)。execute/redo は編集案の `nextFeatures` を返し (再採番なし,
 * 教訓 5.20)、undo は `baseline` を返す。結果は created/survived/deleted を対称に
 * 通知する (教訓 5.23)。
 */
export function createAffiliationCommand(
  baseline: AffiliationState,
  proposal: AffiliationProposal,
): Command<AffiliationState> {
  const committedResult = resultFor(proposal);
  const undoResult = createCommandResult({
    // undo は確定で消えた集約を復活させ、新規集約を取り除く。通知対象は同じ集合。
    survived: toDomainIds(proposal.survivedTouchedIds),
    created: toDomainIds(proposal.deletedIds),
    deleted: toDomainIds(proposal.createdIds),
  });

  const apply = (): CommandOutcome<AffiliationState> => ({
    state: proposal.nextFeatures,
    result: committedResult,
  });

  return {
    kind: AFFILIATION_COMMAND_KIND,
    label: AFFILIATION_COMMAND_LABEL,
    execute: apply,
    redo: apply,
    undo: (): CommandOutcome<AffiliationState> => ({
      state: baseline,
      result: undoResult,
    }),
  };
}
