// U31 deletion — public barrel.
//
// 面情報の削除を、参照整合性を壊さない単一操作として組み立てる pure domain logic:
//   - 削除可否の事前判定 (全錨横断・双方向参照列挙・再編許容, FR-41 / eligibility.ts),
//   - 参照掃除 (残存全要素・全時間軸・双方向) + 空集約の連鎖剪定 (不動点, sweep.ts),
//   - 集約地物の自動消滅判定 (下位領域 0 個 = 結果状態, 教訓 5.6, auto-disappear.ts),
//   - 不可分の削除コマンド (FR-73 / FR-94, command.ts),
//   - 日本語拒否文言 (FR-115, messages.ts).
// All framework-free (技術方針 2.13); single-run under Vitest (NFR 5.8).

export { type DeletionState, createDeletionState } from './state';

export { shouldAutoDisappear, emptyAggregateIds } from './auto-disappear';

export {
  type AnchorSweepResult,
  sweepAndPruneAnchor,
  sweepChildLinksOnly,
} from './sweep';

export {
  DELETE_REJECT,
  type DeleteRejectKind,
  DELETE_VERDICT,
  type DeleteVerdictKind,
  type DeleteVerdict,
  type AnchorReferences,
  referencesInAnchor,
  hasReferencesInAnchor,
  judgeDeletion,
  isDeletable,
} from './eligibility';

export {
  DELETE_FEATURE_COMMAND_KIND,
  DELETE_FEATURE_COMMAND_LABEL,
  createDeleteFeatureCommand,
  isNoOpDeletion,
} from './command';

export {
  MSG_DELETE_CONFIRM_TITLE,
  MSG_DELETE_CONFIRM_BODY,
  deleteRejectMessage,
} from './messages';

export {
  DELETE_TARGET_KIND,
  type DeleteTargetKind,
  type DeleteTarget,
  resolveDeleteTarget,
} from './target';
