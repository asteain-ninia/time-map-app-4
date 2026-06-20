// U30 — 結合の単一アンドゥ単位コマンド (FR-94, 教訓 5.11 / 5.20 / 5.23).
//
// 結合の全工程 (結果地物生成・形状論理和または下位平坦化・元地物の同一性終了・下位
// 付け替え・上位設定・プロパティ設定) を、不可分の 1 コマンドとして組む。コマンドが
// 2 個以上に割れないことを型で固定する (受け入れ基準 5)。execute / redo は記録済みの
// 編集案をそのまま再適用し新規 ID を再採番しない (教訓 5.20)。undo は結合前状態へ完全
// 復元する。touched は created∪survived∪deleted を対称に通知する (教訓 5.23)。
//
// 状態 `MergeState` は「面情報集合 + 頂点ストア」のスナップショット。末端のみ結合は
// 頂点を作り直すため頂点ストアも状態に含める。U03/U08 のフル状態ルートへ接続する際は
// このコマンドを composite の 1 要素として U13 へ渡す (spec §依存 U13)。

import { defineCommandKind, type Command, type CommandOutcome } from '../command/command';
import { createCommandResult, type CommandResult } from '../command/result';
import type { Feature } from '../feature';
import { asFeatureId, type DomainId, type FeatureId } from '../ids';
import type { VertexStore } from '../vertex';
import type { MergeProposal } from './proposal';

/** 結合コマンドの状態: 面情報集合 + 頂点ストアのスナップショット。 */
export interface MergeState {
  readonly features: readonly Feature[];
  readonly vertices: VertexStore;
}

export const MERGE_COMMAND_KIND = defineCommandKind('merge');
export const MERGE_COMMAND_LABEL = '結合';

function toDomainIds(ids: readonly FeatureId[]): DomainId[] {
  return ids.map((id) => asFeatureId(id));
}

function committedResultFor(proposal: MergeProposal): CommandResult {
  return createCommandResult({
    survived: toDomainIds(proposal.survivedTouchedIds),
    created: toDomainIds(proposal.createdIds),
    deleted: toDomainIds(proposal.deletedIds),
  });
}

function undoResultFor(proposal: MergeProposal): CommandResult {
  // undo は同一性終了した元地物を復活させ、新規地物を取り除く。通知集合は対称。
  return createCommandResult({
    survived: toDomainIds(proposal.survivedTouchedIds),
    created: toDomainIds(proposal.deletedIds),
    deleted: toDomainIds(proposal.createdIds),
  });
}

/**
 * 結合編集案を単一アンドゥ単位のコマンドへ包む。`baseline` は確定前の状態 (undo の
 * 戻り先)。execute/redo は編集案の適用後状態を返し (再採番なし, 教訓 5.20)、undo は
 * `baseline` を返す。結果は created/survived/deleted を対称に通知する (教訓 5.23)。
 */
export function createMergeCommand(
  baseline: MergeState,
  proposal: MergeProposal,
): Command<MergeState> {
  const committed = committedResultFor(proposal);
  const undone = undoResultFor(proposal);
  const nextState: MergeState = {
    features: proposal.nextFeatures,
    vertices: proposal.nextVertices,
  };

  const apply = (): CommandOutcome<MergeState> => ({ state: nextState, result: committed });

  return {
    kind: MERGE_COMMAND_KIND,
    label: MERGE_COMMAND_LABEL,
    execute: apply,
    redo: apply,
    undo: (): CommandOutcome<MergeState> => ({ state: baseline, result: undone }),
  };
}
